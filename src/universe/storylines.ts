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
import { type Universe, type UniverseTeam } from "./types.ts";

export type StorylineKind = "streak" | "race" | "rivalry" | "decline";

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

export function buildStorylines(u: Universe, opts: { region?: Region | "all"; limit?: number } = {}): Storyline[] {
  const region = opts.region && opts.region !== "all" ? opts.region : null;
  const inRegion = (r: Region) => !region || r === region;
  const out: Storyline[] = [];
  const playerById = new Map(u.players.map(p => [p.id, p] as const));
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

  out.sort((a, b) => b.heat - a.heat);
  return opts.limit ? out.slice(0, opts.limit) : out;
}
