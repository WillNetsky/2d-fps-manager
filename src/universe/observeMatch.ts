import type { GameMap, Player, Side, Team } from "../domain/types.ts";
import { RoundSim } from "../sim/round.ts";
import { applyRoundReward } from "../sim/economy.ts";
import { aiBuyFor } from "../sim/aiBuy.ts";
import { defaultPistol } from "../domain/weapons.ts";
import { Renderer } from "../render/renderer.ts";
import { KillFeed } from "../ui/killFeed.ts";
import { buildTeam, buildPlayerStats, detectClutch, mulberry32, simulateMatchInstant, tallyMultiKills, MATCH_CONSTANTS, type MatchResult } from "./matchSim.ts";
import type { Clutch } from "./types.ts";
import { Timeline } from "../ui/timeline.ts";
import { TeamPanel } from "../ui/teamPanel.ts";

const TICK_MS = 50;

const { STARTING_BANK, HALFTIME_ROUND, MAX_ROUNDS, isPistolRound, swapBankFor, matchDecided } = MATCH_CONSTANTS;

export interface ObserveMatchOptions {
  ctName: string;
  tName: string;
  ctPlayers: Player[];
  tPlayers: Player[];
  map: GameMap;
  // Master RNG seed — same seed reproduces the same match.
  seed: number;
  // Sim-time morale per player (replay only). The match seeds in-match mood from
  // morale, which drifts day to day, so a replay must use the snapshot to
  // reproduce the stored match. Absent for live play (uses current morale).
  moods?: Record<string, number>;
  // If >1, fast-forward (headless) up to but not including this round, then
  // start live observation from there. Used to jump straight to a clutch.
  startAtRound?: number;
  // True when watching a replay of a saved match — enables the round timeline,
  // round scrubber, and prev/next jumping. Hidden during live first-play so
  // future round outcomes aren't spoiled.
  isReplay?: boolean;
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

  // Replay-only: the round timeline (1..N circles colored by winner side).
  const timelineEl = document.createElement("div");
  timelineEl.className = "universe-match-timeline";
  if (opts.isReplay) host.appendChild(timelineEl);

  // Stage row: left team panel | canvas | right team panel.
  const stage = document.createElement("div");
  stage.className = "universe-match-stage";
  host.appendChild(stage);

  const leftPanelCol = document.createElement("div");
  leftPanelCol.className = "ums-side";
  stage.appendChild(leftPanelCol);

  const canvasHost = document.createElement("div");
  canvasHost.className = "canvas-host universe-canvas-host";
  stage.appendChild(canvasHost);

  const rightPanelCol = document.createElement("div");
  rightPanelCol.className = "ums-side";
  stage.appendChild(rightPanelCol);

  // Replay-only: full timeline scrubber with kill markers (reuses the same
  // widget the live-play replay uses).
  let roundScrub: Timeline | null = null;
  if (opts.isReplay) {
    roundScrub = new Timeline(host, {
      onSeek: (idx) => scrubTo(idx * TICK_MS),
      onPlayPauseToggle: () => togglePlayPause(),
    });
  }

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

  // Replay-only prev / next round buttons.
  if (opts.isReplay) {
    const prevBtn = document.createElement("button");
    prevBtn.className = "speed-btn";
    prevBtn.textContent = "⏮ Prev";
    prevBtn.onclick = () => {
      paused = false;
      jumpToRound(roundNumber - 1);
    };
    controls.appendChild(prevBtn);

    const nextBtn = document.createElement("button");
    nextBtn.className = "speed-btn";
    nextBtn.textContent = "Next ⏭";
    nextBtn.onclick = () => {
      // First click on a fresh paused round → resume that round.
      // Otherwise advance to the next round.
      if (sim && !sim.finished && paused) {
        paused = false;
        simInterval = window.setInterval(tickRound, 50);
        return;
      }
      paused = false;
      jumpToRound(roundNumber + 1);
    };
    controls.appendChild(nextBtn);
  }

  const skipBtn = document.createElement("button");
  skipBtn.className = "speed-btn";
  skipBtn.textContent = "End round";
  skipBtn.onclick = () => skipRound();
  controls.appendChild(skipBtn);

  const finishBtn = document.createElement("button");
  finishBtn.className = "speed-btn";
  finishBtn.textContent = "Sim rest";
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
  // Player lookup stays bound to opts arrays (not the closure team refs) so
  // that jump-to-round can rebuild ct/tSide without invalidating it.
  const playerLookup = (id: string): Player | undefined =>
    opts.ctPlayers.find(p => p.id === id) ?? opts.tPlayers.find(p => p.id === id);
  renderer.setNameFor(id => {
    const p = playerLookup(id);
    return p ? p.handle : "";
  });

  const killFeed = new KillFeed(canvasHost);

  // Pre-scan the deterministic match to get every round's winner & duration
  // up front. Cheap (instant-sim of ~24 rounds) and lets the replay UI show
  // the full timeline immediately without spoiling live first-play.
  const prescan = simulateMatchInstant(
    buildTeam("ct-prescan", "CT", opts.ctPlayers, "CT", opts.moods),
    buildTeam("t-prescan",  "T",  opts.tPlayers,  "T", opts.moods),
    opts.map,
    opts.seed,
  );

  // --- Teams ---
  const ct = buildTeam("ct", opts.ctName, opts.ctPlayers, "CT", opts.moods);
  const tSide = buildTeam("t",  opts.tName,  opts.tPlayers,  "T", opts.moods);
  // Each clone's initial mood, captured so jump/scrub re-sims restart from the
  // exact same conditions (mood drifts round-to-round during a sim).
  const initialMoods = new Map<string, number>();
  for (const team of [ct, tSide]) for (const p of team.players) initialMoods.set(p.id, p.mood);
  // After halftime these references swap (the same Team object plays the other side).
  let ctSide: Team = ct;
  let tSideRef: Team = tSide;

  // Side panels (rosters with loadouts + live stats). Bound to the persistent
  // team objects; resetMatchState() mutates state in-place so these stay valid
  // across jump-to-round operations.
  const leftPanel = new TeamPanel(leftPanelCol, ct);
  const rightPanel = new TeamPanel(rightPanelCol, tSide);

  // Reset both teams to round-1 conditions in place, leaving the TeamPanel
  // bindings intact. Used by jumpToRound when the user navigates the timeline.
  function resetMatchState() {
    ct.side = "CT";
    tSide.side = "T";
    ctSide = ct;
    tSideRef = tSide;
    for (const team of [ct, tSide]) {
      team.roundsWon = 0;
      for (const p of team.players) {
        p.money = STARTING_BANK;
        // Restore mood to the round-1 value — it drifts during a sim, and a
        // jump/scrub re-runs from round 1, so it must reset or replays diverge.
        p.mood = initialMoods.get(p.id) ?? p.mood;
      }
      for (const id of Object.keys(team.matchStats)) {
        team.matchStats[id] = { kills: 0, deaths: 0, assists: 0, damage: 0, roundsPlayed: 0 };
      }
      for (const p of team.players) {
        team.loadouts[p.id] = {
          weapon: defaultPistol(team.side), utility: [], armor: false, helmet: false,
          keptWeapon: null, keptArmor: false, keptHelmet: false, keptUtility: [],
        };
      }
    }
  }

  let sim: RoundSim | null = null;
  let simInterval: number | null = null;
  let lossStreaks = { ctLossStreak: 0, tLossStreak: 0 };
  let roundNumber = 1;
  let simRestInstantly = false;
  let lastEventIdx = 0;
  let cleaned = false;
  // In replay mode we default to paused — the user must click Next (or a
  // timeline dot) to play each round, and we pause again at round end.
  let paused = !!opts.isReplay;
  // Seed actually fed to the current round's RoundSim, captured so the
  // scrubber can rebuild this round from the round-start snapshot.
  let currentRoundSeed = 0;
  // Frozen state at the start of the current round, used for backward scrub.
  let roundStart: RoundStartSnapshot | null = null;
  const roundMvps: Record<string, number> = {};
  const clutches: Clutch[] = [];
  const multi = new Map<string, [number, number, number, number, number]>();
  let masterRng = mulberry32(opts.seed);
  const intFrom = () => Math.floor(masterRng() * 0x100000000);

  renderTimeline();
  paintHud();

  // Jump straight to the requested round if any (clutch click → auto-play),
  // otherwise set up round 1. In replay mode, round 1 stays paused so the
  // user explicitly clicks Next to view it.
  if (opts.startAtRound && opts.startAtRound > 1) {
    paused = false;
    jumpToRound(opts.startAtRound);
  } else {
    startRound();
  }

  function paintHud() {
    // Phase label: H1/H2 in regulation, OT (with block number) in overtime.
    const phase = roundNumber <= HALFTIME_ROUND ? "H1"
      : roundNumber <= MAX_ROUNDS ? "H2"
      : `OT${Math.floor((roundNumber - MAX_ROUNDS - 1) / 6) + 1}`;
    // Color follows the side each team is *currently* playing: whichever
    // team is on CT this half gets the CT color, etc. Team names stay
    // attached to their team identity so the scoreboard still tracks
    // "Team X has N wins" correctly across the halftime swap.
    hud.innerHTML =
      `<span class="ct">${escapeHtmlObs(ctSide.name)} <b>${ctSide.roundsWon}</b></span>` +
      `<span class="sep">R${roundNumber} · ${phase}</span>` +
      `<span class="t"><b>${tSideRef.roundsWon}</b> ${escapeHtmlObs(tSideRef.name)}</span>`;
  }

  function startRound() {
    if (cleaned) return;
    // Side/economy swap at the halftime and each overtime half, before the
    // round's buy — same schedule the instant sim uses.
    const bank = swapBankFor(roundNumber);
    if (bank !== null) swapAndReset(bank);
    aiBuyFor(ctSide,   roundNumber, isPistolRound, mulberry32(intFrom()));
    aiBuyFor(tSideRef, roundNumber, isPistolRound, mulberry32(intFrom()));
    currentRoundSeed = intFrom();
    // Snapshot team state AFTER aiBuy so the scrubber can restart the round
    // from the same conditions the live sim is using.
    roundStart = snapshotRoundStart();

    // For the scrubber's kill markers we need this round's event stream up
    // front. Run a headless sub-sim with the same seed, capture events, then
    // restore state before kicking off the live sim. The sub-sim mutates
    // team.matchStats — restoreRoundStart undoes that.
    let roundEvents: import("../domain/types.ts").SimEvent[] = [];
    let roundDurationMs = 0;
    if (opts.isReplay) {
      const headless = new RoundSim(ctSide, tSideRef, opts.map, currentRoundSeed);
      let safety = 100000;
      while (!headless.finished && safety-- > 0) headless.tick();
      roundEvents = [...headless.events];
      roundDurationMs = headless.t;
      restoreRoundStart(roundStart);
    }

    sim = new RoundSim(ctSide, tSideRef, opts.map, currentRoundSeed);
    lastEventIdx = 0;
    killFeed.clear();
    renderer.clearTransient();
    renderer.syncAgents(sim);
    paintHud();
    renderTimeline();
    leftPanel.setAgents(sim.agents);
    rightPanel.setAgents(sim.agents);
    if (roundScrub) {
      const totalTicks = Math.max(1, Math.ceil(roundDurationMs / TICK_MS) + 1);
      roundScrub.setReplay(totalTicks, roundEvents, TICK_MS, `Round ${roundNumber}`, sideOfPlayer);
      roundScrub.setIndex(0);
      roundScrub.setPlaying(!paused);
    }
    if (paused) return;
    if (simRestInstantly) {
      skipRound();
    } else {
      simInterval = window.setInterval(tickRound, 50);
    }
  }

  function togglePlayPause() {
    if (!sim || cleaned) return;
    if (sim.finished) {
      // Replay this round from the start.
      if (roundStart) {
        restoreRoundStart(roundStart);
        sim = new RoundSim(ctSide, tSideRef, opts.map, currentRoundSeed);
        lastEventIdx = 0;
        killFeed.clear();
        renderer.clearTransient();
        renderer.syncAgents(sim);
      }
    }
    paused = !paused;
    if (paused) {
      if (simInterval) { clearInterval(simInterval); simInterval = null; }
    } else if (!simInterval) {
      simInterval = window.setInterval(tickRound, 50);
    }
    roundScrub?.setPlaying(!paused);
  }

  function tickRound() {
    if (!sim || cleaned) return;
    for (let s = 0; s < simSpeed && !sim.finished; s++) sim.tick();
    drainEvents();
    renderer.syncAgents(sim);
    leftPanel.setAgents(sim.agents);
    rightPanel.setAgents(sim.agents);
    roundScrub?.setIndex(Math.floor(sim.t / TICK_MS));
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
    return p ? p.handle : "?";
  }

  // `roundNumber` is the round that just finished here (matches the instant
  // sim's "rounds played" check), so regulation + overtime resolve identically.
  function matchIsOver(): boolean {
    return matchDecided(ct.roundsWon, tSide.roundsWon, roundNumber);
  }

  function applyRoundOutcome(finished: RoundSim) {
    const r = finished.result!;
    const winner = r.winningSide === "CT" ? ctSide : tSideRef;
    winner.roundsWon++;
    const clutch = detectClutch(r, ctSide.players.map(p => p.id), tSideRef.players.map(p => p.id));
    if (clutch) clutches.push({ ...clutch, round: roundNumber });
    tallyMultiKills(r, multi);
    lossStreaks = applyRoundReward(ctSide, tSideRef, r, lossStreaks.ctLossStreak, lossStreaks.tLossStreak);
    carryOverLoadouts(ctSide, finished);
    carryOverLoadouts(tSideRef, finished);
    const mvpId = pickRoundMvp(r, winner);
    if (mvpId) roundMvps[mvpId] = (roundMvps[mvpId] ?? 0) + 1;
  }

  function finishRound() {
    if (!sim || !sim.result || cleaned) return;
    applyRoundOutcome(sim);
    paintHud();
    renderTimeline();
    if (roundScrub && sim) roundScrub.setIndex(Math.floor(sim.t / TICK_MS));
    roundScrub?.setPlaying(false);

    if (matchIsOver()) {
      const winnerSide: "CT" | "T" = ct.roundsWon > tSide.roundsWon ? "CT" : "T";
      const result: MatchResult = {
        ctScore: ct.roundsWon, tScore: tSide.roundsWon, winnerSide, clutches,
        playerStats: buildPlayerStats(ct, tSide, multi),
      };
      // In replay we leave the UI intact so the user can keep navigating the
      // timeline; in live first-play we hand off to the postgame screen.
      if (!opts.isReplay) showPostgame(result);
      else paused = true;
      return;
    }

    // In replay, pause between rounds — user clicks Next to advance.
    if (opts.isReplay) {
      paused = true;
      return;
    }

    roundNumber++;
    // The side swap now happens in startRound (via swapBankFor), so it's applied
    // consistently for both live play and replay jumps.

    // Brief pause between rounds so the result is visible. Skip the pause when
    // sim-rest mode is on.
    if (simRestInstantly) startRound();
    else setTimeout(() => startRound(), 800);
  }

  // --- Replay navigation ---

  interface RoundStartSnapshot {
    ctMoney: Record<string, number>;
    tMoney: Record<string, number>;
    ctLoadouts: Team["loadouts"];
    tLoadouts: Team["loadouts"];
    ctMatchStats: Team["matchStats"];
    tMatchStats: Team["matchStats"];
  }

  function snapshotRoundStart(): RoundStartSnapshot {
    const moneyOf = (t: Team) => Object.fromEntries(t.players.map(p => [p.id, p.money]));
    return {
      ctMoney: moneyOf(ctSide),
      tMoney: moneyOf(tSideRef),
      ctLoadouts: JSON.parse(JSON.stringify(ctSide.loadouts)),
      tLoadouts: JSON.parse(JSON.stringify(tSideRef.loadouts)),
      ctMatchStats: JSON.parse(JSON.stringify(ctSide.matchStats)),
      tMatchStats: JSON.parse(JSON.stringify(tSideRef.matchStats)),
    };
  }

  function restoreRoundStart(s: RoundStartSnapshot) {
    for (const p of ctSide.players) p.money = s.ctMoney[p.id] ?? p.money;
    for (const p of tSideRef.players) p.money = s.tMoney[p.id] ?? p.money;
    ctSide.loadouts = JSON.parse(JSON.stringify(s.ctLoadouts));
    tSideRef.loadouts = JSON.parse(JSON.stringify(s.tLoadouts));
    ctSide.matchStats = JSON.parse(JSON.stringify(s.ctMatchStats));
    tSideRef.matchStats = JSON.parse(JSON.stringify(s.tMatchStats));
  }

  // Resimulate from round 1 up to (and starting) the target round. Resets the
  // live UI state along the way so the timeline stays consistent.
  function jumpToRound(target: number) {
    if (cleaned) return;
    const total = prescan.roundOutcomes?.length ?? MAX_ROUNDS;
    target = Math.max(1, Math.min(target, total));
    if (simInterval) { clearInterval(simInterval); simInterval = null; }
    sim = null;
    lastEventIdx = 0;
    killFeed.clear();
    renderer.clearTransient();

    // Reset the match in-place so the bound TeamPanels keep working.
    resetMatchState();
    roundNumber = 1;
    lossStreaks = { ctLossStreak: 0, tLossStreak: 0 };
    masterRng = mulberry32(opts.seed);
    clutches.length = 0;
    multi.clear();
    for (const k of Object.keys(roundMvps)) delete roundMvps[k];

    // Headlessly simulate every round before the target so state lines up.
    // Swaps follow the same swapBankFor schedule used live and in the instant sim.
    while (roundNumber < target) {
      const bank = swapBankFor(roundNumber);
      if (bank !== null) swapAndReset(bank);
      aiBuyFor(ctSide,   roundNumber, isPistolRound, mulberry32(intFrom()));
      aiBuyFor(tSideRef, roundNumber, isPistolRound, mulberry32(intFrom()));
      const headless = new RoundSim(ctSide, tSideRef, opts.map, intFrom());
      let safety = 100000;
      while (!headless.finished && safety-- > 0) headless.tick();
      if (!headless.result) break;
      applyRoundOutcome(headless);
      // Never resim past match point — guards against a divergent re-sim piling
      // up impossible scores.
      if (matchIsOver()) break;
      roundNumber++;
    }
    startRound();
  }

  // Scrub to a specific millisecond within the current round.
  function scrubTo(targetMs: number) {
    if (!sim || !roundStart) return;
    if (simInterval) { clearInterval(simInterval); simInterval = null; }
    if (targetMs < sim.t) {
      // Backward: restore round-start state and rebuild this round's sim.
      restoreRoundStart(roundStart);
      sim = new RoundSim(ctSide, tSideRef, opts.map, currentRoundSeed);
      lastEventIdx = 0;
      killFeed.clear();
      renderer.clearTransient();
    }
    let safety = 100000;
    while (sim && !sim.finished && sim.t < targetMs && safety-- > 0) sim.tick();
    drainEvents();
    renderer.syncAgents(sim);
    if (sim) {
      leftPanel.setAgents(sim.agents);
      rightPanel.setAgents(sim.agents);
    }
    roundScrub?.setIndex(Math.floor(sim.t / TICK_MS));
    // Resume live ticking only if the user was already playing — scrubbing
    // shouldn't unpause.
    if (sim && !sim.finished && !paused) simInterval = window.setInterval(tickRound, 50);
    else if (sim && sim.finished) finishRound();
  }

  // --- Replay UI rendering ---

  function renderTimeline() {
    if (!opts.isReplay) return;
    timelineEl.innerHTML = "";
    const outcomes = prescan.roundOutcomes ?? [];
    outcomes.forEach((o) => {
      const dot = document.createElement("button");
      dot.className = "umt-dot " + (o.winnerSide === "CT" ? "ct-win" : "t-win");
      if (o.round === roundNumber) dot.classList.add("active");
      dot.textContent = String(o.round);
      dot.title = `Round ${o.round} — ${o.winnerSide} (${o.ctScoreAfter}-${o.tScoreAfter})`;
      dot.onclick = () => {
        paused = false;
        jumpToRound(o.round);
      };
      timelineEl.appendChild(dot);
      if (o.round === HALFTIME_ROUND) {
        const half = document.createElement("span");
        half.className = "umt-half";
        timelineEl.appendChild(half);
      }
    });
  }

  // Swap which roster is on which side and reset both economies to `bank` with
  // fresh pistol loadouts — the halftime and each overtime half. Mirrors the
  // instant sim's swapAndReset so live/replay stay in lockstep.
  function swapAndReset(bank: number) {
    [ctSide, tSideRef] = [tSideRef, ctSide];
    ctSide.side = "CT";
    tSideRef.side = "T";
    for (const team of [ctSide, tSideRef]) {
      for (const p of team.players) {
        p.money = bank;
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

function escapeHtmlObs(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

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
      `<div class="pg-mvp-name">${escapePg(shortNamePg(mvpPlayer))}</div>` +
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
  return p.handle;
}

function escapePg(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}
