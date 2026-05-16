import "./styles.css";
import { makeMap, makeTeam, setSeed } from "./domain/factory.ts";
import { RoundSim } from "./sim/round.ts";
import { applyRoundReward } from "./sim/economy.ts";
import { ReplayPlayer } from "./sim/replay.ts";
import { Renderer } from "./render/renderer.ts";
import { BuyPanel } from "./ui/buyPanel.ts";
import { TeamPanel } from "./ui/teamPanel.ts";
import { Timeline } from "./ui/timeline.ts";
import type { Player, Team } from "./domain/types.ts";

setSeed(Date.now());

const app = document.getElementById("app")!;
app.innerHTML = "";

const leftCol = document.createElement("div");
leftCol.style.display = "contents";
const stage = document.createElement("div");
stage.className = "stage";
const rightCol = document.createElement("div");
rightCol.style.display = "contents";
app.appendChild(leftCol);
app.appendChild(stage);
app.appendChild(rightCol);

// --- MR12 config ---
const STARTING_BANK = 3000;
const HALFTIME_ROUND = 12;
const WIN_THRESHOLD = 13;
const MAX_ROUNDS = 24;
const isPistolRound = (n: number) => n === 1 || n === HALFTIME_ROUND + 1;

// --- Teams ---
const map = makeMap();
const home = makeTeam("home", "Northwind GG", "CT");
const away = makeTeam("away", "Crimson Dust", "T");

let homeIsCt = true;
const ctSideTeam = (): Team => homeIsCt ? home : away;
const tSideTeam = (): Team => homeIsCt ? away : home;

// Initial loadouts
for (const team of [home, away]) for (const p of team.players) {
  team.loadouts[p.id] = {
    weapon: "pistol", utility: [], armor: false, helmet: false,
    keptWeapon: null, keptArmor: false, keptHelmet: false,
  };
}

const playerLookup = (id: string): Player | undefined =>
  home.players.find(p => p.id === id) ?? away.players.find(p => p.id === id);

let lossStreaks = { ctLossStreak: 0, tLossStreak: 0 };
let roundNumber = 1;

// --- Stage / renderer ---
const canvasHost = document.createElement("div");
canvasHost.className = "canvas-host";
stage.appendChild(canvasHost);

const renderer = new Renderer();
await renderer.init(canvasHost, map);
renderer.setNameFor((id) => {
  const p = playerLookup(id);
  if (!p) return "";
  const m = p.name.match(/"([^"]+)"/);
  return m ? m[1] : p.name.split(" ")[0];
});

// --- Panels ---
const buyPanel = new BuyPanel(leftCol, home, { onStart: startRound });
const homeLivePanel = new TeamPanel(leftCol, home);
homeLivePanel.el.style.display = "none";
const oppPanel = new TeamPanel(rightCol, away);
oppPanel.log(`Match start — ${home.name} (CT) vs ${away.name} (T)`);

aiBuyForAway();
buyPanel.setRound(roundNumber);
oppPanel.refresh();

// --- HUD ---
const hud = document.createElement("div");
hud.className = "hud";
canvasHost.appendChild(hud);

// --- Replay ---
const replayPlayer = new ReplayPlayer();
const timeline = new Timeline(stage, {
  onSeek: (idx) => { replayPlayer.seek(idx); },
  onPlayPauseToggle: () => {
    replayPlayer.togglePlay();
    timeline.setPlaying(replayPlayer.isPlaying());
  },
});
timeline.el.style.display = "none";
replayPlayer.setOnFrame((view, idx) => {
  renderer.syncAgents(view);
  timeline.setIndex(idx);
});

function paintHud() {
  const half = roundNumber <= HALFTIME_ROUND ? 1 : 2;
  const homeSide = homeIsCt ? "CT" : "T";
  const awaySide = homeIsCt ? "T" : "CT";
  hud.innerHTML =
    `<span class="ct">${home.name} (${homeSide}) ${home.roundsWon}</span>` +
    `<span class="sep">— R${roundNumber} H${half} —</span>` +
    `<span class="t">${away.roundsWon} (${awaySide}) ${away.name}</span>`;
}
paintHud();

let sim: RoundSim | null = null;
let simInterval: number | null = null;
let lastEventIdx = 0;
let lastRotationIdx = 0;

function aiBuyForAway() {
  type WId = import("./domain/types.ts").WeaponId;
  type UId = import("./domain/types.ts").UtilityId;
  const WPRICE: Record<WId, number> = { knife: 0, pistol: 0, smg: 1250, rifle: 2700, awp: 4750 };
  const VEST = 650;
  const HELMET = 350;
  const UPRICE: Record<UId, number> = { smoke: 300, flash: 200, he: 300, molotov: 400 };

  let budget = away.money;
  const players = away.players;

  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const existing = away.loadouts[p.id];
    const kept = existing.keptWeapon;
    const keptArmor = existing.keptArmor;
    const keptHelmet = existing.keptHelmet;
    const remaining = players.length - i;
    const share = Math.floor(budget / remaining);
    const wCost = (w: WId) => w === kept ? 0 : WPRICE[w];

    let weapon: WId = kept ?? "pistol";
    if (isPistolRound(roundNumber)) {
      weapon = "pistol";
    } else {
      if (p.role === "awper" && weapon !== "awp" && share >= wCost("awp")) weapon = "awp";
      else if (weapon !== "rifle" && weapon !== "awp" && share >= wCost("rifle")) weapon = "rifle";
      else if (weapon === "pistol" && share >= wCost("smg")) weapon = "smg";
    }

    let spent = wCost(weapon);
    let armor = keptArmor;
    let helmet = keptHelmet;
    if (!armor && weapon !== "pistol" && share - spent >= VEST) { armor = true; spent += VEST; }
    if (armor && !helmet && weapon !== "pistol" && share - spent >= HELMET) { helmet = true; spent += HELMET; }

    const util: UId[] = [];
    const want: UId = (p.role === "igl" || p.role === "support") ? "smoke" : "flash";
    if (share - spent >= UPRICE[want]) { util.push(want); spent += UPRICE[want]; }

    away.loadouts[p.id] = {
      weapon, utility: util, armor, helmet,
      keptWeapon: kept, keptArmor, keptHelmet,
    };
    budget -= spent;
  }

  away.money = Math.max(0, budget);
}

function halftimeSwap() {
  homeIsCt = !homeIsCt;
  home.side = homeIsCt ? "CT" : "T";
  away.side = homeIsCt ? "T" : "CT";
  // Economy reset across halves
  home.money = STARTING_BANK;
  away.money = STARTING_BANK;
  for (const team of [home, away]) {
    for (const p of team.players) {
      team.loadouts[p.id] = {
        weapon: "pistol", utility: [], armor: false, helmet: false,
        keptWeapon: null, keptArmor: false, keptHelmet: false,
      };
    }
  }
  lossStreaks = { ctLossStreak: 0, tLossStreak: 0 };
  oppPanel.log(`=== HALFTIME · sides switched ===`);
}

function startRound() {
  buyPanel.refresh();

  replayPlayer.pause();
  timeline.el.style.display = "none";
  renderer.clearTransient();

  sim = new RoundSim(ctSideTeam(), tSideTeam(), map, Math.floor(Math.random() * 1e9));
  lastEventIdx = 0;
  lastRotationIdx = 0;
  oppPanel.clearLog();
  oppPanel.log(`— Round ${roundNumber} begins —`);
  oppPanel.log(`T strategy: ${sim.tStrategy} · CT setup: ${sim.ctSetup.A}A/${sim.ctSetup.B}B/${sim.ctSetup.mid}M`);

  buyPanel.el.style.display = "none";
  homeLivePanel.el.style.display = "";
  homeLivePanel.refresh();

  simInterval = window.setInterval(tickRound, 50);
}

function tickRound() {
  if (!sim) return;
  sim.tick();

  for (let i = lastEventIdx; i < sim.events.length; i++) {
    const e = sim.events[i];
    if (e.kind === "kill") {
      const k = playerLookup(e.killer);
      const v = playerLookup(e.victim);
      const hs = e.headshot ? " 🎯" : "";
      oppPanel.log(`${shortName(k)} [${e.weapon}]${hs} → ${shortName(v)}`);
    } else if (e.kind === "bomb-plant") {
      const planter = playerLookup(e.planter);
      const site = nearestSiteLetter(sim);
      oppPanel.log(`💣 ${shortName(planter)} planted on ${site}`);
      renderer.flashSite(site);
    } else if (e.kind === "bomb-defuse") {
      oppPanel.log(`🛡 ${shortName(playerLookup(e.defuser))} defused`);
    } else if (e.kind === "bomb-detonate") {
      oppPanel.log(`💥 bomb detonated`);
    }
  }
  lastEventIdx = sim.events.length;

  for (let i = lastRotationIdx; i < sim.rotationLog.length; i++) {
    const r = sim.rotationLog[i];
    const p = playerLookup(r.agentId);
    oppPanel.log(`↪ ${shortName(p)} rotates ${r.from}→${r.to}`);
  }
  lastRotationIdx = sim.rotationLog.length;

  renderer.syncAgents(sim);
  oppPanel.setAgents(sim.agents);
  homeLivePanel.setAgents(sim.agents);

  if (sim.finished && sim.result) {
    if (simInterval) clearInterval(simInterval);
    simInterval = null;
    const r = sim.result;
    const winningTeam = r.winningSide === "CT" ? ctSideTeam() : tSideTeam();
    winningTeam.roundsWon++;
    lossStreaks = applyRoundReward(ctSideTeam(), tSideTeam(), r, lossStreaks.ctLossStreak, lossStreaks.tLossStreak);
    oppPanel.log(`Round ${roundNumber} → ${winningTeam.name} wins (${r.outcome})`);

    // Carry over kept weapons/armor/helmet
    for (const ag of sim.agents) {
      const team = home.players.some(p => p.id === ag.playerId) ? home : away;
      if (ag.alive) {
        const hasVest = ag.armor > 30;
        team.loadouts[ag.playerId] = {
          weapon: ag.weapon,
          utility: [],
          armor: hasVest,
          helmet: ag.helmet,
          keptWeapon: ag.weapon === "knife" ? null : ag.weapon,
          keptArmor: hasVest,
          keptHelmet: ag.helmet,
        };
      } else {
        team.loadouts[ag.playerId] = {
          weapon: "pistol", utility: [], armor: false, helmet: false,
          keptWeapon: null, keptArmor: false, keptHelmet: false,
        };
      }
    }

    // Mood drift
    for (const p of winningTeam.players) p.mood = clamp(p.mood + 3, 0, 100);
    const losingTeam = winningTeam === home ? away : home;
    for (const p of losingTeam.players) p.mood = clamp(p.mood - 4, 0, 100);

    roundNumber++;

    // Halftime swap before any UI for the next round.
    if (roundNumber === HALFTIME_ROUND + 1) {
      halftimeSwap();
    }

    paintHud();

    const matchOver = home.roundsWon >= WIN_THRESHOLD || away.roundsWon >= WIN_THRESHOLD || roundNumber > MAX_ROUNDS;
    if (matchOver) {
      const winner = home.roundsWon > away.roundsWon ? home.name
        : away.roundsWon > home.roundsWon ? away.name
        : "Draw";
      oppPanel.log(`=== MATCH OVER · ${winner} ===`);
      homeLivePanel.el.style.display = "none";
      buyPanel.el.style.display = "";
      buyPanel.refresh();
      return;
    }

    const finishedSim = sim;
    setTimeout(() => {
      homeLivePanel.el.style.display = "none";
      buyPanel.el.style.display = "";
      aiBuyForAway();
      buyPanel.setRound(roundNumber);
      oppPanel.refresh();

      if (finishedSim && finishedSim.snapshots.length > 0) {
        renderer.clearTransient();
        replayPlayer.load({
          map,
          snapshots: finishedSim.snapshots,
          events: finishedSim.events,
          tickMs: 50,
        });
        timeline.setReplay(finishedSim.snapshots.length, finishedSim.events, 50, `REPLAY · round ${roundNumber - 1}`);
        timeline.el.style.display = "";
        replayPlayer.play();
        timeline.setPlaying(true);
      }
    }, 1200);
  }
}

function shortName(p: Player | undefined): string {
  if (!p) return "?";
  const m = p.name.match(/"([^"]+)"/);
  return m ? m[1] : p.name.split(" ")[0];
}

function nearestSiteLetter(sim: RoundSim): "A" | "B" {
  if (!sim.bombPlantedAt) return "A";
  let best: "A" | "B" = "A";
  let bd = Infinity;
  for (const s of sim.map.bombsites) {
    const cx = (s.center.x + 0.5) * sim.map.tileSize;
    const cy = (s.center.y + 0.5) * sim.map.tileSize;
    const d = Math.hypot(cx - sim.bombPlantedAt.x, cy - sim.bombPlantedAt.y);
    if (d < bd) { bd = d; best = s.id; }
  }
  return best;
}

function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
