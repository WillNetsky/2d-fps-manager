// Pure end-of-season playoff engine — no DOM, no storage. Builds and advances a
// per-region tournament: an optional Swiss group stage that cuts the field to
// BRACKET_FIELD, then a single-elimination bracket to the title. The day loop in
// universeMode drives it: seed once (startPlayoffs), then each playoff day ask
// for that round's matchups (playoffRoundMatchups), sim them through the normal
// pipeline, and fold the results back (advancePlayoffs).

import { REGION_ORDER, type Region } from "../domain/countries.ts";
import {
  SWISS_FIELD, SWISS_TARGET, BRACKET_FIELD,
  type BracketMatch, type Matchup, type PlayoffEntrant, type PlayoffState,
  type RegionPlayoff, type UniverseTeam,
} from "./types.ts";

// ---- seeding helpers -------------------------------------------------------

// Largest power of two <= n (and <= cap). Used to size a direct bracket.
function pow2Floor(n: number, cap: number): number {
  let p = 1;
  while (p * 2 <= Math.min(n, cap)) p *= 2;
  return p;
}

// Standard single-elim seed slots for a bracket of n (power of two): returns seed
// numbers (1-based) in slot order so seeds 1 and 2 can only meet in the final.
// n=8 -> [1,8,4,5,2,7,3,6]; adjacent pairs are the round-1 matchups.
function seedSlots(n: number): number[] {
  let seeds = [1, 2];
  while (seeds.length < n) {
    const m = seeds.length * 2 + 1;
    const next: number[] = [];
    for (const s of seeds) { next.push(s); next.push(m - s); }
    seeds = next;
  }
  return seeds;
}

// Build the full (empty) bracket structure for `teamIdsBySeed` (index 0 = seed 1),
// length a power of two. Round 1 is filled from the seeding; later rounds are
// empty until winners arrive.
function buildBracket(teamIdsBySeed: string[]): BracketMatch[] {
  const n = teamIdsBySeed.length;
  const slots = seedSlots(n).map(seed => teamIdsBySeed[seed - 1]);
  const matches: BracketMatch[] = [];
  // Round 1 from seeded slots.
  for (let i = 0; i < n / 2; i++) {
    matches.push({ round: 1, slot: i, aTeamId: slots[2 * i], bTeamId: slots[2 * i + 1] });
  }
  // Empty later rounds.
  let count = n / 2;
  let round = 2;
  while (count > 1) {
    count = count / 2;
    for (let i = 0; i < count; i++) matches.push({ round, slot: i });
    round++;
  }
  return matches;
}

// Total knockout rounds for a bracket of `field` teams (power of two).
function bracketRounds(field: number): number {
  return Math.round(Math.log2(field));
}

// ---- start -----------------------------------------------------------------

// Seed playoffs from final regular-season standings. `rankedByRegion` must list,
// per region, the teams that played, already sorted best-first. Regions with no
// qualified teams are skipped; a lone team is crowned immediately.
export function startPlayoffs(
  season: number, rankedByRegion: Map<Region, UniverseTeam[]>,
): PlayoffState {
  const regions: RegionPlayoff[] = [];
  for (const region of REGION_ORDER) {
    const ranked = rankedByRegion.get(region) ?? [];
    if (ranked.length === 0) continue;

    if (ranked.length === 1) {
      // Only one team competed — it's the champion, no games to play.
      regions.push({
        region, stage: "done", entrants: entrantsOf(ranked.slice(0, 1)),
        swissRound: 1, swissTarget: SWISS_TARGET, bracket: [], bracketRound: 1,
        championTeamId: ranked[0].id, skippedSwiss: true,
      });
      continue;
    }

    if (ranked.length >= SWISS_FIELD) {
      // Full Swiss stage over the top SWISS_FIELD, cutting to BRACKET_FIELD.
      regions.push({
        region, stage: "swiss", entrants: entrantsOf(ranked.slice(0, SWISS_FIELD)),
        swissRound: 1, swissTarget: SWISS_TARGET, bracket: [], bracketRound: 1,
      });
    } else {
      // Too few for Swiss — seed a direct power-of-two bracket of the top teams.
      const field = pow2Floor(ranked.length, BRACKET_FIELD);
      const qualified = ranked.slice(0, field);
      regions.push({
        region, stage: "bracket", entrants: entrantsOf(qualified),
        swissRound: 1, swissTarget: SWISS_TARGET,
        bracket: buildBracket(qualified.map(t => t.id)), bracketRound: 1,
        skippedSwiss: true,
      });
    }
  }
  return { season, day: 1, regions };
}

function entrantsOf(teams: UniverseTeam[]): PlayoffEntrant[] {
  return teams.map((t, i) => ({
    teamId: t.id, seed: i + 1, wins: 0, losses: 0, status: "active", oppIds: [],
  }));
}

// ---- per-round pairing -----------------------------------------------------

// Swiss pairing for the current round: group active entrants by (wins,losses),
// then pair within each bucket — fold (top half vs bottom half) when that avoids
// rematches, otherwise any rematch-free matching. Buckets stay even across a
// 16-team 3-3 Swiss, so no byes are needed.
function swissPairings(rp: RegionPlayoff): [PlayoffEntrant, PlayoffEntrant][] {
  const active = rp.entrants.filter(e => e.status === "active");
  const buckets = new Map<string, PlayoffEntrant[]>();
  for (const e of active) {
    const k = `${e.wins}-${e.losses}`;
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(e);
  }
  const pairs: [PlayoffEntrant, PlayoffEntrant][] = [];
  // Stronger records first; within a bucket, by seed.
  const order = [...buckets.entries()].sort((a, b) => {
    const [aw, al] = a[0].split("-").map(Number), [bw, bl] = b[0].split("-").map(Number);
    return (bw - bl) - (aw - al);
  });
  for (const [, bucket] of order) {
    bucket.sort((a, b) => a.seed - b.seed);
    pairs.push(...pairBucket(bucket));
  }
  return pairs;
}

function faced(a: PlayoffEntrant, b: PlayoffEntrant): boolean {
  return a.oppIds.includes(b.teamId);
}

// Pair a same-record bucket (even length, seed-sorted). Prefer fold pairing
// (i vs i+half); if any fold pair is a rematch, fall back to a backtracking
// rematch-free matching; if even that fails, accept the fold (rare).
function pairBucket(bucket: PlayoffEntrant[]): [PlayoffEntrant, PlayoffEntrant][] {
  const k = bucket.length;
  if (k < 2) return [];
  const half = k / 2;
  const fold: [PlayoffEntrant, PlayoffEntrant][] = [];
  let foldClean = true;
  for (let i = 0; i < half; i++) {
    const a = bucket[i], b = bucket[i + half];
    fold.push([a, b]);
    if (faced(a, b)) foldClean = false;
  }
  if (foldClean) return fold;
  const bt = backtrackMatch(bucket);
  return bt ?? fold;
}

// Find any perfect matching of `pool` with no rematches (or null).
function backtrackMatch(pool: PlayoffEntrant[]): [PlayoffEntrant, PlayoffEntrant][] | null {
  if (pool.length === 0) return [];
  const [first, ...rest] = pool;
  for (let i = 0; i < rest.length; i++) {
    if (faced(first, rest[i])) continue;
    const remaining = rest.slice(0, i).concat(rest.slice(i + 1));
    const sub = backtrackMatch(remaining);
    if (sub) return [[first, rest[i]], ...sub];
  }
  return null;
}

// Build the matchups for one playoff day, across every region still playing.
// `rosterOf` returns a team's current 5 player ids. CT/T side is coin-flipped.
// `rand` defaults to Math.random (pairing is deterministic; side is cosmetic).
export function playoffRoundMatchups(
  state: PlayoffState, rosterOf: (teamId: string) => string[],
): Matchup[] {
  const out: Matchup[] = [];
  for (const rp of state.regions) {
    if (rp.stage === "swiss") {
      const pairs = swissPairings(rp);
      pairs.forEach(([a, b], slot) => {
        out.push(makePlayoffMatchup(rp.region, "swiss", rp.swissRound, slot, a.teamId, b.teamId, rosterOf, 3));
      });
    } else if (rp.stage === "bracket") {
      const total = bracketRounds(roundOneCount(rp) * 2);
      const matches = rp.bracket.filter(m => m.round === rp.bracketRound && m.aTeamId && m.bTeamId && !m.winnerTeamId);
      for (const m of matches) {
        const isFinal = rp.bracketRound === total;
        out.push(makePlayoffMatchup(rp.region, "bracket", rp.bracketRound, m.slot, m.aTeamId!, m.bTeamId!, rosterOf, isFinal ? 5 : 3));
      }
    }
  }
  return out;
}

// Number of round-1 matches in a region's bracket (its field is twice this).
function roundOneCount(rp: RegionPlayoff): number {
  return rp.bracket.filter(m => m.round === 1).length;
}

function makePlayoffMatchup(
  region: Region, stage: "swiss" | "bracket", round: number, slot: number,
  teamA: string, teamB: string, rosterOf: (id: string) => string[], bestOf: 3 | 5,
): Matchup {
  // Coin-flip starting sides.
  const aCt = Math.random() < 0.5;
  const ctId = aCt ? teamA : teamB;
  const tId = aCt ? teamB : teamA;
  return {
    id: `po-${region}-${stage}-r${round}-s${slot}`,
    ctPlayerIds: rosterOf(ctId),
    tPlayerIds: rosterOf(tId),
    status: "pending",
    bestOf,
    region,
    ctTeamId: ctId,
    tTeamId: tId,
    playoff: { stage, round, slot },
  };
}

// ---- advance ---------------------------------------------------------------

// Fold a completed playoff day's matchups back into the tournament: update Swiss
// records / bracket winners and transition stages. Call once per playoff day,
// after the matchups have been simmed. Returns true when ALL regions are done.
export function advancePlayoffs(state: PlayoffState, completed: Matchup[]): boolean {
  // Index results by region + stage + slot for the current round of each region.
  for (const rp of state.regions) {
    if (rp.stage === "done") continue;
    const mine = completed.filter(m =>
      m.region === rp.region && m.playoff &&
      m.playoff.stage === rp.stage &&
      m.playoff.round === (rp.stage === "swiss" ? rp.swissRound : rp.bracketRound) &&
      m.status === "completed" && !!winnerTeamOf(m));
    if (rp.stage === "swiss") advanceSwiss(rp, mine);
    else if (rp.stage === "bracket") advanceBracket(rp, mine);
  }
  state.day += 1;
  return state.regions.every(rp => rp.stage === "done");
}

// The winning team id of a completed matchup, from its winning side.
export function winnerTeamOf(m: Matchup): string | undefined {
  if (!m.winnerSide) return undefined;
  return m.winnerSide === "CT" ? m.ctTeamId : m.tTeamId;
}

function entrant(rp: RegionPlayoff, teamId: string): PlayoffEntrant | undefined {
  return rp.entrants.find(e => e.teamId === teamId);
}

function advanceSwiss(rp: RegionPlayoff, results: Matchup[]): void {
  for (const m of results) {
    const winId = winnerTeamOf(m)!;
    const loseId = m.ctTeamId === winId ? m.tTeamId! : m.ctTeamId!;
    const w = entrant(rp, winId), l = entrant(rp, loseId);
    if (!w || !l) continue;
    w.wins++; l.losses++;
    w.oppIds.push(loseId); l.oppIds.push(winId);
  }
  // Apply advance/eliminate thresholds.
  for (const e of rp.entrants) {
    if (e.status !== "active") continue;
    if (e.wins >= rp.swissTarget) e.status = "advanced";
    else if (e.losses >= rp.swissTarget) e.status = "eliminated";
  }
  const advanced = rp.entrants.filter(e => e.status === "advanced");
  if (advanced.length >= BRACKET_FIELD) {
    // Cut to the bracket: seed advancers by record then original seed.
    advanced.sort((a, b) => (b.wins - b.losses) - (a.wins - a.losses) || a.seed - b.seed);
    const qualified = advanced.slice(0, BRACKET_FIELD);
    rp.bracket = buildBracket(qualified.map(e => e.teamId));
    rp.bracketRound = 1;
    rp.stage = "bracket";
  } else {
    rp.swissRound++;
  }
}

function advanceBracket(rp: RegionPlayoff, results: Matchup[]): void {
  const total = bracketRounds(roundOneCount(rp) * 2);
  for (const m of results) {
    const bm = rp.bracket.find(x => x.round === rp.bracketRound && x.slot === m.playoff!.slot);
    if (!bm || bm.winnerTeamId) continue;
    bm.winnerTeamId = winnerTeamOf(m)!;
    bm.matchupId = m.id;
    // Feed the winner into the parent slot of the next round.
    if (rp.bracketRound < total) {
      const parentSlot = Math.floor(bm.slot / 2);
      const parent = rp.bracket.find(x => x.round === rp.bracketRound + 1 && x.slot === parentSlot);
      if (parent) {
        if (bm.slot % 2 === 0) parent.aTeamId = bm.winnerTeamId;
        else parent.bTeamId = bm.winnerTeamId;
      }
    }
  }
  // Round complete?
  const roundMatches = rp.bracket.filter(m => m.round === rp.bracketRound);
  if (roundMatches.every(m => m.winnerTeamId)) {
    if (rp.bracketRound >= total) {
      rp.championTeamId = roundMatches[0].winnerTeamId;
      rp.stage = "done";
    } else {
      rp.bracketRound++;
    }
  }
}
