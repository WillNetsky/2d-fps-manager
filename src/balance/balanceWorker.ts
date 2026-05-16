// Headless balance simulator. Runs in a Web Worker so the UI stays responsive.
import type { GameMap, RoundOutcome, Side } from "../domain/types.ts";
import { makeTeam, neutralizeTeamStats, setSeed, STARTING_PER_PLAYER } from "../domain/factory.ts";
import { RoundSim } from "../sim/round.ts";
import { applyRoundReward } from "../sim/economy.ts";

export interface BalanceRequest {
  kind: "run";
  map: GameMap;
  rounds: number;
  neutralize: boolean;
  resetEachRound: boolean;
}

export interface BalanceProgress {
  kind: "progress";
  done: number;
  total: number;
}

export interface BalanceResult {
  kind: "done";
  stats: RunStats;
}

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
  };
}

function simpleBuy(team: { side: Side; players: { id: string; role: string; money: number }[]; loadouts: Record<string, any> }) {
  const rifle = team.side === "CT" ? "m4" : "ak";
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

function simulate(req: BalanceRequest, onProgress: (done: number) => void): RunStats {
  setSeed(Date.now());
  const home = makeTeam("home", "Home", "CT");
  const away = makeTeam("away", "Away", "T");

  if (req.neutralize) {
    neutralizeTeamStats(home, 60);
    neutralizeTeamStats(away, 60);
  }

  for (const team of [home, away]) for (const p of team.players) {
    team.loadouts[p.id] = {
      weapon: "pistol", utility: [], armor: false, helmet: false,
      keptWeapon: null, keptArmor: false, keptHelmet: false, keptUtility: [],
    };
  }

  let ctLossStreak = 0, tLossStreak = 0;
  const stats = emptyStats();
  const progressEvery = Math.max(1, Math.floor(req.rounds / 50));

  for (let i = 0; i < req.rounds; i++) {
    if (req.resetEachRound) {
      for (const team of [home, away]) for (const p of team.players) p.money = STARTING_PER_PLAYER;
    }
    simpleBuy(home);
    simpleBuy(away);

    const sim = new RoundSim(home, away, req.map, Math.floor(Math.random() * 1e9));
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

    for (const e of r.events) {
      if (e.kind === "kill") {
        if (home.players.some(p => p.id === e.killer)) stats.ctKills++;
        else stats.tKills++;
      } else if (e.kind === "bomb-plant") {
        stats.plants++;
      }
    }

    for (const ag of sim.agents) {
      const team = home.players.some(p => p.id === ag.playerId) ? home : away;
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
          weapon: "pistol", utility: [], armor: false, helmet: false,
          keptWeapon: null, keptArmor: false, keptHelmet: false, keptUtility: [],
        };
      }
    }

    const next = applyRoundReward(home, away, r, ctLossStreak, tLossStreak);
    ctLossStreak = next.ctLossStreak;
    tLossStreak = next.tLossStreak;

    if ((i + 1) % progressEvery === 0) onProgress(i + 1);
  }
  return stats;
}

self.addEventListener("message", (e: MessageEvent<BalanceRequest>) => {
  const req = e.data;
  if (req.kind !== "run") return;
  const stats = simulate(req, (done) => {
    const msg: BalanceProgress = { kind: "progress", done, total: req.rounds };
    self.postMessage(msg);
  });
  const result: BalanceResult = { kind: "done", stats };
  self.postMessage(result);
});
