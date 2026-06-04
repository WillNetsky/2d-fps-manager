// Tournament-circuit logic — pure helpers, no DOM, no storage. The day loop in
// universeMode drives the calendar (counting down to the next event, starting and
// finishing tournaments); this module supplies the seeding, the ranking-point
// payouts, and the calendar math. The tournament itself runs on the existing
// bracket engine in tournament.ts.

import { regionOf, REGION_ORDER, type Region } from "../domain/countries.ts";
import type { Player } from "../domain/types.ts";
import { placementPayouts, type PlacementTiers } from "./finance.ts";
import {
  INVITE_FIELD, YEAR_LENGTH, STARTING_ELO, TEAM_SIZE, FA_CONTENDER_MARGIN,
  type ProvisionalStack, type RegionPlayoff, type UniverseTeam,
} from "./types.ts";

// ---- calendar --------------------------------------------------------------

// The 1-based calendar year a given day falls in. A pure function of the day, so
// it's stable across history trimming — unlike the old season window, every past
// day maps to a definite year. Drives aging and the per-year stat buckets.
export function yearOf(day: number): number {
  return Math.floor((day - 1) / YEAR_LENGTH) + 1;
}

// ---- seeding ---------------------------------------------------------------

// A candidate for an event invite: an already-tracked org, or a recurring full-5
// friend-stack that hasn't crystallized yet. Letting stacks in fills out the
// early brackets; a stack that makes the cut graduates into an org (see
// startEvent), so doing well in events is itself a path to becoming a team.
export type Invitee =
  | { kind: "team"; team: UniverseTeam }
  | { kind: "stack"; stack: ProvisionalStack };

// Seeding strength: ranking points first (orgs only — fresh stacks have none),
// then roster Elo. So a proven org outranks a new stack, but a strong stack still
// beats a weak or idle org.
function inviteeStrength(inv: Invitee, elos: Record<string, number>): { pts: number; elo: number } {
  if (inv.kind === "team") return { pts: inv.team.rankingPoints ?? 0, elo: inv.team.elo ?? STARTING_ELO };
  const ids = inv.stack.playerIds;
  const elo = ids.reduce((s, id) => s + (elos[id] ?? STARTING_ELO), 0) / Math.max(1, ids.length);
  return { pts: 0, elo };
}

// Per region, the top `n` invitees for the next event in seed order: every
// tracked org plus every recurring full-5 stack whose roster is currently active.
// Regions that can't field a bracket (< 2 invitees) are skipped. Feeds startEvent,
// which crystallizes any chosen stacks before handing seeds to startPlayoffs.
export function eventInvitees(
  teams: UniverseTeam[], stacks: ProvisionalStack[],
  elos: Record<string, number>, isActive: (id: string) => boolean, n = INVITE_FIELD,
): Map<Region, Invitee[]> {
  const byRegion = new Map<Region, Invitee[]>();
  const add = (region: Region, inv: Invitee) =>
    (byRegion.get(region) ?? byRegion.set(region, []).get(region)!).push(inv);
  for (const t of teams) if (t.playerIds.length > 0 && !t.disbandedDay) add(t.region, { kind: "team", team: t });
  for (const s of stacks) {
    if (s.playerIds.length === TEAM_SIZE && s.playerIds.every(isActive)) add(s.region, { kind: "stack", stack: s });
  }
  const out = new Map<Region, Invitee[]>();
  for (const region of REGION_ORDER) {
    const pool = byRegion.get(region);
    if (!pool || pool.length < 2) continue;
    pool.sort((a, b) => {
      const sa = inviteeStrength(a, elos), sb = inviteeStrength(b, elos);
      return sa.pts !== sb.pts ? sb.pts - sa.pts : sb.elo - sa.elo;
    });
    out.set(region, pool.slice(0, n));
  }
  return out;
}

// Free-agent contenders for a region's event: the strongest players not already
// committed (on an org or in a seeded stack) band into fresh 5-man lineups — but
// ONLY while a lineup's average Elo out-seeds the weakest qualified team by
// FA_CONTENDER_MARGIN. So we add genuine title threats, never pad a thin field.
// Returns rosters (id arrays), strongest first; the caller crystallizes + seeds
// them. The pool is sorted by Elo, so once a chunk fails the bar the rest do too.
export function freeAgentContenders(
  region: Region, players: Player[], elos: Record<string, number>,
  committed: Set<string>, weakestSeededElo: number, n = INVITE_FIELD,
): string[][] {
  const eloOf = (id: string) => elos[id] ?? STARTING_ELO;
  const pool = players
    .filter(p => !p.retired && !committed.has(p.id) && regionOf(p.country) === region)
    .sort((a, b) => eloOf(b.id) - eloOf(a.id) || a.id.localeCompare(b.id));
  const bar = weakestSeededElo + FA_CONTENDER_MARGIN;
  const out: string[][] = [];
  for (let i = 0; i + TEAM_SIZE <= pool.length && out.length < n; i += TEAM_SIZE) {
    const chunk = pool.slice(i, i + TEAM_SIZE);
    const avg = chunk.reduce((s, p) => s + eloOf(p.id), 0) / TEAM_SIZE;
    if (avg <= bar) break; // sorted desc: this chunk and every later one fail
    out.push(chunk.map(p => p.id));
  }
  return out;
}

// World-ranking order: more ranking points first, Elo as the tiebreak, then name
// for stability. Highest-ranked first.
export function compareRanking(a: UniverseTeam, b: UniverseTeam): number {
  const ap = a.rankingPoints ?? 0, bp = b.rankingPoints ?? 0;
  if (ap !== bp) return bp - ap;
  const ae = a.elo ?? STARTING_ELO, be = b.elo ?? STARTING_ELO;
  if (ae !== be) return be - ae;
  return a.name.localeCompare(b.name);
}

// ---- ranking points --------------------------------------------------------

// Points awarded by tournament finish, distributed exactly like prize money.
export const RANKING_POINTS: PlacementTiers = {
  champion: 1000,
  runnerUp: 600,
  semifinal: 350,
  quarterfinal: 200,
  bracket: 100,
  swiss: 50,
};

// A Major awards far more ranking points — winning one anchors a world #1 run.
export const MAJOR_RANKING_POINTS: PlacementTiers = {
  champion: 3000,
  runnerUp: 1800,
  semifinal: 1050,
  quarterfinal: 600,
  bracket: 300,
  swiss: 150,
};

// Ranking points owed to each team in one finished bracket (regional or Major),
// keyed by team id. Call only after the bracket has fully resolved.
export function rankingPointsFor(rp: RegionPlayoff): Map<string, number> {
  return placementPayouts(rp, rp.intl ? MAJOR_RANKING_POINTS : RANKING_POINTS);
}

// The Major field: the world's best active orgs by ranking, across all regions.
export function majorField(teams: UniverseTeam[], n = INVITE_FIELD): UniverseTeam[] {
  return teams
    .filter(t => !t.disbandedDay && t.playerIds.length > 0)
    .sort(compareRanking)
    .slice(0, n);
}
