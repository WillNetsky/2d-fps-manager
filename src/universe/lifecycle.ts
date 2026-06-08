// Player lifecycle + roster moves — the layer that makes AI teams living orgs.
// Pure functions, no DOM and no storage (mirrors tournament.ts), so the engine
// can be unit-tested and driven from the season-rollover chokepoint in
// universeMode. Everything here fires ONCE PER SEASON: players age a year,
// ratings drift along a peak curve, veterans retire, youth come up to replace
// them, and orgs sign free agents to fill the holes retirement opens.
//
// The crux of roster continuity is chemistry: when an org signs a replacement we
// seed strong bonds between them and the surviving four, so the new five re-form
// as a clique in matchmaking (formTeams) the next day and resolveOrgSide matches
// the org back by its UPDATED rosterKey — the org keeps its id/identity while its
// lineup turns over.

import type { Player, PlayerStats } from "../domain/types.ts";
import { regionOf, REGION_ORDER, type Region } from "../domain/countries.ts";
import { makePlayer, generateManager } from "../domain/factory.ts";
import { generateTeamName } from "../domain/teamNames.ts";
import { FRIEND_THRESHOLD, seedCliqueBonds } from "./chemistry.ts";
import { signContract } from "./finance.ts";
import { refreshActiveRoster } from "./roster.ts";
import {
  STARTING_ELO, DISBAND_IDLE_DAYS, TEAM_SIZE, pickOrgColor,
  PRO_ORGS_PER_REGION, PRO_STARTING_BALANCE, type UniverseTeam,
} from "./types.ts";

// ---- Aging & rating drift -------------------------------------------------
//
// Stats age by category. Physical/aim peak early and decline; cognitive, mental,
// team and utility skills grow with experience and barely fade — so veterans get
// slower but smarter. Weapon preferences and the (unused) jiggle stat are left
// alone. Deltas are small per season but compound over a 15-season career.

type StatKey = keyof PlayerStats;

const PHYSICAL: StatKey[] = ["reflexes", "handSpeed", "movement", "flickAim", "counterStrafe"];
const AIM: StatKey[] = ["accuracy", "crosshairPlacement", "sprayControl", "tapping"];
const COGNITIVE: StatKey[] = ["mapAwareness", "positioning", "gameSense", "timing", "adaptability"];
const MENTAL: StatKey[] = ["composure", "aggression", "patience", "discipline", "recovery"];
const UTILITY: StatKey[] = ["utility", "smokeLineups", "flashTiming", "molotovUse"];
const TEAM: StatKey[] = ["igl", "communication"];

// Per-season delta for a category at a given age. Positive = improving.
function physicalDelta(age: number): number {
  if (age <= 20) return 2.0;   // late development
  if (age <= 24) return 0.5;
  if (age <= 27) return 0;     // plateau
  if (age <= 30) return -1.5;
  if (age <= 33) return -3.0;
  return -5.0;                 // steep veteran decline
}
function aimDelta(age: number): number {
  if (age <= 21) return 2.0;
  if (age <= 27) return 0.3;   // long peak
  if (age <= 30) return -0.8;
  if (age <= 33) return -2.0;
  return -3.5;
}
// Experience skills: grow through the late 20s, fade very slowly.
function experienceDelta(age: number): number {
  if (age <= 20) return 2.5;
  if (age <= 26) return 1.2;
  if (age <= 30) return 0.4;
  if (age <= 34) return -0.3;
  return -1.0;
}
// Mental/temperament: steady growth, near-flat in the veteran years.
function mentalDelta(age: number): number {
  if (age <= 20) return 1.5;
  if (age <= 28) return 0.6;
  if (age <= 34) return 0.1;
  return -0.5;
}

function clampStat(v: number): number {
  return Math.max(1, Math.min(100, v));
}

// Age every active player a year and drift their ratings. Stats are stored as
// floats here (sub-1 deltas matter over a career); UI rounds for display.
export function advancePlayerCareers(players: Player[], rng: () => number = Math.random): void {
  for (const p of players) {
    if (p.retired) continue;
    p.age += 1;
    const jitter = () => (rng() * 2 - 1) * 0.5; // ±0.5 so cohorts don't move in lockstep
    const apply = (keys: StatKey[], delta: number) => {
      for (const k of keys) p.stats[k] = clampStat(p.stats[k] + delta + jitter());
    };
    apply(PHYSICAL, physicalDelta(p.age));
    apply(AIM, aimDelta(p.age));
    apply(COGNITIVE, experienceDelta(p.age));
    apply(TEAM, experienceDelta(p.age) * 0.8);
    apply(UTILITY, experienceDelta(p.age) * 0.6);
    apply(MENTAL, mentalDelta(p.age));
  }
}

// ---- Retirement -----------------------------------------------------------

// Annual retirement probability. Effectively zero before 30, then ramps with
// age; high-elo stars hang on longer. Age 40 is a hard cap (chance >= 1).
function retireChance(age: number, elo: number): number {
  if (age < 30) return 0;
  const base = (age - 30) * 0.1;                       // 30→0, 35→0.5, 40→1.0
  const star = Math.max(0, Math.min(1, (elo - STARTING_ELO) / 600)); // 0..1
  return base * (1 - 0.5 * star);                      // stars retire up to ~half as often
}

// Roll retirement for every active player. Marks the retirees in place and
// returns their ids grouped by region (so youth intake can backfill per scene).
export function rollRetirements(
  players: Player[], elos: Record<string, number>, day: number, rng: () => number = Math.random,
): Map<Region, number> {
  const retiredByRegion = new Map<Region, number>();
  for (const p of players) {
    if (p.retired) continue;
    const chance = retireChance(p.age, elos[p.id] ?? STARTING_ELO);
    if (chance <= 0) continue;
    if (rng() < chance) {
      p.retired = true;
      p.retiredDay = day;
      const r = regionOf(p.country);
      retiredByRegion.set(r, (retiredByRegion.get(r) ?? 0) + 1);
    }
  }
  return retiredByRegion;
}

// ---- Youth intake ---------------------------------------------------------

// Mint fresh prospects to replace this season's retirees, one-for-one per region
// so each scene's active headcount holds steady. New players debut young and at
// the baseline elo — they earn their rating from results like anyone else.
export function replenishYouth(
  players: Player[], elos: Record<string, number>,
  retiredByRegion: Map<Region, number>, rng: () => number = Math.random,
): Player[] {
  const youth: Player[] = [];
  for (const region of REGION_ORDER) {
    const n = retiredByRegion.get(region) ?? 0;
    for (let i = 0; i < n; i++) {
      const p = makePlayer(region);
      p.age = 16 + Math.floor(rng() * 4); // 16..19
      elos[p.id] = STARTING_ELO;
      players.push(p);
      youth.push(p);
    }
  }
  return youth;
}

// ---- Org roster reconciliation --------------------------------------------

// Average elo of a set of players (the org's target level when shopping).
function avgElo(ids: string[], elos: Record<string, number>): number {
  if (ids.length === 0) return STARTING_ELO;
  return ids.reduce((s, id) => s + (elos[id] ?? STARTING_ELO), 0) / ids.length;
}

// Seed a strong mutual bond between a new signing and each surviving roster
// member, so matchmaking re-forms them as a clique and the org carries on.
const SIGNING_BOND = FRIEND_THRESHOLD + 15;
function bondInto(newcomer: Player, roster: Player[]): void {
  for (const m of roster) {
    if (m.id === newcomer.id) continue;
    newcomer.relationships[m.id] = Math.max(newcomer.relationships[m.id] ?? 0, SIGNING_BOND);
    m.relationships[newcomer.id] = Math.max(m.relationships[newcomer.id] ?? 0, SIGNING_BOND);
  }
}

// Fill the holes retirement opened on every org: release retirees, sign the
// best-fitting free agent in-region, seed chemistry so the signing sticks, and
// log the move. The org keeps its id/name/record across the change. Must run
// AFTER retirements are marked and youth are generated (so a free agent exists).
export function reconcileOrgRosters(
  teams: UniverseTeam[], players: Player[], elos: Record<string, number>, day: number,
  rng: () => number = Math.random,
): void {
  const byId = new Map(players.map(p => [p.id, p] as const));
  // Players already committed to an org — never poach from another org's roster.
  const onOrg = new Set<string>();
  for (const t of teams) for (const id of t.playerIds) onOrg.add(id);

  for (const team of teams) {
    if (team.disbandedDay) continue; // dead org — don't sign for it
    const retirees = team.playerIds.filter(id => byId.get(id)?.retired);
    if (retirees.length === 0) continue;

    for (const retireeId of retirees) {
      const survivors = team.playerIds.filter(id => id !== retireeId && !byId.get(id)?.retired);
      const target = avgElo(survivors, elos);

      // Free agent: same region, active, not on any org. Closest to the org's
      // level wins, lightly weighted toward ambition (driven players join orgs).
      let best: Player | null = null;
      let bestScore = Infinity;
      for (const p of players) {
        if (p.retired || onOrg.has(p.id)) continue;
        if (regionOf(p.country) !== team.region) continue;
        const eloGap = Math.abs((elos[p.id] ?? STARTING_ELO) - target);
        const ambitionPull = (p.ambition - 50) * 1.5; // up to ±75 elo-equivalent
        const tiebreak = rng() * 10;                   // small jitter so ties don't bias by id
        const score = eloGap - ambitionPull + tiebreak;
        if (score < bestScore) { bestScore = score; best = p; }
      }
      if (!best) {
        // No free agent (shouldn't happen after youth intake): drop the retiree
        // anyway. The org plays short / dormant until it re-forms — rare.
        team.playerIds = survivors;
        continue;
      }

      const retiree = byId.get(retireeId);
      const signing = best;
      onOrg.add(signing.id);
      team.playerIds = [...survivors, signing.id];
      bondInto(signing, survivors.map(id => byId.get(id)!).filter(Boolean));

      (team.rosterHistory ??= []).push({
        day,
        playerIds: [...team.playerIds],
        note: `Signed ${signing.handle}${retiree ? `, ${retiree.handle} retired` : ""}`,
      });
    }

    // Refresh the org's identity fields to the new lineup.
    team.rosterKey = [...team.playerIds].sort().join(",");
    team.elo = Math.round(avgElo(team.playerIds, elos));
  }
}

// ---- Org dissolution ------------------------------------------------------

// Disband orgs that have gone cold: idle past DISBAND_IDLE_DAYS AND with a fully
// decayed clique (no two current members still bonded at FRIEND_THRESHOLD). A
// disbanded org is frozen — invitees, rankings, and "current team" lookups skip
// it — but its record/history is kept. A closing roster-history entry records
// the departure so a player's team history shows the stint as ended, not current.
// Returns the count disbanded. Runs alongside the season lifecycle.
export function disbandStaleOrgs(teams: UniverseTeam[], players: Player[], day: number): number {
  const byId = new Map(players.map(p => [p.id, p] as const));
  let disbanded = 0;
  for (const team of teams) {
    if (team.disbandedDay) continue;
    if (day - team.lastPlayedDay < DISBAND_IDLE_DAYS) continue;
    const ids = team.playerIds;
    let stillBonded = false;
    outer: for (const a of ids) {
      const pa = byId.get(a);
      if (!pa) continue;
      for (const b of ids) {
        if (a === b) continue;
        if ((pa.relationships[b] ?? 0) >= FRIEND_THRESHOLD) { stillBonded = true; break outer; }
      }
    }
    if (stillBonded) continue;
    team.disbandedDay = day;
    (team.rosterHistory ??= []).push({ day, playerIds: [], note: "Disbanded" });
    disbanded++;
  }
  return disbanded;
}

// ---- Top-down pro orgs -----------------------------------------------------

// Unlike grassroots orgs (which crystallize from a friend-stack and start broke),
// a pro org is founded top-down: a backed club with a big balance and a hired
// manager, but no roster — it signs the best available free agents to field a
// five. Each season we top every region up to PRO_ORGS_PER_REGION such clubs,
// provided enough free agents exist to build a competitive lineup. Returns the
// orgs founded.
export function spawnProOrgs(
  teams: UniverseTeam[], players: Player[], elos: Record<string, number>, day: number,
  rng: () => number = Math.random,
): UniverseTeam[] {
  const onOrg = new Set<string>();
  for (const t of teams) if (!t.disbandedDay) for (const id of t.playerIds) onOrg.add(id);

  const founded: UniverseTeam[] = [];
  const eloOf = (id: string) => elos[id] ?? STARTING_ELO;
  for (const region of REGION_ORDER) {
    let count = teams.filter(t => !t.disbandedDay && t.tier === "pro" && t.region === region).length;
    while (count < PRO_ORGS_PER_REGION) {
      const fas = players
        .filter(p => !p.retired && !onOrg.has(p.id) && regionOf(p.country) === region)
        .sort((a, b) => eloOf(b.id) - eloOf(a.id));
      if (fas.length < 3) break; // not enough talent free to build on
      const signed = fas.slice(0, TEAM_SIZE);
      const ids = signed.map(p => p.id);
      const id = `t${teams.length}_${Date.now().toString(36)}${Math.floor(rng() * 1e4).toString(36)}`;
      const manager = generateManager(region, day);
      const team: UniverseTeam = {
        id,
        name: generateTeamName(rng),
        region,
        color: pickOrgColor(id),
        country: manager.country,
        manager,
        playerIds: [...ids],
        activeIds: [...ids],
        rosterKey: [...ids].sort().join(","),
        tier: "pro",
        rosterHistory: [{ day, playerIds: [...ids], note: "Founded (pro)" }],
        elo: Math.round(ids.reduce((s, x) => s + eloOf(x), 0) / ids.length),
        foundedDay: day,
        lastPlayedDay: day,
        wins: 0, losses: 0, roundsWon: 0, roundsLost: 0, streak: 0,
        balance: PRO_STARTING_BALANCE,
        earnings: 0,
      };
      for (const p of signed) { signContract(p, day, rng); onOrg.add(p.id); }
      seedCliqueBonds(signed, FRIEND_THRESHOLD + 15);
      refreshActiveRoster(team, elos);
      teams.push(team);
      founded.push(team);
      count++;
    }
  }
  return founded;
}

// ---- Orchestration --------------------------------------------------------

export interface LifecycleSummary {
  retired: number;
  debuted: number;
  disbanded: number;
  proOrgsFounded: number;
}

// Run a full season's lifecycle: age + drift, retire, replenish, reconcile orgs.
// Order matters — retirements must be marked before youth/roster moves so the
// holes are visible and a free-agent pool exists when orgs go shopping.
export function runSeasonLifecycle(
  players: Player[], elos: Record<string, number>, teams: UniverseTeam[], day: number,
  rng: () => number = Math.random,
): LifecycleSummary {
  advancePlayerCareers(players, rng);
  const retiredByRegion = rollRetirements(players, elos, day, rng);
  const youth = replenishYouth(players, elos, retiredByRegion, rng);
  reconcileOrgRosters(teams, players, elos, day, rng);
  const disbanded = disbandStaleOrgs(teams, players, day);
  const proOrgsFounded = spawnProOrgs(teams, players, elos, day, rng).length;
  let retired = 0;
  for (const n of retiredByRegion.values()) retired += n;
  return { retired, debuted: youth.length, disbanded, proOrgsFounded };
}
