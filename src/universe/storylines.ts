// Storylines — the curated counterpart to the firehose news feed. Where the feed
// is a chronological log of discrete events, these are the ONGOING threads worth
// watching right now, ranked by "heat". All derived from current state (+ the
// year buckets and the chemistry graph) — no persisted narrative state. Pure and
// DOM-free like news.ts; the UI renders the ranked result.
//
// Four thread types, matching the increment-2 plan:
//   streak  — a team riding a long active win streak
//   race    — a region whose top two are separated by a sliver of ranking points
//   rivalry — two players on different orgs with strong mutual antipathy
//   decline — a veteran whose year-over-year rating is sliding

import { REGION_ORDER, REGION_LABELS, type Region } from "../domain/countries.ts";
import { ratingOfCareer } from "./rating.ts";
import { formatMoney } from "./finance.ts";
import { type Universe, type UniverseTeam } from "./types.ts";

export type StorylineKind =
  | "streak" | "race" | "rivalry" | "decline"      // increment 2
  | "headtohead" | "dynasty" | "milestone" | "breakout" // increment 3
  | "trouble"                                      // economy (v2)
  | "expiring";                                    // contracts (v3)

export interface Storyline {
  kind: StorylineKind;
  heat: number;                // higher = more prominent
  title: string;
  detail: string;
  region?: Region;
  teamIds: string[];           // involved orgs (clickable)
  playerIds: string[];         // involved players (clickable)
}

const MIN_STREAK = 5;          // matches won in a row to be a story
const RACE_GAP_FRAC = 0.18;    // #2 within this fraction of #1's points = a race
const RIVALRY_MIN = 60;        // summed (both-direction) negative bond to count
const VET_AGE = 30;
const DECLINE_DROP = 0.08;     // year-over-year rating drop to flag a slide
const H2H_MIN_MEETINGS = 4;    // org pair must have met this often in the window
const DYNASTY_MIN_TITLES = 3;  // recent titles to count as a dynasty
const DYNASTY_WINDOW_DAYS = 200;
const KILL_STEP = 1000;        // career-kill milestone granularity
const KILL_NEAR = 60;          // within this many kills of the next step = a watch
const WIN_STEPS = [100, 250, 500, 1000];
const WIN_NEAR = 8;            // within this many wins of a step = a watch
const BREAKOUT_AGE = 21;
const BREAKOUT_RATING = 1.1;   // recent-year rating to count as breaking out
const BREAKOUT_MIN_GAMES = 10; // ...over at least this many games (real sample)
const TROUBLE_BALANCE = -100_000; // balance below this = a club in financial trouble
const CONTRACT_YEAR_DAYS = 21;    // a deal expiring within this many days = a contract year
const CONTRACT_YEAR_MIN_VALUE = 120_000; // ...for a player at least this valuable (notable)

export function buildStorylines(u: Universe, opts: { region?: Region | "all"; limit?: number } = {}): Storyline[] {
  const region = opts.region && opts.region !== "all" ? opts.region : null;
  const inRegion = (r: Region) => !region || r === region;
  const out: Storyline[] = [];
  const playerById = new Map(u.players.map(p => [p.id, p] as const));
  const teamById = new Map((u.teams ?? []).map(t => [t.id, t] as const));
  const activeTeams = (u.teams ?? []).filter(t => !t.disbandedDay && t.playerIds.length > 0);

  // Current org of each active player (for rivalry / decline attribution).
  const orgOf = new Map<string, UniverseTeam>();
  for (const t of activeTeams) for (const id of t.playerIds) orgOf.set(id, t);

  // --- Hot streaks ---
  for (const t of activeTeams) {
    if (t.streak < MIN_STREAK || !inRegion(t.region)) continue;
    out.push({
      kind: "streak", heat: 40 + t.streak * 6,
      title: `${t.name} are on a tear`,
      detail: `${REGION_LABELS[t.region] ?? t.region} · ${t.streak}-match win streak (${t.wins}-${t.losses} all-time).`,
      region: t.region, teamIds: [t.id], playerIds: [],
    });
  }

  // --- Title races (per region: top two close on ranking points) ---
  for (const r of (region ? [region] : REGION_ORDER)) {
    const ranked = activeTeams
      .filter(t => t.region === r)
      .sort((a, b) => (b.rankingPoints ?? 0) - (a.rankingPoints ?? 0));
    if (ranked.length < 2) continue;
    const [lead, chase] = ranked;
    const lp = lead.rankingPoints ?? 0, cp = chase.rankingPoints ?? 0;
    if (lp <= 0) continue;
    const gap = lp - cp;
    if (gap > lp * RACE_GAP_FRAC) continue;
    out.push({
      kind: "race", heat: 55 + (1 - gap / (lp * RACE_GAP_FRAC)) * 25,
      title: `${REGION_LABELS[r] ?? r} title race is tight`,
      detail: `${lead.name} lead ${chase.name} by just ${Math.round(gap)} ranking points.`,
      region: r, teamIds: [lead.id, chase.id], playerIds: [],
    });
  }

  // --- Rivalries (strong cross-org negative chemistry, deduped per pair) ---
  const seenPair = new Set<string>();
  for (const [aid, ta] of orgOf) {
    const pa = playerById.get(aid);
    if (!pa) continue;
    for (const [bid, relAB] of Object.entries(pa.relationships)) {
      if (relAB >= 0) continue;
      const tb = orgOf.get(bid);
      if (!tb || tb.id === ta.id) continue;
      const key = aid < bid ? `${aid}|${bid}` : `${bid}|${aid}`;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      const pb = playerById.get(bid);
      const strength = -(relAB + (pb?.relationships[aid] ?? 0));
      if (strength < RIVALRY_MIN || !inRegion(ta.region)) continue;
      out.push({
        kind: "rivalry", heat: 30 + strength * 0.4,
        title: `Bad blood: ${pa.handle} vs ${pb?.handle ?? bid}`,
        detail: `${pa.handle} (${ta.name}) and ${pb?.handle ?? bid} (${tb.name}) can't stand each other.`,
        region: ta.region, teamIds: [ta.id, tb.id], playerIds: [aid, bid],
      });
    }
  }

  // --- Veteran decline (recent year's rating down vs the prior rated year) ---
  if (u.yearStats) {
    const years = Object.keys(u.yearStats).map(Number).sort((a, b) => b - a);
    for (const [pid, t] of orgOf) {
      const p = playerById.get(pid);
      if (!p || p.age < VET_AGE || !inRegion(t.region)) continue;
      const rated: { year: number; rating: number }[] = [];
      for (const y of years) {
        const c = u.yearStats[y]?.[pid];
        const rt = c ? ratingOfCareer(c) : null;
        if (rt !== null) rated.push({ year: y, rating: rt });
        if (rated.length === 2) break;
      }
      if (rated.length < 2) continue;
      const [recent, prior] = rated;
      const drop = prior.rating - recent.rating;
      if (drop < DECLINE_DROP || recent.rating >= 1.05) continue;
      out.push({
        kind: "decline", heat: 25 + drop * 100,
        title: `${p.handle}'s twilight`,
        detail: `${p.name} (age ${p.age}, ${t.name}) is sliding — rating ${prior.rating.toFixed(2)} → ${recent.rating.toFixed(2)}.`,
        region: t.region, teamIds: [t.id], playerIds: [pid],
      });
    }
  }

  // --- Head-to-head team rivalries (frequent, close matchups in the window) ---
  const h2h = new Map<string, { a: string; b: string; aw: number; bw: number; n: number; region?: Region }>();
  const days = u.pendingDay ? [...u.history, { day: u.pendingDay.day, matchups: u.pendingDay.matchups }] : u.history;
  for (const d of days) {
    for (const m of d.matchups) {
      if (m.status !== "completed" || !m.ctTeamId || !m.tTeamId || !m.winnerSide) continue;
      const key = m.ctTeamId < m.tTeamId ? `${m.ctTeamId}|${m.tTeamId}` : `${m.tTeamId}|${m.ctTeamId}`;
      let rec = h2h.get(key);
      if (!rec) { const [a, b] = key.split("|"); h2h.set(key, rec = { a, b, aw: 0, bw: 0, n: 0, region: m.region }); }
      const winnerId = m.winnerSide === "CT" ? m.ctTeamId : m.tTeamId;
      if (winnerId === rec.a) rec.aw++; else rec.bw++;
      rec.n++;
    }
  }
  for (const rec of h2h.values()) {
    if (rec.n < H2H_MIN_MEETINGS) continue;
    const ta = teamById.get(rec.a), tb = teamById.get(rec.b);
    if (!ta || !tb || ta.disbandedDay || tb.disbandedDay || !inRegion(ta.region)) continue;
    if (Math.min(rec.aw, rec.bw) < rec.n / 3) continue; // one-sided ≠ a rivalry
    const [lead, , lw, tw] = rec.aw >= rec.bw ? [ta, tb, rec.aw, rec.bw] : [tb, ta, rec.bw, rec.aw];
    out.push({
      kind: "headtohead", heat: 45 + rec.n * 4 + Math.min(rec.aw, rec.bw) * 3,
      title: `${ta.name} vs ${tb.name} is a real rivalry`,
      detail: lw === tw
        ? `${rec.n} recent meetings, all square at ${lw}-${tw}.`
        : `${rec.n} recent meetings — ${lead.name} edge it ${lw}-${tw}.`,
      region: ta.region, teamIds: [ta.id, tb.id], playerIds: [],
    });
  }

  // --- Dynasties (multiple recent titles by a still-active org) ---
  const recentTitles = new Map<string, number>();
  for (const t of u.titles ?? []) {
    if (u.day - t.day > DYNASTY_WINDOW_DAYS) continue;
    recentTitles.set(t.championTeamId, (recentTitles.get(t.championTeamId) ?? 0) + 1);
  }
  for (const [tid, n] of recentTitles) {
    if (n < DYNASTY_MIN_TITLES) continue;
    const t = teamById.get(tid);
    if (!t || t.disbandedDay || !inRegion(t.region)) continue;
    out.push({
      kind: "dynasty", heat: 75 + n * 8,
      title: `${t.name} are building a dynasty`,
      detail: `${n} circuit titles in recent memory — the team to beat in ${REGION_LABELS[t.region] ?? t.region}.`,
      region: t.region, teamIds: [tid], playerIds: [],
    });
  }

  // --- Milestone watch (career kills / team wins about to tick over) ---
  for (const [pid, t] of orgOf) {
    if (!inRegion(t.region)) continue;
    const kills = u.careers?.[pid]?.kills ?? 0;
    if (kills < KILL_STEP) continue;
    const next = Math.ceil((kills + 1) / KILL_STEP) * KILL_STEP;
    const away = next - kills;
    if (away > KILL_NEAR) continue;
    const p = playerById.get(pid);
    out.push({
      kind: "milestone", heat: 25 + (KILL_NEAR - away),
      title: `${p?.handle ?? pid} nears ${next.toLocaleString()} career kills`,
      detail: `${kills.toLocaleString()} and counting — ${away} to go.`,
      region: t.region, teamIds: [t.id], playerIds: [pid],
    });
  }
  for (const t of activeTeams) {
    if (!inRegion(t.region)) continue;
    const next = WIN_STEPS.find(s => t.wins < s && s - t.wins <= WIN_NEAR);
    if (next === undefined) continue;
    out.push({
      kind: "milestone", heat: 22 + (WIN_NEAR - (next - t.wins)) * 2,
      title: `${t.name} close in on ${next} wins`,
      detail: `${t.wins} wins and counting.`,
      region: t.region, teamIds: [t.id], playerIds: [],
    });
  }

  // --- Breakouts (a young org player posting a big recent year) ---
  if (u.yearStats) {
    const recentYear = Object.keys(u.yearStats).map(Number).sort((a, b) => b - a)[0];
    if (recentYear !== undefined) {
      for (const [pid, t] of orgOf) {
        const p = playerById.get(pid);
        if (!p || p.age > BREAKOUT_AGE || !inRegion(t.region)) continue;
        const c = u.yearStats[recentYear]?.[pid];
        if (!c || c.played < BREAKOUT_MIN_GAMES) continue;
        const rt = ratingOfCareer(c);
        if (rt === null || rt < BREAKOUT_RATING) continue;
        out.push({
          kind: "breakout", heat: 45 + (rt - 1) * 60,
          title: `${p.handle} is breaking out`,
          detail: `${p.name} (age ${p.age}, ${t.name}) — ${rt.toFixed(2)} rating over ${c.played} games this year.`,
          region: t.region, teamIds: [t.id], playerIds: [pid],
        });
      }
    }
  }

  // --- Financial trouble (an org deep in the red, nearing insolvency) ---
  for (const t of activeTeams) {
    const bal = t.balance ?? 0;
    if (bal >= TROUBLE_BALANCE || !inRegion(t.region)) continue;
    out.push({
      kind: "trouble", heat: 50 + Math.min(40, -bal / 10000),
      title: `${t.name} are in financial trouble`,
      detail: `${formatMoney(bal)} in the red — selling stars or folding may be next.`,
      region: t.region, teamIds: [t.id], playerIds: [],
    });
  }

  // --- Contract years (a notable player's deal nearing expiry) ---
  for (const [pid, t] of orgOf) {
    const p = playerById.get(pid);
    if (!p?.contract || !inRegion(t.region)) continue;
    const daysLeft = p.contract.until - u.day;
    if (daysLeft < 0 || daysLeft > CONTRACT_YEAR_DAYS || (p.value ?? 0) < CONTRACT_YEAR_MIN_VALUE) continue;
    out.push({
      kind: "expiring", heat: 38 + (p.value ?? 0) / 12000,
      title: `${p.handle} enters a contract year`,
      detail: `${p.name}'s deal at ${t.name} expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"} — rivals will circle.`,
      region: t.region, teamIds: [t.id], playerIds: [pid],
    });
  }

  out.sort((a, b) => b.heat - a.heat);
  return opts.limit ? out.slice(0, opts.limit) : out;
}
