import type { GameMap, Player } from "../domain/types.ts";
import { makePlayer, setSeed } from "../domain/factory.ts";
import {
  flagEmoji, REGION_ORDER, REGION_LABELS, type Region,
} from "../domain/countries.ts";
import { loadCustomMap, loadSavedMapsAll } from "../editor/mapEditor.ts";
import { builtinMaps } from "../domain/builtinMaps.ts";
import { decayRelationships } from "./chemistry.ts";
import { observeMatch } from "./observeMatch.ts";
import {
  generateMatchups, newSeed, simOneMatchup, foldOutcome, recordMatchupCareers,
  emptyCareer, clutchBucket, type SimState, type MatchupOutcome,
} from "./universeSim.ts";
import SimWorker from "./universeSimWorker.ts?worker";
import type { SimWorkerRequest, SimWorkerResponse } from "./universeSimWorker.ts";
import {
  appendDays, deleteUniverse, listUniverses, loadUniverse, newUniverseId,
  saveUniverse, HISTORY_WINDOW,
} from "./storage.ts";
import {
  PLAYERS_PER_REGION, MAX_PLAYERS_PER_REGION, STARTING_ELO, TEAM_SIZE,
  type CareerStats, type Clutch, type CompletedDay, type Matchup, type PlayerMatchStats, type Universe,
} from "./types.ts";

// How many recent completed days to keep in memory for replay + per-player game
// logs. The full archive lives in IndexedDB; lifetime stats live in
// `Universe.careers`, so trimming here only limits how far back individual
// matches stay replayable — not the career totals.
const HISTORY_DAYS = HISTORY_WINDOW;

type Screen = "menu" | "newUniverse" | "players" | "matchups" | "match" | "standings" | "career" | "settings" | "player" | "replay";

// In-progress configuration for the New Universe setup screen.
interface UniverseSetup {
  name: string;
  regions: Set<Region>;
  perRegion: number;
  maps: GameMap[];
}

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
  private replayRef: { day: number; matchIdx: number; startAtRound?: number; gameIdx?: number } | null = null;
  private replayReturnPlayerId: string | null = null;
  // Config being assembled on the New Universe setup screen.
  private setup: UniverseSetup | null = null;
  // Which day the matchups board is showing. null = follow the live (current)
  // day; a number points at a past day held in the in-memory history window.
  private viewingDay: number | null = null;

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

    // Top bar (visible on every screen except the match canvas / replay and the
    // full-bleed title screen, which is its own immersive layout).
    if (this.screen !== "match" && this.screen !== "replay" && this.screen !== "menu") {
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
      case "newUniverse": this.renderNewUniverse(body); break;
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

  private openReplay(day: number, matchIdx: number, startAtRound?: number, gameIdx?: number) {
    if (!this.universe) return;
    this.replayRef = { day, matchIdx, startAtRound, gameIdx };
    // If we're already on a player page, return to it after the replay.
    this.replayReturnPlayerId = this.screen === "player" ? this.activePlayerId : null;
    this.screen = "replay";
    this.render();
  }

  private async renderReplay(body: HTMLElement) {
    if (!this.universe || !this.replayRef) { this.exitReplay(); return; }
    const u = this.universe;
    const ref = this.replayRef;
    // Resolve from history, or the in-progress day for matches just completed
    // today (which haven't rolled into history yet).
    const day = u.history.find(d => d.day === ref.day)
      ?? (u.pendingDay?.day === ref.day ? u.pendingDay : undefined);
    const m = day?.matchups[ref.matchIdx];
    if (!m || !u.maps || u.maps.length === 0) { this.exitReplay(); return; }
    // A series replays a specific game (each has its own seed/map); a Bo1 uses
    // the matchup's own seed/map.
    const game = m.games && ref.gameIdx !== undefined ? m.games[ref.gameIdx] : undefined;
    const seed = game ? game.seed : m.seed;
    if (seed === undefined) { this.exitReplay(); return; }
    const map = u.maps[(game ? game.mapIndex : m.mapIndex) ?? 0] ?? u.maps[0];
    // Sim-time morale snapshot, so the replay reproduces the exact stored match.
    const moods = game ? game.moods : m.moods;
    const ctPlayers = m.ctPlayerIds.map(id => u.players.find(p => p.id === id)!).filter(Boolean);
    const tPlayers  = m.tPlayerIds.map (id => u.players.find(p => p.id === id)!).filter(Boolean);
    const back = () => this.exitReplay();
    await observeMatch(body, {
      ctName: teamNameFor(ctPlayers, u.elos),
      tName:  teamNameFor(tPlayers,  u.elos),
      ctPlayers, tPlayers,
      map,
      seed,
      moods,
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
    // Full-bleed broadcast title screen.
    const screen = document.createElement("div");
    screen.className = "uni-title";

    const inner = document.createElement("div");
    inner.className = "uni-title-inner";
    screen.appendChild(inner);

    // --- Masthead ---
    const head = document.createElement("div");
    head.className = "uni-title-head";
    head.innerHTML =
      `<div class="uni-overline">2D&nbsp;FPS&nbsp;Manager</div>` +
      `<h1 class="uni-wordmark"><span class="uw-a">Universe</span><span class="uw-b">Mode</span></h1>` +
      `<div class="uni-rule"></div>` +
      `<p class="uni-tagline">Spin up a living scene — hundreds of players across six regions, ` +
      `forming teams, building rivalries, and climbing the rankings one match day at a time.</p>`;
    inner.appendChild(head);

    // --- Primary action ---
    const actions = document.createElement("div");
    actions.className = "uni-title-actions";
    actions.appendChild(btn("New Universe", "primary big", () => this.openNewUniverse()));
    inner.appendChild(actions);

    // --- Saved universes ---
    const loadPanel = document.createElement("div");
    loadPanel.className = "uni-title-load";
    const loadLabel = document.createElement("div");
    loadLabel.className = "uni-load-label";
    loadLabel.textContent = "Saved universes";
    loadPanel.appendChild(loadLabel);

    const list = document.createElement("div");
    list.className = "universe-load-list";
    // Loading the saved-universe list is async (IndexedDB); render a placeholder
    // and fill the container once the list resolves.
    const loading = document.createElement("div");
    loading.className = "universe-empty";
    loading.textContent = "Loading…";
    list.appendChild(loading);
    listUniverses().then(slots => {
      list.innerHTML = "";
      if (slots.length === 0) {
        const empty = document.createElement("div");
        empty.className = "universe-empty";
        empty.textContent = "No saved universes yet — start a New Universe above.";
        list.appendChild(empty);
        return;
      }
      for (const s of slots) {
        const row = document.createElement("div");
        row.className = "universe-load-row";
        const info = document.createElement("div");
        info.className = "universe-load-info";
        info.innerHTML = `<div class="ul-name">${escapeHtml(s.name)}</div><div class="ul-meta">Day ${s.day} · ${new Date(s.createdAt).toLocaleDateString()}</div>`;
        row.appendChild(info);
        const rowActions = document.createElement("div");
        rowActions.appendChild(btn("Load", "primary", () => { void this.loadUniverseById(s.id); }));
        rowActions.appendChild(btn("Delete", "danger", () => {
          if (confirm(`Delete universe "${s.name}"?`)) {
            void deleteUniverse(s.id).then(() => this.render());
          }
        }));
        row.appendChild(rowActions);
        list.appendChild(row);
      }
    });
    loadPanel.appendChild(list);
    inner.appendChild(loadPanel);

    body.appendChild(screen);
  }

  // ---- Universe lifecycle ----

  // Open the New Universe setup screen with sensible defaults.
  private openNewUniverse() {
    this.setup = {
      name: `Universe ${new Date().toLocaleDateString()}`,
      regions: new Set(REGION_ORDER),
      perRegion: PLAYERS_PER_REGION,
      // Default to the full builtin rotation (plus a saved custom map if any) so
      // series have distinct maps per game — Bo3 needs ≥3, Bo5 needs ≥5.
      maps: [...(loadCustomMap() ? [loadCustomMap()!] : []), ...builtinMaps().map(deepCloneMap)],
    };
    this.screen = "newUniverse";
    this.render();
  }

  // Build the universe from the assembled setup config.
  private createUniverse() {
    const s = this.setup;
    if (!s) return;
    const regions = REGION_ORDER.filter(r => s.regions.has(r));
    if (regions.length === 0) { alert("Pick at least one region."); return; }
    // Need both teams' worth of players for a region to field a lobby.
    const perRegion = Math.min(MAX_PLAYERS_PER_REGION, Math.max(TEAM_SIZE * 2, Math.floor(s.perRegion) || 0));
    const maps = s.maps.length > 0 ? s.maps : [deepCloneMap(builtinMaps()[0])];

    setSeed(Date.now());
    const players: Player[] = [];
    for (const region of regions) {
      for (let i = 0; i < perRegion; i++) players.push(makePlayer(region));
    }
    const elos: Record<string, number> = {};
    for (const p of players) elos[p.id] = STARTING_ELO;
    this.universe = {
      id: newUniverseId(),
      name: s.name.trim() || `Universe ${new Date().toLocaleDateString()}`,
      createdAt: Date.now(),
      day: 1,
      players,
      elos,
      history: [],
      pendingDay: null,
      careers: {},
      maps: maps.map(deepCloneMap),
    };
    this.setup = null;
    this.persist();
    this.screen = "players";
    this.render();
  }

  // ---- New Universe setup screen ----

  private renderNewUniverse(body: HTMLElement) {
    const s = this.setup;
    if (!s) { this.screen = "menu"; this.render(); return; }

    const wrap = document.createElement("div");
    wrap.className = "universe-menu-wrap";
    const card = document.createElement("div");
    card.className = "universe-menu-card universe-setup-card";
    wrap.appendChild(card);

    const h = document.createElement("h2");
    h.textContent = "New Universe";
    card.appendChild(h);

    // --- Name ---
    const nameField = document.createElement("div");
    nameField.className = "universe-setup-field";
    nameField.innerHTML = `<label>Name</label>`;
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "universe-setup-input";
    nameInput.value = s.name;
    nameInput.oninput = () => { s.name = nameInput.value; };
    nameField.appendChild(nameInput);
    card.appendChild(nameField);

    // --- Players per region ---
    const perField = document.createElement("div");
    perField.className = "universe-setup-field";
    perField.innerHTML = `<label>Players per region</label>`;
    const perInput = document.createElement("input");
    perInput.type = "number";
    perInput.className = "universe-setup-input narrow";
    perInput.min = String(TEAM_SIZE * 2);
    perInput.max = String(MAX_PLAYERS_PER_REGION);
    perInput.step = "10";
    perInput.value = String(s.perRegion);
    perField.appendChild(perInput);
    card.appendChild(perField);

    // --- Regions ---
    const regLabel = document.createElement("div");
    regLabel.className = "universe-section-label";
    regLabel.textContent = "Regions";
    card.appendChild(regLabel);

    const regGrid = document.createElement("div");
    regGrid.className = "universe-region-checks";
    const summary = document.createElement("div");
    summary.className = "universe-setup-summary";
    const updateSummary = () => {
      const n = REGION_ORDER.filter(r => s.regions.has(r)).length;
      const per = Math.max(TEAM_SIZE * 2, Math.floor(s.perRegion) || 0);
      summary.textContent = `${n} region${n === 1 ? "" : "s"} × ${per} = ${n * per} players`;
    };
    perInput.oninput = () => {
      const v = parseInt(perInput.value, 10);
      s.perRegion = Number.isFinite(v) ? v : 0;
      updateSummary();
    };
    for (const region of REGION_ORDER) {
      const id = `region-${region}`;
      const lab = document.createElement("label");
      lab.className = "universe-region-check";
      lab.htmlFor = id;
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.id = id;
      cb.checked = s.regions.has(region);
      cb.onchange = () => {
        if (cb.checked) s.regions.add(region); else s.regions.delete(region);
        updateSummary();
      };
      lab.appendChild(cb);
      const span = document.createElement("span");
      span.textContent = REGION_LABELS[region];
      lab.appendChild(span);
      regGrid.appendChild(lab);
    }
    card.appendChild(regGrid);
    card.appendChild(summary);
    updateSummary();

    // --- Starting maps ---
    const mapLabel = document.createElement("div");
    mapLabel.className = "universe-section-label";
    mapLabel.textContent = "Starting map rotation";
    card.appendChild(mapLabel);
    card.appendChild(mapRotationList(s.maps, (idx) => {
      s.maps.splice(idx, 1);
      this.render();
    }));
    card.appendChild(mapPickerRow((m) => {
      s.maps.push(m);
      this.render();
    }));

    // --- Actions ---
    const actions = document.createElement("div");
    actions.className = "universe-setup-actions";
    actions.appendChild(btn("Cancel", "", () => {
      this.setup = null;
      this.screen = "menu";
      this.render();
    }));
    actions.appendChild(btn("Create universe", "primary big", () => this.createUniverse()));
    card.appendChild(actions);

    body.appendChild(wrap);
  }

  private async loadUniverseById(id: string) {
    const u = await loadUniverse(id);
    if (!u) return;
    // Migrate older saves that predate the universe-level map / map rotation.
    if (!u.maps || u.maps.length === 0) {
      u.maps = [u.map ?? loadCustomMap() ?? deepCloneMap(builtinMaps()[0])];
    }
    delete u.map;
    // Backfill the ambition personality axis on pre-existing players.
    for (const p of u.players) {
      if (typeof p.ambition !== "number") p.ambition = Math.round(15 + Math.random() * 80);
    }
    // Career aggregates are maintained incrementally and persisted in core, so
    // we trust them. The in-memory history is only a recent window now (the full
    // archive lives in IndexedDB), so rebuilding from it would undercount —
    // only rebuild when careers are entirely absent, and only from what we have.
    if (!u.careers) rebuildCareers(u);
    trimHistory(u);
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

  // Saving is async now (IndexedDB). persist() is fire-and-forget but
  // coalesced: overlapping calls collapse into one in-flight write that re-runs
  // if more changes arrived while it was saving, so rapid match completions
  // never stack up writes or race. flush() awaits the queue when a write must
  // durably land before moving on (e.g. before leaving the universe).
  private saveQueued = false;
  private saving: Promise<void> | null = null;

  private persist() {
    if (!this.universe) return;
    this.saveQueued = true;
    if (this.saving) return;
    this.saving = (async () => {
      while (this.saveQueued) {
        this.saveQueued = false;
        try { await saveUniverse(this.universe!); }
        catch (e) { console.error("Failed to save universe", e); }
      }
      this.saving = null;
    })();
  }

  private async flush(): Promise<void> {
    if (this.saving) await this.saving;
  }

  // ---- Headless simulation (off-thread, parallel) ----

  // A SimState view over the live universe — foldMatchResult mutates the
  // players/elos/careers it references in place, so applying results updates the
  // universe directly. pendingDay/day are advanced by the coordinator on `u`.
  private foldState(u: Universe): SimState {
    return {
      players: u.players,
      elos: u.elos,
      careers: u.careers ??= {},
      maps: u.maps ?? [],
      pendingDay: u.pendingDay,
      day: u.day,
    };
  }

  // Simulate `nDays` days. Each day's matches are sharded across a worker pool
  // and run in parallel (every player plays one match per day, so they're
  // independent), then folded sequentially here. With roll=false, only the
  // current pending day's remaining matches are simulated (no day roll) — that's
  // "Sim all remaining". Returns the completed days produced, for archiving.
  private async runDaySim(
    u: Universe, nDays: number, roll: boolean,
    onDay?: (done: number) => void,
  ): Promise<CompletedDay[]> {
    const state = this.foldState(u);
    const byId = new Map(u.players.map(p => [p.id, p] as const));
    const pool = new SimPool(simPoolSize(), u.maps ?? []);
    const completed: CompletedDay[] = [];
    try {
      for (let i = 0; i < nDays; i++) {
        if (!u.pendingDay) {
          u.pendingDay = { day: u.day, matchups: generateMatchups(u.players, u.elos, u.maps?.length ?? 1) };
        }
        const pending = u.pendingDay.matchups.filter(m => m.status !== "completed");
        if (pending.length > 0) {
          const results = await pool.simulate(pending, byId);
          const resById = new Map(results.map(r => [r.id, r]));
          // Fold in matchup order (deterministic; players are disjoint within a day).
          for (const m of u.pendingDay.matchups) {
            const r = resById.get(m.id);
            if (r) foldOutcome(state, m, r, byId);
          }
        }
        if (!roll) break;
        const done: CompletedDay = { day: u.pendingDay.day, matchups: u.pendingDay.matchups };
        u.history.push(done);
        completed.push(done);
        trimHistory(u);
        decayRelationships(u.players); // bonds fade day-to-day without upkeep
        u.pendingDay = null;
        u.day++;
        onDay?.(i + 1);
        await nextFrame(); // let the overlay repaint between days
      }
      if (roll && !u.pendingDay) {
        u.pendingDay = { day: u.day, matchups: generateMatchups(u.players, u.elos, u.maps?.length ?? 1) };
      }
    } finally {
      pool.terminate();
    }
    return completed;
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
    this.viewingDay = null;
    this.screen = "matchups";
    this.render();
  }

  // Day navigator for the matchups board: step back/forward through the recent
  // history window, with a center button that jumps back to the live day.
  private dayNav(viewing: number, currentDay: number): HTMLElement {
    const u = this.universe!;
    const earliest = u.history.length ? u.history[0].day : currentDay;
    const nav = document.createElement("div");
    nav.className = "umc-day-nav";

    const prev = btn("◀ Prev", "", () => { this.viewingDay = Math.max(earliest, viewing - 1); this.render(); });
    prev.disabled = viewing <= earliest;

    const isCurrent = viewing === currentDay;
    const center = btn(
      isCurrent ? `Day ${viewing} · Current` : `Day ${viewing} · Jump to current →`,
      isCurrent ? "" : "primary",
      () => { this.viewingDay = null; this.render(); },
    );
    center.disabled = isCurrent;
    center.classList.add("umc-day-label");

    const next = btn("Next ▶", "", () => {
      const target = Math.min(currentDay, viewing + 1);
      this.viewingDay = target === currentDay ? null : target;
      this.render();
    });
    next.disabled = isCurrent;

    nav.append(prev, center, next);
    return nav;
  }

  private renderMatchups(body: HTMLElement) {
    if (!this.universe || !this.universe.pendingDay) return;
    const u = this.universe;
    const pending = u.pendingDay!;
    // Resolve which day to show: the live day, or a past day from the window.
    const viewing = this.viewingDay ?? pending.day;
    const isCurrent = viewing === pending.day;
    const day = isCurrent ? pending : u.history.find(d => d.day === viewing);
    // The viewed day fell out of the in-memory window (e.g. after trimming);
    // snap back to the live day.
    if (!day) { this.viewingDay = null; this.renderMatchups(body); return; }

    body.appendChild(this.dayNav(viewing, pending.day));

    const playerById = new Map(u.players.map(p => [p.id, p] as const));
    const elos = u.elos;

    // Top performers across all completed matches today. Updates as more
    // matches finish, so even a single sim'd match shows the top of the day.
    const completed = day.matchups.filter(m => m.status === "completed" && (m.playerStats || m.games?.length));
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
      card.style.setProperty("--card-i", String(i)); // staggered page-load reveal

      const isSeries = (m.bestOf ?? 1) > 1;
      const header = document.createElement("div");
      header.className = "umc-header";
      const mapName = this.universe!.maps?.[m.mapIndex ?? 0]?.name ?? this.universe!.map?.name;
      // Series show their format (the map differs per game); Bo1 shows the map.
      header.textContent = isSeries
        ? `Match ${i + 1} · Bo${m.bestOf}`
        : (m.status === "completed" && mapName ? `Match ${i + 1} · ${mapName}` : `Match ${i + 1}`);
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
        // A series can't be watched as a single match; only Bo1 offers live Play.
        if (!isSeries) actions.appendChild(btn("Play", "primary", () => this.playMatchup(m.id)));
      } else {
        // Replay reruns deterministically from a stored seed. matchIdx is the
        // index into the day's full matchups list (not the per-region slice).
        const matchIdx = day.matchups.indexOf(m);
        if (isSeries && m.games?.length) {
          // One replay button per game in the series.
          m.games.forEach((_g, gi) => {
            const b = btn(`G${gi + 1}`, "", () => this.openReplay(day.day, matchIdx, undefined, gi));
            b.title = `Replay game ${gi + 1}`;
            actions.appendChild(b);
          });
        } else if (m.seed !== undefined) {
          actions.appendChild(btn("Replay", "", () => this.openReplay(day.day, matchIdx)));
        }
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
      // Series carry stats per game; aggregate them across the series so a
      // player's whole-series line competes in the day's top performers.
      const stats = matchupPlayerStats(m);
      for (const [pid, s] of Object.entries(stats)) {
        const side: "CT" | "T" = m.ctPlayerIds.includes(pid) ? "CT" : "T";
        rows.push({ pid, side, stats: s, rating: hltvRating1(s) });
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

  // Single-match instant sim (the per-card "Sim" button). One match is cheap, so
  // it runs on the main thread; the shared engine keeps the fold logic identical
  // to the batch worker path.
  private runInstantSim(m: Matchup) {
    if (!this.universe) return;
    const u = this.universe;
    if (!u.maps || u.maps.length === 0) u.maps = [loadCustomMap() ?? deepCloneMap(builtinMaps()[0])];
    simOneMatchup(this.foldState(u), m);
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
    // Snapshot the morale the match is played with so its replay reproduces it.
    const moods: Record<string, number> = {};
    for (const p of [...ctPlayers, ...tPlayers]) moods[p.id] = p.morale;

    await observeMatch(body, {
      ctName: teamNameFor(ctPlayers, u.elos),
      tName:  teamNameFor(tPlayers,  u.elos),
      ctPlayers, tPlayers, map,
      seed: m.seed,
      onDone: (result) => {
        // Fold the watched result through the same path the sim uses, so elo,
        // chemistry, form, careers, map comfort, and the mood snapshot all match.
        const outcome: MatchupOutcome = {
          id: m.id, winnerSide: result.winnerSide, ctScore: result.ctScore, tScore: result.tScore,
          clutches: result.clutches, playerStats: result.playerStats,
          seed: m.seed, mapIndex: m.mapIndex, moods,
        };
        foldOutcome(this.foldState(u), m, outcome, new Map(u.players.map(p => [p.id, p] as const)));
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

  // Headless-sim every still-pending matchup of the current day in the worker,
  // so a full day of matches doesn't freeze the UI. Leaves the user on their
  // current tab so they can review the results.
  private async simRemaining() {
    if (!this.universe || !this.universe.pendingDay) return;
    const u = this.universe;
    await this.runDaySim(u, 1, /* roll */ false);
    this.viewingDay = null; // jump back to the live day to show the results
    this.persist();
    this.render();
  }

  // Roll the (fully-completed) current day into history and start the next
  // day's matchups. The universe always has a pendingDay while in the day
  // view, so the user is dropped straight back onto the Matchups tab.
  private continueFromMatchups() {
    if (!this.universe || !this.universe.pendingDay) return;
    const u = this.universe;
    const done: CompletedDay = { day: u.pendingDay!.day, matchups: u.pendingDay!.matchups };
    u.history.push(done);
    trimHistory(u);
    void appendDays(u.id, [done]); // archive the completed day (append-only)
    decayRelationships(u.players); // bonds fade day-to-day without upkeep
    u.day++;
    u.pendingDay = { day: u.day, matchups: generateMatchups(u.players, u.elos, u.maps?.length ?? 1) };
    this.viewingDay = null;
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
    // Let the browser paint the overlay before we hand off to the worker.
    await nextFrame();

    // try/finally so the full-screen overlay is ALWAYS removed and the screen
    // re-renders — otherwise a throw leaves the blocking overlay up and the app
    // appears frozen.
    try {
      // Each day's matches run in parallel across the worker pool; days roll
      // sequentially (matchmaking depends on the prior day's elo/chemistry).
      const completed = await this.runDaySim(u, capped, /* roll */ true, done => overlay.update(done));
      // Archive every completed day in one transaction, then save core state and
      // wait for it to land — a multi-day sim is too much work to risk losing if
      // the tab closes right after the overlay disappears.
      await appendDays(u.id, completed);
      this.persist();
      await this.flush();
    } finally {
      this.viewingDay = null;
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

    // Removing must keep at least one map in the pool, otherwise future
    // matchup generation has nothing to assign.
    card.appendChild(mapRotationList(u.maps, (idx) => {
      u.maps!.splice(idx, 1);
      this.persist();
      this.render();
    }));
    card.appendChild(mapPickerRow((m) => {
      u.maps!.push(m);
      this.persist();
      this.render();
    }));

    // Tools — map editor and balance testing open as separate workspaces.
    const tools = document.createElement("div");
    tools.className = "universe-settings-card";
    const th = document.createElement("h2");
    th.textContent = "Tools";
    tools.appendChild(th);
    const tsub = document.createElement("p");
    tsub.className = "universe-settings-sub";
    tsub.textContent = "Design custom maps to add to the rotation, or run loadout/balance experiments. These open in a separate workspace; your universe is saved.";
    tools.appendChild(tsub);
    const toolRow = document.createElement("div");
    toolRow.className = "universe-settings-tools";
    toolRow.appendChild(btn("Map Editor", "", () => { window.location.hash = "#editor"; }));
    toolRow.appendChild(btn("Balance Testing", "", () => { window.location.hash = "#balance"; }));
    tools.appendChild(toolRow);
    wrap.appendChild(tools);

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
    body.appendChild(playerPage(p, u, (day, idx, round, gameIdx) => this.openReplay(day, idx, round, gameIdx)));
  }
}

// ---- Sim worker pool -----------------------------------------------------

// Cap the pool at the hardware concurrency (leaving the spec's fallback), but
// never more than 8 — beyond that the per-message cloning overhead outweighs
// the gain for our match sizes.
function simPoolSize(): number {
  const cores = (typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(8, cores));
}

// A fixed set of sim workers. Maps are sent once at construction (they carry
// large wall arrays); each simulate() call shards the matchups across all
// workers and resolves with the combined results.
class SimPool {
  private workers: Worker[];

  constructor(size: number, maps: GameMap[]) {
    this.workers = Array.from({ length: size }, () => new SimWorker());
    const init: SimWorkerRequest = { kind: "init", maps };
    for (const w of this.workers) w.postMessage(init);
  }

  async simulate(matchups: Matchup[], byId: Map<string, Player>): Promise<MatchupOutcome[]> {
    const chunks = chunkEvenly(matchups, this.workers.length);
    const out = await Promise.all(chunks.map((c, i) => this.runChunk(this.workers[i], c, byId)));
    return out.flat();
  }

  private runChunk(worker: Worker, matchups: Matchup[], byId: Map<string, Player>): Promise<MatchupOutcome[]> {
    if (matchups.length === 0) return Promise.resolve([]);
    const players = playersFor(matchups, byId);
    return new Promise((resolve, reject) => {
      const onMsg = (e: MessageEvent<SimWorkerResponse>) => { cleanup(); resolve(e.data.results); };
      const onErr = (err: ErrorEvent) => { cleanup(); reject(err); };
      const cleanup = () => {
        worker.removeEventListener("message", onMsg);
        worker.removeEventListener("error", onErr);
      };
      worker.addEventListener("message", onMsg);
      worker.addEventListener("error", onErr);
      const req: SimWorkerRequest = { kind: "simMatches", players, matchups };
      worker.postMessage(req);
    });
  }

  terminate() { for (const w of this.workers) w.terminate(); }
}

// Round-robin split so each worker gets a near-equal count of matches.
function chunkEvenly<T>(arr: T[], n: number): T[][] {
  const chunks: T[][] = Array.from({ length: n }, () => []);
  arr.forEach((item, i) => chunks[i % n].push(item));
  return chunks;
}

// The unique player objects involved in a batch of matchups — only these need
// to cross to the worker (each player appears in just one match per day).
function playersFor(matchups: Matchup[], byId: Map<string, Player>): Player[] {
  const ids = new Set<string>();
  for (const m of matchups) {
    for (const id of m.ctPlayerIds) ids.add(id);
    for (const id of m.tPlayerIds) ids.add(id);
  }
  const out: Player[] = [];
  for (const id of ids) { const p = byId.get(id); if (p) out.push(p); }
  return out;
}

// ---- Shared map-rotation UI (settings + new-universe setup) --------------

interface MapSource { key: string; label: string; map: () => GameMap; }

// Every map available to add to a rotation, grouped by origin.
function collectMapSources(): { group: string; items: MapSource[] }[] {
  const sources: { group: string; items: MapSource[] }[] = [{
    group: "Built-in",
    items: builtinMaps().map(m => ({ key: `b:${m.name}`, label: m.name, map: () => deepCloneMap(m) })),
  }];
  const saved = loadSavedMapsAll();
  const savedNames = Object.keys(saved).sort();
  if (savedNames.length > 0) {
    sources.push({
      group: "Saved (editor)",
      items: savedNames.map(name => ({ key: `s:${name}`, label: name, map: () => deepCloneMap(saved[name]) })),
    });
  }
  return sources;
}

// Read-only list of the maps in a rotation. If `onRemove` is given, each row
// gets a Remove button — but the last map can't be removed (matchups need one).
function mapRotationList(maps: GameMap[], onRemove?: (idx: number) => void): HTMLElement {
  const list = document.createElement("div");
  list.className = "universe-map-list";
  maps.forEach((map, idx) => {
    const row = document.createElement("div");
    row.className = "universe-map-row";
    const left = document.createElement("div");
    left.className = "umr-info";
    left.innerHTML = `<div class="umr-name">${escapeHtml(map.name || `Map ${idx + 1}`)}</div>` +
                     `<div class="umr-meta">${map.width}×${map.height} tiles · ${map.bombsites.length} sites</div>`;
    row.appendChild(left);
    const actions = document.createElement("div");
    if (onRemove && maps.length > 1) {
      actions.appendChild(btn("Remove", "danger", () => onRemove(idx)));
    }
    row.appendChild(actions);
    list.appendChild(row);
  });
  return list;
}

// Dropdown of all available maps + an "add" button that hands back a fresh
// clone of the chosen map.
function mapPickerRow(onAdd: (m: GameMap) => void): HTMLElement {
  const sources = collectMapSources();
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
      if (found) { onAdd(found.map()); return; }
    }
  }));
  return addRow;
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

  // Friend-stack in this lineup (at most one). Members get a marker so you can
  // see who queued together vs. who was filled in around them.
  const idSet = new Set(ids);
  const stack = (matchup.parties ?? []).find(grp => grp.some(id => idSet.has(id)));
  const stackSet = new Set(stack ?? []);

  const header = document.createElement("div");
  header.className = "umc-team-header";
  const stackBadge = stackSet.size >= 2
    ? `<span class="umc-stack-badge" title="${stackSet.size} players queued together">🔗${stackSet.size}</span>`
    : "";
  header.innerHTML =
    `<div class="umc-team-name">Team ${escapeHtml(shortName(captain))}${stackBadge}</div>` +
    `<div class="umc-team-elo">Avg ${Math.round(avgElo)}</div>`;
  col.appendChild(header);

  for (const p of players) {
    const row = document.createElement("div");
    const inStack = stackSet.has(p.id);
    row.className = "umc-roster-row" + (inStack ? " stacked" : "");
    const preElo = Math.round(eloFor(p.id));
    let eloHtml = `<span class="umc-elo">${preElo}</span>`;
    if (isDone) {
      const delta = Math.round(signedDelta);
      const cls = delta >= 0 ? "umc-elo-delta good" : "umc-elo-delta bad";
      const sign = delta >= 0 ? "+" : "−";
      eloHtml += `<span class="${cls}">${sign}${Math.abs(delta)}</span>`;
    }
    const stackDot = inStack ? `<span class="umc-stack-dot">🔗</span>` : "";
    row.innerHTML = `${stackDot}<span class="umc-flag">${flagEmoji(p.country)}</span><span class="umc-name">${escapeHtml(shortName(p))}</span>${eloHtml}`;
    if (onPick) {
      row.classList.add("clickable");
      row.title = inStack ? `Queued as a ${stackSet.size}-stack · view player` : "View player";
      const pid = p.id;
      row.onclick = () => onPick(pid);
    } else if (inStack) {
      row.title = `Queued as a ${stackSet.size}-stack`;
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

// A generic sortable table whose rows are virtualized: only the rows visible in
// the scroll viewport (plus a small overscan) are ever in the DOM, with spacer
// rows preserving total scroll height. Lets the standings/career tables handle
// thousands of players without building tens of thousands of nodes per sort.
interface VCol<T> {
  label: string;
  thClass?: string;                                   // header class (e.g. width)
  fill: (item: T, td: HTMLTableCellElement) => void;  // populate a body cell
  cmp: (a: T, b: T) => number;                        // ascending comparator
}

function virtualTable<T>(
  items: T[],
  cols: VCol<T>[],
  initialSortIdx: number,
  initialDir: 1 | -1,
  onPick?: (item: T) => void,
): HTMLElement {
  let sortIdx = initialSortIdx;
  let sortDir = initialDir;
  let sorted: T[] = [];
  let rowH = 44;            // measured after first paint; matched to avoid drift
  let measured = false;
  const OVERSCAN = 8;

  const wrap = document.createElement("div");
  wrap.className = "universe-player-table-wrap";
  const scroll = document.createElement("div");
  scroll.className = "universe-player-table-scroll";
  const table = document.createElement("table");
  table.className = "universe-player-table";
  const thead = document.createElement("thead");
  const tbody = document.createElement("tbody");
  table.append(thead, tbody);
  scroll.appendChild(table);
  wrap.appendChild(scroll);

  const buildHeader = () => {
    thead.innerHTML = "";
    const trh = document.createElement("tr");
    cols.forEach((col, i) => {
      const th = document.createElement("th");
      th.textContent = col.label + (sortIdx === i ? (sortDir === -1 ? " ▼" : " ▲") : "");
      if (col.thClass) th.className = col.thClass;
      th.onclick = () => {
        if (sortIdx === i) sortDir = (sortDir === 1 ? -1 : 1);
        else { sortIdx = i; sortDir = -1; }
        resort();
        scroll.scrollTop = 0;
        buildHeader();
        renderWindow();
      };
      trh.appendChild(th);
    });
    thead.appendChild(trh);
  };

  const resort = () => {
    sorted = [...items].sort((a, b) => cols[sortIdx].cmp(a, b) * sortDir);
  };

  const makeRow = (item: T): HTMLTableRowElement => {
    const tr = document.createElement("tr");
    if (onPick) {
      tr.classList.add("clickable-row");
      tr.onclick = () => onPick(item);
    }
    for (const col of cols) {
      const td = document.createElement("td");
      col.fill(item, td);
      tr.appendChild(td);
    }
    return tr;
  };

  const spacer = (h: number): HTMLTableRowElement => {
    const tr = document.createElement("tr");
    tr.className = "pt-spacer";
    const td = document.createElement("td");
    td.colSpan = cols.length;
    td.style.height = `${h}px`;
    tr.appendChild(td);
    return tr;
  };

  const renderWindow = () => {
    const viewH = scroll.clientHeight || 600;
    const start = Math.max(0, Math.floor(scroll.scrollTop / rowH) - OVERSCAN);
    const end = Math.min(sorted.length, Math.ceil((scroll.scrollTop + viewH) / rowH) + OVERSCAN);

    tbody.innerHTML = "";
    if (start > 0) tbody.appendChild(spacer(start * rowH));
    for (let i = start; i < end; i++) tbody.appendChild(makeRow(sorted[i]));
    if (end < sorted.length) tbody.appendChild(spacer((sorted.length - end) * rowH));

    // Calibrate row height from a real row once, then re-window so the spacer
    // math (and thus scroll height) matches actual layout exactly.
    if (!measured && start === 0 && sorted.length > 0) {
      measured = true;
      const first = tbody.querySelector("tr:not(.pt-spacer)") as HTMLElement | null;
      const h = first?.offsetHeight ?? 0;
      if (h > 0 && Math.abs(h - rowH) > 0.5) { rowH = h; renderWindow(); }
    }
  };

  scroll.addEventListener("scroll", renderWindow);
  resort();
  buildHeader();
  renderWindow();
  // clientHeight is 0 until the table is in the document; re-window next frame
  // so the initial visible range fills the real viewport height.
  requestAnimationFrame(renderWindow);
  return wrap;
}

function playerTable(
  players: Player[],
  elos: Record<string, number>,
  showElo: boolean,
  onPick?: (playerId: string) => void,
): HTMLElement {
  const cols = COLUMNS.filter(c => !c.needsElo || showElo);
  const valueOf = (col: typeof COLUMNS[number], p: Player) => col.getter(p, elos[p.id] ?? STARTING_ELO);

  const vcols: VCol<Player>[] = cols.map(col => ({
    label: col.label,
    thClass: col.key === "name" ? "pt-col-name" : undefined,
    cmp: (a, b) => {
      const va = valueOf(col, a), vb = valueOf(col, b);
      if (typeof va === "number" && typeof vb === "number") return va - vb;
      return String(va).localeCompare(String(vb));
    },
    fill: (p, td) => {
      const v = valueOf(col, p);
      if (col.key === "country") {
        td.innerHTML = `<span class="flag">${flagEmoji(p.country)}</span> ${escapeHtml(p.country)}`;
        td.className = "country-cell";
      } else if (col.key === "name") {
        td.innerHTML = `<span class="pt-handle">${escapeHtml(p.handle)}</span>` +
          `<span class="pt-realname">${escapeHtml(p.name)}</span>`;
        td.className = "name-cell";
      } else {
        td.textContent = typeof v === "number" ? String(Math.round(v)) : String(v);
      }
      if (typeof v === "number" && col.key !== "elo" && col.key !== "age") {
        td.style.color = ratingColor(v);
      }
    },
  }));

  const initialIdx = Math.max(0, cols.findIndex(c => c.key === (showElo ? "elo" : "overall")));
  return virtualTable(players, vcols, initialIdx, -1, onPick ? p => onPick(p.id) : undefined);
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
    const c = careerView(careerOf(u, p.id));
    const clutchBuckets = careerClutchBuckets(careerOf(u, p.id));
    const clutches = clutchBuckets.reduce((s, b) => s + b.wins, 0);
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

  const initialIdx = Math.max(0, cols.findIndex(c => c.label === "Rating"));
  const vcols: VCol<CareerRow>[] = cols.map(c => ({
    label: c.label,
    thClass: c.label === "Name" ? "pt-col-name" : undefined,
    cmp: c.cmp,
    fill: (r, td) => { td.innerHTML = c.cellHtml(r); if (c.cls) td.className = c.cls; },
  }));
  return virtualTable(rows, vcols, initialIdx, -1, onPick ? r => onPick(r.p.id) : undefined);
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
  const isSeries = !!m.games?.length;
  header.innerHTML =
    (isSeries ? `<div class="ustats-series-label">Bo${m.bestOf} series</div>` : ``) +
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

  // Series map veto, in order (ban/pick/decider per side).
  if (m.veto?.length) {
    const playersOf = (ids: string[]) => ids.map(id => u.players.find(p => p.id === id)).filter((p): p is Player => !!p);
    const ctName = teamNameFor(playersOf(m.ctPlayerIds), u.elos);
    const tName = teamNameFor(playersOf(m.tPlayerIds), u.elos);
    const veto = document.createElement("div");
    veto.className = "ustats-veto";
    veto.innerHTML = m.veto.map(s => {
      const team = s.side === "CT" ? ctName : tName;
      const mapName = u.maps?.[s.mapIndex]?.name ?? `Map ${s.mapIndex + 1}`;
      const cls = s.side === "CT" ? "ct" : "t";
      if (s.action === "decider") return `<span class="uv-step"><span class="uv-act">decider</span> ${escapeHtml(mapName)}</span>`;
      const verb = s.action === "ban" ? "removed" : "picked";
      return `<span class="uv-step"><span class="${cls}">${escapeHtml(team)}</span> <span class="uv-act">${verb}</span> ${escapeHtml(mapName)}</span>`;
    }).join("");
    modal.appendChild(veto);
  }

  // Body holds the box score for the selected game (or the single match).
  const body = document.createElement("div");

  const renderBox = (gm: Matchup, label?: string) => {
    body.innerHTML = "";
    if (label) {
      const l = document.createElement("div");
      l.className = "ustats-game-label";
      l.textContent = label;
      body.appendChild(l);
    }
    const wrap = document.createElement("div");
    wrap.className = "ustats-teams";
    wrap.appendChild(boxScoreTable("CT", gm.ctPlayerIds, gm, u));
    wrap.appendChild(boxScoreTable("T",  gm.tPlayerIds,  gm, u));
    body.appendChild(wrap);
  };

  if (m.games?.length) {
    // Tab per game; each tab shows that game's map, round score, and box score.
    const tabs = document.createElement("div");
    tabs.className = "ustats-game-tabs";
    m.games.forEach((g, gi) => {
      const mapName = u.maps?.[g.mapIndex]?.name ?? `Map ${g.mapIndex + 1}`;
      const tab = btn(`G${gi + 1}`, "", () => {
        const gm: Matchup = {
          ...m, games: undefined, playerStats: g.playerStats, clutches: g.clutches,
          ctScore: g.ctScore, tScore: g.tScore, winnerSide: g.winnerSide,
          seed: g.seed, mapIndex: g.mapIndex,
        };
        renderBox(gm, `Game ${gi + 1} · ${mapName} · ${g.ctScore}-${g.tScore}`);
        for (const c of Array.from(tabs.children)) c.classList.remove("active");
        tab.classList.add("active");
      });
      tabs.appendChild(tab);
    });
    modal.appendChild(tabs);
    modal.appendChild(body);
    (tabs.firstChild as HTMLElement | null)?.click(); // default to game 1
  } else {
    renderBox(m);
    modal.appendChild(body);
  }

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
  onReplay: (day: number, matchIdx: number, startAtRound?: number, gameIdx?: number) => void,
): HTMLElement {
  const root = document.createElement("div");
  root.className = "universe-player-page";

  const elo = Math.round(u.elos[p.id] ?? STARTING_ELO);
  // Career totals + clutch breakdown come from the running aggregate (lifetime).
  // The game-log list below uses the bounded recent history for replay detail.
  const log = buildGameLog(p.id, u);
  const career = careerView(careerOf(u, p.id));
  const clutchBuckets = careerClutchBuckets(careerOf(u, p.id));
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
    <div class="upp-dyn-item"><span>Form</span><b style="color:${ratingColor(p.morale)}" title="${Math.round(p.morale)}/100 morale">${formLabel(p.morale)}</b></div>
    <div class="upp-dyn-item"><span>Values</span><b title="${p.ambition ?? 50}/100 ambition">${valuesLabel(p.ambition ?? 50)}</b></div>
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

  // ----- Map comfort (emergent from results per map) -----
  const mapEntries = Object.entries(p.mapStats ?? {}).sort((a, b) => b[1].played - a[1].played);
  if (mapEntries.length > 0) {
    const mapCard = document.createElement("div");
    mapCard.className = "upp-clutches";
    const mTitle = document.createElement("div");
    mTitle.className = "upp-stat-title";
    mTitle.textContent = "Map comfort";
    mapCard.appendChild(mTitle);
    const mRow = document.createElement("div");
    mRow.className = "upp-clutch-row";
    for (const [name, rec] of mapEntries) {
      const winPct = rec.played > 0 ? Math.round((rec.won / rec.played) * 100) : 0;
      const cell = document.createElement("div");
      cell.className = "upp-clutch-cell";
      cell.innerHTML =
        `<div class="upp-clutch-label">${escapeHtml(name)}</div>` +
        `<div class="upp-clutch-val" style="color:${ratingColor(winPct)}">${winPct}%</div>` +
        `<div class="upp-gl-missing" style="font-size:11px">${rec.won}-${rec.played - rec.won}</div>`;
      mRow.appendChild(cell);
    }
    mapCard.appendChild(mRow);
    root.appendChild(mapCard);
  }

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
        // Label by enemies faced (1vX) so it matches the career clutch table;
        // kills won is shown in the tooltip.
        chip.textContent = `1v${Math.max(1, c.bucket)}`;
        if (g.seed !== undefined && c.round !== undefined) {
          chip.className = "upp-gl-clutch-chip";
          chip.title = `${c.kills} kill${c.kills === 1 ? "" : "s"} · replay round ${c.round}`;
          chip.onclick = (ev) => {
            ev.stopPropagation();
            onReplay(g.day, g.matchIdx, c.round, g.gameIdx);
          };
        }
        clutchTd.appendChild(chip);
      });
      tr.appendChild(clutchTd);

      // Whole-match replay: clickable row, only when seed is recorded.
      if (g.seed !== undefined) {
        tr.classList.add("clickable-row");
        tr.title = "Replay match";
        tr.onclick = () => onReplay(g.day, g.matchIdx, undefined, g.gameIdx);
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
  gameIdx?: number;          // set for a game within a series (for replay)
  seed: number | undefined;
  side: "CT" | "T";
  ownScore: number;
  oppScore: number;
  won: boolean;
  opponentIds: string[];
  // Only successful clutches end up here — used for the 1vX/round chips.
  // `bucket` is the number of enemies faced (matches the career table); kills
  // is how many the clutcher actually got.
  clutches: { bucket: number; kills: number; round: number | undefined }[];
  // Full attempt list (won + lost) for opportunity tracking.
  clutchAttempts: { bucket: number; won: boolean; round: number | undefined }[];
  stats: import("./types.ts").PlayerMatchStats | null;
}

// Rebuild every career total from scratch by replaying all known completed
// matchups — both retained history and any already-finished games still in the
// pending day. Used to migrate pre-aggregate saves (one-time) before history
// gets trimmed, so no past result is lost.
function rebuildCareers(u: Universe): void {
  const careers: Record<string, CareerStats> = {};
  for (const day of u.history) {
    for (const m of day.matchups) recordMatchupCareers(careers, m);
  }
  for (const m of u.pendingDay?.matchups ?? []) recordMatchupCareers(careers, m);
  u.careers = careers;
}

// Keep only the most recent HISTORY_DAYS of completed days. Career totals are
// already folded in, so dropped days only lose per-match replay/log detail.
function trimHistory(u: Universe): void {
  if (u.history.length > HISTORY_DAYS) {
    u.history.splice(0, u.history.length - HISTORY_DAYS);
  }
}

// Display view over a career aggregate — same shape the old summarizeCareer
// returned from a game-log scan, so the table/player-page code is unchanged.
function careerView(c: CareerStats) {
  const rating = c.matchesWithStats > 0
    ? hltvRating1({
        kills: c.kills, deaths: c.deaths, assists: c.assists, damage: c.damage,
        roundsPlayed: c.rounds, k1: c.k1, k2: c.k2, k3: c.k3, k4: c.k4, k5: c.k5,
      })
    : null;
  return {
    played: c.played,
    wins: c.wins,
    losses: c.losses,
    roundsWon: c.roundsWon,
    roundsLost: c.roundsLost,
    roundDiff: c.roundsWon - c.roundsLost,
    kills: c.kills, deaths: c.deaths, assists: c.assists, damage: c.damage, rounds: c.rounds,
    adr: c.rounds > 0 ? c.damage / c.rounds : null,
    rating,
    hasStats: c.matchesWithStats > 0,
    k2: c.k2, k3: c.k3, k4: c.k4, k5: c.k5,
  };
}

function careerClutchBuckets(c: CareerStats): ClutchBucketStats[] {
  return [1, 2, 3, 4, 5].map(b => ({
    bucket: b,
    wins: c.clutchWins[b - 1] ?? 0,
    attempts: c.clutchAttempts[b - 1] ?? 0,
  }));
}

function careerOf(u: Universe, id: string): CareerStats {
  return u.careers?.[id] ?? emptyCareer();
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

// Per-player stats for a matchup: a Bo1's own stats, or a series' games summed
// per player (so a whole-series line can be shown/ranked as one).
function matchupPlayerStats(m: Matchup): Record<string, PlayerMatchStats> {
  if (!m.games?.length) return m.playerStats ?? {};
  const agg: Record<string, PlayerMatchStats> = {};
  for (const g of m.games) {
    for (const [pid, s] of Object.entries(g.playerStats)) {
      const a = agg[pid] ?? (agg[pid] = { kills: 0, deaths: 0, assists: 0, damage: 0, roundsPlayed: 0, k1: 0, k2: 0, k3: 0, k4: 0, k5: 0 });
      a.kills += s.kills; a.deaths += s.deaths; a.assists += s.assists; a.damage += s.damage; a.roundsPlayed += s.roundsPlayed;
      a.k1 += s.k1; a.k2 += s.k2; a.k3 += s.k3; a.k4 += s.k4; a.k5 += s.k5;
    }
  }
  return agg;
}

function buildGameLog(playerId: string, u: Universe): GameLogEntry[] {
  const out: GameLogEntry[] = [];
  for (const day of u.history) {
    day.matchups.forEach((m, idx) => {
      if (m.status !== "completed") return;
      const onCt = m.ctPlayerIds.includes(playerId);
      const onT  = m.tPlayerIds.includes(playerId);
      if (!onCt && !onT) return;
      const side: "CT" | "T" = onCt ? "CT" : "T";
      const opponentIds = onCt ? m.tPlayerIds : m.ctPlayerIds;
      const clutchWonOf = (c: { won?: boolean }) => c.won ?? true; // legacy = won

      // Emit one log row per game. A Bo1 contributes a single row; a series
      // contributes one row per game (each with its own seed for replay).
      const pushRow = (
        gameIdx: number | undefined, seed: number | undefined, winnerSide: "CT" | "T",
        ctScore: number, tScore: number, clutchesArr: Clutch[],
        stats: PlayerMatchStats | null,
      ) => {
        const mine = clutchesArr.filter(c => c.playerId === playerId);
        out.push({
          day: day.day, matchIdx: idx, gameIdx, seed, side,
          ownScore: onCt ? ctScore : tScore,
          oppScore: onCt ? tScore : ctScore,
          won: (onCt && winnerSide === "CT") || (onT && winnerSide === "T"),
          opponentIds,
          clutches: mine.filter(clutchWonOf).map(c => ({ bucket: clutchBucket(c), kills: c.kills, round: c.round })),
          clutchAttempts: mine.map(c => ({ bucket: clutchBucket(c), won: clutchWonOf(c), round: c.round })),
          stats,
        });
      };

      if (m.games?.length) {
        m.games.forEach((g, gi) =>
          pushRow(gi, g.seed, g.winnerSide, g.ctScore, g.tScore, g.clutches ?? [], g.playerStats?.[playerId] ?? null));
      } else if (m.winnerSide && m.ctScore !== undefined && m.tScore !== undefined) {
        pushRow(undefined, m.seed, m.winnerSide, m.ctScore, m.tScore, m.clutches ?? [], m.playerStats?.[playerId] ?? null);
      }
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

function prettifyKey(k: string): string {
  return k.replace(/([A-Z])/g, " $1").replace(/^./, c => c.toUpperCase());
}

// Describe persistent form (morale 0..100) as a streak-flavored label.
function formLabel(morale: number): string {
  if (morale >= 80) return "On fire";
  if (morale >= 65) return "Confident";
  if (morale >= 50) return "Steady";
  if (morale >= 35) return "Shaky";
  return "Tilted";
}

// Describe a player's ambition (0..100) as a fun↔ambitious temperament label.
function valuesLabel(ambition: number): string {
  if (ambition >= 75) return "Ambitious";
  if (ambition >= 55) return "Driven";
  if (ambition >= 40) return "Balanced";
  if (ambition >= 25) return "Social";
  return "Just for fun";
}

function btn(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.className = `universe-btn ${cls}`.trim();
  b.onclick = onClick;
  return b;
}
