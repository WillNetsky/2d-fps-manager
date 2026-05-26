import type { GameMap, Player, RoundResult, Side, Team } from "../domain/types.ts";
import { defaultPistol } from "../domain/weapons.ts";
import { RoundSim } from "../sim/round.ts";
import { applyRoundReward } from "../sim/economy.ts";
import { aiBuyFor } from "../sim/aiBuy.ts";
import type { Clutch, PlayerMatchStats } from "./types.ts";

export interface MatchResult {
  ctScore: number;
  tScore: number;
  winnerSide: "CT" | "T";
  clutches: Clutch[];
  playerStats: Record<string, PlayerMatchStats>;
  // Per-round outcomes (only populated by simulateMatchInstant; replay UI
  // uses this to render the timeline up front).
  roundOutcomes?: RoundOutcome[];
}

export interface RoundOutcome {
  round: number;
  winnerSide: "CT" | "T";
  durationMs: number;
  ctScoreAfter: number;
  tScoreAfter: number;
}

// Tiny, self-contained 32-bit RNG. Two RNGs with the same seed produce the
// same stream — that's the whole point: a single saved seed reproduces the
// entire match.
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Per-round, increment the appropriate multi-kill bucket (k1..k5) for every
// player who got at least one kill in the round's events.
export function tallyMultiKills(r: RoundResult, acc: Map<string, [number, number, number, number, number]>) {
  const perPlayer = new Map<string, number>();
  for (const ev of r.events) {
    if (ev.kind !== "kill") continue;
    perPlayer.set(ev.killer, (perPlayer.get(ev.killer) ?? 0) + 1);
  }
  for (const [id, k] of perPlayer) {
    if (k < 1) continue;
    const slot = Math.min(k, 5) - 1;
    const cur = acc.get(id) ?? [0, 0, 0, 0, 0];
    cur[slot]++;
    acc.set(id, cur);
  }
}

// Merge per-team match stats with the multi-kill accumulator into a flat
// playerId → PlayerMatchStats map covering both teams.
export function buildPlayerStats(
  ct: Team, t: Team,
  multi: Map<string, [number, number, number, number, number]>,
): Record<string, PlayerMatchStats> {
  const out: Record<string, PlayerMatchStats> = {};
  for (const team of [ct, t]) {
    for (const p of team.players) {
      const ms = team.matchStats[p.id];
      const mk = multi.get(p.id) ?? [0, 0, 0, 0, 0];
      out[p.id] = {
        kills: ms?.kills ?? 0,
        deaths: ms?.deaths ?? 0,
        assists: ms?.assists ?? 0,
        damage: ms?.damage ?? 0,
        roundsPlayed: ms?.roundsPlayed ?? 0,
        k1: mk[0], k2: mk[1], k3: mk[2], k4: mk[3], k5: mk[4],
      };
    }
  }
  return out;
}

// Inspect a finished round and return a clutch attempt for EACH side that was
// reduced to a lone survivor, with X = enemies remaining the moment that player
// became last alive, the kills they got during it, and whether they converted.
//
// Tracking both sides is what makes 1v1s real: when a round trades down to a
// 1v1, the FIRST player to be last alive faced 2+ (a 1vX), but the SECOND faced
// exactly 1 — a genuine 1v1, won by the survivor and lost by the other. The old
// single-clutcher version only ever saw the first, so the 1v1 bucket could
// never fill. Returns [] only if neither team dropped to one alive.
export function detectClutch(r: RoundResult, ctIds: string[], tIds: string[]): Clutch[] {
  const ctSet = new Set(ctIds);
  const tSet = new Set(tIds);
  const aliveCt = new Set(ctIds);
  const aliveT = new Set(tIds);
  type Stand = { id: string; side: Side; kills: number; enemiesAtStart: number; died: boolean };
  let ct: Stand | null = null;
  let t: Stand | null = null;

  for (const ev of r.events) {
    if (ev.kind !== "kill") continue;

    if (aliveCt.has(ev.victim)) aliveCt.delete(ev.victim);
    else if (aliveT.has(ev.victim)) aliveT.delete(ev.victim);

    // First time each side drops to its last survivor, lock in that player and
    // how many enemies they were facing at that moment.
    if (!ct && aliveCt.size === 1) ct = { id: [...aliveCt][0], side: "CT", kills: 0, enemiesAtStart: aliveT.size, died: false };
    if (!t && aliveT.size === 1) t = { id: [...aliveT][0], side: "T", kills: 0, enemiesAtStart: aliveCt.size, died: false };

    // Kills each clutcher landed on the opposing side after becoming last alive.
    if (ct && ev.killer === ct.id && tSet.has(ev.victim)) ct.kills++;
    if (t && ev.killer === t.id && ctSet.has(ev.victim)) t.kills++;
    if (ct && ev.victim === ct.id) ct.died = true;
    if (t && ev.victim === t.id) t.died = true;
  }

  const out: Clutch[] = [];
  const record = (s: Stand | null, ids: string[], aliveSet: Set<string>) => {
    if (!s || s.enemiesAtStart < 1) return;
    // Sanity guard against truncated rosters: the side must genuinely have lost
    // all but one (N-1 teammate deaths on the kill stream).
    const teammateDeaths = r.events.filter(e =>
      e.kind === "kill" && (s.side === "CT" ? ctSet : tSet).has(e.victim)).length;
    if (teammateDeaths < ids.length - 1 || aliveSet.size > 1) return;
    // Won iff their side won the round and they survived — losing the round or
    // dying (e.g. bomb detonates) is a missed opportunity.
    out.push({ playerId: s.id, kills: s.kills, enemiesAtStart: s.enemiesAtStart, won: !s.died && s.side === r.winningSide });
  };
  record(ct, ctIds, aliveCt);
  record(t, tIds, aliveT);
  return out;
}

const STARTING_BANK = 800;
const HALFTIME_ROUND = 12;
const WIN_THRESHOLD = 13;
const MAX_ROUNDS = 24;
// Overtime: MR3 blocks (6 rounds, 3 per side), first to OT_WIN takes the match;
// a tied (3-3) block goes to another OT. Each OT half is a full-buy reset.
const OT_HALF_ROUNDS = 3;
const OT_WIN = 4;
const OT_BANK = 10000;
const OT_MAX_BLOCKS = 20; // safety cap against an unending tie
const isPistolRound = (n: number): boolean => n === 1 || n === HALFTIME_ROUND + 1;

// When ROUND `r` is about to start, does it begin a new side/economy, and with
// what starting bank? Regulation swaps once at halftime; overtime swaps every
// OT_HALF_ROUNDS rounds (each OT half is a full-buy reset). Returns null when the
// round just continues the current side. Shared by the instant sim and the
// observe/replay loop so they stay perfectly in lockstep.
function swapBankFor(r: number): number | null {
  if (r === HALFTIME_ROUND + 1) return STARTING_BANK;
  if (r > MAX_ROUNDS && (r - (MAX_ROUNDS + 1)) % OT_HALF_ROUNDS === 0) return OT_BANK;
  return null;
}

// Is the match decided after `roundsPlayed` rounds at this score? Regulation is
// first to WIN_THRESHOLD within MAX_ROUNDS; a 12-12 tie goes to overtime, where
// the bar rises by OT_HALF_ROUNDS each MR3 block (16, then 19, ...) — the first
// team to OT_WIN rounds in a block wins, and a tied block plays another OT.
function matchDecided(ctWins: number, tWins: number, roundsPlayed: number): boolean {
  if (roundsPlayed < MAX_ROUNDS) return ctWins >= WIN_THRESHOLD || tWins >= WIN_THRESHOLD;
  if (roundsPlayed === MAX_ROUNDS) return ctWins !== tWins; // not 12-12 ⇒ already won; 12-12 ⇒ OT
  const block = Math.floor((roundsPlayed - MAX_ROUNDS - 1) / (OT_HALF_ROUNDS * 2));
  const threshold = (WIN_THRESHOLD - 1) + OT_WIN + OT_HALF_ROUNDS * block;
  return ctWins >= threshold || tWins >= threshold;
}

export function buildTeam(id: string, name: string, players: Player[], side: Side, moodOverride?: Record<string, number>): Team {
  // Deep-clone the players so the universe's canonical Player objects aren't
  // mutated by per-match state (money, mood drift, matchStats, etc.).
  const cloned: Player[] = players.map(p => ({
    ...p,
    relationships: { ...p.relationships },
    stats: { ...p.stats },
    money: STARTING_BANK,
    // Start the match's in-the-moment mood at the player's persistent form
    // (morale), so a hot streak or a tilt carries into how they shoot. Mood
    // then swings round-to-round on the clone and is discarded after. A replay
    // passes the snapshotted sim-time morale so it reproduces the exact match
    // even after the player's live morale has drifted.
    mood: moodOverride?.[p.id] ?? p.morale,
  }));
  return {
    id, name, side,
    players: cloned,
    roundsWon: 0,
    loadouts: Object.fromEntries(cloned.map(p => [p.id, {
      weapon: defaultPistol(side), utility: [], armor: false, helmet: false,
      keptWeapon: null, keptArmor: false, keptHelmet: false, keptUtility: [],
    }])),
    matchStats: Object.fromEntries(cloned.map(p => [p.id, { kills: 0, deaths: 0, assists: 0, damage: 0, roundsPlayed: 0 }])),
  };
}

// Headless: simulate a full MR12 match instantly. No rendering. Returns the
// final score. Mutates the team objects but they're already match-scoped
// (created by buildTeam, which clones the underlying player data).
export function simulateMatchInstant(ct: Team, t: Team, map: GameMap, seed: number): MatchResult {
  let homeCtTeam = ct;     // tracks which roster is currently on CT side
  let homeTteam = t;
  let lossStreaks = { ctLossStreak: 0, tLossStreak: 0 };
  let roundNumber = 1;
  const clutches: Clutch[] = [];
  const multi = new Map<string, [number, number, number, number, number]>();
  const masterRng = mulberry32(seed);
  const intFrom = () => Math.floor(masterRng() * 0x100000000);
  const roundOutcomes: RoundOutcome[] = [];

  // Swap which roster is on which side, and reset both teams' economy to `bank`
  // with fresh pistol loadouts (used at the regulation halftime and each OT half).
  const swapAndReset = (bank: number) => {
    [homeCtTeam, homeTteam] = [homeTteam, homeCtTeam];
    homeCtTeam.side = "CT";
    homeTteam.side = "T";
    for (const team of [homeCtTeam, homeTteam]) {
      for (const p of team.players) {
        p.money = bank;
        team.loadouts[p.id] = {
          weapon: defaultPistol(team.side), utility: [], armor: false, helmet: false,
          keptWeapon: null, keptArmor: false, keptHelmet: false, keptUtility: [],
        };
      }
    }
    lossStreaks = { ctLossStreak: 0, tLossStreak: 0 };
  };

  // Play the current round to completion and fold its result in. Returns false
  // only if the sim failed to produce a result (defensive). roundNumber is
  // advanced by the caller.
  const playRound = (): boolean => {
    aiBuyFor(homeCtTeam, roundNumber, isPistolRound, mulberry32(intFrom()));
    aiBuyFor(homeTteam, roundNumber, isPistolRound, mulberry32(intFrom()));
    const sim = new RoundSim(homeCtTeam, homeTteam, map, intFrom());
    let safety = 100000;
    while (!sim.finished && safety-- > 0) sim.tick();
    if (!sim.result) return false;
    const r = sim.result;
    const winner = r.winningSide === "CT" ? homeCtTeam : homeTteam;
    winner.roundsWon++;
    for (const c of detectClutch(r, homeCtTeam.players.map(p => p.id), homeTteam.players.map(p => p.id))) {
      clutches.push({ ...c, round: roundNumber });
    }
    tallyMultiKills(r, multi);
    roundOutcomes.push({
      round: roundNumber,
      winnerSide: r.winningSide,
      durationMs: sim.t,
      ctScoreAfter: ct.roundsWon,
      tScoreAfter: t.roundsWon,
    });
    lossStreaks = applyRoundReward(homeCtTeam, homeTteam, r, lossStreaks.ctLossStreak, lossStreaks.tLossStreak);
    carryOverLoadouts(homeCtTeam, sim);
    carryOverLoadouts(homeTteam, sim);
    return true;
  };

  // Play rounds until the match is decided (regulation or overtime). Side/
  // economy swaps follow the shared schedule so a replay can mirror it exactly.
  const hardCap = MAX_ROUNDS + OT_MAX_BLOCKS * OT_HALF_ROUNDS * 2;
  while (!matchDecided(ct.roundsWon, t.roundsWon, roundNumber - 1) && roundNumber <= hardCap) {
    const bank = swapBankFor(roundNumber);
    if (bank !== null) swapAndReset(bank);
    if (!playRound()) break;
    roundNumber++;
  }

  const winnerSide: "CT" | "T" = ct.roundsWon >= t.roundsWon ? "CT" : "T";
  return {
    ctScore: ct.roundsWon, tScore: t.roundsWon, winnerSide, clutches,
    playerStats: buildPlayerStats(ct, t, multi),
    roundOutcomes,
  };
}

function carryOverLoadouts(team: Team, sim: RoundSim) {
  for (const ag of sim.agents) {
    if (!team.players.some(p => p.id === ag.playerId)) continue;
    if (ag.alive) {
      const hasVest = ag.armor > 30;
      const keptUtil = [...ag.utility];
      team.loadouts[ag.playerId] = {
        weapon: ag.weapon,
        utility: keptUtil,
        armor: hasVest,
        helmet: ag.helmet,
        keptWeapon: ag.weapon === "knife" ? null : ag.weapon,
        keptArmor: hasVest,
        keptHelmet: ag.helmet,
        keptUtility: keptUtil,
      };
    } else {
      team.loadouts[ag.playerId] = {
        weapon: defaultPistol(team.side), utility: [], armor: false, helmet: false,
        keptWeapon: null, keptArmor: false, keptHelmet: false, keptUtility: [],
      };
    }
  }
}

export const MATCH_CONSTANTS = {
  STARTING_BANK, HALFTIME_ROUND, WIN_THRESHOLD, MAX_ROUNDS,
  OT_HALF_ROUNDS, OT_WIN, OT_BANK, OT_MAX_BLOCKS, isPistolRound,
  swapBankFor, matchDecided,
};
