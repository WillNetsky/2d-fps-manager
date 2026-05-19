import type { GameMap, Player, Side, Team } from "../domain/types.ts";
import { defaultPistol } from "../domain/weapons.ts";
import { RoundSim } from "../sim/round.ts";
import { applyRoundReward } from "../sim/economy.ts";
import { aiBuyFor } from "../sim/aiBuy.ts";

export interface MatchResult {
  ctScore: number;
  tScore: number;
  winnerSide: "CT" | "T";
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
export function simulateMatchInstant(ct: Team, t: Team, map: GameMap): MatchResult {
  let homeCtTeam = ct;     // tracks which roster is currently on CT side
  let homeTteam = t;
  let lossStreaks = { ctLossStreak: 0, tLossStreak: 0 };
  let roundNumber = 1;
  // SAFETY: bound the loop in case of a misbehaving sim.
  while (roundNumber <= MAX_ROUNDS && ct.roundsWon < WIN_THRESHOLD && t.roundsWon < WIN_THRESHOLD) {
    aiBuyFor(homeCtTeam, roundNumber, isPistolRound);
    aiBuyFor(homeTteam, roundNumber, isPistolRound);

    const sim = new RoundSim(homeCtTeam, homeTteam, map, Math.floor(Math.random() * 1e9));
    let safety = 100000;
    while (!sim.finished && safety-- > 0) sim.tick();
    if (!sim.result) break;

    const r = sim.result;
    const winner = r.winningSide === "CT" ? homeCtTeam : homeTteam;
    winner.roundsWon++;
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
  return { ctScore: ct.roundsWon, tScore: t.roundsWon, winnerSide };
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
