// Newsfeed — a derived VIEW over data the universe already keeps, not a new
// persisted log (which would balloon the save with thousands of match items).
// Pure and DOM-free (mirrors circuit.ts / lifecycle.ts) so it's testable and the
// UI just renders what this returns. Stories come from four existing sources:
//   trophy  — u.titles (championships, with first-title / back-to-back flavor)
//   match   — completed org-vs-org results in the retained history window
//   roster  — each org's rosterHistory notes (founded, signed, disbanded…)
//   career  — retirements of players who were ever on a tracked org
// "Everything" is bounded naturally: matches by the HISTORY_WINDOW, the rest by
// their own durable structures. Filtering (region/category) makes the firehose
// usable; the UI caps how many rows it paints.

import { regionOf, type Region } from "../domain/countries.ts";
import { STARTING_ELO, type Universe } from "./types.ts";

export type NewsCategory = "trophy" | "match" | "roster" | "career";

export interface NewsItem {
  day: number;
  seq: number;                 // stable tiebreak within a day (generation order)
  category: NewsCategory;
  headline: string;            // plain text, names baked in (escaped at render)
  region?: Region;
  teamIds: string[];           // involved orgs, most-relevant first (clickable)
  playerIds: string[];         // involved players (clickable)
  tag?: string;                // short label, e.g. "UPSET", "FIRST TITLE"
}

// Elo gap (loser − winner) at which a result reads as an upset.
const UPSET_ELO_GAP = 75;

// Within a day, float the juicier categories above routine match spam.
const CATEGORY_RANK: Record<NewsCategory, number> = { trophy: 3, career: 2, roster: 1, match: 0 };

export interface NewsOptions {
  category?: NewsCategory | "all";
  region?: Region | "all";
  limit?: number;              // max items returned (newest first)
}

export function buildNews(u: Universe, opts: NewsOptions = {}): NewsItem[] {
  const want = (c: NewsCategory) => !opts.category || opts.category === "all" || opts.category === c;
  const teamById = new Map((u.teams ?? []).map(t => [t.id, t] as const));
  const items: NewsItem[] = [];
  let seq = 0;

  // --- Trophies: championships, with first-title and back-to-back detection ---
  if (want("trophy")) {
    const titles = [...(u.titles ?? [])].sort((a, b) => a.eventId - b.eventId);
    const everWon = new Set<string>();
    const lastChampByRegion = new Map<Region, string>();
    for (const t of titles) {
      let tag: string | undefined;
      if (lastChampByRegion.get(t.region) === t.championTeamId) tag = "BACK-TO-BACK";
      else if (!everWon.has(t.championTeamId)) tag = "FIRST TITLE";
      everWon.add(t.championTeamId);
      lastChampByRegion.set(t.region, t.championTeamId);
      items.push({
        day: t.day, seq: seq++, category: "trophy",
        headline: `🏆 ${t.championName} win ${t.name}${t.runnerUpName ? ` over ${t.runnerUpName}` : ""}`,
        region: t.region,
        teamIds: [t.championTeamId, ...(t.runnerUpTeamId ? [t.runnerUpTeamId] : [])],
        playerIds: [],
        tag,
      });
    }
  }

  // --- Roster moves: every org's rosterHistory note is a story ---
  if (want("roster")) {
    for (const team of u.teams ?? []) {
      for (const e of team.rosterHistory ?? []) {
        const tag = /disband/i.test(e.note) ? "DISBANDED"
          : /founded|re-formed/i.test(e.note) ? "NEW ORG"
          : /signed/i.test(e.note) ? "TRANSFER" : undefined;
        items.push({
          day: e.day, seq: seq++, category: "roster",
          headline: `${team.name} — ${e.note}`,
          region: team.region,
          teamIds: [team.id],
          playerIds: [...e.playerIds],
          tag,
        });
      }
    }
  }

  // --- Retirements: only players who ever played for a tracked org (signal) ---
  if (want("career")) {
    const orgPlayers = new Set<string>();
    for (const t of u.teams ?? []) for (const e of t.rosterHistory ?? []) for (const id of e.playerIds) orgPlayers.add(id);
    for (const p of u.players) {
      if (!p.retired || p.retiredDay === undefined || !orgPlayers.has(p.id)) continue;
      items.push({
        day: p.retiredDay, seq: seq++, category: "career",
        headline: `${p.name} ("${p.handle}") retires`,
        region: regionOf(p.country),
        teamIds: [],
        playerIds: [p.id],
        tag: "RETIREMENT",
      });
    }
  }

  // --- Match results: every completed org-vs-org game in the history window ---
  if (want("match")) {
    const days = u.pendingDay ? [...u.history, { day: u.pendingDay.day, matchups: u.pendingDay.matchups }] : u.history;
    for (const d of days) {
      for (const m of d.matchups) {
        if (m.status !== "completed" || !m.ctTeamId || !m.tTeamId || !m.winnerSide) continue;
        const ct = teamById.get(m.ctTeamId), t = teamById.get(m.tTeamId);
        if (!ct || !t) continue;
        const ctWon = m.winnerSide === "CT";
        const winner = ctWon ? ct : t, loser = ctWon ? t : ct;
        const wScore = ctWon ? (m.ctScore ?? 0) : (m.tScore ?? 0);
        const lScore = ctWon ? (m.tScore ?? 0) : (m.ctScore ?? 0);
        const gap = (loser.elo ?? STARTING_ELO) - (winner.elo ?? STARTING_ELO);
        const tag = m.playoff ? "PLAYOFF" : gap >= UPSET_ELO_GAP ? "UPSET" : undefined;
        items.push({
          day: d.day, seq: seq++, category: "match",
          headline: `${winner.name} beat ${loser.name} ${wScore}-${lScore}${m.games?.length ? ` (Bo${m.bestOf})` : ""}`,
          region: m.region,
          teamIds: [winner.id, loser.id],
          playerIds: [],
          tag,
        });
      }
    }
  }

  let out = (opts.region && opts.region !== "all") ? items.filter(i => i.region === opts.region) : items;
  out.sort((a, b) =>
    b.day - a.day ||
    CATEGORY_RANK[b.category] - CATEGORY_RANK[a.category] ||
    b.seq - a.seq);
  return opts.limit && out.length > opts.limit ? out.slice(0, opts.limit) : out;
}
