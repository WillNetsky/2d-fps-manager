// Pure universe simulation engine — no DOM, no class, no storage. Operates on a
// plain SimState so it can run on the main thread for a single match or inside a
// Web Worker for batch fast-forward (see universeSimWorker.ts). The UI layer
// (universeMode.ts) builds a SimState view over its live Universe, hands it to
// the worker, and merges the mutated state back when the worker returns.

import type { GameMap, Player } from "../domain/types.ts";
import { regionOf, REGION_ORDER, type Region } from "../domain/countries.ts";
import { buildTeam, simulateMatchInstant } from "./matchSim.ts";
import { applyMatchElo } from "./elo.ts";
import { applyMatchChemistry, decayRelationships, FRIEND_THRESHOLD } from "./chemistry.ts";
import { applyMatchForm } from "./form.ts";
import {
  STARTING_ELO, TEAM_SIZE,
  type CareerStats, type CompletedDay, type Matchup, type PendingDay,
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

// Simulate one pending matchup and fold the result into elo, chemistry, form,
// and career totals. Mutates `m` and the shared state in place. `byId` is an
// optional prebuilt id→player index; without it one is built from state.players
// (fine for a one-off single match, wasteful in a loop — pass one there).
export function simOneMatchup(state: SimState, m: Matchup, byId?: Map<string, Player>): void {
  const maps = state.maps;
  if (m.mapIndex === undefined || m.mapIndex >= maps.length) {
    m.mapIndex = Math.floor(Math.random() * maps.length);
  }
  const map = maps[m.mapIndex];
  if (m.seed === undefined) m.seed = newSeed();

  const index = byId ?? new Map(state.players.map(p => [p.id, p] as const));
  const ctPlayers = m.ctPlayerIds.map(id => index.get(id)!).filter(Boolean);
  const tPlayers  = m.tPlayerIds.map (id => index.get(id)!).filter(Boolean);
  const ctTeam = buildTeam("ct", "CT-side", ctPlayers, "CT");
  const tTeam  = buildTeam("t",  "T-side",  tPlayers,  "T");
  const result = simulateMatchInstant(ctTeam, tTeam, map, m.seed);

  m.status = "completed";
  m.ctScore = result.ctScore;
  m.tScore  = result.tScore;
  m.winnerSide = result.winnerSide;
  m.clutches = result.clutches;
  m.playerStats = result.playerStats;

  const winners = result.winnerSide === "CT" ? m.ctPlayerIds : m.tPlayerIds;
  const losers  = result.winnerSide === "CT" ? m.tPlayerIds  : m.ctPlayerIds;
  m.eloDelta = applyMatchElo(winners, losers, state.elos);
  applyMatchChemistry(state.players, { winnerIds: winners, loserIds: losers, stats: m.playerStats });
  applyMatchForm(state.players, { winnerIds: winners, loserIds: losers, stats: m.playerStats });
  recordMatchupCareers(state.careers, m);
}

// Sim every still-pending match in the current day, leaving the day in place
// (no roll). Used by "Sim all remaining".
export function simPendingDay(state: SimState): void {
  if (!state.pendingDay) return;
  const byId = new Map(state.players.map(p => [p.id, p] as const));
  for (const m of state.pendingDay.matchups) {
    if (m.status !== "completed") simOneMatchup(state, m, byId);
  }
}

// Fast-forward `nDays` days: ensure a pending day, sim all its matches, roll it
// into a completed day, decay relationships, advance the date. Always leaves a
// fresh pending day ready for the next interaction. Returns the days produced
// so the caller can archive them. `onDay(done)` fires after each day for
// progress reporting.
export function simulateDays(
  state: SimState,
  nDays: number,
  onDay?: (done: number) => void,
): { completedDays: CompletedDay[] } {
  const byId = new Map(state.players.map(p => [p.id, p] as const));
  const completedDays: CompletedDay[] = [];
  const mapCount = Math.max(1, state.maps.length);

  for (let i = 0; i < nDays; i++) {
    if (!state.pendingDay) {
      state.pendingDay = { day: state.day, matchups: generateMatchups(state.players, state.elos, mapCount) };
    }
    for (const m of state.pendingDay.matchups) {
      if (m.status !== "completed") simOneMatchup(state, m, byId);
    }
    completedDays.push({ day: state.pendingDay.day, matchups: state.pendingDay.matchups });
    decayRelationships(state.players); // bonds fade day-to-day without upkeep
    state.pendingDay = null;
    state.day++;
    onDay?.(i + 1);
  }

  // Drop a fresh pending day so the day view always has something to act on.
  if (!state.pendingDay) {
    state.pendingDay = { day: state.day, matchups: generateMatchups(state.players, state.elos, mapCount) };
  }
  return { completedDays };
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
    for (let i = 0; i + 1 < teams.length; i += 2) {
      const aStartsCt = Math.random() < 0.5;
      const ct = aStartsCt ? teams[i] : teams[i + 1];
      const t  = aStartsCt ? teams[i + 1] : teams[i];
      // Surface the friend-stacks (2+ that queued together) in this lobby.
      const parties = [ct.partyIds, t.partyIds].filter(p => p.length >= 2);
      matchups.push({
        id: `m${idx++}`,
        ctPlayerIds: ct.players.map(p => p.id),
        tPlayerIds:  t.players.map(p => p.id),
        status: "pending",
        seed: newSeed(),
        mapIndex: Math.floor(Math.random() * pool),
        region,
        ...(parties.length > 0 ? { parties } : {}),
      });
    }
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
  if (m.status !== "completed" || !m.winnerSide
      || m.ctScore === undefined || m.tScore === undefined) return;
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
