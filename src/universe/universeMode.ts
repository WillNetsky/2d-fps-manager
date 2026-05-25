import type { GameMap, Player } from "../domain/types.ts";
import { makePlayer, setSeed } from "../domain/factory.ts";
import {
  flagEmoji, regionOf, REGION_ORDER, REGION_LABELS, type Region,
} from "../domain/countries.ts";
import { loadCustomMap, loadSavedMapsAll } from "../editor/mapEditor.ts";
import { builtinMaps } from "../domain/builtinMaps.ts";
import { applyMatchElo } from "./elo.ts";
import { applyMatchChemistry, FRIEND_THRESHOLD } from "./chemistry.ts";
import { buildTeam, simulateMatchInstant } from "./matchSim.ts";
import { observeMatch } from "./observeMatch.ts";
import {
  deleteUniverse, listUniverses, loadUniverse, newUniverseId, saveUniverse,
} from "./storage.ts";
import {
  PLAYER_COUNT, STARTING_ELO, TEAM_SIZE,
  type Matchup, type PlayerMatchStats, type Universe,
} from "./types.ts";

type Screen = "menu" | "players" | "matchups" | "match" | "standings" | "career" | "settings" | "player" | "replay";

// Screens that share the day-view tab bar.
const DAY_TABS: Screen[] = ["matchups", "standings", "career", "settings"];

export class UniverseMode {
  private root: HTMLElement;
  private universe: Universe | null = null;
  private screen: Screen = "menu";
  private activeMatchupId: string | null = null;
  private activePlayerId: string | null = null;
  // Screen to return to from the player page (set when navigating in).
  private playerReturnScreen: Screen = "standings";
  // Replay state: which historical matchup to play back, and where to return.
  private replayRef: { day: number; matchIdx: number; startAtRound?: number } | null = null;
  private replayReturnPlayerId: string | null = null;

  constructor(parent: HTMLElement) {
    this.root = parent;
    this.render();
  }

  // ---- Routing / shell ----

  private render() {
    this.root.className = "universe-app";
    this.root.innerHTML = "";
    const main = document.createElement("div");
    main.className = "universe-main";
    this.root.appendChild(main);

    // Top bar (visible on every screen except the match canvas / replay).
    if (this.screen !== "match" && this.screen !== "replay") {
      main.appendChild(this.topBar());
    }

    const body = document.createElement("div");
    body.className = "universe-body";
    main.appendChild(body);

    // Day-view tab bar: lets the user flip between matchups, ratings, and
    // career stats while a day is active or after it has wrapped up.
    if (DAY_TABS.includes(this.screen) && this.universe) {
      body.appendChild(this.dayTabBar());
    }

    switch (this.screen) {
      case "menu":      this.renderMenu(body); break;
      case "players":   this.renderPlayers(body); break;
      case "matchups":  this.renderMatchups(body); break;
      case "match":     this.renderMatch(body); break;
      case "standings": this.renderStandings(body); break;
      case "career":    this.renderCareer(body); break;
      case "settings":  this.renderSettings(body); break;
      case "player":    this.renderPlayer(body); break;
      case "replay":    this.renderReplay(body); break;
    }
  }

  private openReplay(day: number, matchIdx: number, startAtRound?: number) {
    if (!this.universe) return;
    this.replayRef = { day, matchIdx, startAtRound };
    // If we're already on a player page, return to it after the replay.
    this.replayReturnPlayerId = this.screen === "player" ? this.activePlayerId : null;
    this.screen = "replay";
    this.render();
  }

  private async renderReplay(body: HTMLElement) {
    if (!this.universe || !this.replayRef) { this.exitReplay(); return; }
    const u = this.universe;
    const ref = this.replayRef;
    const day = u.history.find(d => d.day === ref.day);
    const m = day?.matchups[ref.matchIdx];
    if (!m || m.seed === undefined || !u.maps || u.maps.length === 0) { this.exitReplay(); return; }
    const map = u.maps[m.mapIndex ?? 0] ?? u.maps[0];
    const ctPlayers = m.ctPlayerIds.map(id => u.players.find(p => p.id === id)!).filter(Boolean);
    const tPlayers  = m.tPlayerIds.map (id => u.players.find(p => p.id === id)!).filter(Boolean);
    const back = () => this.exitReplay();
    await observeMatch(body, {
      ctName: teamNameFor(ctPlayers, u.elos),
      tName:  teamNameFor(tPlayers,  u.elos),
      ctPlayers, tPlayers,
      map,
      seed: m.seed,
      startAtRound: ref.startAtRound,
      isReplay: true,
      // Replays don't mutate saved results — both endings just exit.
      onDone: () => back(),
      onCancel: () => back(),
    });
  }

  private exitReplay() {
    const returnPid = this.replayReturnPlayerId;
    this.replayRef = null;
    this.replayReturnPlayerId = null;
    if (returnPid) {
      this.activePlayerId = returnPid;
      this.screen = "player";
    } else {
      this.screen = "standings";
    }
    this.render();
  }

  private dayTabBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "universe-tabs";
    const u = this.universe!;
    const hasPending = !!u.pendingDay;
    const tabs: { key: Screen; label: string; show: boolean }[] = [
      { key: "matchups",  label: "Matchups",       show: hasPending },
      { key: "standings", label: "Player ratings", show: true },
      { key: "career",    label: "Career stats",   show: true },
      { key: "settings",  label: "Settings",       show: true },
    ];
    for (const t of tabs) {
      if (!t.show) continue;
      const el = document.createElement("button");
      el.className = "universe-tab" + (this.screen === t.key ? " active" : "");
      el.textContent = t.label;
      el.onclick = () => {
        if (this.screen === t.key) return;
        this.screen = t.key;
        this.render();
      };
      bar.appendChild(el);
    }
    return bar;
  }

  private openPlayer(playerId: string) {
    this.activePlayerId = playerId;
    this.playerReturnScreen = this.screen === "player" ? this.playerReturnScreen : this.screen;
    this.screen = "player";
    this.render();
  }

  private topBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "universe-topbar";
    const left = document.createElement("div");
    left.className = "universe-topbar-left";
    if (this.universe) {
      const title = document.createElement("span");
      title.className = "universe-title";
      title.textContent = this.universe.name;
      left.appendChild(title);
      const day = document.createElement("span");
      day.className = "universe-day";
      day.textContent = `Day ${this.universe.day}`;
      left.appendChild(day);
    } else {
      const title = document.createElement("span");
      title.className = "universe-title";
      title.textContent = "Universe Mode";
      left.appendChild(title);
    }
    bar.appendChild(left);

    const right = document.createElement("div");
    right.className = "universe-topbar-right";

    if (this.screen === "players" && this.universe) {
      right.appendChild(btn("Continue to universe →", "primary", () => this.startDay()));
    } else if (DAY_TABS.includes(this.screen) && this.screen !== "settings"
               && this.universe && this.universe.pendingDay) {
      right.appendChild(btn("Sim X days", "", () => this.simManyDays()));
      const allDone = this.universe.pendingDay.matchups.every(m => m.status === "completed");
      if (allDone) {
        right.appendChild(btn("Continue →", "primary", () => this.continueFromMatchups()));
      } else {
        right.appendChild(btn("Sim all remaining", "primary", () => this.simRemaining()));
      }
    } else if (this.screen === "player" && this.universe) {
      right.appendChild(btn("← Back", "", () => {
        this.screen = this.playerReturnScreen;
        this.activePlayerId = null;
        this.render();
      }));
    }

    const menu = btn("☰ Main menu", "", () => {
      window.location.hash = "";
      window.location.reload();
    });
    right.appendChild(menu);
    bar.appendChild(right);
    return bar;
  }

  // ---- Menu screen ----

  private renderMenu(body: HTMLElement) {
    const wrap = document.createElement("div");
    wrap.className = "universe-menu-wrap";

    const card = document.createElement("div");
    card.className = "universe-menu-card";

    const h = document.createElement("h2");
    h.textContent = "Universe Mode";
    card.appendChild(h);

    const sub = document.createElement("p");
    sub.className = "universe-sub";
    sub.textContent = "Generate a pool of players and let them play casual matchups day by day. Elo rises and falls with each result.";
    card.appendChild(sub);

    card.appendChild(btn("New Universe", "primary big", () => this.createUniverse()));

    const loadHeader = document.createElement("div");
    loadHeader.className = "universe-section-label";
    loadHeader.textContent = "Load existing";
    card.appendChild(loadHeader);

    const list = document.createElement("div");
    list.className = "universe-load-list";
    const slots = listUniverses();
    if (slots.length === 0) {
      const empty = document.createElement("div");
      empty.className = "universe-empty";
      empty.textContent = "No saved universes yet.";
      list.appendChild(empty);
    } else {
      for (const s of slots) {
        const row = document.createElement("div");
        row.className = "universe-load-row";
        const info = document.createElement("div");
        info.className = "universe-load-info";
        info.innerHTML = `<div class="ul-name">${escapeHtml(s.name)}</div><div class="ul-meta">Day ${s.day} · ${new Date(s.createdAt).toLocaleDateString()}</div>`;
        row.appendChild(info);
        const actions = document.createElement("div");
        actions.appendChild(btn("Load", "", () => this.loadUniverseById(s.id)));
        actions.appendChild(btn("Delete", "danger", () => {
          if (confirm(`Delete universe "${s.name}"?`)) {
            deleteUniverse(s.id);
            this.render();
          }
        }));
        row.appendChild(actions);
        list.appendChild(row);
      }
    }
    card.appendChild(list);
    wrap.appendChild(card);
    body.appendChild(wrap);
  }

  // ---- Universe lifecycle ----

  private createUniverse() {
    setSeed(Date.now());
    const players: Player[] = [];
    for (let i = 0; i < PLAYER_COUNT; i++) players.push(makePlayer());
    const elos: Record<string, number> = {};
    for (const p of players) elos[p.id] = STARTING_ELO;
    const name = prompt("Name this universe:", `Universe ${new Date().toLocaleDateString()}`) ?? "Universe";
    this.universe = {
      id: newUniverseId(),
      name,
      createdAt: Date.now(),
      day: 1,
      players,
      elos,
      history: [],
      pendingDay: null,
      // Start with one map in rotation — settings tab lets the user add more.
      maps: [loadCustomMap() ?? deepCloneMap(builtinMaps()[0])],
    };
    this.persist();
    this.screen = "players";
    this.render();
  }

  private loadUniverseById(id: string) {
    const u = loadUniverse(id);
    if (!u) return;
    // Migrate older saves that predate the universe-level map / map rotation.
    if (!u.maps || u.maps.length === 0) {
      u.maps = [u.map ?? loadCustomMap() ?? deepCloneMap(builtinMaps()[0])];
    }
    delete u.map;
    // Older saves may have rolled a day into history without generating the
    // next day's matchups. The day view now always expects a pendingDay, so
    // backfill one before rendering.
    if (!u.pendingDay && u.history.length > 0) {
      u.pendingDay = { day: u.day, matchups: generateMatchups(u.players, u.elos, u.maps?.length ?? 1) };
    }
    this.universe = u;
    this.screen = u.pendingDay ? "matchups" : "players";
    this.render();
  }

  private persist() {
    if (this.universe) saveUniverse(this.universe);
  }

  // ---- Players (roster) screen ----

  private renderPlayers(body: HTMLElement) {
    if (!this.universe) return;
    const u = this.universe;
    const table = playerTable(u.players, u.elos, /* showElo */ true, id => this.openPlayer(id));
    body.appendChild(table);
  }

  // ---- Matchups screen ----

  private startDay() {
    if (!this.universe) return;
    if (!this.universe.pendingDay) {
      this.universe.pendingDay = {
        day: this.universe.day,
        matchups: generateMatchups(this.universe.players, this.universe.elos, this.universe.maps?.length ?? 1),
      };
      this.persist();
    }
    this.screen = "matchups";
    this.render();
  }

  private renderMatchups(body: HTMLElement) {
    if (!this.universe || !this.universe.pendingDay) return;
    const day = this.universe.pendingDay;
    const playerById = new Map(this.universe.players.map(p => [p.id, p] as const));
    const elos = this.universe.elos;

    // Top performers across all completed matches today. Updates as more
    // matches finish, so even a single sim'd match shows the top of the day.
    const completed = day.matchups.filter(m => m.status === "completed" && m.playerStats);
    if (completed.length > 0) {
      body.appendChild(this.topPerformersGrid(completed, playerById));
    }

    // Group the board by region. Matchups are generated in region order, but
    // group explicitly so legacy (region-less) saves still render in one block.
    const groups = new Map<string, Matchup[]>();
    for (const m of day.matchups) {
      const key = m.region ?? "—";
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(m);
    }

    for (const [regionKey, regionMatchups] of groups) {
      const label = regionKey in REGION_LABELS
        ? REGION_LABELS[regionKey as Region]
        : "All regions";
      const section = document.createElement("div");
      section.className = "universe-region-header";
      section.textContent = `${label} · ${regionMatchups.length} match${regionMatchups.length === 1 ? "" : "es"}`;
      body.appendChild(section);

      const grid = document.createElement("div");
      grid.className = "universe-matchup-grid";

    regionMatchups.forEach((m, i) => {
      const card = document.createElement("div");
      card.className = "universe-matchup-card " + (m.status === "completed" ? "completed" : "");

      const header = document.createElement("div");
      header.className = "umc-header";
      header.textContent = `Match ${i + 1}`;
      card.appendChild(header);

      const teams = document.createElement("div");
      teams.className = "umc-teams";
      teams.appendChild(rosterColumn("CT", m.ctPlayerIds, playerById, elos, m, id => this.openPlayer(id)));
      const vs = document.createElement("div");
      vs.className = "umc-vs";
      if (m.status === "completed") {
        const ctWon = m.winnerSide === "CT";
        vs.innerHTML = `<div class="umc-score clickable" title="View box score"><span class="ct${ctWon ? " winner" : ""}">${m.ctScore}</span><span>:</span><span class="t${ctWon ? "" : " winner"}">${m.tScore}</span></div>`;
        const scoreEl = vs.querySelector(".umc-score") as HTMLElement;
        scoreEl.onclick = () => showMatchStatsModal(m, this.universe!);
      } else {
        vs.textContent = "vs";
      }
      teams.appendChild(vs);
      teams.appendChild(rosterColumn("T", m.tPlayerIds, playerById, elos, m, id => this.openPlayer(id)));
      card.appendChild(teams);

      const actions = document.createElement("div");
      actions.className = "umc-actions";
      if (m.status === "pending") {
        actions.appendChild(btn("Sim", "", () => this.simMatchup(m.id)));
        actions.appendChild(btn("Play", "primary", () => this.playMatchup(m.id)));
      }
      card.appendChild(actions);
      grid.appendChild(card);
    });

      body.appendChild(grid);
    }
  }

  // Top 4 players by HLTV rating across completed matches in the current day.
  private topPerformersGrid(matchups: Matchup[], byId: Map<string, Player>): HTMLElement {
    interface Row {
      pid: string; side: "CT" | "T"; stats: PlayerMatchStats; rating: number;
    }
    const rows: Row[] = [];
    for (const m of matchups) {
      if (!m.playerStats) continue;
      for (const [pid, stats] of Object.entries(m.playerStats)) {
        const side: "CT" | "T" = m.ctPlayerIds.includes(pid) ? "CT" : "T";
        rows.push({ pid, side, stats, rating: hltvRating1(stats) });
      }
    }
    rows.sort((a, b) => b.rating - a.rating);
    const top = rows.slice(0, 4);

    const wrap = document.createElement("div");
    wrap.className = "universe-top-performers";
    top.forEach((r, i) => {
      const p = byId.get(r.pid);
      if (!p) return;
      const card = document.createElement("div");
      card.className = `utp-card ${r.side === "CT" ? "ct" : "t"}`;
      card.onclick = () => this.openPlayer(r.pid);
      const adr = r.stats.roundsPlayed > 0 ? r.stats.damage / r.stats.roundsPlayed : 0;
      const ratingColorCss = r.rating >= 1 ? "var(--good)" : "var(--bad)";
      card.innerHTML = `
        <div class="utp-head">
          <span class="utp-rank">#${i + 1}</span>
          <span class="utp-rating" style="color:${ratingColorCss}">${r.rating.toFixed(2)}</span>
        </div>
        <div class="utp-name">${escapeHtml(shortName(p))}</div>
        <div class="utp-stats">
          <span><b>${r.stats.kills}</b>K</span>
          <span><b>${r.stats.deaths}</b>D</span>
          <span><b>${r.stats.assists}</b>A</span>
          <span><b>${Math.round(adr)}</b>ADR</span>
        </div>
      `;
      wrap.appendChild(card);
    });
    return wrap;
  }

  private findMatchup(id: string): Matchup | null {
    return this.universe?.pendingDay?.matchups.find(m => m.id === id) ?? null;
  }

  private simMatchup(id: string) {
    if (!this.universe) return;
    const m = this.findMatchup(id);
    if (!m || m.status === "completed") return;
    this.runInstantSim(m);
    this.persist();
    this.render();
  }

  private runInstantSim(m: Matchup) {
    if (!this.universe) return;
    const u = this.universe;
    if (!u.maps || u.maps.length === 0) u.maps = [loadCustomMap() ?? deepCloneMap(builtinMaps()[0])];
    if (m.mapIndex === undefined || m.mapIndex >= u.maps.length) {
      m.mapIndex = Math.floor(Math.random() * u.maps.length);
    }
    const map = u.maps[m.mapIndex];
    if (m.seed === undefined) m.seed = newSeed();
    const ctPlayers = m.ctPlayerIds.map(id => u.players.find(p => p.id === id)!).filter(Boolean);
    const tPlayers  = m.tPlayerIds.map (id => u.players.find(p => p.id === id)!).filter(Boolean);
    const ctTeam = buildTeam("ct", "CT-side", ctPlayers, "CT");
    const tTeam  = buildTeam("t",  "T-side",  tPlayers,  "T");
    const result = simulateMatchInstant(ctTeam, tTeam, map, m.seed);
    m.status = "completed";
    m.ctScore = result.ctScore;
    m.tScore  = result.tScore;
    m.winnerSide = result.winnerSide;
    m.clutches = result.clutches;
    m.playerStats = result.playerStats;
    const winners = result.winnerSide === "CT" ? m.ctPlayerIds : m.tPlayerIds;
    const losers  = result.winnerSide === "CT" ? m.tPlayerIds  : m.ctPlayerIds;
    m.eloDelta = applyMatchElo(winners, losers, u.elos);
    applyMatchChemistry(u.players, winners, losers);
  }

  private playMatchup(id: string) {
    const m = this.findMatchup(id);
    if (!m || m.status === "completed") return;
    this.activeMatchupId = id;
    this.screen = "match";
    this.render();
  }

  private async renderMatch(body: HTMLElement) {
    if (!this.universe || !this.activeMatchupId) {
      this.screen = "matchups";
      this.render();
      return;
    }
    const m = this.findMatchup(this.activeMatchupId);
    if (!m) { this.screen = "matchups"; this.render(); return; }
    const u = this.universe;
    if (!u.maps || u.maps.length === 0) u.maps = [loadCustomMap() ?? deepCloneMap(builtinMaps()[0])];
    if (m.mapIndex === undefined || m.mapIndex >= u.maps.length) {
      m.mapIndex = Math.floor(Math.random() * u.maps.length);
    }
    const map = u.maps[m.mapIndex];
    if (m.seed === undefined) m.seed = newSeed();
    const ctPlayers = m.ctPlayerIds.map(id => u.players.find(p => p.id === id)!).filter(Boolean);
    const tPlayers  = m.tPlayerIds.map (id => u.players.find(p => p.id === id)!).filter(Boolean);

    await observeMatch(body, {
      ctName: teamNameFor(ctPlayers, u.elos),
      tName:  teamNameFor(tPlayers,  u.elos),
      ctPlayers, tPlayers, map,
      seed: m.seed,
      onDone: (result) => {
        m.status = "completed";
        m.ctScore = result.ctScore;
        m.tScore  = result.tScore;
        m.winnerSide = result.winnerSide;
        m.clutches = result.clutches;
    m.playerStats = result.playerStats;
        const winners = result.winnerSide === "CT" ? m.ctPlayerIds : m.tPlayerIds;
        const losers  = result.winnerSide === "CT" ? m.tPlayerIds  : m.ctPlayerIds;
        m.eloDelta = applyMatchElo(winners, losers, u.elos);
        applyMatchChemistry(u.players, winners, losers);
        this.persist();
        this.activeMatchupId = null;
        this.screen = "matchups";
        this.render();
      },
      onCancel: () => {
        // No result recorded — return to matchup board with this match still pending.
        this.activeMatchupId = null;
        this.screen = "matchups";
        this.render();
      },
    });
  }

  // Headless-sim every still-pending matchup of the current day. Leaves the
  // user on their current tab so they can review the results.
  private simRemaining() {
    if (!this.universe || !this.universe.pendingDay) return;
    for (const m of this.universe.pendingDay.matchups) {
      if (m.status !== "completed") this.runInstantSim(m);
    }
    this.persist();
    this.render();
  }

  // Roll the (fully-completed) current day into history and start the next
  // day's matchups. The universe always has a pendingDay while in the day
  // view, so the user is dropped straight back onto the Matchups tab.
  private continueFromMatchups() {
    if (!this.universe || !this.universe.pendingDay) return;
    const u = this.universe;
    const done = u.pendingDay!;
    u.history.push({ day: done.day, matchups: done.matchups });
    u.day++;
    u.pendingDay = { day: u.day, matchups: generateMatchups(u.players, u.elos, u.maps?.length ?? 1) };
    this.persist();
    this.screen = "matchups";
    this.render();
  }

  private async simManyDays() {
    if (!this.universe) return;
    const input = prompt("How many days to simulate?", "30");
    if (input === null) return;
    const n = Math.floor(Number(input));
    if (!Number.isFinite(n) || n <= 0) return;
    const capped = Math.min(n, 1000); // soft guard — 1000 days is already a lot
    const u = this.universe;

    const overlay = makeSimOverlay(capped);
    this.root.appendChild(overlay.el);
    // Let the browser paint the overlay before we start chewing through days.
    await nextFrame();

    // try/finally so the full-screen overlay is ALWAYS removed and the screen
    // re-renders — otherwise a throw (e.g. storage quota) leaves the blocking
    // overlay up and the app appears frozen after the last day.
    try {
      for (let i = 0; i < capped; i++) {
        if (!u.pendingDay) {
          u.pendingDay = { day: u.day, matchups: generateMatchups(u.players, u.elos, u.maps?.length ?? 1) };
        }
        for (const m of u.pendingDay.matchups) {
          if (m.status !== "completed") this.runInstantSim(m);
        }
        u.history.push({ day: u.pendingDay.day, matchups: u.pendingDay.matchups });
        u.pendingDay = null;
        u.day++;

        // Yield to the browser every day so the progress bar updates smoothly.
        overlay.update(i + 1);
        await nextFrame();
      }

      // Drop the user into the next day's pending matchups so the day view
      // always has something to act on.
      if (!u.pendingDay) {
        u.pendingDay = { day: u.day, matchups: generateMatchups(u.players, u.elos, u.maps?.length ?? 1) };
      }
      this.persist();
    } finally {
      overlay.el.remove();
      this.screen = "matchups";
      this.render();
    }
  }

  // ---- Standings (player ratings) screen ----

  private renderStandings(body: HTMLElement) {
    if (!this.universe) return;
    const u = this.universe;
    const table = playerTable(u.players, u.elos, /* showElo */ true, id => this.openPlayer(id));
    body.appendChild(table);
  }

  // ---- Career stats screen ----

  private renderCareer(body: HTMLElement) {
    if (!this.universe) return;
    body.appendChild(careerStatsTable(this.universe, id => this.openPlayer(id)));
  }

  // ---- Settings screen ----

  private renderSettings(body: HTMLElement) {
    if (!this.universe) return;
    const u = this.universe;
    if (!u.maps || u.maps.length === 0) u.maps = [loadCustomMap() ?? deepCloneMap(builtinMaps()[0])];

    const wrap = document.createElement("div");
    wrap.className = "universe-settings";

    const card = document.createElement("div");
    card.className = "universe-settings-card";
    wrap.appendChild(card);

    const h = document.createElement("h2");
    h.textContent = "Map rotation";
    card.appendChild(h);

    const sub = document.createElement("p");
    sub.className = "universe-settings-sub";
    sub.textContent = "Each match picks one map from this pool at random. Adding more variety here changes future matchups only — already-generated games keep their assigned map.";
    card.appendChild(sub);

    const list = document.createElement("div");
    list.className = "universe-map-list";
    u.maps.forEach((map, idx) => {
      const row = document.createElement("div");
      row.className = "universe-map-row";
      const left = document.createElement("div");
      left.className = "umr-info";
      left.innerHTML = `<div class="umr-name">${escapeHtml(map.name || `Map ${idx + 1}`)}</div>` +
                       `<div class="umr-meta">${map.width}×${map.height} tiles · ${map.bombsites.length} sites</div>`;
      row.appendChild(left);
      const actions = document.createElement("div");
      // Removing must keep at least one map in the pool, otherwise future
      // matchup generation has nothing to assign.
      if (u.maps!.length > 1) {
        actions.appendChild(btn("Remove", "danger", () => {
          u.maps!.splice(idx, 1);
          this.persist();
          this.render();
        }));
      }
      row.appendChild(actions);
      list.appendChild(row);
    });
    card.appendChild(list);

    // Collect everything available across the four storage sources so the
    // user can add any of them to this universe's rotation.
    interface Source { key: string; label: string; map: () => GameMap; }
    const sources: { group: string; items: Source[] }[] = [];
    sources.push({
      group: "Built-in",
      items: builtinMaps().map(m => ({
        key: `b:${m.name}`,
        label: m.name,
        map: () => deepCloneMap(m),
      })),
    });
    const saved = loadSavedMapsAll();
    const savedNames = Object.keys(saved).sort();
    if (savedNames.length > 0) {
      sources.push({
        group: "Saved (editor)",
        items: savedNames.map(name => ({
          key: `s:${name}`,
          label: name,
          map: () => deepCloneMap(saved[name]),
        })),
      });
    }
    const addRow = document.createElement("div");
    addRow.className = "universe-map-add";
    const select = document.createElement("select");
    select.className = "universe-map-select";
    for (const group of sources) {
      const og = document.createElement("optgroup");
      og.label = group.group;
      for (const item of group.items) {
        const opt = document.createElement("option");
        opt.value = item.key;
        opt.textContent = item.label;
        og.appendChild(opt);
      }
      select.appendChild(og);
    }
    addRow.appendChild(select);
    addRow.appendChild(btn("+ Add to rotation", "primary", () => {
      const key = select.value;
      for (const group of sources) {
        const found = group.items.find(it => it.key === key);
        if (found) {
          u.maps!.push(found.map());
          this.persist();
          this.render();
          return;
        }
      }
    }));
    card.appendChild(addRow);

    body.appendChild(wrap);
  }

  // ---- Player page ----

  private renderPlayer(body: HTMLElement) {
    if (!this.universe || !this.activePlayerId) {
      this.screen = this.playerReturnScreen;
      this.render();
      return;
    }
    const u = this.universe;
    const p = u.players.find(x => x.id === this.activePlayerId);
    if (!p) {
      this.screen = this.playerReturnScreen;
      this.render();
      return;
    }
    body.appendChild(playerPage(p, u, (day, idx, round) => this.openReplay(day, idx, round)));
  }
}

// ---- Matchup generation: region-locked, friendship-aware ----------------
//
// Players matchmake only within their own region. Within a region we let
// friends group up: strongly-bonded players ([[chemistry]] >= FRIEND_THRESHOLD)
// form a party that stays on one team, the rest of the slots are filled with
// the nearest-Elo solo players, and full 5-stacks are paired off by team Elo.
// Because teammates bond every time they play, the same parties tend to re-form
// day after day — emergent, self-reinforcing rosters.

function generateMatchups(players: Player[], elos: Record<string, number>, mapCount: number): Matchup[] {
  const pool = Math.max(1, mapCount);
  const eloOf = (p: Player) => elos[p.id] ?? STARTING_ELO;
  const avgElo = (team: Player[]) => team.reduce((s, p) => s + eloOf(p), 0) / team.length;

  // Partition the pool by competitive region — players only see their own scene.
  const byRegion = new Map<Region, Player[]>();
  for (const p of players) {
    const r = regionOf(p.country);
    (byRegion.get(r) ?? byRegion.set(r, []).get(r)!).push(p);
  }

  const matchups: Matchup[] = [];
  let idx = 0;
  // Walk regions in canonical order so the matchup board groups consistently.
  for (const region of REGION_ORDER) {
    const inRegion = byRegion.get(region);
    if (!inRegion || inRegion.length < TEAM_SIZE * 2) continue; // can't field a lobby

    const teams = formTeams(inRegion, eloOf);
    // Pair adjacent teams by Elo so each matchup is between similar-strength
    // 5-stacks. An odd team out sits the day.
    teams.sort((a, b) => avgElo(b) - avgElo(a));
    for (let i = 0; i + 1 < teams.length; i += 2) {
      const aStartsCt = Math.random() < 0.5;
      const ct = aStartsCt ? teams[i] : teams[i + 1];
      const t  = aStartsCt ? teams[i + 1] : teams[i];
      matchups.push({
        id: `m${idx++}`,
        ctPlayerIds: ct.map(p => p.id),
        tPlayerIds:  t.map(p => p.id),
        status: "pending",
        seed: newSeed(),
        mapIndex: Math.floor(Math.random() * pool),
        region,
      });
    }
  }
  return matchups;
}

// Build full 5-player teams out of a region's players, keeping friends together.
//  1. Grow friendship cliques: anchor on the highest-Elo unassigned player and
//     repeatedly pull in their strongest available friend (bond >= threshold).
//  2. Fill each multi-player party up to 5 with the nearest-Elo solo players.
//  3. Chunk any leftover solos into Elo-banded teams of 5.
// Players who don't fit a full team sit out the day.
function formTeams(regionPlayers: Player[], eloOf: (p: Player) => number): Player[][] {
  const byEloDesc = [...regionPlayers].sort(
    (a, b) => eloOf(b) - eloOf(a) || a.id.localeCompare(b.id),
  );
  const used = new Set<string>();

  // 1. Friendship cliques.
  const parties: Player[][] = [];
  for (const anchor of byEloDesc) {
    if (used.has(anchor.id)) continue;
    used.add(anchor.id);
    const party = [anchor];
    while (party.length < TEAM_SIZE) {
      let best: Player | null = null;
      let bestRel = FRIEND_THRESHOLD - 1; // must clear the friendship bar
      for (const cand of byEloDesc) {
        if (used.has(cand.id)) continue;
        // Strongest bond between the candidate and anyone already in the party.
        let rel = -Infinity;
        for (const m of party) rel = Math.max(rel, cand.relationships[m.id] ?? 0);
        if (rel > bestRel) { bestRel = rel; best = cand; }
      }
      if (!best) break;
      used.add(best.id);
      party.push(best);
    }
    parties.push(party);
  }

  const solos = parties
    .filter(p => p.length === 1)
    .map(p => p[0])
    .sort((a, b) => eloOf(b) - eloOf(a) || a.id.localeCompare(b.id));
  const groups = parties
    .filter(p => p.length >= 2)
    .sort((a, b) => avgOf(b, eloOf) - avgOf(a, eloOf));

  const teams: Player[][] = [];

  // 2. Fill each real party up to 5 with the nearest-Elo solos.
  for (const g of groups) {
    const team = [...g];
    const target = avgOf(g, eloOf);
    while (team.length < TEAM_SIZE && solos.length > 0) {
      let bi = 0, bd = Infinity;
      for (let i = 0; i < solos.length; i++) {
        const d = Math.abs(eloOf(solos[i]) - target);
        if (d < bd) { bd = d; bi = i; }
      }
      team.push(solos.splice(bi, 1)[0]);
    }
    if (team.length === TEAM_SIZE) teams.push(team);
    // Under-filled (ran out of solos): party sits the day.
  }

  // 3. Elo-banded teams from the remaining solos.
  for (let i = 0; i + TEAM_SIZE <= solos.length; i += TEAM_SIZE) {
    teams.push(solos.slice(i, i + TEAM_SIZE));
  }

  return teams;
}

function avgOf(team: Player[], eloOf: (p: Player) => number): number {
  return team.reduce((s, p) => s + eloOf(p), 0) / team.length;
}

function newSeed(): number {
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}

// Faceit-style team name: the highest-elo player in the lineup names the
// team. Stable tiebreak by id so the name doesn't drift if elos happen to
// tie. Mirrors rosterColumn's captain-pick logic used on the matchups grid.
function teamNameFor(players: Player[], elos: Record<string, number>): string {
  if (players.length === 0) return "Team";
  const captain = [...players].sort((a, b) => {
    const da = elos[a.id] ?? STARTING_ELO;
    const db = elos[b.id] ?? STARTING_ELO;
    if (db !== da) return db - da;
    return a.id.localeCompare(b.id);
  })[0];
  return `Team ${shortName(captain)}`;
}

// Deep-clone a map so adding the same source twice doesn't share mutable
// arrays between rotation entries.
function deepCloneMap(m: GameMap): GameMap {
  return {
    name: m.name,
    width: m.width,
    height: m.height,
    tileSize: m.tileSize,
    walls: [...m.walls],
    ctSpawns: m.ctSpawns.map(s => ({ x: s.x, y: s.y })),
    tSpawns: m.tSpawns.map(s => ({ x: s.x, y: s.y })),
    bombsites: m.bombsites.map(b => ({ id: b.id, center: { x: b.center.x, y: b.center.y }, radius: b.radius })),
    wallColor: m.wallColor,
    floorColor: m.floorColor,
  };
}

// ---- UI helpers ----

function rosterColumn(
  side: "CT" | "T",
  ids: string[],
  byId: Map<string, Player>,
  elos: Record<string, number>,
  matchup: Matchup,
  onPick?: (playerId: string) => void,
): HTMLElement {
  const col = document.createElement("div");
  col.className = `umc-roster ${side === "CT" ? "ct" : "t"}`;

  // After a match, show each player's elo as it was BEFORE the match plus a
  // ±delta chip. The absolute delta is shared across the roster; the sign
  // flips by side. Before the match, just show the current elo.
  const isDone = matchup.status === "completed" && matchup.eloDelta !== undefined && matchup.winnerSide;
  const signedDelta = isDone
    ? (side === matchup.winnerSide ? +matchup.eloDelta! : -matchup.eloDelta!)
    : 0;
  const eloFor = (id: string) => (elos[id] ?? STARTING_ELO) - signedDelta;

  const players = ids.map(id => byId.get(id)).filter((p): p is Player => !!p);
  const captain = [...players].sort((a, b) => {
    const da = eloFor(a.id);
    const db = eloFor(b.id);
    if (db !== da) return db - da;
    return a.id.localeCompare(b.id);
  })[0];
  const avgElo = players.length
    ? players.reduce((s, p) => s + eloFor(p.id), 0) / players.length
    : STARTING_ELO;

  const header = document.createElement("div");
  header.className = "umc-team-header";
  header.innerHTML =
    `<div class="umc-team-name">Team ${escapeHtml(shortName(captain))}</div>` +
    `<div class="umc-team-elo">Avg ${Math.round(avgElo)}</div>`;
  col.appendChild(header);

  for (const p of players) {
    const row = document.createElement("div");
    row.className = "umc-roster-row";
    const preElo = Math.round(eloFor(p.id));
    let eloHtml = `<span class="umc-elo">${preElo}</span>`;
    if (isDone) {
      const delta = Math.round(signedDelta);
      const cls = delta >= 0 ? "umc-elo-delta good" : "umc-elo-delta bad";
      const sign = delta >= 0 ? "+" : "−";
      eloHtml += `<span class="${cls}">${sign}${Math.abs(delta)}</span>`;
    }
    row.innerHTML = `<span class="umc-flag">${flagEmoji(p.country)}</span><span class="umc-name">${escapeHtml(shortName(p))}</span>${eloHtml}`;
    if (onPick) {
      row.classList.add("clickable");
      row.title = "View player";
      const pid = p.id;
      row.onclick = () => onPick(pid);
    }
    col.appendChild(row);
  }
  return col;
}

type SortKey = "name" | "country" | "age" | "role" | "elo" | "aim" | "mechanical" | "cognitive" | "mental" | "utility" | "leader" | "overall";

const COLUMNS: { key: SortKey; label: string; needsElo?: boolean; getter: (p: Player, elo: number) => number | string }[] = [
  { key: "name",       label: "Name",      getter: (p) => p.handle },
  { key: "country",    label: "From",      getter: (p) => p.country },
  { key: "age",        label: "Age",       getter: (p) => p.age },
  { key: "role",       label: "Role",      getter: (p) => p.role },
  { key: "elo",        label: "Elo", needsElo: true, getter: (_p, e) => Math.round(e) },
  { key: "aim",        label: "Aim",       getter: (p) => avgStats(p, ["accuracy", "crosshairPlacement", "tapping", "flickAim", "sprayControl"]) },
  { key: "mechanical", label: "Mech",      getter: (p) => avgStats(p, ["reflexes", "handSpeed", "movement", "counterStrafe", "jiggle"]) },
  { key: "cognitive",  label: "Mind",      getter: (p) => avgStats(p, ["mapAwareness", "positioning", "gameSense", "timing", "adaptability"]) },
  { key: "mental",     label: "Nerves",    getter: (p) => avgStats(p, ["composure", "aggression", "patience", "discipline", "recovery"]) },
  { key: "utility",    label: "Util",      getter: (p) => avgStats(p, ["utility", "smokeLineups", "flashTiming", "molotovUse"]) },
  { key: "leader",     label: "Lead",      getter: (p) => avgStats(p, ["igl", "communication"]) },
  { key: "overall",    label: "OVR",       getter: (p) => Math.round(avgStats(p, ["accuracy","crosshairPlacement","sprayControl","tapping","flickAim","counterStrafe","reflexes","handSpeed","movement","jiggle","mapAwareness","positioning","gameSense","timing","adaptability","composure","aggression","patience","discipline","recovery","utility","smokeLineups","flashTiming","molotovUse"])) },
];

function playerTable(
  players: Player[],
  elos: Record<string, number>,
  showElo: boolean,
  onPick?: (playerId: string) => void,
): HTMLElement {
  let sortKey: SortKey = showElo ? "elo" : "overall";
  let sortDir: 1 | -1 = -1;

  const wrap = document.createElement("div");
  wrap.className = "universe-player-table-wrap";

  const renderTable = () => {
    wrap.innerHTML = "";
    const table = document.createElement("table");
    table.className = "universe-player-table";
    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    for (const col of COLUMNS) {
      if (col.needsElo && !showElo) continue;
      const th = document.createElement("th");
      th.textContent = col.label + (sortKey === col.key ? (sortDir === -1 ? " ▼" : " ▲") : "");
      th.onclick = () => {
        if (sortKey === col.key) sortDir = (sortDir === 1 ? -1 : 1);
        else { sortKey = col.key; sortDir = -1; }
        renderTable();
      };
      trh.appendChild(th);
    }
    thead.appendChild(trh);
    table.appendChild(thead);

    const sortedCol = COLUMNS.find(c => c.key === sortKey)!;
    const sorted = [...players].sort((a, b) => {
      const va = sortedCol.getter(a, elos[a.id] ?? STARTING_ELO);
      const vb = sortedCol.getter(b, elos[b.id] ?? STARTING_ELO);
      if (typeof va === "number" && typeof vb === "number") return (va - vb) * sortDir;
      return String(va).localeCompare(String(vb)) * sortDir;
    });

    const tbody = document.createElement("tbody");
    for (const p of sorted) {
      const tr = document.createElement("tr");
      if (onPick) {
        tr.classList.add("clickable-row");
        tr.onclick = () => onPick(p.id);
      }
      for (const col of COLUMNS) {
        if (col.needsElo && !showElo) continue;
        const td = document.createElement("td");
        const v = col.getter(p, elos[p.id] ?? STARTING_ELO);
        if (col.key === "country") {
          td.innerHTML = `<span class="flag">${flagEmoji(p.country)}</span> ${escapeHtml(p.country)}`;
          td.className = "country-cell";
        } else if (col.key === "name") {
          // Handle is the primary identifier; real name rides along underneath.
          td.innerHTML = `<span class="pt-handle">${escapeHtml(p.handle)}</span>` +
            `<span class="pt-realname">${escapeHtml(p.name)}</span>`;
          td.className = "name-cell";
        } else {
          td.textContent = typeof v === "number" ? String(Math.round(v)) : String(v);
        }
        // Color-code stat ratings on a red→yellow→green gradient. Elo, age,
        // country, name, and role stay uncolored — they aren't 0-100 ratings.
        if (typeof v === "number" && col.key !== "elo" && col.key !== "age") {
          td.style.color = ratingColor(v);
        }
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
  };

  renderTable();
  return wrap;
}

// Career stats table — aggregates each player's game log into a sortable
// per-player overview of their performance across the whole universe history.
function careerStatsTable(u: Universe, onPick?: (id: string) => void): HTMLElement {
  interface CareerRow {
    p: Player;
    elo: number;
    matches: number;
    winPct: number;
    record: string;
    kills: number;
    deaths: number;
    assists: number;
    kd: number;
    adr: number | null;
    rating: number | null;
    clutches: number;
    k2: number; k3: number; k4: number; k5: number;
    clutchBuckets: ClutchBucketStats[];     // length 5: 1v1..1v5
  }

  const rows: CareerRow[] = u.players.map(p => {
    const log = buildGameLog(p.id, u);
    const c = summarizeCareer(log);
    const clutches = log.reduce((s, g) => s + g.clutches.length, 0);
    const clutchBuckets = summarizeClutchBuckets(log);
    return {
      p,
      elo: u.elos[p.id] ?? STARTING_ELO,
      matches: c.played,
      winPct: c.played > 0 ? (c.wins / c.played) * 100 : 0,
      record: `${c.wins}-${c.losses}`,
      kills: c.kills,
      deaths: c.deaths,
      assists: c.assists,
      kd: c.deaths > 0 ? c.kills / c.deaths : c.kills,
      adr: c.adr,
      rating: c.rating,
      clutches,
      k2: c.k2, k3: c.k3, k4: c.k4, k5: c.k5,
      clutchBuckets,
    };
  });

  type Col = {
    label: string;
    cellHtml: (r: CareerRow) => string;
    cmp: (a: CareerRow, b: CareerRow) => number;
    cls?: string;
  };
  const numCmp = (sel: (r: CareerRow) => number) => (a: CareerRow, b: CareerRow) => sel(a) - sel(b);
  const cols: Col[] = [
    { label: "Name",   cellHtml: r => `<span class="pt-handle">${escapeHtml(r.p.handle)}</span><span class="pt-realname">${escapeHtml(r.p.name)}</span>`, cmp: (a, b) => a.p.handle.localeCompare(b.p.handle), cls: "name-cell" },
    { label: "From",   cellHtml: r => `<span class="flag">${flagEmoji(r.p.country)}</span> ${escapeHtml(r.p.country)}`, cmp: (a, b) => a.p.country.localeCompare(b.p.country), cls: "country-cell" },
    { label: "Role",   cellHtml: r => escapeHtml(r.p.role), cmp: (a, b) => a.p.role.localeCompare(b.p.role) },
    { label: "Elo",    cellHtml: r => String(Math.round(r.elo)), cmp: numCmp(r => r.elo) },
    { label: "M",      cellHtml: r => String(r.matches), cmp: numCmp(r => r.matches) },
    { label: "Record", cellHtml: r => r.record, cmp: numCmp(r => r.matches > 0 ? r.winPct : -1) },
    { label: "Win %",  cellHtml: r => r.matches > 0 ? `${Math.round(r.winPct)}%` : "—", cmp: numCmp(r => r.winPct) },
    { label: "K",      cellHtml: r => String(r.kills), cmp: numCmp(r => r.kills) },
    { label: "D",      cellHtml: r => String(r.deaths), cmp: numCmp(r => r.deaths) },
    { label: "A",      cellHtml: r => String(r.assists), cmp: numCmp(r => r.assists) },
    { label: "K/D",    cellHtml: r => r.deaths + r.kills > 0 ? r.kd.toFixed(2) : "—", cmp: numCmp(r => r.kd) },
    { label: "ADR",    cellHtml: r => r.adr !== null ? r.adr.toFixed(1) : "—", cmp: numCmp(r => r.adr ?? -1) },
    { label: "Rating", cellHtml: r => r.rating !== null
        ? `<span style="color:${r.rating >= 1 ? "var(--good)" : "var(--bad)"};font-weight:700">${r.rating.toFixed(2)}</span>`
        : "—", cmp: numCmp(r => r.rating ?? -1) },
    { label: "2K",     cellHtml: r => String(r.k2), cmp: numCmp(r => r.k2) },
    { label: "3K",     cellHtml: r => String(r.k3), cmp: numCmp(r => r.k3) },
    { label: "4K",     cellHtml: r => String(r.k4), cmp: numCmp(r => r.k4) },
    { label: "Ace",    cellHtml: r => r.k5 > 0 ? `<span style="color:var(--accent);font-weight:700">${r.k5}</span>` : "0", cmp: numCmp(r => r.k5) },
    { label: "Clutch", cellHtml: r => r.clutches > 0 ? `<span style="color:var(--accent);font-weight:600">${r.clutches}</span>` : "0", cmp: numCmp(r => r.clutches) },
    ...([1, 2, 3, 4, 5] as const).map(bn => ({
      label: `1v${bn}`,
      cellHtml: (r: CareerRow) => {
        const b = r.clutchBuckets[bn - 1];
        if (b.attempts === 0) return `<span class="upp-gl-missing">—</span>`;
        const rate = Math.round((b.wins / b.attempts) * 100);
        return `<span>${b.wins}/${b.attempts}</span> <span class="upp-gl-missing" style="font-size:11px">${rate}%</span>`;
      },
      // Sort by total successful clutches in this bucket; tiebreak by attempts.
      cmp: (a: CareerRow, b2: CareerRow) => {
        const wa = a.clutchBuckets[bn - 1].wins;
        const wb = b2.clutchBuckets[bn - 1].wins;
        if (wa !== wb) return wa - wb;
        return a.clutchBuckets[bn - 1].attempts - b2.clutchBuckets[bn - 1].attempts;
      },
    })),
  ];

  let sortIdx = cols.findIndex(c => c.label === "Rating");
  let sortDir: 1 | -1 = -1;

  const wrap = document.createElement("div");
  wrap.className = "universe-player-table-wrap";

  const draw = () => {
    wrap.innerHTML = "";
    const table = document.createElement("table");
    table.className = "universe-player-table";
    const thead = document.createElement("thead");
    const trh = document.createElement("tr");
    cols.forEach((c, i) => {
      const th = document.createElement("th");
      th.textContent = c.label + (sortIdx === i ? (sortDir === -1 ? " ▼" : " ▲") : "");
      th.onclick = () => {
        if (sortIdx === i) sortDir = (sortDir === 1 ? -1 : 1);
        else { sortIdx = i; sortDir = -1; }
        draw();
      };
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);

    const sorted = [...rows].sort((a, b) => cols[sortIdx].cmp(a, b) * sortDir);
    const tbody = document.createElement("tbody");
    for (const r of sorted) {
      const tr = document.createElement("tr");
      if (onPick) {
        tr.classList.add("clickable-row");
        tr.onclick = () => onPick(r.p.id);
      }
      for (const c of cols) {
        const td = document.createElement("td");
        td.innerHTML = c.cellHtml(r);
        if (c.cls) td.className = c.cls;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
  };

  draw();
  return wrap;
}

// Map a 0-100 rating to a red→yellow→green background. Stats here cluster in
// roughly 30-90, so anchor the gradient between those for stronger contrast.
function ratingColor(v: number): string {
  const t = Math.max(0, Math.min(1, (v - 30) / 60));
  const hue = t * 120; // 0 = red, 60 = yellow, 120 = green
  return `hsl(${hue}, 75%, 62%)`;
}

function avgStats(p: Player, keys: string[]): number {
  let sum = 0;
  for (const k of keys) sum += (p.stats as unknown as Record<string, number>)[k] ?? 0;
  return sum / keys.length;
}

// Modal: box-score view of a completed match. Lists each side's roster with
// K/D/A, damage, ADR, and HLTV 1.0 rating. Cheap to render — pulls from the
// playerStats snapshot already stored on the matchup.
function showMatchStatsModal(m: Matchup, u: Universe) {
  const backdrop = document.createElement("div");
  backdrop.className = "universe-modal-backdrop";
  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
  };
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);

  const modal = document.createElement("div");
  modal.className = "universe-modal universe-stats-modal";

  const header = document.createElement("div");
  header.className = "ustats-header";
  const ctWon = m.winnerSide === "CT";
  header.innerHTML =
    `<div class="ustats-score">` +
      `<span class="ct${ctWon ? " winner" : ""}">${m.ctScore ?? 0}</span>` +
      `<span class="sep">:</span>` +
      `<span class="t${ctWon ? "" : " winner"}">${m.tScore ?? 0}</span>` +
    `</div>`;
  const closeBtn = document.createElement("button");
  closeBtn.className = "ustats-close";
  closeBtn.textContent = "✕";
  closeBtn.onclick = close;
  header.appendChild(closeBtn);
  modal.appendChild(header);

  const wrap = document.createElement("div");
  wrap.className = "ustats-teams";
  wrap.appendChild(boxScoreTable("CT", m.ctPlayerIds, m, u));
  wrap.appendChild(boxScoreTable("T",  m.tPlayerIds,  m, u));
  modal.appendChild(wrap);

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
}

function boxScoreTable(side: "CT" | "T", ids: string[], m: Matchup, u: Universe): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = `ustats-team ${side === "CT" ? "ct" : "t"}`;
  const title = document.createElement("div");
  title.className = "ustats-team-title";
  title.textContent = `${side} side`;
  wrap.appendChild(title);

  const table = document.createElement("table");
  table.className = "ustats-team-table";
  table.innerHTML = `<thead><tr>
    <th>Player</th><th>K</th><th>D</th><th>A</th><th>DMG</th><th>ADR</th><th>Rating</th>
  </tr></thead>`;
  const tbody = document.createElement("tbody");

  const rows = ids.map(id => {
    const p = u.players.find(x => x.id === id);
    const s = m.playerStats?.[id] ?? null;
    return { id, p, s };
  });
  // Sort by rating desc so the top performers float to the top.
  rows.sort((a, b) => {
    const ra = a.s ? hltvRating1(a.s) : -1;
    const rb = b.s ? hltvRating1(b.s) : -1;
    return rb - ra;
  });

  for (const r of rows) {
    if (!r.p) continue;
    const s = r.s;
    const adr = s && s.roundsPlayed > 0 ? s.damage / s.roundsPlayed : null;
    const rating = s ? hltvRating1(s) : null;
    const num = (v: number | null, d = 0) =>
      v === null ? `<td class="ustats-missing">—</td>`
                 : `<td>${d === 0 ? Math.round(v) : v.toFixed(d)}</td>`;
    const ratingCell = rating === null
      ? `<td class="ustats-missing">—</td>`
      : `<td style="color:${rating >= 1 ? "var(--good)" : "var(--bad)"};font-weight:700">${rating.toFixed(2)}</td>`;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="ustats-name">${escapeHtml(shortName(r.p))}</td>
      ${num(s?.kills ?? null)}
      ${num(s?.deaths ?? null)}
      ${num(s?.assists ?? null)}
      ${num(s?.damage ?? null)}
      ${num(adr, 1)}
      ${ratingCell}
    `;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function shortName(p: Player): string {
  return p.handle;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
}

function nextFrame(): Promise<void> {
  return new Promise(r => requestAnimationFrame(() => r()));
}

function makeSimOverlay(total: number): { el: HTMLElement; update: (done: number) => void } {
  const el = document.createElement("div");
  el.className = "universe-sim-overlay";
  el.innerHTML = `
    <div class="usim-card">
      <div class="usim-title">Simulating…</div>
      <div class="usim-bar"><div class="usim-fill"></div></div>
      <div class="usim-count">0 / ${total} days</div>
    </div>`;
  const fill = el.querySelector(".usim-fill") as HTMLElement;
  const count = el.querySelector(".usim-count") as HTMLElement;
  return {
    el,
    update(done: number) {
      const pct = Math.min(100, Math.round((done / total) * 100));
      fill.style.width = `${pct}%`;
      count.textContent = `${done} / ${total} days`;
    },
  };
}

// Stat groupings used by both the table summary columns and the player page.
const STAT_GROUPS: { label: string; keys: (keyof import("../domain/types.ts").PlayerStats)[] }[] = [
  { label: "Aim",        keys: ["accuracy", "crosshairPlacement", "sprayControl", "tapping", "flickAim", "counterStrafe"] },
  { label: "Mechanical", keys: ["reflexes", "handSpeed", "movement", "jiggle"] },
  { label: "Cognitive",  keys: ["mapAwareness", "positioning", "gameSense", "timing", "adaptability"] },
  { label: "Mental",     keys: ["composure", "aggression", "patience", "discipline", "recovery"] },
  { label: "Utility",    keys: ["utility", "smokeLineups", "flashTiming", "molotovUse"] },
  { label: "Team",       keys: ["igl", "communication"] },
  { label: "Weapon prefs", keys: ["pistolPref", "riflePref", "awpPref", "smgPref"] },
];

function playerPage(
  p: Player, u: Universe,
  onReplay: (day: number, matchIdx: number, startAtRound?: number) => void,
): HTMLElement {
  const root = document.createElement("div");
  root.className = "universe-player-page";

  const elo = Math.round(u.elos[p.id] ?? STARTING_ELO);
  const log = buildGameLog(p.id, u);
  const career = summarizeCareer(log);
  const clutchBuckets = summarizeClutchBuckets(log);
  const totalClutchWins = clutchBuckets.reduce((s, b) => s + b.wins, 0);
  const totalClutchAttempts = clutchBuckets.reduce((s, b) => s + b.attempts, 0);

  // ----- Header -----
  const header = document.createElement("div");
  header.className = "upp-header";
  header.innerHTML = `
    <div class="upp-identity">
      <div class="upp-flag">${flagEmoji(p.country)}</div>
      <div>
        <div class="upp-name">${escapeHtml(p.name)}</div>
        <div class="upp-handle">"${escapeHtml(p.handle)}"</div>
        <div class="upp-meta">${escapeHtml(p.country)} · Age ${p.age} · ${escapeHtml(p.role)}</div>
      </div>
    </div>
    <div class="upp-headline-stats">
      <div class="upp-hl"><div class="upp-hl-label">Elo</div><div class="upp-hl-val">${elo}</div></div>
      <div class="upp-hl"><div class="upp-hl-label">Matches</div><div class="upp-hl-val">${career.played}</div></div>
      <div class="upp-hl"><div class="upp-hl-label">Record</div><div class="upp-hl-val">${career.wins}-${career.losses}</div></div>
      <div class="upp-hl"><div class="upp-hl-label">Win %</div><div class="upp-hl-val">${career.played > 0 ? Math.round((career.wins / career.played) * 100) : 0}%</div></div>
      <div class="upp-hl"><div class="upp-hl-label">Rounds</div><div class="upp-hl-val">${career.roundsWon}-${career.roundsLost}</div></div>
      <div class="upp-hl"><div class="upp-hl-label">Round diff</div><div class="upp-hl-val">${career.roundDiff >= 0 ? "+" : ""}${career.roundDiff}</div></div>
      ${career.hasStats ? `
        <div class="upp-hl"><div class="upp-hl-label">K / D / A</div><div class="upp-hl-val">${career.kills} / ${career.deaths} / ${career.assists}</div></div>
        <div class="upp-hl"><div class="upp-hl-label">ADR</div><div class="upp-hl-val">${career.adr !== null ? career.adr.toFixed(1) : "—"}</div></div>
        <div class="upp-hl"><div class="upp-hl-label">Rating</div><div class="upp-hl-val" style="color:${(career.rating ?? 0) >= 1 ? "var(--good)" : "var(--bad)"}">${career.rating !== null ? career.rating.toFixed(2) : "—"}</div></div>
      ` : ""}
    </div>
  `;
  root.appendChild(header);

  // ----- Traits -----
  const traits = document.createElement("div");
  traits.className = "upp-traits";
  if (p.traits.length === 0) {
    traits.innerHTML = `<span class="upp-trait-empty">No notable traits</span>`;
  } else {
    for (const t of p.traits) {
      const chip = document.createElement("span");
      chip.className = "upp-trait";
      chip.textContent = t;
      traits.appendChild(chip);
    }
  }
  root.appendChild(traits);

  // ----- Dynamic state (money/mood/morale) -----
  const dyn = document.createElement("div");
  dyn.className = "upp-dyn";
  dyn.innerHTML = `
    <div class="upp-dyn-item"><span>Money</span><b>$${p.money}</b></div>
    <div class="upp-dyn-item"><span>Mood</span><b style="color:${ratingColor(p.mood)}">${Math.round(p.mood)}</b></div>
    <div class="upp-dyn-item"><span>Morale</span><b style="color:${ratingColor(p.morale)}">${Math.round(p.morale)}</b></div>
    <div class="upp-dyn-item"><span>CT assignment</span><b>${p.ctAssignment}</b></div>
  `;
  root.appendChild(dyn);

  // ----- Stat groups -----
  const grid = document.createElement("div");
  grid.className = "upp-stat-grid";
  const statsObj = p.stats as unknown as Record<string, number>;
  for (const g of STAT_GROUPS) {
    const card = document.createElement("div");
    card.className = "upp-stat-card";
    const title = document.createElement("div");
    title.className = "upp-stat-title";
    title.textContent = g.label;
    card.appendChild(title);
    for (const k of g.keys) {
      const v = statsObj[k as string] ?? 0;
      const row = document.createElement("div");
      row.className = "upp-stat-row";
      row.innerHTML = `
        <span class="upp-stat-key">${escapeHtml(prettifyKey(k as string))}</span>
        <span class="upp-stat-bar"><span class="upp-stat-fill" style="width:${Math.max(0, Math.min(100, v))}%;background:${ratingColor(v)}"></span></span>
        <span class="upp-stat-val" style="color:${ratingColor(v)}">${Math.round(v)}</span>
      `;
      card.appendChild(row);
    }
    grid.appendChild(card);
  }
  root.appendChild(grid);

  // ----- Relationships (only show non-zero, capped) -----
  const rels = Object.entries(p.relationships ?? {}).filter(([, v]) => v !== 0);
  if (rels.length > 0) {
    const relsCard = document.createElement("div");
    relsCard.className = "upp-rels";
    const title = document.createElement("div");
    title.className = "upp-stat-title";
    title.textContent = "Relationships";
    relsCard.appendChild(title);
    const byId = new Map(u.players.map(x => [x.id, x] as const));
    rels.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 20).forEach(([id, v]) => {
      const other = byId.get(id);
      if (!other) return;
      const row = document.createElement("div");
      row.className = "upp-rel-row";
      const color = v > 0 ? "var(--ct, #6ea6ff)" : "#e57373";
      row.innerHTML = `<span>${escapeHtml(other.name)}</span><span style="color:${color}">${v > 0 ? "+" : ""}${v}</span>`;
      relsCard.appendChild(row);
    });
    root.appendChild(relsCard);
  }

  // ----- Clutches (conversion by 1vX bucket) -----
  const clutchCard = document.createElement("div");
  clutchCard.className = "upp-clutches";
  const clutchTitle = document.createElement("div");
  clutchTitle.className = "upp-stat-title";
  const overallRate = totalClutchAttempts > 0
    ? Math.round((totalClutchWins / totalClutchAttempts) * 100)
    : 0;
  clutchTitle.textContent = totalClutchAttempts > 0
    ? `Clutches (${totalClutchWins} / ${totalClutchAttempts} · ${overallRate}%)`
    : `Clutches (0)`;
  clutchCard.appendChild(clutchTitle);
  const row = document.createElement("div");
  row.className = "upp-clutch-row";
  for (const b of clutchBuckets) {
    const cell = document.createElement("div");
    cell.className = "upp-clutch-cell";
    const rate = b.attempts > 0 ? Math.round((b.wins / b.attempts) * 100) : null;
    const rateStr = rate !== null ? `${rate}%` : "—";
    cell.innerHTML =
      `<div class="upp-clutch-label">1v${b.bucket}</div>` +
      `<div class="upp-clutch-val">${b.wins}<span class="upp-clutch-attempts">/${b.attempts}</span></div>` +
      `<div class="upp-clutch-rate">${rateStr}</div>`;
    row.appendChild(cell);
  }
  clutchCard.appendChild(row);
  root.appendChild(clutchCard);

  // ----- Multi-kill rounds -----
  const mkCard = document.createElement("div");
  mkCard.className = "upp-clutches";
  const mkTitle = document.createElement("div");
  mkTitle.className = "upp-stat-title";
  const mkTotal = career.k2 + career.k3 + career.k4 + career.k5;
  mkTitle.textContent = `Multi-kill rounds (${mkTotal})`;
  mkCard.appendChild(mkTitle);
  const mkBuckets: { label: string; count: number }[] = [
    { label: "2K",  count: career.k2 },
    { label: "3K",  count: career.k3 },
    { label: "4K",  count: career.k4 },
    { label: "Ace", count: career.k5 },
  ];
  const mkRow = document.createElement("div");
  mkRow.className = "upp-clutch-row";
  for (const b of mkBuckets) {
    const cell = document.createElement("div");
    cell.className = "upp-clutch-cell";
    cell.innerHTML = `<div class="upp-clutch-label">${escapeHtml(b.label)}</div><div class="upp-clutch-val">${b.count}</div>`;
    mkRow.appendChild(cell);
  }
  mkCard.appendChild(mkRow);
  root.appendChild(mkCard);

  // ----- Game log -----
  const logCard = document.createElement("div");
  logCard.className = "upp-gamelog";
  const logTitle = document.createElement("div");
  logTitle.className = "upp-stat-title";
  logTitle.textContent = `Game log (${log.length})`;
  logCard.appendChild(logTitle);

  if (log.length === 0) {
    const empty = document.createElement("div");
    empty.className = "upp-gamelog-empty";
    empty.textContent = "No matches played yet.";
    logCard.appendChild(empty);
  } else {
    const table = document.createElement("table");
    table.className = "upp-gamelog-table";
    table.innerHTML = `<thead><tr>
      <th>Day</th><th>Side</th><th>Score</th><th>Result</th><th>Opponent</th>
      <th>K</th><th>D</th><th>A</th><th>DMG</th><th>ADR</th><th>Rating</th>
      <th>Clutch</th>
    </tr></thead>`;
    const tbody = document.createElement("tbody");
    const byId = new Map(u.players.map(x => [x.id, x] as const));
    for (const g of log) {
      const tr = document.createElement("tr");
      const opp = g.opponentIds.map(id => byId.get(id)).filter((x): x is Player => !!x);
      const oppCaptain = [...opp].sort((a, b) => {
        const da = u.elos[a.id] ?? STARTING_ELO;
        const db = u.elos[b.id] ?? STARTING_ELO;
        if (db !== da) return db - da;
        return a.id.localeCompare(b.id);
      })[0];
      const oppLabel = oppCaptain ? `Team ${shortName(oppCaptain)}` : "—";
      const sideClass = g.side === "CT" ? "ct" : "t";
      const resultClass = g.won ? "good" : "bad";
      const s = g.stats;
      const adr = s && s.roundsPlayed > 0 ? s.damage / s.roundsPlayed : null;
      const rating = s ? hltvRating1(s) : null;
      const numCell = (v: number | null, digits = 0) =>
        v === null ? `<td class="upp-gl-stat upp-gl-missing">—</td>`
                   : `<td class="upp-gl-stat">${digits === 0 ? Math.round(v) : v.toFixed(digits)}</td>`;
      const ratingCell = rating === null
        ? `<td class="upp-gl-stat upp-gl-missing">—</td>`
        : `<td class="upp-gl-stat upp-gl-rating" style="color:${rating >= 1 ? "var(--good)" : "var(--bad)"}">${rating.toFixed(2)}</td>`;
      tr.innerHTML = `
        <td>${g.day}</td>
        <td class="upp-gl-side ${sideClass}">${g.side}</td>
        <td class="upp-gl-score"><b>${g.ownScore}</b> : ${g.oppScore}</td>
        <td class="upp-gl-result ${resultClass}">${g.won ? "W" : "L"}</td>
        <td>${escapeHtml(oppLabel)}</td>
        ${numCell(s?.kills ?? null)}
        ${numCell(s?.deaths ?? null)}
        ${numCell(s?.assists ?? null)}
        ${numCell(s?.damage ?? null)}
        ${numCell(adr, 1)}
        ${ratingCell}
      `;

      // Clutch cell: build with per-clutch chips so each can deep-link into
      // the replay starting at that round.
      const clutchTd = document.createElement("td");
      clutchTd.className = "upp-gl-clutch";
      g.clutches.forEach((c, ci) => {
        if (ci > 0) clutchTd.appendChild(document.createTextNode(", "));
        const chip = document.createElement("span");
        chip.textContent = `1v${c.kills}`;
        if (g.seed !== undefined && c.round !== undefined) {
          chip.className = "upp-gl-clutch-chip";
          chip.title = `Replay round ${c.round}`;
          chip.onclick = (ev) => {
            ev.stopPropagation();
            onReplay(g.day, g.matchIdx, c.round);
          };
        }
        clutchTd.appendChild(chip);
      });
      tr.appendChild(clutchTd);

      // Whole-match replay: clickable row, only when seed is recorded.
      if (g.seed !== undefined) {
        tr.classList.add("clickable-row");
        tr.title = "Replay match";
        tr.onclick = () => onReplay(g.day, g.matchIdx);
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    logCard.appendChild(table);
  }
  root.appendChild(logCard);

  // ----- Raw JSON (collapsed) for debugging while we iterate -----
  const details = document.createElement("details");
  details.className = "upp-raw";
  const summary = document.createElement("summary");
  summary.textContent = "Raw player data";
  details.appendChild(summary);
  const pre = document.createElement("pre");
  pre.textContent = JSON.stringify(p, null, 2);
  details.appendChild(pre);
  root.appendChild(details);

  return root;
}

interface GameLogEntry {
  day: number;
  matchIdx: number;
  seed: number | undefined;
  side: "CT" | "T";
  ownScore: number;
  oppScore: number;
  won: boolean;
  opponentIds: string[];
  // Only successful clutches end up here — used for the kills/round chips.
  clutches: { kills: number; round: number | undefined }[];
  // Full attempt list (won + lost) for opportunity tracking.
  clutchAttempts: { bucket: number; won: boolean; round: number | undefined }[];
  stats: import("./types.ts").PlayerMatchStats | null;
}

// Resolve which 1vX bucket a clutch belongs to. Prefer enemiesAtStart (the
// standard definition); fall back to kills for legacy saves where only
// successful clutches were recorded with their kill count.
function clutchBucket(c: { kills: number; enemiesAtStart?: number; won?: boolean }): number {
  return c.enemiesAtStart ?? c.kills ?? 0;
}

// HLTV 1.0 rating from per-match stats. Constants are the league averages used
// in the original formula. Returns 0 if the player did not play any rounds.
function hltvRating1(s: import("./types.ts").PlayerMatchStats): number {
  const R = s.roundsPlayed;
  if (R <= 0) return 0;
  const kr = (s.kills / R) / 0.679;
  const sr = ((R - s.deaths) / R) / 0.317;
  const mkr = (s.k1 + 4 * s.k2 + 9 * s.k3 + 16 * s.k4 + 25 * s.k5) / R / 1.277;
  return (kr + 0.7 * sr + mkr) / 2.7;
}

function buildGameLog(playerId: string, u: Universe): GameLogEntry[] {
  const out: GameLogEntry[] = [];
  for (const day of u.history) {
    day.matchups.forEach((m, idx) => {
      if (m.status !== "completed" || !m.winnerSide
          || m.ctScore === undefined || m.tScore === undefined) return;
      const onCt = m.ctPlayerIds.includes(playerId);
      const onT  = m.tPlayerIds.includes(playerId);
      if (!onCt && !onT) return;
      const side: "CT" | "T" = onCt ? "CT" : "T";
      const ownScore = onCt ? m.ctScore : m.tScore;
      const oppScore = onCt ? m.tScore : m.ctScore;
      const myClutches = (m.clutches ?? []).filter(c => c.playerId === playerId);
      // Re-derive whether each clutch attempt was actually converted from
      // data we always have: the player's side this match and the match
      // winner. The saved `won` field is treated as advisory only — legacy
      // entries don't have it, and we've seen cases where the algorithm
      // recorded `won: true` despite the player dying / their side losing.
      const playerSide: "CT" | "T" = onCt ? "CT" : "T";
      const won = playerSide === m.winnerSide;
      const clutches = won
        ? myClutches.map(c => ({ kills: c.kills, round: c.round }))
        : [];
      const clutchAttempts = myClutches.map(c => ({
        bucket: clutchBucket(c),
        won,
        round: c.round,
      }));
      out.push({
        day: day.day,
        matchIdx: idx,
        seed: m.seed,
        side,
        ownScore,
        oppScore,
        won: (onCt && m.winnerSide === "CT") || (onT && m.winnerSide === "T"),
        opponentIds: onCt ? m.tPlayerIds : m.ctPlayerIds,
        clutches,
        clutchAttempts,
        stats: m.playerStats?.[playerId] ?? null,
      });
    });
  }
  // Most recent first.
  out.sort((a, b) => b.day - a.day);
  return out;
}

// Group clutches into 1v1..1v5 buckets by the number of kills the player got
// while last alive. Any clutch with 0 kills (e.g. T-side clutch where the bomb
// detonates) is bucketed as 1v0 only if present.
interface ClutchBucketStats { bucket: number; wins: number; attempts: number; }

function summarizeClutchBuckets(log: GameLogEntry[]): ClutchBucketStats[] {
  // Always show the standard 1v1..1v5 buckets so conversion% has stable
  // columns even when a bucket has zero attempts.
  const buckets = new Map<number, ClutchBucketStats>();
  for (const b of [1, 2, 3, 4, 5]) buckets.set(b, { bucket: b, wins: 0, attempts: 0 });
  for (const g of log) {
    for (const a of g.clutchAttempts) {
      const b = Math.max(1, Math.min(5, a.bucket));
      const s = buckets.get(b)!;
      s.attempts++;
      if (a.won) s.wins++;
    }
  }
  return [...buckets.values()];
}

function summarizeCareer(log: GameLogEntry[]) {
  let wins = 0, losses = 0, roundsWon = 0, roundsLost = 0;
  let kills = 0, deaths = 0, assists = 0, damage = 0, rounds = 0;
  let k1 = 0, k2 = 0, k3 = 0, k4 = 0, k5 = 0;
  let matchesWithStats = 0;
  for (const g of log) {
    if (g.won) wins++; else losses++;
    roundsWon += g.ownScore;
    roundsLost += g.oppScore;
    if (g.stats) {
      matchesWithStats++;
      kills += g.stats.kills;
      deaths += g.stats.deaths;
      assists += g.stats.assists;
      damage += g.stats.damage;
      rounds += g.stats.roundsPlayed;
      k1 += g.stats.k1; k2 += g.stats.k2; k3 += g.stats.k3;
      k4 += g.stats.k4; k5 += g.stats.k5;
    }
  }
  const rating = matchesWithStats > 0
    ? hltvRating1({ kills, deaths, assists, damage, roundsPlayed: rounds, k1, k2, k3, k4, k5 })
    : null;
  return {
    played: log.length,
    wins,
    losses,
    roundsWon,
    roundsLost,
    roundDiff: roundsWon - roundsLost,
    kills, deaths, assists, damage, rounds,
    adr: rounds > 0 ? damage / rounds : null,
    rating,
    hasStats: matchesWithStats > 0,
    k2, k3, k4, k5,
  };
}

function prettifyKey(k: string): string {
  return k.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase());
}

function btn(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.className = `universe-btn ${cls}`.trim();
  b.onclick = onClick;
  return b;
}
