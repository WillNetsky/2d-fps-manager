// Headless balance simulator. Runs in a Web Worker so the UI stays responsive.
import type { GameMap, RoundOutcome, Side, TStrategy, WeaponId, UtilityId } from "../domain/types.ts";
import { makeTeam, neutralizeTeamStats, setSeed } from "../domain/factory.ts";
import { RoundSim } from "../sim/round.ts";
import { applyRoundReward } from "../sim/economy.ts";
import { defaultPistol } from "../domain/weapons.ts";

// In "independent rounds" mode we give every player a full-buy stipend each
// round, so the sim measures rifle-vs-rifle balance instead of a permanent
// pistol round. Covers rifle + vest + helmet + a piece of utility.
const INDEPENDENT_ROUND_STIPEND = 4500;

// Named loadout presets the matrix iterates over. "auto" defers to simpleBuy
// (eco-driven, depends on money/kept gear).
export type LoadoutPreset = "auto" | "pistol" | "pistol+armor" | "smg" | "rifle" | "awp";
export const ALL_PRESETS: LoadoutPreset[] = ["pistol", "pistol+armor", "smg", "rifle", "awp"];
export const PRESET_LABELS: Record<LoadoutPreset, string> = {
  "auto": "Auto (eco-driven)",
  "pistol": "Pistol",
  "pistol+armor": "Pistol + vest",
  "smg": "SMG + vest",
  "rifle": "Rifle (full buy)",
  "awp": "4 rifles + 1 AWP",
};

export interface BalanceRequest {
  kind: "run";
  map: GameMap;
  rounds: number;
  neutralize: boolean;
  resetEachRound: boolean;
  ctLoadout: LoadoutPreset;
  tLoadout: LoadoutPreset;
  matrix: boolean; // if true, ignore ctLoadout/tLoadout and run all combos in ALL_PRESETS
}

export interface BalanceProgress {
  kind: "progress";
  done: number;
  total: number;
  cell?: { ct: LoadoutPreset; t: LoadoutPreset; index: number; count: number };
}

export interface BalanceResult {
  kind: "done";
  stats: RunStats;
}

export interface BalanceMatrixResult {
  kind: "done-matrix";
  cells: { ct: LoadoutPreset; t: LoadoutPreset; stats: RunStats }[];
}

export interface StrategyStats {
  rounds: number;
  ctWins: number;
  tWins: number;
  plants: number;
  defuses: number;
  detonations: number;
  timeouts: number;
  ctKills: number;
  tKills: number;
  totalDurationMs: number;
}

export const ALL_T_STRATEGIES: TStrategy[] = ["rush-A", "rush-B", "default", "split-A", "split-B"];

export interface RunStats {
  rounds: number;
  ctWins: number;
  tWins: number;
  outcomes: Record<RoundOutcome, number>;
  totalDurationMs: number;
  ctKills: number;
  tKills: number;
  plants: number;
  defuses: number;
  detonations: number;
  ctElims: number;
  tElims: number;
  timeouts: number;
  byTStrategy: Record<TStrategy, StrategyStats>;
  byCtSetup: Record<string, StrategyStats>; // key e.g. "2A/2B/1M"
}

function emptyBucket(): StrategyStats {
  return { rounds: 0, ctWins: 0, tWins: 0, plants: 0, defuses: 0, detonations: 0, timeouts: 0, ctKills: 0, tKills: 0, totalDurationMs: 0 };
}

function emptyStrategyStats(): Record<TStrategy, StrategyStats> {
  const out = {} as Record<TStrategy, StrategyStats>;
  for (const s of ALL_T_STRATEGIES) out[s] = emptyBucket();
  return out;
}

function emptyStats(): RunStats {
  return {
    rounds: 0, ctWins: 0, tWins: 0,
    outcomes: {
      "ct-elim": 0, "t-elim": 0,
      "bomb-detonated": 0, "bomb-defused": 0, "time-expired": 0,
    },
    totalDurationMs: 0,
    ctKills: 0, tKills: 0,
    plants: 0, defuses: 0, detonations: 0,
    ctElims: 0, tElims: 0, timeouts: 0,
    byTStrategy: emptyStrategyStats(),
    byCtSetup: {},
  };
}

export function ctSetupKey(setup: { A: number; B: number; mid: number }): string {
  return `${setup.A}A/${setup.B}B/${setup.mid}M`;
}

interface MiniTeam {
  side: Side;
  players: { id: string; role: string; money: number; mood: number; morale: number }[];
  loadouts: Record<string, {
    weapon: WeaponId; utility: UtilityId[]; armor: boolean; helmet: boolean;
    keptWeapon: WeaponId | null; keptArmor: boolean; keptHelmet: boolean; keptUtility: UtilityId[];
  }>;
}

function simpleBuy(team: MiniTeam) {
  const rifle: WeaponId = team.side === "CT" ? "m4" : "ak";
  const rifleCost = team.side === "CT" ? 3100 : 2700;
  const VEST = 650, HELMET = 350;
  for (const p of team.players) {
    const l = team.loadouts[p.id];
    let spent = 0;
    if (!l.keptWeapon && p.money >= rifleCost) { l.weapon = rifle; spent += rifleCost; }
    else if (l.keptWeapon) l.weapon = l.keptWeapon;
    if (!l.keptArmor && p.money - spent >= VEST) { l.armor = true; spent += VEST; }
    if (l.armor && !l.keptHelmet && p.money - spent >= HELMET) { l.helmet = true; spent += HELMET; }
    p.money = Math.max(0, p.money - spent);
  }
}

// Force every player on `team` to the given preset, ignoring money. Used when
// the operator picks a specific loadout (or for matrix mode).
function applyPreset(team: MiniTeam, preset: LoadoutPreset) {
  if (preset === "auto") { simpleBuy(team); return; }
  const rifle: WeaponId = team.side === "CT" ? "m4" : "ak";
  const smg: WeaponId = team.side === "CT" ? "mp9" : "mac10";
  const pistol = defaultPistol(team.side);
  team.players.forEach((p, i) => {
    let weapon: WeaponId = pistol;
    let armor = false, helmet = false;
    switch (preset) {
      case "pistol": weapon = pistol; break;
      case "pistol+armor": weapon = pistol; armor = true; break;
      case "smg": weapon = smg; armor = true; break;
      case "rifle": weapon = rifle; armor = true; helmet = true; break;
      case "awp": weapon = i === 0 ? "awp" : rifle; armor = true; helmet = true; break;
    }
    team.loadouts[p.id] = {
      weapon, utility: [], armor, helmet,
      keptWeapon: null, keptArmor: false, keptHelmet: false, keptUtility: [],
    };
  });
}

interface CellParams {
  map: GameMap;
  rounds: number;
  neutralize: boolean;
  resetEachRound: boolean;
  ctLoadout: LoadoutPreset;
  tLoadout: LoadoutPreset;
  onProgress: (done: number) => void;
}

export function simulateCell(p: CellParams): RunStats {
  setSeed(Date.now());
  const home = makeTeam("home", "Home", "CT") as unknown as MiniTeam;
  const away = makeTeam("away", "Away", "T") as unknown as MiniTeam;

  if (p.neutralize) {
    neutralizeTeamStats(home as any, 60);
    neutralizeTeamStats(away as any, 60);
  }

  for (const team of [home, away]) for (const pl of team.players) {
    team.loadouts[pl.id] = {
      weapon: defaultPistol(team.side), utility: [], armor: false, helmet: false,
      keptWeapon: null, keptArmor: false, keptHelmet: false, keptUtility: [],
    };
  }

  // If a fixed loadout is specified, force it every round; eco state doesn't
  // matter (and we always reset money to be safe). simpleBuy is only used in
  // "auto" mode.
  const ctForced = p.ctLoadout !== "auto";
  const tForced = p.tLoadout !== "auto";
  const forced = ctForced || tForced;

  let ctLossStreak = 0, tLossStreak = 0;
  const stats = emptyStats();
  const progressEvery = Math.max(1, Math.floor(p.rounds / 50));

  for (let i = 0; i < p.rounds; i++) {
    if (p.resetEachRound || forced) {
      for (const team of [home, away]) {
        for (const pl of team.players) {
          pl.money = INDEPENDENT_ROUND_STIPEND;
          team.loadouts[pl.id] = {
            weapon: defaultPistol(team.side), utility: [], armor: false, helmet: false,
            keptWeapon: null, keptArmor: false, keptHelmet: false, keptUtility: [],
          };
        }
      }
      ctLossStreak = 0;
      tLossStreak = 0;
    }
    // Mood feeds back into aim — without resetting between rounds the winning
    // side's mood saturates and creates a runaway lead. Keep balance runs
    // honest by re-anchoring mood each round when stats are neutralized or the
    // economy is being reset anyway.
    if (p.neutralize || p.resetEachRound || forced) {
      for (const team of [home, away]) for (const pl of team.players) {
        pl.mood = 65; pl.morale = 65;
      }
    }
    applyPreset(home, p.ctLoadout);
    applyPreset(away, p.tLoadout);

    const sim = new RoundSim(home as any, away as any, p.map, Math.floor(Math.random() * 1e9));
    let safety = 100000;
    while (!sim.finished && safety-- > 0) sim.tick();
    if (!sim.result) continue;

    const r = sim.result;
    stats.rounds++;
    stats.totalDurationMs += r.durationMs;
    stats.outcomes[r.outcome]++;
    if (r.winningSide === "CT") stats.ctWins++; else stats.tWins++;
    if (r.outcome === "ct-elim") stats.tElims++;
    else if (r.outcome === "t-elim") stats.ctElims++;
    else if (r.outcome === "bomb-detonated") stats.detonations++;
    else if (r.outcome === "bomb-defused") stats.defuses++;
    else if (r.outcome === "time-expired") stats.timeouts++;

    const strat = stats.byTStrategy[sim.tStrategy];
    const setupKey = ctSetupKey(sim.ctSetup);
    const setupBucket = stats.byCtSetup[setupKey] ?? (stats.byCtSetup[setupKey] = emptyBucket());
    for (const b of [strat, setupBucket]) {
      b.rounds++;
      b.totalDurationMs += r.durationMs;
      if (r.winningSide === "CT") b.ctWins++; else b.tWins++;
      if (r.outcome === "bomb-defused") b.defuses++;
      else if (r.outcome === "bomb-detonated") b.detonations++;
      else if (r.outcome === "time-expired") b.timeouts++;
    }

    for (const e of r.events) {
      if (e.kind === "kill") {
        const ctKill = home.players.some(pl => pl.id === e.killer);
        if (ctKill) { stats.ctKills++; strat.ctKills++; setupBucket.ctKills++; }
        else { stats.tKills++; strat.tKills++; setupBucket.tKills++; }
      } else if (e.kind === "bomb-plant") {
        stats.plants++;
        strat.plants++;
        setupBucket.plants++;
      }
    }

    // Carry over surviving loadouts (only meaningful in "auto" mode without reset).
    for (const ag of sim.agents) {
      const team = home.players.some(pl => pl.id === ag.playerId) ? home : away;
      if (ag.alive) {
        const hasVest = ag.armor > 30;
        const keptUtil = [...ag.utility];
        team.loadouts[ag.playerId] = {
          weapon: ag.weapon, utility: keptUtil, armor: hasVest, helmet: ag.helmet,
          keptWeapon: ag.weapon === "knife" ? null : ag.weapon,
          keptArmor: hasVest, keptHelmet: ag.helmet, keptUtility: keptUtil,
        };
      } else {
        team.loadouts[ag.playerId] = {
          weapon: defaultPistol(team.side), utility: [], armor: false, helmet: false,
          keptWeapon: null, keptArmor: false, keptHelmet: false, keptUtility: [],
        };
      }
    }

    const next = applyRoundReward(home as any, away as any, r, ctLossStreak, tLossStreak);
    ctLossStreak = next.ctLossStreak;
    tLossStreak = next.tLossStreak;

    if ((i + 1) % progressEvery === 0) p.onProgress(i + 1);
  }
  return stats;
}

// Worker entry — guarded so Node-side scripts can import this module.
if (typeof self !== "undefined" && typeof (self as any).addEventListener === "function") {
self.addEventListener("message", (e: MessageEvent<BalanceRequest>) => {
  const req = e.data;
  if (req.kind !== "run") return;

  if (req.matrix) {
    const cells: { ct: LoadoutPreset; t: LoadoutPreset; stats: RunStats }[] = [];
    const total = ALL_PRESETS.length * ALL_PRESETS.length;
    let cellIndex = 0;
    for (const ct of ALL_PRESETS) {
      for (const t of ALL_PRESETS) {
        cellIndex++;
        const stats = simulateCell({
          map: req.map, rounds: req.rounds,
          neutralize: req.neutralize, resetEachRound: req.resetEachRound,
          ctLoadout: ct, tLoadout: t,
          onProgress: (done) => {
            const msg: BalanceProgress = {
              kind: "progress", done, total: req.rounds,
              cell: { ct, t, index: cellIndex, count: total },
            };
            self.postMessage(msg);
          },
        });
        cells.push({ ct, t, stats });
      }
    }
    const result: BalanceMatrixResult = { kind: "done-matrix", cells };
    self.postMessage(result);
  } else {
    const stats = simulateCell({
      map: req.map, rounds: req.rounds,
      neutralize: req.neutralize, resetEachRound: req.resetEachRound,
      ctLoadout: req.ctLoadout, tLoadout: req.tLoadout,
      onProgress: (done) => {
        const msg: BalanceProgress = { kind: "progress", done, total: req.rounds };
        self.postMessage(msg);
      },
    });
    const result: BalanceResult = { kind: "done", stats };
    self.postMessage(result);
  }
});
}
