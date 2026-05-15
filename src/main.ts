import "./styles.css";
import { makeMap, makeTeam, setSeed } from "./domain/factory.ts";
import { RoundSim } from "./sim/round.ts";
import { applyRoundReward } from "./sim/economy.ts";
import { ReplayPlayer } from "./sim/replay.ts";
import { Renderer } from "./render/renderer.ts";
import { BuyPanel } from "./ui/buyPanel.ts";
import { TeamPanel } from "./ui/teamPanel.ts";
import { Timeline } from "./ui/timeline.ts";
import type { Player } from "./domain/types.ts";

setSeed(Date.now());

const app = document.getElementById("app")!;
app.innerHTML = "";

// Layout: left panel (buy), center stage (sim), right panel (opponent + log)
const leftCol = document.createElement("div");
leftCol.style.display = "contents";
const stage = document.createElement("div");
stage.className = "stage";
const rightCol = document.createElement("div");
rightCol.style.display = "contents";
app.appendChild(leftCol);
app.appendChild(stage);
app.appendChild(rightCol);

// Game state
const map = makeMap();
const ct = makeTeam("home", "Northwind GG", "CT");
const t = makeTeam("away", "Crimson Dust", "T");

// Equip pistols for round 1 by default
for (const team of [ct, t]) for (const p of team.players) {
  team.loadouts[p.id] = {
    weapon: "pistol", utility: [], armor: false,
    keptWeapon: null, keptArmor: false,
  };
}

const playerLookup = (id: string): Player | undefined =>
  ct.players.find(p => p.id === id) ?? t.players.find(p => p.id === id);

let lossStreaks = { ctLossStreak: 0, tLossStreak: 0 };
let roundNumber = 1;
const MAX_ROUNDS = 16;

// Stage layout: canvas host on top, timeline below.
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

const buyPanel = new BuyPanel(leftCol, ct, { onStart: startRound });
const ctLivePanel = new TeamPanel(leftCol, ct);
ctLivePanel.el.style.display = "none";
const oppPanel = new TeamPanel(rightCol, t);
oppPanel.log(`Match start — ${ct.name} (CT) vs ${t.name} (T)`);

// T buys at the start of every buy phase so the user can see their loadout while choosing their own.
aiBuyForT();
buyPanel.setRound(roundNumber);
oppPanel.refresh();

// Scoreboard HUD (overlays the canvas)
const hud = document.createElement("div");
hud.className = "hud";
canvasHost.appendChild(hud);

// Replay timeline below the canvas
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
  hud.innerHTML = `<span class="ct">${ct.name} ${ct.roundsWon}</span><span class="sep">— Round ${roundNumber} —</span><span class="t">${t.roundsWon} ${t.name}</span>`;
}
paintHud();

let sim: RoundSim | null = null;
let simInterval: number | null = null;
let lastEventIdx = 0;
let lastRotationIdx = 0;

function aiBuyForT() {
  type WId = import("./domain/types.ts").WeaponId;
  type UId = import("./domain/types.ts").UtilityId;
  const WPRICE: Record<WId, number> = { knife: 0, pistol: 200, smg: 1250, rifle: 2700, awp: 4750 };
  const ARMOR = 1000;
  const UPRICE: Record<UId, number> = { smoke: 300, flash: 200, he: 300, molotov: 400 };

  let budget = t.money;
  const players = t.players;

  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const existing = t.loadouts[p.id];
    const kept = existing.keptWeapon;
    const keptArmor = existing.keptArmor;
    const remaining = players.length - i;
    const share = Math.floor(budget / remaining);
    const wCost = (w: WId) => w === kept ? 0 : WPRICE[w];

    // Start from kept weapon; consider upgrades.
    let weapon: WId = kept ?? "pistol";
    // Pistol round: weapons locked to pistol.
    if (roundNumber === 1) {
      weapon = "pistol";
    } else {
      if (p.role === "awper" && weapon !== "awp" && share >= wCost("awp")) weapon = "awp";
      else if (weapon !== "rifle" && weapon !== "awp" && share >= wCost("rifle")) weapon = "rifle";
      else if (weapon === "pistol" && share >= wCost("smg")) weapon = "smg";
    }

    let spent = wCost(weapon);
    let armor = keptArmor;
    const armorCost = keptArmor ? 0 : ARMOR;
    if (!armor && weapon !== "pistol" && share - spent >= armorCost) { armor = true; spent += armorCost; }

    const util: UId[] = [];
    const want: UId = (p.role === "igl" || p.role === "support") ? "smoke" : "flash";
    if (share - spent >= UPRICE[want]) { util.push(want); spent += UPRICE[want]; }

    t.loadouts[p.id] = {
      weapon, utility: util, armor,
      keptWeapon: kept, keptArmor,
    };
    budget -= spent;
  }

  t.money = Math.max(0, budget);
}

function startRound() {
  buyPanel.refresh();

  // Stop any replay from previous round
  replayPlayer.pause();
  timeline.el.style.display = "none";
  renderer.clearTransient();

  sim = new RoundSim(ct, t, map, Math.floor(Math.random() * 1e9));
  lastEventIdx = 0;
  lastRotationIdx = 0;
  oppPanel.clearLog();
  oppPanel.log(`— Round ${roundNumber} begins —`);
  oppPanel.log(`T strategy: ${sim.tStrategy} · CT setup: ${sim.ctSetup.A}A/${sim.ctSetup.B}B/${sim.ctSetup.mid}M`);

  // Swap left panel: buy → live team status
  buyPanel.el.style.display = "none";
  ctLivePanel.el.style.display = "";
  ctLivePanel.refresh();

  simInterval = window.setInterval(tickRound, 50);
}

function tickRound() {
  if (!sim) return;
  sim.tick();

  // Process new events
  for (let i = lastEventIdx; i < sim.events.length; i++) {
    const e = sim.events[i];
    if (e.kind === "kill") {
      const k = playerLookup(e.killer);
      const v = playerLookup(e.victim);
      oppPanel.log(`${shortName(k)} [${e.weapon}] → ${shortName(v)}`);
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

  // Drain rotations
  for (let i = lastRotationIdx; i < sim.rotationLog.length; i++) {
    const r = sim.rotationLog[i];
    const p = playerLookup(r.agentId);
    oppPanel.log(`↪ ${shortName(p)} rotates ${r.from}→${r.to}`);
  }
  lastRotationIdx = sim.rotationLog.length;

  renderer.syncAgents(sim);
  oppPanel.setAgents(sim.agents);
  ctLivePanel.setAgents(sim.agents);

  if (sim.finished && sim.result) {
    if (simInterval) clearInterval(simInterval);
    simInterval = null;
    const r = sim.result;
    if (r.winningSide === "CT") ct.roundsWon++; else t.roundsWon++;
    lossStreaks = applyRoundReward(ct, t, r, lossStreaks.ctLossStreak, lossStreaks.tLossStreak);
    oppPanel.log(`Round ${roundNumber} → ${r.winningSide} wins (${r.outcome})`);

    // Carry over: alive players keep their weapon + armor for free next round.
    for (const ag of sim.agents) {
      const team = ct.players.some(p => p.id === ag.playerId) ? ct : t;
      if (ag.alive) {
        team.loadouts[ag.playerId] = {
          weapon: ag.weapon,
          utility: [],
          armor: ag.armor > 30,
          keptWeapon: ag.weapon === "knife" ? null : ag.weapon,
          keptArmor: ag.armor > 30,
        };
      } else {
        team.loadouts[ag.playerId] = {
          weapon: "pistol", utility: [], armor: false,
          keptWeapon: null, keptArmor: false,
        };
      }
    }

    // Mood drift based on outcome
    for (const p of ct.players) p.mood = clamp(p.mood + (r.winningSide === "CT" ? 3 : -4), 0, 100);
    for (const p of t.players) p.mood = clamp(p.mood + (r.winningSide === "T" ? 3 : -4), 0, 100);

    roundNumber++;
    paintHud();

    const winThreshold = Math.floor(MAX_ROUNDS / 2) + 1;
    if (ct.roundsWon >= winThreshold || t.roundsWon >= winThreshold || roundNumber > MAX_ROUNDS) {
      oppPanel.log(`=== MATCH OVER === ${ct.roundsWon > t.roundsWon ? ct.name : t.name} wins`);
      ctLivePanel.el.style.display = "none";
      buyPanel.el.style.display = "";
      buyPanel.refresh();
      return;
    }

    // Hand the just-finished round to the replay player.
    const finishedSim = sim;
    setTimeout(() => {
      ctLivePanel.el.style.display = "none";
      buyPanel.el.style.display = "";
      aiBuyForT();
      buyPanel.setRound(roundNumber);
      oppPanel.refresh();

      // Show the timeline and auto-play the replay of the round we just watched.
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
