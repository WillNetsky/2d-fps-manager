import { makeMap, makeTeam, setSeed } from "./domain/factory.ts";
import { RoundSim } from "./sim/round.ts";
import { applyRoundReward } from "./sim/economy.ts";
import { WEAPONS as WEAPONS_DICT, defaultPistol } from "./domain/weapons.ts";
import { ReplayPlayer } from "./sim/replay.ts";
import { Renderer } from "./render/renderer.ts";
import { BuyPanel } from "./ui/buyPanel.ts";
import { TeamPanel } from "./ui/teamPanel.ts";
import { Timeline } from "./ui/timeline.ts";
import { KillFeed } from "./ui/killFeed.ts";
import { loadCustomMap } from "./editor/mapEditor.ts";
import type { Player, Side, Team } from "./domain/types.ts";

export async function initGame(app: HTMLElement) {
  setSeed(Date.now());

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
  const STARTING_BANK = 800; // per-player starting money
  const HALFTIME_ROUND = 12;
  const WIN_THRESHOLD = 13;
  const MAX_ROUNDS = 24;
  const isPistolRound = (n: number) => n === 1 || n === HALFTIME_ROUND + 1;

  // --- Teams + map (custom takes precedence if present) ---
  const map = loadCustomMap() ?? makeMap();
  const home = makeTeam("home", "Northwind GG", "CT");
  const away = makeTeam("away", "Crimson Dust", "T");

  let homeIsCt = true;
  const ctSideTeam = (): Team => homeIsCt ? home : away;
  const tSideTeam = (): Team => homeIsCt ? away : home;

  for (const team of [home, away]) for (const p of team.players) {
    team.loadouts[p.id] = {
      weapon: defaultPistol(team.side), utility: [], armor: false, helmet: false,
      keptWeapon: null, keptArmor: false, keptHelmet: false, keptUtility: [],
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
  const buyPanel = new BuyPanel(leftCol, home, {
    onStart: startRound,
    onSimNow: () => { aiBuyFor(home); buyPanel.refresh(); startRound(); skipToEnd(); },
  });
  const homeLivePanel = new TeamPanel(leftCol, home);
  homeLivePanel.el.style.display = "none";
  const oppPanel = new TeamPanel(rightCol, away);
  oppPanel.log(`Match start — ${home.name} (CT) vs ${away.name} (T)`);

  aiBuyFor(away);
  buyPanel.setRound(roundNumber);
  oppPanel.refresh();

  // --- HUD ---
  const hud = document.createElement("div");
  hud.className = "hud";
  canvasHost.appendChild(hud);

  // Round-end summary card (winner + outcome + MVP). Hidden until round ends.
  const roundEndCard = document.createElement("div");
  roundEndCard.className = "round-end-card";
  roundEndCard.style.display = "none";
  canvasHost.appendChild(roundEndCard);

  // Live / Replay status badge.
  const liveBadge = document.createElement("div");
  liveBadge.className = "live-badge";
  canvasHost.appendChild(liveBadge);
  const setStatus = (mode: "live" | "replay" | "idle") => {
    if (mode === "idle") {
      liveBadge.style.display = "none";
      speedBtn.style.display = "none";
      skipBtn.style.display = "none";
      return;
    }
    liveBadge.style.display = "";
    liveBadge.className = `live-badge ${mode}`;
    liveBadge.textContent = mode === "live" ? "LIVE" : "REPLAY";
    speedBtn.style.display = mode === "live" ? "" : "none";
    skipBtn.style.display = mode === "live" ? "" : "none";
  };

  // Speed control (live sim only).
  const SPEEDS = [1, 2, 4, 8];
  const speedBtn = document.createElement("button");
  speedBtn.className = "speed-btn";
  speedBtn.textContent = "1×";
  speedBtn.onclick = () => {
    const idx = SPEEDS.indexOf(simSpeed);
    simSpeed = SPEEDS[(idx + 1) % SPEEDS.length];
    speedBtn.textContent = `${simSpeed}×`;
  };
  canvasHost.appendChild(speedBtn);

  const skipBtn = document.createElement("button");
  skipBtn.className = "speed-btn skip-btn";
  skipBtn.textContent = "⏭ End";
  skipBtn.title = "Fast-forward to end of round";
  skipBtn.onclick = () => skipToEnd();
  canvasHost.appendChild(skipBtn);

  setStatus("idle");

  function skipToEnd() {
    if (!sim || sim.finished) return;
    // Bound the loop so a runaway round can't hang the tab.
    let safety = 100000;
    while (sim && !sim.finished && safety-- > 0) {
      tickRound();
    }
  }

  // Kill feed in the canvas-host top-right.
  const killFeed = new KillFeed(canvasHost);

  const sideOfPlayer = (id: string): Side | null => {
    if (home.players.some(p => p.id === id)) return home.side;
    if (away.players.some(p => p.id === id)) return away.side;
    return null;
  };

  // Small editor link in the HUD corner.
  const editorLink = document.createElement("a");
  editorLink.href = "#editor";
  editorLink.className = "editor-link";
  editorLink.textContent = "✎ Edit map";
  editorLink.onclick = () => { window.location.reload(); };
  canvasHost.appendChild(editorLink);

  const balanceLink = document.createElement("a");
  balanceLink.href = "#balance";
  balanceLink.className = "editor-link balance-link";
  balanceLink.textContent = "📊 Balance";
  balanceLink.onclick = () => { window.location.reload(); };
  canvasHost.appendChild(balanceLink);

  const menuLink = document.createElement("a");
  menuLink.href = "#";
  menuLink.className = "editor-link menu-link";
  menuLink.textContent = "☰ Menu";
  menuLink.onclick = (e) => { e.preventDefault(); window.location.hash = ""; window.location.reload(); };
  canvasHost.appendChild(menuLink);

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
  let simSpeed = 1;
  let lastEventIdx = 0;
  let lastRotationIdx = 0;

  function aiBuyFor(team: Team) {
    type WId = import("./domain/types.ts").WeaponId;
    type UId = import("./domain/types.ts").UtilityId;
    const VEST = 650;
    const HELMET = 350;
    const UPRICE: Record<UId, number> = { smoke: 300, flash: 200, he: 300, molotov: 400 };
    const rifle: WId = team.side === "T" ? "ak" : "m4";
    const smg: WId   = team.side === "T" ? "mac10" : "mp9";

    const players = team.players;
    const W = (id: WId) => WEAPONS_DICT[id];

    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      const existing = team.loadouts[p.id];
      const kept = existing.keptWeapon;
      const keptArmor = existing.keptArmor;
      const keptHelmet = existing.keptHelmet;
      const keptUtil = [...existing.keptUtility];
      const share = p.money;
      const wCost = (id: WId) => id === kept ? 0 : W(id).cost;
      const uCost = (u: UId) => keptUtil.includes(u) ? 0 : UPRICE[u];

      let weapon: WId = kept ?? defaultPistol(team.side);
      let spent = 0;
      let armor = keptArmor;
      let helmet = keptHelmet;
      const util: UId[] = [...keptUtil];
      // Utility preference: weighted roll between smoke and flash by the
      // player's lineup/timing ratings instead of a role-based pick.
      const smokeW = Math.max(1, p.stats.smokeLineups);
      const flashW = Math.max(1, p.stats.flashTiming);
      const want: UId = Math.random() * (smokeW + flashW) < smokeW ? "smoke" : "flash";

      if (isPistolRound(roundNumber)) {
        weapon = defaultPistol(team.side);
        helmet = false;
        // Composed/disciplined players are more willing to spend on armor.
        const vestChance = 0.25 + (p.stats.composure + p.stats.discipline) / 400;
        const wantsVest = Math.random() < vestChance;
        if (wantsVest && share >= VEST) {
          armor = true;
          spent += VEST;
        } else if (!util.includes(want) && share - spent >= uCost(want)) {
          util.push(want);
          spent += uCost(want);
        }
      } else {
        const isRifle = (w: WId) => W(w).slot === "rifle";
        // Likelihood of going for the AWP scales with the player's awpPref
        // rating — roll it instead of locking the buy to a role label.
        const awpChance = Math.max(0, (p.stats.awpPref - 50) / 50);
        const wantsAwp = Math.random() < awpChance;
        if (wantsAwp && weapon !== "awp" && share >= wCost("awp")) weapon = "awp";
        else if (!isRifle(weapon) && weapon !== "awp" && share >= wCost(rifle)) weapon = rifle;
        else if (W(weapon).slot === "pistol" && share >= wCost(smg)) weapon = smg;
        // Pistol upgrade if we're stuck on pistol and have spare cash for a deagle.
        if (W(weapon).slot === "pistol" && weapon !== "deagle" && share >= wCost("deagle")) weapon = "deagle";

        spent = wCost(weapon);
        if (!armor && W(weapon).slot !== "pistol" && share - spent >= VEST) { armor = true; spent += VEST; }
        if (armor && !helmet && W(weapon).slot !== "pistol" && share - spent >= HELMET) { helmet = true; spent += HELMET; }
        if (!util.includes(want) && share - spent >= uCost(want)) {
          util.push(want);
          spent += uCost(want);
        }
      }

      team.loadouts[p.id] = {
        weapon, utility: util, armor, helmet,
        keptWeapon: kept, keptArmor, keptHelmet, keptUtility: keptUtil,
      };
      p.money = Math.max(0, p.money - spent);
    }
  }

  function halftimeSwap() {
    homeIsCt = !homeIsCt;
    home.side = homeIsCt ? "CT" : "T";
    away.side = homeIsCt ? "T" : "CT";
    for (const team of [home, away]) {
      for (const p of team.players) {
        p.money = STARTING_BANK;
        team.loadouts[p.id] = {
          weapon: defaultPistol(team.side), utility: [], armor: false, helmet: false,
          keptWeapon: null, keptArmor: false, keptHelmet: false, keptUtility: [],
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
    killFeed.clear();
    setStatus("live");

    sim = new RoundSim(ctSideTeam(), tSideTeam(), map, Math.floor(Math.random() * 1e9));
    lastEventIdx = 0;
    lastRotationIdx = 0;
    oppPanel.clearLog();
    oppPanel.log(`— Round ${roundNumber} begins —`);
    oppPanel.log(`T strategy: ${sim.tStrategy} · CT setup: ${sim.ctSetup.A}A/${sim.ctSetup.B}B/${sim.ctSetup.mid}M`);

    buyPanel.el.style.display = "none";
    homeLivePanel.el.style.display = "";
    homeLivePanel.refresh();
    roundEndCard.style.display = "none";

    simInterval = window.setInterval(tickRound, 50);
  }

  function tickRound() {
    if (!sim) return;
    // Run sim faster by stepping multiple sim ticks per render frame.
    for (let s = 0; s < simSpeed && !sim.finished; s++) {
      sim.tick();
    }

    for (let i = lastEventIdx; i < sim.events.length; i++) {
      const e = sim.events[i];
      if (e.kind === "kill") {
        const k = playerLookup(e.killer);
        const v = playerLookup(e.victim);
        const hs = e.headshot ? " 🎯" : "";
        oppPanel.log(`${shortName(k)} [${e.weapon}]${hs} → ${shortName(v)}`);
        const kSide = sideOfPlayer(e.killer);
        const vSide = sideOfPlayer(e.victim);
        if (kSide && vSide) {
          killFeed.push(
            { name: shortName(k), side: kSide },
            { name: shortName(v), side: vSide },
            e.weapon, e.headshot,
          );
        }
      } else if (e.kind === "bomb-plant") {
        const planter = playerLookup(e.planter);
        const site = nearestSiteLetter(sim);
        oppPanel.log(`💣 ${shortName(planter)} planted on ${site}`);
        renderer.flashSite(site);
      } else if (e.kind === "bomb-defuse") {
        oppPanel.log(`🛡 ${shortName(playerLookup(e.defuser))} defused`);
      } else if (e.kind === "bomb-detonate") {
        oppPanel.log(`💥 bomb detonated`);
      } else if (e.kind === "pickup") {
        const p = playerLookup(e.player);
        const got = WEAPONS_DICT[e.weapon].name;
        const drop = e.dropped ? ` (dropped ${WEAPONS_DICT[e.dropped].name})` : "";
        oppPanel.log(`🎒 ${shortName(p)} picked up ${got}${drop}`);
      } else if (e.kind === "util-throw") {
        const p = playerLookup(e.thrower);
        const icon = e.util === "smoke" ? "💨" : e.util === "flash" ? "✨" : e.util === "molotov" ? "🔥" : "💣";
        oppPanel.log(`${icon} ${shortName(p)} threw a ${e.util}`);
      } else if (e.kind === "save") {
        const p = playerLookup(e.player);
        oppPanel.log(e.on ? `🛟 ${shortName(p)} is saving` : `↩ ${shortName(p)} re-engages`);
      } else if (e.kind === "bomb-pickup") {
        oppPanel.log(`💣 ${shortName(playerLookup(e.player))} picked up the bomb`);
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

      // MVP: most kills this round on the winning team; fall back to the
      // player who completed the objective (plant / defuse).
      const roundKillsByPlayer = new Map<string, number>();
      const headshotsByPlayer = new Map<string, number>();
      for (const ev of r.events) {
        if (ev.kind !== "kill") continue;
        if (!winningTeam.players.some(pp => pp.id === ev.killer)) continue;
        roundKillsByPlayer.set(ev.killer, (roundKillsByPlayer.get(ev.killer) ?? 0) + 1);
        if (ev.headshot) headshotsByPlayer.set(ev.killer, (headshotsByPlayer.get(ev.killer) ?? 0) + 1);
      }
      let mvpId: string | null = null;
      let mvpKills = 0;
      for (const [id, k] of roundKillsByPlayer) {
        if (k > mvpKills) { mvpKills = k; mvpId = id; }
      }
      const plantEvt = r.events.find(e => e.kind === "bomb-plant");
      const defuseEvt = r.events.find(e => e.kind === "bomb-defuse");
      let mvpLine = "";
      if (mvpId) {
        const hs = headshotsByPlayer.get(mvpId) ?? 0;
        mvpLine = `${mvpKills} kill${mvpKills === 1 ? "" : "s"}${hs ? ` (${hs} HS)` : ""}`;
        const mvp = playerLookup(mvpId);
        const planted = plantEvt && plantEvt.kind === "bomb-plant" && plantEvt.planter === mvpId;
        const defused = defuseEvt && defuseEvt.kind === "bomb-defuse" && defuseEvt.defuser === mvpId;
        if (planted) mvpLine += ` + plant`;
        if (defused) mvpLine += ` + defuse`;
        oppPanel.log(`🏆 MVP: ${shortName(mvp)} — ${mvpLine}`);
      } else if (r.winningSide === "T" && plantEvt && plantEvt.kind === "bomb-plant") {
        mvpId = plantEvt.planter;
        mvpLine = "planted the bomb";
        oppPanel.log(`🏆 MVP: ${shortName(playerLookup(mvpId))} — ${mvpLine}`);
      } else if (r.winningSide === "CT" && defuseEvt && defuseEvt.kind === "bomb-defuse") {
        mvpId = defuseEvt.defuser;
        mvpLine = "defused the bomb";
        oppPanel.log(`🏆 MVP: ${shortName(playerLookup(mvpId))} — ${mvpLine}`);
      }

      // Round-end overlay card.
      const outcomeText: Record<typeof r.outcome, string> = {
        "ct-elim": "Ts eliminated",
        "t-elim": "CTs eliminated",
        "bomb-detonated": "Bomb detonated",
        "bomb-defused": "Bomb defused",
        "time-expired": "Time expired",
      };
      const winnerLabel = r.winningSide === "CT" ? "Counter-Terrorists win" : "Terrorists win";
      const winnerCls = r.winningSide === "CT" ? "ct" : "t";
      const durSec = (r.durationMs / 1000).toFixed(1);
      const mvpHtml = mvpId
        ? `<div class="rec-mvp"><span class="crown">🏆</span> MVP: <span class="mvp-name">${shortName(playerLookup(mvpId))}</span><div class="mvp-line">${mvpLine}</div></div>`
        : "";
      roundEndCard.innerHTML =
        `<div class="rec-winner ${winnerCls}">${winnerLabel}</div>` +
        `<div class="rec-outcome">${outcomeText[r.outcome]} · ${durSec}s</div>` +
        mvpHtml;
      roundEndCard.style.display = "";

      for (const ag of sim.agents) {
        const team = home.players.some(p => p.id === ag.playerId) ? home : away;
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

      for (const p of winningTeam.players) p.mood = clamp(p.mood + 3, 0, 100);
      const losingTeam = winningTeam === home ? away : home;
      for (const p of losingTeam.players) p.mood = clamp(p.mood - 4, 0, 100);

      roundNumber++;

      if (roundNumber === HALFTIME_ROUND + 1) halftimeSwap();

      paintHud();

      const matchOver = home.roundsWon >= WIN_THRESHOLD || away.roundsWon >= WIN_THRESHOLD || roundNumber > MAX_ROUNDS;
      if (matchOver) {
        const winner = home.roundsWon > away.roundsWon ? home.name
          : away.roundsWon > home.roundsWon ? away.name
          : "Draw";
        oppPanel.log(`=== MATCH OVER · ${winner} ===`);
        setStatus("idle");
        homeLivePanel.el.style.display = "none";
        buyPanel.el.style.display = "";
        buyPanel.refresh();
        return;
      }

      const finishedSim = sim;
      setTimeout(() => {
        homeLivePanel.el.style.display = "none";
        buyPanel.el.style.display = "";
        aiBuyFor(away);
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
          timeline.setReplay(finishedSim.snapshots.length, finishedSim.events, 50, `REPLAY · round ${roundNumber - 1}`, sideOfPlayer);
          timeline.el.style.display = "";
          replayPlayer.play();
          timeline.setPlaying(true);
          setStatus("replay");
          killFeed.clear();
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
}
