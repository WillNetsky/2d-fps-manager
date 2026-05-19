import type { GameMap, Player, Side, Team } from "../domain/types.ts";
import { RoundSim } from "../sim/round.ts";
import { applyRoundReward } from "../sim/economy.ts";
import { aiBuyFor } from "../sim/aiBuy.ts";
import { defaultPistol } from "../domain/weapons.ts";
import { Renderer } from "../render/renderer.ts";
import { KillFeed } from "../ui/killFeed.ts";
import { buildTeam, MATCH_CONSTANTS, type MatchResult } from "./matchSim.ts";

const { STARTING_BANK, HALFTIME_ROUND, WIN_THRESHOLD, MAX_ROUNDS, isPistolRound } = MATCH_CONSTANTS;

export interface ObserveMatchOptions {
  ctName: string;
  tName: string;
  ctPlayers: Player[];
  tPlayers: Player[];
  map: GameMap;
  onDone: (result: MatchResult) => void;
  onCancel: () => void;
}

// Live-render an MR12 match between two rosters, observe-only (no buy panel).
// Returns an object with a `dispose` method to clean up if the caller exits early.
export async function observeMatch(host: HTMLElement, opts: ObserveMatchOptions): Promise<{ dispose: () => void }> {
  host.innerHTML = "";
  host.className = "universe-match";

  // --- Layout ---
  const hud = document.createElement("div");
  hud.className = "universe-match-hud";
  host.appendChild(hud);

  const canvasHost = document.createElement("div");
  canvasHost.className = "canvas-host universe-canvas-host";
  host.appendChild(canvasHost);

  const controls = document.createElement("div");
  controls.className = "universe-match-controls";
  host.appendChild(controls);

  // Speed control + skip
  const SPEEDS = [1, 2, 4, 8];
  let simSpeed = 1;
  const speedBtn = document.createElement("button");
  speedBtn.className = "speed-btn";
  speedBtn.textContent = "1×";
  speedBtn.onclick = () => {
    const i = SPEEDS.indexOf(simSpeed);
    simSpeed = SPEEDS[(i + 1) % SPEEDS.length];
    speedBtn.textContent = `${simSpeed}×`;
  };
  controls.appendChild(speedBtn);

  const skipBtn = document.createElement("button");
  skipBtn.className = "speed-btn";
  skipBtn.textContent = "⏭ End round";
  skipBtn.onclick = () => skipRound();
  controls.appendChild(skipBtn);

  const finishBtn = document.createElement("button");
  finishBtn.className = "speed-btn";
  finishBtn.textContent = "⏭⏭ Sim rest";
  finishBtn.onclick = () => { simRestInstantly = true; skipRound(); };
  controls.appendChild(finishBtn);

  const backBtn = document.createElement("button");
  backBtn.className = "speed-btn";
  backBtn.textContent = "← Back";
  backBtn.onclick = () => { cleaned = true; cleanup(); opts.onCancel(); };
  controls.appendChild(backBtn);

  // --- Renderer ---
  const renderer = new Renderer();
  await renderer.init(canvasHost, opts.map);
  const playerLookup = (id: string): Player | undefined =>
    ct.players.find(p => p.id === id) ?? tSide.players.find(p => p.id === id);
  renderer.setNameFor(id => {
    const p = playerLookup(id);
    if (!p) return "";
    const m = p.name.match(/"([^"]+)"/);
    return m ? m[1] : p.name.split(" ")[0];
  });

  const killFeed = new KillFeed(canvasHost);

  // --- Teams ---
  const ct = buildTeam("ct", opts.ctName, opts.ctPlayers, "CT");
  const tSide = buildTeam("t",  opts.tName,  opts.tPlayers,  "T");
  // After halftime these references swap (the same Team object plays the other side).
  let ctSide: Team = ct;
  let tSideRef: Team = tSide;

  let sim: RoundSim | null = null;
  let simInterval: number | null = null;
  let lossStreaks = { ctLossStreak: 0, tLossStreak: 0 };
  let roundNumber = 1;
  let simRestInstantly = false;
  let lastEventIdx = 0;
  let cleaned = false;

  paintHud();
  startRound();

  function paintHud() {
    const half = roundNumber <= HALFTIME_ROUND ? 1 : 2;
    // Score is tracked per original team identity, not by current side, so the
    // labels stay stable across halftime.
    hud.innerHTML =
      `<span class="ct">${ct.name} ${ct.roundsWon}</span>` +
      `<span class="sep">R${roundNumber} · H${half}</span>` +
      `<span class="t">${tSide.roundsWon} ${tSide.name}</span>`;
  }

  function startRound() {
    if (cleaned) return;
    aiBuyFor(ctSide, roundNumber, isPistolRound);
    aiBuyFor(tSideRef, roundNumber, isPistolRound);
    sim = new RoundSim(ctSide, tSideRef, opts.map, Math.floor(Math.random() * 1e9));
    lastEventIdx = 0;
    renderer.clearTransient();
    paintHud();
    if (simRestInstantly) {
      skipRound();
    } else {
      simInterval = window.setInterval(tickRound, 50);
    }
  }

  function tickRound() {
    if (!sim || cleaned) return;
    for (let s = 0; s < simSpeed && !sim.finished; s++) sim.tick();
    drainEvents();
    renderer.syncAgents(sim);
    if (sim.finished && sim.result) {
      if (simInterval) clearInterval(simInterval);
      simInterval = null;
      finishRound();
    }
  }

  function skipRound() {
    if (!sim || cleaned) return;
    if (simInterval) { clearInterval(simInterval); simInterval = null; }
    let safety = 100000;
    while (sim && !sim.finished && safety-- > 0) sim.tick();
    drainEvents();
    if (sim.finished && sim.result) finishRound();
  }

  function drainEvents() {
    if (!sim) return;
    for (let i = lastEventIdx; i < sim.events.length; i++) {
      const e = sim.events[i];
      if (e.kind === "kill") {
        const k = playerLookup(e.killer);
        const v = playerLookup(e.victim);
        const kSide: Side | null = k ? sideOfPlayer(e.killer) : null;
        const vSide: Side | null = v ? sideOfPlayer(e.victim) : null;
        if (k && v && kSide && vSide) {
          killFeed.push(
            { name: shortName(k), side: kSide },
            { name: shortName(v), side: vSide },
            e.weapon, e.headshot,
          );
        }
      }
    }
    lastEventIdx = sim.events.length;
  }

  function sideOfPlayer(id: string): Side | null {
    if (ctSide.players.some(p => p.id === id)) return ctSide.side;
    if (tSideRef.players.some(p => p.id === id)) return tSideRef.side;
    return null;
  }

  function shortName(p: Player | undefined): string {
    if (!p) return "?";
    const m = p.name.match(/"([^"]+)"/);
    return m ? m[1] : p.name.split(" ")[0];
  }

  function finishRound() {
    if (!sim || !sim.result || cleaned) return;
    const r = sim.result;
    const winner = r.winningSide === "CT" ? ctSide : tSideRef;
    winner.roundsWon++;
    lossStreaks = applyRoundReward(ctSide, tSideRef, r, lossStreaks.ctLossStreak, lossStreaks.tLossStreak);
    carryOverLoadouts(ctSide, sim);
    carryOverLoadouts(tSideRef, sim);

    paintHud();

    const matchOver =
      ct.roundsWon >= WIN_THRESHOLD ||
      tSide.roundsWon >= WIN_THRESHOLD ||
      roundNumber >= MAX_ROUNDS;

    if (matchOver) {
      const winnerSide: "CT" | "T" = ct.roundsWon > tSide.roundsWon ? "CT" : "T";
      const result: MatchResult = { ctScore: ct.roundsWon, tScore: tSide.roundsWon, winnerSide };
      cleanup();
      opts.onDone(result);
      return;
    }

    roundNumber++;
    if (roundNumber === HALFTIME_ROUND + 1) halftimeSwap();

    // Brief pause between rounds so the result is visible. Skip the pause when
    // sim-rest mode is on.
    if (simRestInstantly) startRound();
    else setTimeout(() => startRound(), 800);
  }

  function halftimeSwap() {
    [ctSide, tSideRef] = [tSideRef, ctSide];
    ctSide.side = "CT";
    tSideRef.side = "T";
    for (const team of [ctSide, tSideRef]) {
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

  function carryOverLoadouts(team: Team, finishedSim: RoundSim) {
    for (const ag of finishedSim.agents) {
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

  function cleanup() {
    cleaned = true;
    if (simInterval) { clearInterval(simInterval); simInterval = null; }
    killFeed.dispose();
    renderer.destroy();
  }

  return { dispose: cleanup };
}
