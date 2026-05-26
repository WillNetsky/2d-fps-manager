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
  STARTING_ELO, TEAM_SIZE,
  type CareerStats, type Clutch, type GameResult, type Matchup, type PendingDay, type PlayerMatchStats,
} from "./types.ts";

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

// Phase A map selection for a series: distinct maps in random order. (Phase C
// replaces this with a preference-driven CS pick/ban veto.) The series length
// is gated to the pool size at matchmaking, so we always have enough.
function chooseSeriesMaps(maps: GameMap[], bestOf: number): number[] {
  const idxs = maps.map((_, i) => i);
  for (let i = idxs.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idxs[i], idxs[j]] = [idxs[j], idxs[i]];
  }
  return idxs.slice(0, Math.min(bestOf, idxs.length));
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
  const mapOrder = chooseSeriesMaps(maps, bestOf);
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
  return { id: m.id, winnerSide: ctWon > tWon ? "CT" : "T", ctScore: ctWon, tScore: tWon, games };
}

// Fold one game's result into elo, chemistry, form, and career totals. Per the
// per-game model, each game of a series is folded exactly like a standalone Bo1.
function foldGame(state: SimState, ctIds: string[], tIds: string[], g: GameResult, byId: Map<string, Player>): number {
  const winners = g.winnerSide === "CT" ? ctIds : tIds;
  const losers  = g.winnerSide === "CT" ? tIds  : ctIds;
  const delta = applyMatchElo(winners, losers, state.elos);
  applyMatchChemistry(state.players, { winnerIds: winners, loserIds: losers, stats: g.playerStats }, byId);
  applyMatchForm(state.players, { winnerIds: winners, loserIds: losers, stats: g.playerStats }, byId);
  // Per-game career fold: a game looks like a completed Bo1 match for tallying.
  recordMatchupCareers(state.careers, {
    id: "", status: "completed", ctPlayerIds: ctIds, tPlayerIds: tIds,
    ctScore: g.ctScore, tScore: g.tScore, winnerSide: g.winnerSide,
    clutches: g.clutches, playerStats: g.playerStats,
  });
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
  recordMatchupCareers(state.careers, m);
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

export function generateMatchups(players: Player[], elos: Record<string, number>, mapCount: number): Matchup[] {
  const pool = Math.max(1, mapCount);
  const eloOf = (p: Player) => elos[p.id] ?? STARTING_ELO;
  const avgElo = (team: Player[]) => team.reduce((s, p) => s + eloOf(p), 0) / team.length;

  // Partition the pool by competitive region — players only see their own scene.
  const byRegion = new Map<Region, Player[]>();
  for (const p of players) {
    const r = regionOf(p.country);
    (byRegion.get(r) ?? byRegion.set(r, []).get(r)!).push(p);
  }

  const matchups: Matchup[] = [];
  let idx = 0;
  // Walk regions in canonical order so the matchup board groups consistently.
  for (const region of REGION_ORDER) {
    const inRegion = byRegion.get(region);
    if (!inRegion || inRegion.length < TEAM_SIZE * 2) continue; // can't field a lobby

    const teams = formTeams(inRegion, eloOf);
    // Pair adjacent teams by Elo so each matchup is between similar-strength
    // 5-stacks. An odd team out sits the day.
    teams.sort((a, b) => avgElo(b.players) - avgElo(a.players));
    const pairings = [];
    for (let i = 0; i + 1 < teams.length; i += 2) {
      const a = teams[i], b = teams[i + 1];
      pairings.push({ a, b, elo: (avgElo(a.players) + avgElo(b.players)) / 2 });
    }

    // The region's top pairing plays a Bo3 "tournament" series — but only when
    // it's STRICTLY stronger than the runner-up (a tie at the top means no clear
    // headliner, so everyone plays Bo1) and the rotation has ≥3 maps for a
    // distinct map each game.
    const topIsSeries = pairings.length >= 2 && pairings[0].elo > pairings[1].elo && pool >= 3;

    pairings.forEach((pr, pi) => {
      const aStartsCt = Math.random() < 0.5;
      const ct = aStartsCt ? pr.a : pr.b;
      const t  = aStartsCt ? pr.b : pr.a;
      // Surface the friend-stacks (2+ that queued together) in this lobby.
      const parties = [ct.partyIds, t.partyIds].filter(p => p.length >= 2);
      const series = pi === 0 && topIsSeries;
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
      });
    });
  }
  return matchups;
}

// A formed 5-player team plus the friend-stack that seeded it (player ids of
// the 2+ clique that queued together; empty for teams built purely from solos).
interface FormedTeam { players: Player[]; partyIds: string[]; }

// Build full 5-player teams out of a region's players, keeping friends together.
//  1. Grow friendship cliques: anchor on the highest-Elo unassigned player and
//     repeatedly pull in their strongest available friend (bond >= threshold).
//  2. Fill each multi-player party up to 5 with the nearest-Elo solo players.
//  3. Chunk any leftover solos into Elo-banded teams of 5.
// Players who don't fit a full team sit out the day.
function formTeams(regionPlayers: Player[], eloOf: (p: Player) => number): FormedTeam[] {
  const byEloDesc = [...regionPlayers].sort(
    (a, b) => eloOf(b) - eloOf(a) || a.id.localeCompare(b.id),
  );
  const used = new Set<string>();

  // 1. Friendship cliques.
  const parties: Player[][] = [];
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
    parties.push(party);
  }

  const solos = parties
    .filter(p => p.length === 1)
    .map(p => p[0])
    .sort((a, b) => eloOf(b) - eloOf(a) || a.id.localeCompare(b.id));
  const groups = parties
    .filter(p => p.length >= 2)
    .sort((a, b) => avgOf(b, eloOf) - avgOf(a, eloOf));

  const teams: FormedTeam[] = [];

  // 2. Fill each real party up to 5 with the nearest-Elo solos. The original
  //    clique members are the team's friend-stack.
  for (const g of groups) {
    const team = [...g];
    const target = avgOf(g, eloOf);
    while (team.length < TEAM_SIZE && solos.length > 0) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < solos.length; i++) {
        const d = Math.abs(eloOf(solos[i]) - target);
        if (d < bd) { bd = d; bi = i; }
      }
      team.push(solos.splice(bi, 1)[0]);
    }
    if (team.length === TEAM_SIZE) teams.push({ players: team, partyIds: g.map(p => p.id) });
    // Under-filled (ran out of solos): party sits the day.
  }

  // 3. Elo-banded teams from the remaining solos — no friend-stack.
  for (let i = 0; i + TEAM_SIZE <= solos.length; i += TEAM_SIZE) {
    teams.push({ players: solos.slice(i, i + TEAM_SIZE), partyIds: [] });
  }

  return teams;
}

function avgOf(team: Player[], eloOf: (p: Player) => number): number {
  return team.reduce((s, p) => s + eloOf(p), 0) / team.length;
}

// ---- Career aggregates ----------------------------------------------------
// Lifetime totals are accumulated incrementally so we never have to replay the
// entire history to show a player's career. Each completed matchup is folded
// in exactly once (when it's simmed/played out), which lets us trim old days
// from history without losing any career figures.

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
