import type { GameMap, Player, Side, Team } from "../domain/types.ts";
import { RoundSim } from "../sim/round.ts";
import { applyRoundReward } from "../sim/economy.ts";
import { aiBuyFor } from "../sim/aiBuy.ts";
import { defaultPistol } from "../domain/weapons.ts";
import { Renderer } from "../render/renderer.ts";
import { KillFeed } from "../ui/killFeed.ts";
import { buildTeam, buildPlayerStats, detectClutch, tallyMultiKills, MATCH_CONSTANTS, type MatchResult } from "./matchSim.ts";
import type { Clutch } from "./types.ts";

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
  const roundMvps: Record<string, number> = {};
  const clutches: Clutch[] = [];
  const multi = new Map<string, [number, number, number, number, number]>();

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
    const clutch = detectClutch(r, ctSide.players.map(p => p.id), tSideRef.players.map(p => p.id));
    if (clutch) clutches.push(clutch);
    tallyMultiKills(r, multi);
    lossStreaks = applyRoundReward(ctSide, tSideRef, r, lossStreaks.ctLossStreak, lossStreaks.tLossStreak);
    carryOverLoadouts(ctSide, sim);
    carryOverLoadouts(tSideRef, sim);

    // Round MVP: most kills on the winning team, fallback to plant / defuse.
    const mvpId = pickRoundMvp(r, winner);
    if (mvpId) roundMvps[mvpId] = (roundMvps[mvpId] ?? 0) + 1;

    paintHud();

    const matchOver =
      ct.roundsWon >= WIN_THRESHOLD ||
      tSide.roundsWon >= WIN_THRESHOLD ||
      roundNumber >= MAX_ROUNDS;

    if (matchOver) {
      const winnerSide: "CT" | "T" = ct.roundsWon > tSide.roundsWon ? "CT" : "T";
      const result: MatchResult = {
        ctScore: ct.roundsWon, tScore: tSide.roundsWon, winnerSide, clutches,
        playerStats: buildPlayerStats(ct, tSide, multi),
      };
      showPostgame(result);
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

  function showPostgame(result: MatchResult) {
    // Tear down live UI but defer the onDone callback until the user dismisses
    // the postgame card.
    if (simInterval) { clearInterval(simInterval); simInterval = null; }
    killFeed.dispose();
    renderer.destroy();
    cleaned = true;
    host.innerHTML = "";
    host.className = "universe-postgame";
    renderPostgame(host, {
      ct, tSide, result, roundMvps,
      onContinue: () => opts.onDone(result),
    });
  }

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    if (simInterval) { clearInterval(simInterval); simInterval = null; }
    killFeed.dispose();
    renderer.destroy();
  }

  return { dispose: cleanup };
}

// ---- Round MVP ----

function pickRoundMvp(r: import("../domain/types.ts").RoundResult, winner: Team): string | null {
  const kills = new Map<string, number>();
  for (const e of r.events) {
    if (e.kind !== "kill") continue;
    if (!winner.players.some(p => p.id === e.killer)) continue;
    kills.set(e.killer, (kills.get(e.killer) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestKills = 0;
  for (const [id, k] of kills) {
    if (k > bestKills) { bestKills = k; best = id; }
  }
  if (best) return best;
  // No kills on the winning side — credit the objective player.
  if (r.winningSide === "T") {
    const plant = r.events.find(e => e.kind === "bomb-plant");
    if (plant && plant.kind === "bomb-plant") return plant.planter;
  } else {
    const def = r.events.find(e => e.kind === "bomb-defuse");
    if (def && def.kind === "bomb-defuse") return def.defuser;
  }
  return null;
}

// ---- Postgame screen ----

interface PostgameOptions {
  ct: Team;
  tSide: Team;
  result: MatchResult;
  roundMvps: Record<string, number>;
  onContinue: () => void;
}

function renderPostgame(host: HTMLElement, opts: PostgameOptions): void {
  const { ct, tSide, result, roundMvps, onContinue } = opts;
  const winningTeam = result.winnerSide === "CT" ? ct : tSide;

  const wrap = document.createElement("div");
  wrap.className = "postgame-wrap";

  // Header — score
  const header = document.createElement("div");
  header.className = "postgame-header";
  header.innerHTML =
    `<div class="postgame-team-name ct">${escapePg(ct.name)}</div>` +
    `<div class="postgame-score">` +
      `<span class="ct${result.winnerSide === "CT" ? " winner" : ""}">${result.ctScore}</span>` +
      `<span class="sep">:</span>` +
      `<span class="t${result.winnerSide === "T" ? " winner" : ""}">${result.tScore}</span>` +
    `</div>` +
    `<div class="postgame-team-name t">${escapePg(tSide.name)}</div>`;
  wrap.appendChild(header);

  // Match MVP
  const allPlayers = [...ct.players, ...tSide.players];
  const mvpScore = (id: string) => {
    const team = ct.players.some(p => p.id === id) ? ct : tSide;
    const s = team.matchStats[id];
    return (roundMvps[id] ?? 0) * 5 + s.kills * 2 + s.assists + s.damage / 50;
  };
  let mvpId: string | null = null;
  let bestScore = -Infinity;
  for (const p of allPlayers) {
    const sc = mvpScore(p.id);
    if (sc > bestScore) { bestScore = sc; mvpId = p.id; }
  }
  if (mvpId) {
    const mvpPlayer = allPlayers.find(p => p.id === mvpId)!;
    const team = ct.players.some(p => p.id === mvpId) ? ct : tSide;
    const onWinner = team === winningTeam;
    const s = team.matchStats[mvpId];
    const mvpCard = document.createElement("div");
    mvpCard.className = "postgame-mvp";
    mvpCard.innerHTML =
      `<div class="pg-mvp-label">Match MVP${onWinner ? "" : " <span class='pg-mvp-sub'>(losing side)</span>"}</div>` +
      `<div class="pg-mvp-name">${escapePg(mvpPlayer.name)}</div>` +
      `<div class="pg-mvp-line">${s.kills} K · ${s.deaths} D · ${s.assists} A · ${roundMvps[mvpId] ?? 0} round MVP${(roundMvps[mvpId] ?? 0) === 1 ? "" : "s"} · ${Math.round(s.damage)} dmg</div>`;
    wrap.appendChild(mvpCard);
  }

  // Two team tables side by side.
  const tables = document.createElement("div");
  tables.className = "postgame-tables";
  tables.appendChild(teamStatsTable(ct, roundMvps, mvpId, "ct"));
  tables.appendChild(teamStatsTable(tSide, roundMvps, mvpId, "t"));
  wrap.appendChild(tables);

  // Continue button
  const actions = document.createElement("div");
  actions.className = "postgame-actions";
  const btn = document.createElement("button");
  btn.className = "universe-btn primary big";
  btn.textContent = "Continue →";
  btn.onclick = onContinue;
  actions.appendChild(btn);
  wrap.appendChild(actions);

  host.appendChild(wrap);
}

function teamStatsTable(team: Team, roundMvps: Record<string, number>, mvpId: string | null, side: "ct" | "t"): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = `postgame-team postgame-team-${side}`;

  const title = document.createElement("div");
  title.className = "postgame-team-title";
  title.textContent = team.name;
  wrap.appendChild(title);

  const table = document.createElement("table");
  table.className = "postgame-table";
  table.innerHTML =
    `<thead><tr><th>Player</th><th>K</th><th>D</th><th>A</th><th>MVP</th><th>DMG</th></tr></thead>`;
  const tbody = document.createElement("tbody");
  const sorted = [...team.players].sort((a, b) => {
    const sa = team.matchStats[a.id], sb = team.matchStats[b.id];
    return (sb.kills - sa.kills) || (sb.damage - sa.damage);
  });
  for (const p of sorted) {
    const s = team.matchStats[p.id];
    const tr = document.createElement("tr");
    if (p.id === mvpId) tr.className = "is-mvp";
    tr.innerHTML =
      `<td class="pg-name">${escapePg(shortNamePg(p))}</td>` +
      `<td>${s.kills}</td>` +
      `<td>${s.deaths}</td>` +
      `<td>${s.assists}</td>` +
      `<td>${roundMvps[p.id] ?? 0}</td>` +
      `<td>${Math.round(s.damage)}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function shortNamePg(p: Player): string {
  const m = p.name.match(/"([^"]+)"/);
  return m ? m[1] : p.name.split(" ")[0];
}

function escapePg(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
