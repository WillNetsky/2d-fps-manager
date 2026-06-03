// Pure universe simulation engine — no DOM, no class, no storage. Operates on a
// plain SimState so it can run on the main thread for a single match or inside a
// Web Worker for batch fast-forward (see universeSimWorker.ts). The UI layer
// (universeMode.ts) builds a SimState view over its live Universe, hands it to
// the worker, and merges the mutated state back when the worker returns.

import type { GameMap, Player } from "../domain/types.ts";
import { regionOf, REGION_ORDER, type Region } from "../domain/countries.ts";
import { buildTeam, simulateMatchInstant } from "./matchSim.ts";
import { applyMatchElo } from "./elo.ts";
import { applyMatchChemistry, FRIEND_THRESHOLD } from "./chemistry.ts";
import { applyMatchForm } from "./form.ts";
import {
  STARTING_ELO, TEAM_SIZE, RECRUIT_BOND,
  GAMES_TO_ORG, DRIVEN_AMBITION, DRIVEN_CORE_SIZE,
  type CareerStats, type Clutch, type GameResult, type Matchup, type PendingDay, type PlayerMatchStats,
  type ProvisionalStack, type UniverseTeam, type VetoStep,
} from "./types.ts";
import { generateTeamName } from "../domain/teamNames.ts";

// The mutable slice of a Universe the simulation reads and writes. Everything
// here is plain data (structured-cloneable), so it crosses the worker boundary
// by postMessage. History/maps metadata that the sim doesn't mutate is kept by
// the caller; `maps` is sent read-only so matches can resolve their map.
export interface SimState {
  players: Player[];
  elos: Record<string, number>;
  careers: Record<string, CareerStats>;
  maps: GameMap[];
  pendingDay: PendingDay | null;
  day: number;
  // Current calendar year, and the per-year career buckets to fold into
  // alongside lifetime `careers`. Both optional so a SimState can be built
  // without period tracking (older call sites / tests); when present, every
  // folded match also accrues into yearStats[period]. Kept up to date by the
  // caller across a multi-day run so each day attributes to its own year.
  period?: number;
  yearStats?: Record<number, Record<string, CareerStats>>;
}

export function newSeed(): number {
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}

// ---- Per-match simulation + folding --------------------------------------
//
// Simulation and folding are split so a whole day of matches can be simulated
// in parallel across a worker pool (every player plays exactly one match per
// day, so the matches are independent) and then folded sequentially on the
// coordinator. simulateMatchResult is pure (no shared-state mutation);
// foldMatchResult applies the result to elo/chemistry/form/career totals.

// The result of simulating one matchup that crosses the worker boundary. For a
// Bo1 it carries the single game's fields; for a series it carries the per-game
// list plus the series tally (games won) in ctScore/tScore.
export interface MatchupOutcome {
  id: string;
  winnerSide: "CT" | "T";
  ctScore: number;                                  // Bo1: rounds; series: games won by CT
  tScore: number;
  games?: GameResult[];                             // series only
  veto?: VetoStep[];                                // series only
  // Bo1 only — series detail lives per game in `games`.
  clutches?: Clutch[];
  playerStats?: Record<string, PlayerMatchStats>;
  seed?: number;
  mapIndex?: number;
  moods?: Record<string, number>;                   // Bo1 sim-time morale snapshot
}

// The round-level result of a single game (before its seed/map/moods are attached).
type GameOutcome = Omit<GameResult, "seed" | "mapIndex" | "moods">;

// Snapshot each participating player's current morale — the value the sim seeds
// in-match mood from — so a replay reproduces the exact match later.
function snapshotMoods(ctIds: string[], tIds: string[], byId: Map<string, Player>): Record<string, number> {
  const moods: Record<string, number> = {};
  for (const id of [...ctIds, ...tIds]) moods[id] = byId.get(id)?.morale ?? 50;
  return moods;
}

function runGame(ctIds: string[], tIds: string[], byId: Map<string, Player>, map: GameMap, seed: number): GameOutcome {
  const ctPlayers = ctIds.map(id => byId.get(id)!).filter(Boolean);
  const tPlayers  = tIds.map (id => byId.get(id)!).filter(Boolean);
  const ctTeam = buildTeam("ct", "CT-side", ctPlayers, "CT");
  const tTeam  = buildTeam("t",  "T-side",  tPlayers,  "T");
  const r = simulateMatchInstant(ctTeam, tTeam, map, seed);
  return { ctScore: r.ctScore, tScore: r.tScore, winnerSide: r.winnerSide, clutches: r.clutches, playerStats: r.playerStats };
}

// CS-style pick/ban veto driven by each team's emergent map comfort. The two
// sides alternate (CT seeds first; sides are randomized per matchup, so that's
// effectively a coin flip): first banning their least-preferred remaining maps
// down to the series length, then picking their most-preferred — each pick is
// the next game, and the final leftover is the decider. Deterministic given the
// players' map records (ties break by map name), so a series is reproducible.
// Returns the map indices in game order plus the veto sequence for display.
export function runVeto(
  maps: GameMap[], bestOf: number, ctIds: string[], tIds: string[], byId: Map<string, Player>,
): { order: number[]; steps: VetoStep[] } {
  const remaining = maps.map((_, i) => i);
  const need = Math.min(bestOf, remaining.length); // maps to finish with (games)
  const bans = Math.max(0, remaining.length - need);
  const steps: VetoStep[] = [];
  const order: number[] = [];

  const idsOf = (turn: number) => (turn % 2 === 0 ? ctIds : tIds);
  const sideOf = (turn: number): "CT" | "T" => (turn % 2 === 0 ? "CT" : "T");
  const comfort = (turn: number, mi: number) => teamMapComfort(idsOf(turn), byId, maps[mi].name);
  const take = (mi: number) => remaining.splice(remaining.indexOf(mi), 1);

  let turn = 0;
  // Bans: each team removes its least-preferred remaining map.
  for (let b = 0; b < bans; b++) {
    let pick = remaining[0], best = Infinity;
    for (const mi of remaining) {
      const c = comfort(turn, mi);
      if (c < best || (c === best && maps[mi].name < maps[pick].name)) { best = c; pick = mi; }
    }
    take(pick);
    steps.push({ side: sideOf(turn), action: "ban", mapIndex: pick });
    turn++;
  }
  // Picks: each team takes its most-preferred remaining map as the next game.
  for (let p = 0; p < need - 1; p++) {
    let pick = remaining[0], best = -Infinity;
    for (const mi of remaining) {
      const c = comfort(turn, mi);
      if (c > best || (c === best && maps[mi].name < maps[pick].name)) { best = c; pick = mi; }
    }
    take(pick);
    steps.push({ side: sideOf(turn), action: "pick", mapIndex: pick });
    order.push(pick);
    turn++;
  }
  // Decider: the last remaining map.
  const decider = remaining[0];
  steps.push({ side: sideOf(turn), action: "decider", mapIndex: decider });
  order.push(decider);
  return { order, steps };
}

// Pure: simulate a matchup (Bo1 or full series) and return its outcome. Does not
// touch shared state, so it's safe to run in parallel for matchups with disjoint
// players. A series stops as soon as one team clinches a majority.
export function simulateMatchup(m: Matchup, byId: Map<string, Player>, maps: GameMap[]): MatchupOutcome {
  const bestOf = m.bestOf ?? 1;
  const moods = snapshotMoods(m.ctPlayerIds, m.tPlayerIds, byId);
  if (bestOf <= 1) {
    if (m.mapIndex === undefined || m.mapIndex >= maps.length) m.mapIndex = Math.floor(Math.random() * maps.length);
    if (m.seed === undefined) m.seed = newSeed();
    const g = runGame(m.ctPlayerIds, m.tPlayerIds, byId, maps[m.mapIndex], m.seed);
    return { id: m.id, winnerSide: g.winnerSide, ctScore: g.ctScore, tScore: g.tScore, clutches: g.clutches, playerStats: g.playerStats, seed: m.seed, mapIndex: m.mapIndex, moods };
  }
  const { order: mapOrder, steps: veto } = runVeto(maps, bestOf, m.ctPlayerIds, m.tPlayerIds, byId);
  const need = Math.ceil(bestOf / 2);
  const games: GameResult[] = [];
  let ctWon = 0, tWon = 0;
  for (let i = 0; i < bestOf && ctWon < need && tWon < need; i++) {
    const seed = newSeed();
    const mapIndex = mapOrder[i % mapOrder.length];
    const g = runGame(m.ctPlayerIds, m.tPlayerIds, byId, maps[mapIndex], seed);
    // All games of a series are simulated from the same pre-series morale (folding
    // happens after), so each game snapshots the same moods.
    games.push({ seed, mapIndex, ...g, moods });
    if (g.winnerSide === "CT") ctWon++; else tWon++;
  }
  return { id: m.id, winnerSide: ctWon > tWon ? "CT" : "T", ctScore: ctWon, tScore: tWon, games, veto };
}

// Update each participating player's per-map win/loss record for the map just
// played — the raw material for emergent map comfort.
function recordMapComfort(
  byId: Map<string, Player>, ctIds: string[], tIds: string[],
  mapName: string | undefined, winnerSide: "CT" | "T",
): void {
  if (!mapName) return;
  const winSet = new Set(winnerSide === "CT" ? ctIds : tIds);
  for (const id of [...ctIds, ...tIds]) {
    const p = byId.get(id);
    if (!p) continue;
    const ms = (p.mapStats ??= {});
    const rec = ms[mapName] ?? (ms[mapName] = { played: 0, won: 0 });
    rec.played++;
    if (winSet.has(id)) rec.won++;
  }
}

// A team's emergent comfort on a map (0..1): the average of its players' win
// rate on that map, smoothed toward a neutral prior so a couple of games don't
// swing it wildly. Players with no history sit at neutral. Consumed by the veto.
const MAP_COMFORT_PRIOR = 2;
const MAP_COMFORT_NEUTRAL = 0.5;
export function teamMapComfort(playerIds: string[], byId: Map<string, Player>, mapName: string): number {
  let sum = 0, n = 0;
  for (const id of playerIds) {
    const p = byId.get(id);
    if (!p) continue;
    const rec = p.mapStats?.[mapName];
    sum += rec
      ? (rec.won + MAP_COMFORT_PRIOR * MAP_COMFORT_NEUTRAL) / (rec.played + MAP_COMFORT_PRIOR)
      : MAP_COMFORT_NEUTRAL;
    n++;
  }
  return n > 0 ? sum / n : MAP_COMFORT_NEUTRAL;
}

// Fold a completed matchup into the current year's per-player bucket, mirroring
// the lifetime `careers` fold. No-op unless the caller is tracking the period.
function recordPeriodCareers(state: SimState, m: Matchup): void {
  if (state.period === undefined || !state.yearStats) return;
  const bucket = state.yearStats[state.period] ??= {};
  recordMatchupCareers(bucket, m);
}

// Fold one game's result into elo, chemistry, form, career totals, and map
// comfort. Per the per-game model, each game of a series folds like a Bo1.
function foldGame(state: SimState, ctIds: string[], tIds: string[], g: GameResult, byId: Map<string, Player>): number {
  const winners = g.winnerSide === "CT" ? ctIds : tIds;
  const losers  = g.winnerSide === "CT" ? tIds  : ctIds;
  const delta = applyMatchElo(winners, losers, state.elos);
  applyMatchChemistry(state.players, { winnerIds: winners, loserIds: losers, stats: g.playerStats }, byId);
  applyMatchForm(state.players, { winnerIds: winners, loserIds: losers, stats: g.playerStats }, byId);
  recordMapComfort(byId, ctIds, tIds, state.maps[g.mapIndex]?.name, g.winnerSide);
  // Per-game career fold: a game looks like a completed Bo1 match for tallying.
  const asMatch: Matchup = {
    id: "", status: "completed", ctPlayerIds: ctIds, tPlayerIds: tIds,
    ctScore: g.ctScore, tScore: g.tScore, winnerSide: g.winnerSide,
    clutches: g.clutches, playerStats: g.playerStats,
  };
  recordMatchupCareers(state.careers, asMatch);
  recordPeriodCareers(state, asMatch);
  return delta;
}

// Sequential: record a matchup outcome onto the matchup and fold it into elo,
// chemistry, form, and career totals. `byId` is the shared id→player index.
export function foldOutcome(state: SimState, m: Matchup, o: MatchupOutcome, byId: Map<string, Player>): void {
  m.status = "completed";
  m.winnerSide = o.winnerSide;
  m.ctScore = o.ctScore;
  m.tScore  = o.tScore;

  if (o.games) {
    m.games = o.games;
    m.veto = o.veto;
    // Each game adjusts elo; the card shows an approximate symmetric delta — the
    // winning side's average net elo change across the series. Per-game truth
    // lives in the box score.
    const winnerIds = o.winnerSide === "CT" ? m.ctPlayerIds : m.tPlayerIds;
    const pre = winnerIds.map(id => state.elos[id] ?? STARTING_ELO);
    for (const g of o.games) foldGame(state, m.ctPlayerIds, m.tPlayerIds, g, byId);
    const net = winnerIds.reduce((s, id, i) => s + ((state.elos[id] ?? STARTING_ELO) - pre[i]), 0) / winnerIds.length;
    m.eloDelta = Math.round(net);
    return;
  }

  m.clutches = o.clutches;
  m.playerStats = o.playerStats;
  m.moods = o.moods;
  if (o.seed !== undefined) m.seed = o.seed;
  if (o.mapIndex !== undefined) m.mapIndex = o.mapIndex;
  const winners = o.winnerSide === "CT" ? m.ctPlayerIds : m.tPlayerIds;
  const losers  = o.winnerSide === "CT" ? m.tPlayerIds  : m.ctPlayerIds;
  m.eloDelta = applyMatchElo(winners, losers, state.elos);
  applyMatchChemistry(state.players, { winnerIds: winners, loserIds: losers, stats: o.playerStats! }, byId);
  applyMatchForm(state.players, { winnerIds: winners, loserIds: losers, stats: o.playerStats! }, byId);
  recordMapComfort(byId, m.ctPlayerIds, m.tPlayerIds, state.maps[m.mapIndex ?? 0]?.name, o.winnerSide);
  recordMatchupCareers(state.careers, m);
  recordPeriodCareers(state, m);
}

// Simulate + fold one matchup on the current thread. Used for the single-match
// "Sim" button, where spinning up the worker pool isn't worth it. Handles series.
export function simOneMatchup(state: SimState, m: Matchup, byId?: Map<string, Player>): void {
  const index = byId ?? new Map(state.players.map(p => [p.id, p] as const));
  const o = simulateMatchup(m, index, state.maps);
  foldOutcome(state, m, o, index);
}

// ---- Matchup generation: region-locked, friendship-aware -----------------
//
// Players matchmake only within their own region. Within a region we let
// friends group up: strongly-bonded players (chemistry >= FRIEND_THRESHOLD)
// form a party that stays on one team, the rest of the slots are filled with
// the nearest-Elo solo players, and full 5-stacks are paired off by team Elo.
// Because teammates bond every time they play, the same parties tend to re-form
// day after day — emergent, self-reinforcing rosters.

// Optional persistent-team context. When supplied, generateMatchups routes full
// 5-man friend-stacks through the stack→org pipeline: recurring cliques accrue
// commitment in `stacks` and, once they clear the gate, crystallize into tracked
// `teams` whose matchup sides are tagged — the bridge from emergent rosters to
// standings/tournaments. `byId` resolves roster ambition for the gate.
export interface TeamContext {
  teams: UniverseTeam[];
  stacks: ProvisionalStack[];
  byId: Map<string, Player>;
  day: number;
}

// Look up (or create) the persistent team for a full 5-man stack, identified by
// its sorted roster. On a hit we refresh the team's roster order, elo, and
// last-played day; on a miss we mint a new named org (tier "org") and record its
// founding lineup. Returns its stable id.
export function crystallizeTeam(
  ctx: TeamContext, region: Region, playerIds: string[], elos: Record<string, number>,
): string {
  const sorted = [...playerIds].sort();
  const rosterKey = sorted.join(",");
  const elo = Math.round(playerIds.reduce((s, id) => s + (elos[id] ?? STARTING_ELO), 0) / playerIds.length);
  let team = ctx.teams.find(t => t.rosterKey === rosterKey);
  if (!team) {
    team = {
      id: `t${ctx.teams.length}_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
      name: generateTeamName(Math.random),
      region,
      country: ctx.byId.get(captainOf(playerIds, elos))?.country,
      playerIds: [...playerIds],
      rosterKey,
      tier: "org",
      rosterHistory: [{ day: ctx.day, playerIds: [...playerIds], note: "Founded" }],
      elo,
      foundedDay: ctx.day,
      lastPlayedDay: ctx.day,
      wins: 0, losses: 0, roundsWon: 0, roundsLost: 0, streak: 0,
    };
    ctx.teams.push(team);
  } else {
    team.playerIds = [...playerIds];
    team.elo = elo;
    team.lastPlayedDay = ctx.day;
    team.region = region;
    // The exact clique re-formed: revive a disbanded org rather than minting a
    // new identity, and reopen its roster history.
    if (team.disbandedDay !== undefined) {
      team.disbandedDay = undefined;
      (team.rosterHistory ??= []).push({ day: ctx.day, playerIds: [...playerIds], note: "Re-formed" });
    }
  }
  return team.id;
}

// The de facto captain of a roster: the highest-elo player (stable tiebreak by
// id). Used as the org founder, so the org takes their nationality.
export function captainOf(playerIds: string[], elos: Record<string, number>): string {
  return [...playerIds].sort((a, b) => {
    const d = (elos[b] ?? STARTING_ELO) - (elos[a] ?? STARTING_ELO);
    return d !== 0 ? d : a.localeCompare(b);
  })[0];
}

// Number of "driven" players (ambition >= DRIVEN_AMBITION) on a roster — the
// core that pushes a casual clique to take itself seriously.
function drivenCore(playerIds: string[], byId: Map<string, Player>): number {
  let n = 0;
  for (const id of playerIds) {
    if ((byId.get(id)?.ambition ?? 0) >= DRIVEN_AMBITION) n++;
  }
  return n;
}

// Resolve a full-5 friend clique to a tracked-org id, or undefined if it isn't
// (yet) an org. Already-crystallized rosters reuse their org. Otherwise the
// clique accrues commitment as a ProvisionalStack and only promotes — minting
// the org — once it clears the games-together + driven-core gate. Un-promoted
// cliques return undefined and play out as ordinary pickup lobbies.
export function resolveOrgSide(
  ctx: TeamContext, region: Region, playerIds: string[], elos: Record<string, number>,
): string | undefined {
  const rosterKey = [...playerIds].sort().join(",");
  if (ctx.teams.some(t => t.rosterKey === rosterKey)) {
    return crystallizeTeam(ctx, region, playerIds, elos); // existing org — refresh + reuse
  }

  let stack = ctx.stacks.find(s => s.rosterKey === rosterKey);
  if (!stack) {
    stack = {
      rosterKey, region, playerIds: [...playerIds],
      gamesTogether: 0, firstSeenDay: ctx.day, lastSeenDay: ctx.day,
    };
    ctx.stacks.push(stack);
  }
  stack.gamesTogether++;
  stack.lastSeenDay = ctx.day;
  stack.playerIds = [...playerIds];
  stack.region = region;

  const ready = stack.gamesTogether >= GAMES_TO_ORG
    && drivenCore(playerIds, ctx.byId) >= DRIVEN_CORE_SIZE;
  if (!ready) return undefined;

  // Promote: crystallize the org and retire the provisional record.
  const teamId = crystallizeTeam(ctx, region, playerIds, elos);
  ctx.stacks.splice(ctx.stacks.indexOf(stack), 1);
  return teamId;
}

export function generateMatchups(
  players: Player[], elos: Record<string, number>, mapCount: number, teamCtx?: TeamContext,
  excludeIds?: Set<string>,
): Matchup[] {
  const pool = Math.max(1, mapCount);
  const eloOf = (p: Player) => elos[p.id] ?? STARTING_ELO;

  // Partition the pool by competitive region — players only see their own scene.
  // Retired players stay in the pool (for their pages/careers) but never matchmake.
  // Players already committed to an active tournament sit out the daily ladder.
  const byRegion = new Map<Region, Player[]>();
  for (const p of players) {
    if (p.retired || excludeIds?.has(p.id)) continue;
    const r = regionOf(p.country);
    (byRegion.get(r) ?? byRegion.set(r, []).get(r)!).push(p);
  }

  const matchups: Matchup[] = [];
  let idx = 0;
  // Walk regions in canonical order so the matchup board groups consistently.
  for (const region of REGION_ORDER) {
    const inRegion = byRegion.get(region);
    if (!inRegion || inRegion.length < TEAM_SIZE * 2) continue; // can't field a lobby

    const teams = formTeams(inRegion, eloOf, !!teamCtx);
    // Pair teams by stack composition first, Elo second: a 3+2 lobby faces
    // another 3+2 (or a 2+2+1), a premade five faces a premade, solos face solos
    // — so a stacked side never stomps five randoms. Odd teams out sit the day.
    const pairings = pairTeams(teams, eloOf);

    // The strongest pairing plays a Bo3 "tournament" series — but only when it's
    // STRICTLY stronger than the runner-up (a tie at the top means no clear
    // headliner, so everyone plays Bo1) and the rotation has ≥3 maps for a
    // distinct map each game.
    pairings.sort((a, b) => b.elo - a.elo);
    const topIsSeries = pairings.length >= 2 && pairings[0].elo > pairings[1].elo && pool >= 3;

    pairings.forEach((pr, pi) => {
      const aStartsCt = Math.random() < 0.5;
      const ct = aStartsCt ? pr.a : pr.b;
      const t  = aStartsCt ? pr.b : pr.a;
      // Surface every friend-stack (2+ that queued together) in this lobby.
      const parties = [...ct.parties, ...t.parties];
      const series = pi === 0 && topIsSeries;
      // A side that fielded a full premade five enters the stack→org pipeline:
      // it's tagged (and its result folds into standings) only once it has
      // promoted to a tracked org; until then it plays as a pickup lobby.
      const ctTeamId = teamCtx && ct.parties.some(p => p.length === TEAM_SIZE)
        ? resolveOrgSide(teamCtx, region, ct.players.map(p => p.id), elos) : undefined;
      const tTeamId = teamCtx && t.parties.some(p => p.length === TEAM_SIZE)
        ? resolveOrgSide(teamCtx, region, t.players.map(p => p.id), elos) : undefined;
      matchups.push({
        id: `m${idx++}`,
        ctPlayerIds: ct.players.map(p => p.id),
        tPlayerIds:  t.players.map(p => p.id),
        status: "pending",
        // Bo1 picks its seed/map up front; a series assigns them per game at
        // sim time (each game has its own).
        ...(series ? { bestOf: 3 as const } : { seed: newSeed(), mapIndex: Math.floor(Math.random() * pool) }),
        region,
        ...(parties.length > 0 ? { parties } : {}),
        ...(ctTeamId ? { ctTeamId } : {}),
        ...(tTeamId ? { tTeamId } : {}),
      });
    });
  }
  return matchups;
}

// A formed 5-player team plus the friend-stacks that seeded it (each a clique of
// 2+ players who queued together; empty for teams built purely from solos). A
// team can carry more than one stack, e.g. a 3+2 or 2+2+1 lobby.
interface FormedTeam { players: Player[]; parties: string[][]; }

// Two partial stacks are only merged into one lineup when their average Elo is
// within this band, so grouping friends never builds a wildly mismatched five.
const STACK_ELO_BAND = 300;

// Build full 5-player teams out of a region's players, keeping friends together
// and grouping similar-size stacks so the lobby can later be matched against an
// equally stacked one.
//  1. Grow friendship cliques: anchor on the highest-Elo unassigned player and
//     repeatedly pull in their strongest available friend (bond >= threshold).
//  2. Premade five-stacks stand as their own teams.
//  3. Compose partial stacks into fives, preferring to pair a trio and a duo
//     (3+2) or stack two duos (2+2+1) of similar Elo before topping up with the
//     nearest-Elo solos.
//  4. Chunk any leftover solos into Elo-banded teams of 5.
// Players who can't fill a team sit out the day.
//
// When `recruit5th` is set (the persistent-team universe mode), a friendship
// clique that stalls one short of five with a driven member actively recruits
// its top-up solo INTO the party and seeds a bond — see step 3 — so the
// completed five re-forms the next day and can pursue org status. This mutates
// the recruit's and clique's relationships, so it's gated to that mode only.
function formTeams(
  regionPlayers: Player[], eloOf: (p: Player) => number, recruit5th = false,
): FormedTeam[] {
  const byEloDesc = [...regionPlayers].sort(
    (a, b) => eloOf(b) - eloOf(a) || a.id.localeCompare(b.id),
  );
  const used = new Set<string>();

  // 1. Friendship cliques.
  const cliques: Player[][] = [];
  for (const anchor of byEloDesc) {
    if (used.has(anchor.id)) continue;
    used.add(anchor.id);
    const party = [anchor];
    while (party.length < TEAM_SIZE) {
      let best: Player | null = null;
      let bestRel = FRIEND_THRESHOLD - 1; // must clear the friendship bar
      for (const cand of byEloDesc) {
        if (used.has(cand.id)) continue;
        // Strongest bond between the candidate and anyone already in the party.
        let rel = -Infinity;
        for (const m of party) rel = Math.max(rel, cand.relationships[m.id] ?? 0);
        if (rel > bestRel) { bestRel = rel; best = cand; }
      }
      if (!best) break;
      used.add(best.id);
      party.push(best);
    }
    cliques.push(party);
  }

  const avg = (g: Player[]) => avgOf(g, eloOf);
  const premades = cliques.filter(c => c.length === TEAM_SIZE);
  const stacks = cliques.filter(c => c.length >= 2 && c.length < TEAM_SIZE).sort((a, b) => avg(b) - avg(a));
  const solos = cliques.filter(c => c.length === 1).map(c => c[0])
    .sort((a, b) => eloOf(b) - eloOf(a) || a.id.localeCompare(b.id));

  const teams: FormedTeam[] = [];

  // 2. Premade five-stacks stand as their own teams.
  for (const p of premades) teams.push({ players: p, parties: [p.map(x => x.id)] });

  // 3. Compose partial stacks into fives, grouping similar-Elo stacks first.
  while (stacks.length > 0) {
    const anchor = stacks.shift()!;
    const members = [...anchor];
    const parts: Player[][] = [anchor];
    const target = avg(anchor);
    // Pull in compatible stacks (closest Elo within the band) before any solos,
    // so a free trio joins a duo (3+2) and duos stack up (2+2+1).
    for (let need = TEAM_SIZE - members.length; need > 0; need = TEAM_SIZE - members.length) {
      let bi = -1, bd = Infinity;
      for (let i = 0; i < stacks.length; i++) {
        if (stacks[i].length > need) continue;
        const d = Math.abs(avg(stacks[i]) - target);
        if (d < bd && d <= STACK_ELO_BAND) { bd = d; bi = i; }
      }
      if (bi < 0) break;
      const s = stacks.splice(bi, 1)[0];
      members.push(...s); parts.push(s);
    }
    // A 4-clique with at least one driven member recruits its fifth: the top-up
    // solo joins the clique's party (not just filler) and a bond is seeded, so
    // the completed five re-forms next day and accrues toward org status.
    const recruiting = recruit5th
      && anchor.length === TEAM_SIZE - 1   // the clique itself is four (not a 2+2)
      && parts.length === 1
      && members.length === TEAM_SIZE - 1
      && anchor.some(p => p.ambition >= DRIVEN_AMBITION);

    // Top up with the nearest-Elo solos.
    while (members.length < TEAM_SIZE && solos.length > 0) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < solos.length; i++) {
        const d = Math.abs(eloOf(solos[i]) - target);
        if (d < bd) { bd = d; bi = i; }
      }
      const recruit = solos.splice(bi, 1)[0];
      members.push(recruit);
      if (recruiting) {
        anchor.push(recruit); // promote the recruit into the party (parts[0] is anchor)
        for (const m of anchor) {
          if (m.id === recruit.id) continue;
          recruit.relationships[m.id] = Math.max(recruit.relationships[m.id] ?? 0, RECRUIT_BOND);
          m.relationships[recruit.id] = Math.max(m.relationships[recruit.id] ?? 0, RECRUIT_BOND);
        }
      }
    }
    if (members.length === TEAM_SIZE) teams.push({ players: members, parties: parts.map(g => g.map(x => x.id)) });
    // Under-filled (ran out of fitting stacks and solos): the stack sits the day.
  }

  // 4. Elo-banded teams from the remaining solos — no friend-stack.
  for (let i = 0; i + TEAM_SIZE <= solos.length; i += TEAM_SIZE) {
    teams.push({ players: solos.slice(i, i + TEAM_SIZE), parties: [] });
  }

  return teams;
}

function avgOf(team: Player[], eloOf: (p: Player) => number): number {
  return team.reduce((s, p) => s + eloOf(p), 0) / team.length;
}

// A lobby's stack makeup, used to match like against like:
//  premade — a full five-stack;  heavy — a trio+ or two-plus duos (3+2, 2+2+1,
//  4+1);  light — a single duo (2+1+1+1);  solo — five randoms.
type StackClass = "premade" | "heavy" | "light" | "solo";
function stackClass(parties: string[][]): StackClass {
  if (parties.some(p => p.length >= TEAM_SIZE)) return "premade";
  const big = parties.filter(p => p.length >= 2);
  if (big.some(p => p.length >= 3) || big.length >= 2) return "heavy";
  if (big.length === 1) return "light";
  return "solo";
}
const CLASS_ORDER: StackClass[] = ["premade", "heavy", "light", "solo"];

// Pair teams into matches, matching stack composition first and Elo second:
// within each stack class, sort by Elo and pair adjacent. The odd team out of
// each class spills into a cross-class pool paired by Elo, so a leftover 3+2 can
// still get a game (against the nearest 2+2+1 / duo) rather than sitting idle.
function pairTeams(
  teams: FormedTeam[], eloOf: (p: Player) => number,
): { a: FormedTeam; b: FormedTeam; elo: number }[] {
  const elo = (t: FormedTeam) => avgOf(t.players, eloOf);
  const mk = (a: FormedTeam, b: FormedTeam) => ({ a, b, elo: (elo(a) + elo(b)) / 2 });
  const byClass = new Map<StackClass, FormedTeam[]>();
  for (const t of teams) {
    const c = stackClass(t.parties);
    (byClass.get(c) ?? byClass.set(c, []).get(c)!).push(t);
  }
  const pairings: { a: FormedTeam; b: FormedTeam; elo: number }[] = [];
  const leftovers: FormedTeam[] = [];
  for (const c of CLASS_ORDER) {
    const list = (byClass.get(c) ?? []).sort((a, b) => elo(b) - elo(a));
    let i = 0;
    for (; i + 1 < list.length; i += 2) pairings.push(mk(list[i], list[i + 1]));
    if (i < list.length) leftovers.push(list[i]);
  }
  // Cross-class fallback for the odd teams out, nearest Elo together.
  leftovers.sort((a, b) => elo(b) - elo(a));
  for (let i = 0; i + 1 < leftovers.length; i += 2) pairings.push(mk(leftovers[i], leftovers[i + 1]));
  return pairings;
}

// ---- Career aggregates ----------------------------------------------------
// Lifetime totals are accumulated incrementally so we never have to replay the
// entire history to show a player's career. Each completed matchup is folded
// in exactly once (when it's simmed/played out), which lets us trim old days
// from history without losing any career figures.

// Fold a completed day's matchups into persistent-team records. Only matchups
// with BOTH sides tagged as tracked orgs (ctTeamId + tTeamId) count — pickup and
// scrim lobbies don't move team records. Must be called exactly once per matchup
// (at day roll-over), mirroring how careers are folded. `ctScore`/`tScore` hold
// the match (or series) result, so round diff uses them directly. Covers both
// ladder games and tournament games (any tagged org-vs-org result).
export function recordTeamResults(teams: UniverseTeam[], matchups: Matchup[]): void {
  const byId = new Map(teams.map(t => [t.id, t] as const));
  for (const m of matchups) {
    if (m.status !== "completed" || !m.ctTeamId || !m.tTeamId) continue;
    if (m.ctScore === undefined || m.tScore === undefined || !m.winnerSide) continue;
    const ct = byId.get(m.ctTeamId), t = byId.get(m.tTeamId);
    if (!ct || !t) continue;
    const ctWon = m.winnerSide === "CT";
    ct.roundsWon += m.ctScore; ct.roundsLost += m.tScore;
    t.roundsWon += m.tScore; t.roundsLost += m.ctScore;
    if (ctWon) { ct.wins++; t.losses++; } else { ct.losses++; t.wins++; }
    ct.streak = ctWon ? Math.max(1, ct.streak + 1) : Math.min(-1, ct.streak - 1);
    t.streak = ctWon ? Math.min(-1, t.streak - 1) : Math.max(1, t.streak + 1);
  }
}

export function emptyCareer(): CareerStats {
  return {
    played: 0, wins: 0, losses: 0, roundsWon: 0, roundsLost: 0,
    matchesWithStats: 0, kills: 0, deaths: 0, assists: 0, damage: 0, rounds: 0,
    k1: 0, k2: 0, k3: 0, k4: 0, k5: 0,
    clutchWins: [0, 0, 0, 0, 0], clutchAttempts: [0, 0, 0, 0, 0],
  };
}

// 1vX bucket for a clutch. Prefer the recorded opportunity size; fall back to
// kills for legacy clutches where only successful clutches were recorded.
export function clutchBucket(c: { kills: number; enemiesAtStart?: number; won?: boolean }): number {
  return c.enemiesAtStart ?? c.kills ?? 0;
}

// Fold one completed matchup into the running career totals for everyone who
// played in it. Must be called exactly once per matchup.
export function recordMatchupCareers(careers: Record<string, CareerStats>, m: Matchup) {
  if (m.status !== "completed") return;
  // A series folds in per game — each game counts as a match for career totals.
  if (m.games?.length) {
    for (const g of m.games) {
      recordMatchupCareers(careers, {
        id: m.id, status: "completed", ctPlayerIds: m.ctPlayerIds, tPlayerIds: m.tPlayerIds,
        ctScore: g.ctScore, tScore: g.tScore, winnerSide: g.winnerSide,
        clutches: g.clutches, playerStats: g.playerStats,
      });
    }
    return;
  }
  if (!m.winnerSide || m.ctScore === undefined || m.tScore === undefined) return;
  const sides = [
    { ids: m.ctPlayerIds, side: "CT" as const, own: m.ctScore, opp: m.tScore },
    { ids: m.tPlayerIds,  side: "T"  as const, own: m.tScore,  opp: m.ctScore },
  ];
  for (const { ids, side, own, opp } of sides) {
    const won = side === m.winnerSide;
    for (const id of ids) {
      const c = careers[id] ?? (careers[id] = emptyCareer());
      c.played++;
      if (won) c.wins++; else c.losses++;
      c.roundsWon += own;
      c.roundsLost += opp;
      const s = m.playerStats?.[id];
      if (s) {
        c.matchesWithStats++;
        c.kills += s.kills; c.deaths += s.deaths; c.assists += s.assists;
        c.damage += s.damage; c.rounds += s.roundsPlayed;
        c.k1 += s.k1; c.k2 += s.k2; c.k3 += s.k3; c.k4 += s.k4; c.k5 += s.k5;
      }
      // Clutch attempts/wins use the PER-CLUTCH outcome (survived + won that
      // round), not the match result — losing a 1v5 in a won match is still a
      // failed attempt. Legacy saves only stored successful clutches, so a
      // missing flag counts as a win.
      for (const cl of m.clutches ?? []) {
        if (cl.playerId !== id) continue;
        const b = Math.max(1, Math.min(5, clutchBucket(cl)));
        c.clutchAttempts[b - 1]++;
        if (cl.won ?? true) c.clutchWins[b - 1]++;
      }
    }
  }
}
