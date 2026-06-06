// Headless balance simulator. Runs in a Web Worker so the UI stays responsive.
import type { GameMap, RoundOutcome, RoundResult, Side, TStrategy, WeaponId, UtilityId } from "../domain/types.ts";
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
  rounds: number; // round count, or (in series mode) the number of full games to sim
  neutralize: boolean;
  resetEachRound: boolean;
  ctLoadout: LoadoutPreset;
  tLoadout: LoadoutPreset;
  matrix: boolean; // if true, ignore ctLoadout/tLoadout and run all combos in ALL_PRESETS
  // If true, sim whole MR12 games (first to 13, halftime side-swap, MR3 OT) with
  // a real economy instead of independent rounds. `rounds` is read as the series
  // count; loadout/matrix/reset-money options are ignored (economy drives buys).
  seriesMode: boolean;
}

export interface BalanceProgress {
  kind: "progress";
  done: number;
  total: number;
  cell?: { ct: LoadoutPreset; t: LoadoutPreset; index: number; count: number };
}

// Per-tile heatmap grids (length width*height each), accumulated over a run.
// Deaths are binned at the victim's position; occupancy samples alive agents
// every POS_SAMPLE_EVERY ticks. Only collected for single (non-matrix) runs.
export interface HeatGrids {
  width: number;
  height: number;
  ctDeaths: number[];  // where CTs died
  tDeaths: number[];   // where Ts died
  ctKills: number[];   // where CTs were standing when they got a kill
  tKills: number[];    // where Ts were standing when they got a kill
  ctPos: number[];
  tPos: number[];
}

// Series-level color, populated only by MR12 series runs. Round-by-side balance
// still lives in RunStats (aggregated over every round of every game); this adds
// what only a full-game sim can show: how lopsided games are, how often they go
// to OT, and how decisive pistol rounds are.
export interface SeriesStats {
  seriesPlayed: number;
  overtimes: number;          // games that reached 12-12 and went to OT
  totalWinnerScore: number;   // sum of the winning team's round total → avg
  totalLoserScore: number;    // sum of the losing team's round total → avg
  pistolRounds: number;       // first round of each regulation half
  pistolCtWins: number;
  pistolTWins: number;
  halvesPlayed: number;          // regulation halves played to completion (12 rounds)
  pistolWinnerHalfWins: number;  // such halves the pistol winner went on to win
}

export interface BalanceResult {
  kind: "done";
  stats: RunStats;
  heat?: HeatGrids;
  series?: SeriesStats;
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
  // When provided, the run records death locations and samples agent positions
  // into these per-tile grids. Omitted for matrix runs (heat isn't shown there).
  heatOut?: HeatGrids;
}

// Sample alive-agent occupancy this often (in ticks) for the positioning grid.
const POS_SAMPLE_EVERY = 5;

export function emptyHeatGrids(map: GameMap): HeatGrids {
  const n = map.width * map.height;
  return {
    width: map.width, height: map.height,
    ctDeaths: new Array(n).fill(0), tDeaths: new Array(n).fill(0),
    ctKills: new Array(n).fill(0), tKills: new Array(n).fill(0),
    ctPos: new Array(n).fill(0), tPos: new Array(n).fill(0),
  };
}

function tileIndex(map: GameMap, x: number, y: number): number {
  const tx = Math.min(map.width - 1, Math.max(0, Math.floor(x / map.tileSize)));
  const ty = Math.min(map.height - 1, Math.max(0, Math.floor(y / map.tileSize)));
  return ty * map.width + tx;
}

// A clean buy-phase loadout: default pistol, no armor/util, nothing kept.
function freshLoadout(side: Side): MiniTeam["loadouts"][string] {
  return {
    weapon: defaultPistol(side), utility: [], armor: false, helmet: false,
    keptWeapon: null, keptArmor: false, keptHelmet: false, keptUtility: [],
  };
}

// Run a round to completion, optionally folding death/kill/occupancy into heat.
function runRound(sim: RoundSim, map: GameMap, heat?: HeatGrids) {
  if (heat) sim.collectHeat = true;
  let safety = 100000;
  let tickN = 0;
  while (!sim.finished && safety-- > 0) {
    sim.tick();
    // Occupancy: bin every alive agent's tile into its side's grid periodically.
    if (heat && tickN++ % POS_SAMPLE_EVERY === 0) {
      for (const ag of sim.agents) {
        if (!ag.alive) continue;
        const idx = tileIndex(map, ag.pos.x, ag.pos.y);
        if (ag.side === "CT") heat.ctPos[idx]++; else heat.tPos[idx]++;
      }
    }
  }
  if (heat && sim.result) {
    for (const d of sim.deathLog) {
      const idx = tileIndex(map, d.x, d.y);
      if (d.side === "CT") heat.ctDeaths[idx]++; else heat.tDeaths[idx]++;
    }
    for (const k of sim.killLog) {
      const idx = tileIndex(map, k.x, k.y);
      if (k.side === "CT") heat.ctKills[idx]++; else heat.tKills[idx]++;
    }
  }
}

// Fold one finished round into the aggregate stats. `ctIds` identifies which
// players were on CT this round (for kill attribution) — it flips at halftime.
function tallyRound(stats: RunStats, sim: RoundSim, r: RoundResult, ctIds: Set<string>) {
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
      if (ctIds.has(e.killer)) { stats.ctKills++; strat.ctKills++; setupBucket.ctKills++; }
      else { stats.tKills++; strat.tKills++; setupBucket.tKills++; }
    } else if (e.kind === "bomb-plant") {
      stats.plants++;
      strat.plants++;
      setupBucket.plants++;
    }
  }
}

// Carry surviving agents' gear into next round's loadout; reset the fallen to a
// fresh pistol. Only meaningful when the economy isn't reset between rounds.
function carryLoadouts(ctTeam: MiniTeam, tTeam: MiniTeam, sim: RoundSim) {
  for (const ag of sim.agents) {
    const team = ctTeam.players.some(pl => pl.id === ag.playerId) ? ctTeam : tTeam;
    if (ag.alive) {
      const hasVest = ag.armor > 30;
      const keptUtil = [...ag.utility];
      team.loadouts[ag.playerId] = {
        weapon: ag.weapon, utility: keptUtil, armor: hasVest, helmet: ag.helmet,
        keptWeapon: ag.weapon === "knife" ? null : ag.weapon,
        keptArmor: hasVest, keptHelmet: ag.helmet, keptUtility: keptUtil,
      };
    } else {
      team.loadouts[ag.playerId] = freshLoadout(team.side);
    }
  }
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
    team.loadouts[pl.id] = freshLoadout(team.side);
  }

  // If a fixed loadout is specified, force it every round; eco state doesn't
  // matter (and we always reset money to be safe). simpleBuy is only used in
  // "auto" mode.
  const ctForced = p.ctLoadout !== "auto";
  const tForced = p.tLoadout !== "auto";
  const forced = ctForced || tForced;

  let ctLossStreak = 0, tLossStreak = 0;
  const stats = emptyStats();
  const ctIds = new Set(home.players.map(pl => pl.id)); // home is always CT here
  const progressEvery = Math.max(1, Math.floor(p.rounds / 50));

  for (let i = 0; i < p.rounds; i++) {
    if (p.resetEachRound || forced) {
      for (const team of [home, away]) {
        for (const pl of team.players) {
          pl.money = INDEPENDENT_ROUND_STIPEND;
          team.loadouts[pl.id] = freshLoadout(team.side);
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
    runRound(sim, p.map, p.heatOut);
    if (!sim.result) continue;

    const r = sim.result;
    tallyRound(stats, sim, r, ctIds);

    // Carry over surviving loadouts (only meaningful in "auto" mode without reset).
    carryLoadouts(home, away, sim);

    const next = applyRoundReward(home as any, away as any, r, ctLossStreak, tLossStreak);
    ctLossStreak = next.ctLossStreak;
    tLossStreak = next.tLossStreak;

    if ((i + 1) % progressEvery === 0) p.onProgress(i + 1);
  }
  return stats;
}

// --- MR12 series simulation -------------------------------------------------

interface SeriesParams {
  map: GameMap;
  seriesCount: number;
  neutralize: boolean;
  onProgress: (done: number) => void;
  heatOut?: HeatGrids;
}

function emptySeriesStats(): SeriesStats {
  return {
    seriesPlayed: 0, overtimes: 0,
    totalWinnerScore: 0, totalLoserScore: 0,
    pistolRounds: 0, pistolCtWins: 0, pistolTWins: 0,
    halvesPlayed: 0, pistolWinnerHalfWins: 0,
  };
}

// MR12 rules: first to 13, sides switch after 12, MR3 overtime if 12-12.
const REG_HALF = 12, REG_WIN = 13;
const OT_HALF = 3, OT_WIN = 4;       // each OT: 6 rounds (3 per side), first to +4
const PISTOL_MONEY = 800, OT_MONEY = 10000;
const MAX_OT_BLOCKS = 20;            // guard against a pathological infinite tie

// Sim `seriesCount` full MR12 games with a real economy (loss bonuses, pistol
// rounds, halftime reset + side-swap). Round-by-side balance accrues into a
// normal RunStats; the series-only color goes into SeriesStats.
export function simulateSeries(p: SeriesParams): { stats: RunStats; series: SeriesStats } {
  setSeed(Date.now());
  const teamA = makeTeam("home", "Home", "CT") as unknown as MiniTeam;
  const teamB = makeTeam("away", "Away", "T") as unknown as MiniTeam;
  if (p.neutralize) {
    neutralizeTeamStats(teamA as any, 60);
    neutralizeTeamStats(teamB as any, 60);
  }
  const stats = emptyStats();
  const series = emptySeriesStats();

  for (let s = 0; s < p.seriesCount; s++) {
    // Fresh game: team A starts CT, team B starts T. ctTeam/tTeam track who's on
    // which side right now and are swapped at the half.
    let ctTeam = teamA, tTeam = teamB;
    ctTeam.side = "CT"; tTeam.side = "T";
    let scoreA = 0, scoreB = 0; // total rounds won, by team identity (not side)
    let ctLossStreak = 0, tLossStreak = 0;

    // Play up to `len` rounds. Resets economy to `startMoney` and re-anchors mood
    // at the buy. Returns "decided" the instant a team reaches `winTarget` (the
    // game is over), else "complete" once all `len` rounds are played. Pistol /
    // half-conversion color is only recorded for regulation halves.
    const playHalf = (len: number, startMoney: number, winTarget: number, regulation: boolean): "decided" | "complete" => {
      for (const team of [ctTeam, tTeam]) for (const pl of team.players) {
        pl.money = startMoney;
        if (p.neutralize) { pl.mood = 65; pl.morale = 65; }
        team.loadouts[pl.id] = freshLoadout(team.side);
      }
      ctLossStreak = 0; tLossStreak = 0;
      const aAtStart = scoreA;
      let pistolWinner: MiniTeam | null = null;

      for (let r = 0; r < len; r++) {
        if (p.neutralize) for (const team of [ctTeam, tTeam]) for (const pl of team.players) {
          pl.mood = 65; pl.morale = 65;
        }
        applyPreset(ctTeam, "auto");
        applyPreset(tTeam, "auto");

        const sim = new RoundSim(ctTeam as any, tTeam as any, p.map, Math.floor(Math.random() * 1e9));
        runRound(sim, p.map, p.heatOut);
        if (!sim.result) continue;
        const res = sim.result;
        tallyRound(stats, sim, res, new Set(ctTeam.players.map(pl => pl.id)));

        const winnerTeam = res.winningSide === "CT" ? ctTeam : tTeam;
        if (winnerTeam === teamA) scoreA++; else scoreB++;

        if (regulation && r === 0) { // pistol round
          series.pistolRounds++;
          if (res.winningSide === "CT") series.pistolCtWins++; else series.pistolTWins++;
          pistolWinner = winnerTeam;
        }

        carryLoadouts(ctTeam, tTeam, sim);
        const next = applyRoundReward(ctTeam as any, tTeam as any, res, ctLossStreak, tLossStreak);
        ctLossStreak = next.ctLossStreak; tLossStreak = next.tLossStreak;

        if (scoreA >= winTarget || scoreB >= winTarget) return "decided";
      }

      // Half played to completion. Record conversion only for regulation halves
      // (OT "pistols" are $10k full buys, not real pistol rounds).
      if (regulation) {
        series.halvesPlayed++;
        const halfWinner = (scoreA - aAtStart) > len / 2 ? teamA : teamB; // 7+ of 12
        if (pistolWinner && halfWinner === pistolWinner) series.pistolWinnerHalfWins++;
      }
      return "complete";
    };

    const swapSides = () => {
      [ctTeam, tTeam] = [tTeam, ctTeam];
      ctTeam.side = "CT"; tTeam.side = "T";
    };

    // Regulation: two 12-round halves with a side-swap at the break.
    let decided = playHalf(REG_HALF, PISTOL_MONEY, REG_WIN, true) === "decided";
    if (!decided) {
      swapSides();
      decided = playHalf(REG_HALF, PISTOL_MONEY, REG_WIN, true) === "decided";
    }

    // 12-12 → MR3 overtime: 6-round blocks, $10k, swap at 3, first to +4 wins.
    let wentToOT = false;
    if (!decided && scoreA === scoreB) {
      wentToOT = true;
      swapSides();
      let blocks = 0;
      while (scoreA === scoreB && blocks++ < MAX_OT_BLOCKS) {
        const target = scoreA + OT_WIN; // both equal here
        if (playHalf(OT_HALF, OT_MONEY, target, false) === "decided") break;
        swapSides();
        if (playHalf(OT_HALF, OT_MONEY, target, false) === "decided") break;
        swapSides(); // block tied (3-3); reset orientation for the next block
      }
    }

    series.seriesPlayed++;
    if (wentToOT) series.overtimes++;
    series.totalWinnerScore += Math.max(scoreA, scoreB);
    series.totalLoserScore += Math.min(scoreA, scoreB);
    p.onProgress(s + 1);
  }

  return { stats, series };
}

// Worker entry — guarded so Node-side scripts can import this module.
if (typeof self !== "undefined" && typeof (self as any).addEventListener === "function") {
self.addEventListener("message", (e: MessageEvent<BalanceRequest>) => {
  const req = e.data;
  if (req.kind !== "run") return;

  if (req.seriesMode) {
    const heat = emptyHeatGrids(req.map);
    const { stats, series } = simulateSeries({
      map: req.map, seriesCount: req.rounds, neutralize: req.neutralize,
      heatOut: heat,
      onProgress: (done) => {
        const msg: BalanceProgress = { kind: "progress", done, total: req.rounds };
        self.postMessage(msg);
      },
    });
    const result: BalanceResult = { kind: "done", stats, heat, series };
    self.postMessage(result);
  } else if (req.matrix) {
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
    const heat = emptyHeatGrids(req.map);
    const stats = simulateCell({
      map: req.map, rounds: req.rounds,
      neutralize: req.neutralize, resetEachRound: req.resetEachRound,
      ctLoadout: req.ctLoadout, tLoadout: req.tLoadout,
      heatOut: heat,
      onProgress: (done) => {
        const msg: BalanceProgress = { kind: "progress", done, total: req.rounds };
        self.postMessage(msg);
      },
    });
    const result: BalanceResult = { kind: "done", stats, heat };
    self.postMessage(result);
  }
});
}
