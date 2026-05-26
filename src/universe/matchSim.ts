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

// Inspect a finished round and, if a player ever became their team's last
// survivor, return the clutch attempt with X = enemies-remaining when the
// clutch started, kills they got during it, and whether they converted (won
// the round). Returns null only if neither team dropped to one alive.
export function detectClutch(r: RoundResult, ctIds: string[], tIds: string[]): Clutch | null {
  const ctSet = new Set(ctIds);
  const tSet = new Set(tIds);
  const aliveCt = new Set(ctIds);
  const aliveT = new Set(tIds);
  let clutcher: { id: string; side: Side; kills: number; enemiesAtStart: number; died: boolean } | null = null;

  for (const ev of r.events) {
    if (ev.kind !== "kill") continue;

    if (aliveCt.has(ev.victim)) aliveCt.delete(ev.victim);
    else if (aliveT.has(ev.victim)) aliveT.delete(ev.victim);

    // First time a side drops to one survivor: that player is the clutcher.
    if (!clutcher) {
      if (aliveCt.size === 1) {
        const last = [...aliveCt][0];
        clutcher = { id: last, side: "CT", kills: 0, enemiesAtStart: aliveT.size, died: false };
      } else if (aliveT.size === 1) {
        const last = [...aliveT][0];
        clutcher = { id: last, side: "T", kills: 0, enemiesAtStart: aliveCt.size, died: false };
      }
    }

    // Count opposing-side kills made by the clutcher after they became last alive.
    if (clutcher && ev.killer === clutcher.id) {
      const opp = clutcher.side === "CT" ? tSet : ctSet;
      if (opp.has(ev.victim)) clutcher.kills++;
    }

    if (clutcher && ev.victim === clutcher.id) clutcher.died = true;
  }

  if (!clutcher) return null;

  // Sanity guards against false positives. A real clutch requires that the
  // clutcher's team genuinely had only the clutcher alive at some point. If
  // either of these checks fails, treat it as not a clutch — most likely the
  // input roster was truncated (e.g. a lookup dropped players) so the alive
  // set hit "size 1" without actually being last alive.
  const sideSize = (clutcher.side === "CT" ? ctIds : tIds).length;
  // At least N-1 teammate deaths must have shown up on the kill stream for
  // someone on that side to actually be last alive.
  const teammateDeaths = r.events.filter(e =>
    e.kind === "kill" &&
    (clutcher!.side === "CT" ? ctSet.has(e.victim) : tSet.has(e.victim))
  ).length;
  if (teammateDeaths < sideSize - 1) return null;
  // And at end-of-events the side's tracked alive count should be ≤ 1.
  const teamAliveAtEnd = clutcher.side === "CT" ? aliveCt.size : aliveT.size;
  if (teamAliveAtEnd > 1) return null;

  // Won iff their side won the round AND they didn't die — either path being
  // false means a missed opportunity (round lost, or died but bomb detonated).
  const won = !clutcher.died && clutcher.side === r.winningSide;
  return {
    playerId: clutcher.id,
    kills: clutcher.kills,
    enemiesAtStart: clutcher.enemiesAtStart,
    won,
  };
}

const STARTING_BANK = 800;
const HALFTIME_ROUND = 12;
const WIN_THRESHOLD = 13;
const MAX_ROUNDS = 24;
const isPistolRound = (n: number): boolean => n === 1 || n === HALFTIME_ROUND + 1;

export function buildTeam(id: string, name: string, players: Player[], side: Side): Team {
  // Deep-clone the players so the universe's canonical Player objects aren't
  // mutated by per-match state (money, mood drift, matchStats, etc.).
  const cloned: Player[] = players.map(p => ({
    ...p,
    relationships: { ...p.relationships },
    stats: { ...p.stats },
    money: STARTING_BANK,
    // Start the match's in-the-moment mood at the player's persistent form
    // (morale), so a hot streak or a tilt carries into how they shoot. Mood
    // then swings round-to-round on the clone and is discarded after.
    mood: p.morale,
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
  // SAFETY: bound the loop in case of a misbehaving sim.
  while (roundNumber <= MAX_ROUNDS && ct.roundsWon < WIN_THRESHOLD && t.roundsWon < WIN_THRESHOLD) {
    aiBuyFor(homeCtTeam, roundNumber, isPistolRound, mulberry32(intFrom()));
    aiBuyFor(homeTteam, roundNumber, isPistolRound, mulberry32(intFrom()));

    const sim = new RoundSim(homeCtTeam, homeTteam, map, intFrom());
    let safety = 100000;
    while (!sim.finished && safety-- > 0) sim.tick();
    if (!sim.result) break;

    const r = sim.result;
    const winner = r.winningSide === "CT" ? homeCtTeam : homeTteam;
    winner.roundsWon++;
    const clutch = detectClutch(r, homeCtTeam.players.map(p => p.id), homeTteam.players.map(p => p.id));
    if (clutch) clutches.push({ ...clutch, round: roundNumber });
    tallyMultiKills(r, multi);
    roundOutcomes.push({
      round: roundNumber,
      winnerSide: r.winningSide,
      durationMs: sim.t,
      ctScoreAfter: ct.roundsWon,
      tScoreAfter: t.roundsWon,
    });
    lossStreaks = applyRoundReward(homeCtTeam, homeTteam, r, lossStreaks.ctLossStreak, lossStreaks.tLossStreak);

    // Carry over survivor loadout state so next round's AI buy considers kept guns.
    carryOverLoadouts(homeCtTeam, sim);
    carryOverLoadouts(homeTteam, sim);

    if (roundNumber === HALFTIME_ROUND) {
      // Halftime: swap sides + reset banks.
      [homeCtTeam, homeTteam] = [homeTteam, homeCtTeam];
      homeCtTeam.side = "CT";
      homeTteam.side = "T";
      for (const team of [homeCtTeam, homeTteam]) {
        for (const p of team.players) {
          p.money = STARTING_BANK;
          team.loadouts[p.id] = {
            weapon: defaultPistol(team.side), utility: [], armor: false, helmet: false,
            keptWeapon: null, keptArmor: false, keptHelmet: false, keptUtility: [],
          };
        }
      }
      lossStreaks = { ctLossStreak: 0, tLossStreak: 0 };
    }
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

export const MATCH_CONSTANTS = { STARTING_BANK, HALFTIME_ROUND, WIN_THRESHOLD, MAX_ROUNDS, isPistolRound };
