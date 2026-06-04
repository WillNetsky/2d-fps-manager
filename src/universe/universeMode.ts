import type { GameMap, Player } from "../domain/types.ts";
import { makePlayer, reservePlayerIds, setSeed } from "../domain/factory.ts";
import {
  flagEmoji, REGION_ORDER, REGION_LABELS, type Region,
} from "../domain/countries.ts";
import { loadCustomMap, loadSavedMapsAll, savedMapsList } from "../editor/mapEditor.ts";
import { defaultMap } from "../domain/defaultMaps.ts";
import { decayRelationships, seedCliqueBonds } from "./chemistry.ts";
import { observeMatch } from "./observeMatch.ts";
import {
  generateMatchups, newSeed, simOneMatchup, foldOutcome, recordMatchupCareers,
  recordTeamResults, runVeto, crystallizeTeam,
  emptyCareer, clutchBucket, captainOf, type SimState, type MatchupOutcome, type TeamContext,
} from "./universeSim.ts";
import { startPlayoffs, playoffRoundMatchups, advancePlayoffs } from "./tournament.ts";
import { yearOf, eventInvitees, freeAgentContenders, compareRanking, rankingPointsFor } from "./circuit.ts";
import { runSeasonLifecycle } from "./lifecycle.ts";
import { runTransferWindow } from "./transferMarket.ts";
import { buildNews, type NewsCategory } from "./news.ts";
import { buildStorylines } from "./storylines.ts";
import { hltvRating1 } from "./rating.ts";
import { regionPayouts, recomputePlayerValues, formatMoney, PLAYOFF_PRIZES, wageBill, runFinancialCycle, foldInsolventOrgs } from "./finance.ts";
import { generateTeamName, reserveTeamNames, resetTeamNames } from "../domain/teamNames.ts";
import SimWorker from "./universeSimWorker.ts?worker";
import type { SimWorkerRequest, SimWorkerResponse } from "./universeSimWorker.ts";
import {
  appendDays, deleteUniverse, listUniverses, loadUniverse, newUniverseId,
  saveUniverse, HISTORY_WINDOW,
} from "./storage.ts";
import {
  PLAYERS_PER_REGION, MAX_PLAYERS_PER_REGION, STARTING_ELO, TEAM_SIZE,
  EVENT_INTERVAL_DAYS, RANKING_DECAY, RECRUIT_BOND, TITLES_LOG_MAX, TRANSFERS_LOG_MAX, STARTING_BALANCE, YEAR_STATS_KEEP,
  type BracketMatch, type Circuit, type CareerStats, type Clutch, type CompletedDay, type GameResult, type Matchup, type PlayerMatchStats,
  type RegionPlayoff, type TournamentTitle, type Universe, type UniverseTeam, type VetoStep,
} from "./types.ts";

// How many recent completed days to keep in memory for replay + per-player game
// logs. The full archive lives in IndexedDB; lifetime stats live in
// `Universe.careers`, so trimming here only limits how far back individual
// matches stay replayable — not the career totals.
const HISTORY_DAYS = HISTORY_WINDOW;

type Screen = "menu" | "newUniverse" | "players" | "matchups" | "match" | "standings" | "teams" | "market" | "news" | "career" | "settings" | "player" | "team" | "replay";

// In-progress configuration for the New Universe setup screen.
interface UniverseSetup {
  name: string;
  regions: Set<Region>;
  perRegion: number;
  maps: GameMap[];
}

// Live series play: a Bo3/Bo5 watched one game at a time. The map order comes
// from the same veto the headless sim uses; morale is snapshotted once up front
// (the series folds only after the final game, mirroring the headless path).
interface SeriesPlay {
  matchupId: string;
  mapOrder: number[];
  veto: VetoStep[];
  moods: Record<string, number>;
  games: GameResult[];
  ctWon: number;
  tWon: number;
}

// Screens that share the day-view tab bar.
const DAY_TABS: Screen[] = ["matchups", "standings", "teams", "market", "news", "career", "settings"];

export class UniverseMode {
  private root: HTMLElement;
  private universe: Universe | null = null;
  private screen: Screen = "menu";
  private activeMatchupId: string | null = null;
  // In-progress live series play (Bo3/Bo5 watched game-by-game). Null for Bo1.
  private seriesPlay: SeriesPlay | null = null;
  private activePlayerId: string | null = null;
  private activeTeamId: string | null = null;
  // Screen to return to from the team page (set when navigating in).
  private teamReturnScreen: Screen = "teams";
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
  // Teams tab view: per-region regular-season standings, or the flat all-time
  // ladder across every team.
  private teamsView: "season" | "alltime" = "season";

  // Players tab view: the active pool, or retired players (the hall of fame).
  private playersView: "active" | "retired" = "active";

  // News tab filters (firehose feed; filters keep it usable).
  private newsCat: NewsCategory | "all" = "all";
  private newsRegion: Region | "all" = "all";

  // Career stats scope: all games, or tournament (event) games only.
  private careerMode: "all" | "event" = "all";

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
      case "teams":     this.renderTeams(body); break;
      case "market":    this.renderMarket(body); break;
      case "news":      this.renderNews(body); break;
      case "career":    this.renderCareer(body); break;
      case "settings":  this.renderSettings(body); break;
      case "player":    this.renderPlayer(body); break;
      case "team":      this.renderTeam(body); break;
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
      ctName: teamNameFor(ctPlayers, u.elos, orgNameOf(u, m.ctTeamId)),
      tName:  teamNameFor(tPlayers,  u.elos, orgNameOf(u, m.tTeamId)),
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
      { key: "teams",     label: "Teams",          show: true },
      { key: "market",    label: "Market",         show: true },
      { key: "news",      label: "News",           show: true },
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
    // Returning from a player opened off a team page lands back on that team.
    this.playerReturnScreen = this.screen === "player" ? this.playerReturnScreen : this.screen;
    this.screen = "player";
    this.render();
  }

  private openTeam(teamId: string) {
    this.activeTeamId = teamId;
    this.teamReturnScreen = this.screen === "team" ? this.teamReturnScreen : this.screen;
    this.screen = "team";
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
      // A jump to the next tournament (or through the one in progress).
      right.appendChild(btn(
        this.universe.playoffs ? "Sim through event" : "Sim to next event",
        "", () => this.simToNextEvent()));
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
    } else if (this.screen === "team" && this.universe) {
      right.appendChild(btn("← Back", "", () => {
        this.screen = this.teamReturnScreen;
        this.activeTeamId = null;
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
      `<div class="uni-overline">Tactical Management Simulator</div>` +
      `<h1 class="uni-wordmark"><span class="uw-a">2D&nbsp;FPS</span><span class="uw-b">Manager</span></h1>` +
      `<div class="uni-rule"></div>` +
      `<div class="uni-mode-tag">Universe&nbsp;Mode</div>` +
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
      // Default to the saved-map rotation so series have distinct maps per game
      // (Bo3 needs ≥3, Bo5 needs ≥5) — add more in the editor for richer vetoes.
      maps: savedMapsList().map(deepCloneMap),
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
    const maps = s.maps.length > 0 ? s.maps : [deepCloneMap(defaultMap())];

    setSeed(Date.now());
    resetTeamNames();
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
      yearStats: {},
      maps: maps.map(deepCloneMap),
      teams: [],
      stacks: [],
      circuit: { nextEventId: 1, daysUntilNext: EVENT_INTERVAL_DAYS, lastLifecycleYear: 1 },
      titles: [],
    };
    recomputePlayerValues(this.universe);
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
    // The id counter resets to 0 on page load; bump it past this save's players
    // so the next youth intake doesn't re-issue colliding ids (see factory).
    reservePlayerIds(u.players);
    // Migrate older saves that predate the universe-level map / map rotation.
    if (!u.maps || u.maps.length === 0) {
      u.maps = [u.map ?? loadCustomMap() ?? deepCloneMap(defaultMap())];
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
    // Event-only careers postdate lifetime careers; backfill from the retained
    // window on first load (partial for old saves, complete from here forward).
    if (!u.eventCareers) rebuildEventCareers(u);
    trimHistory(u);
    // Reserve existing team names so freshly crystallized teams don't collide,
    // and retire any legacy "Team X" org names (those now read as pickup labels).
    if (u.teams?.length) {
      const legacy = (n: string) => /^Team /.test(n);
      reserveTeamNames(u.teams.filter(t => !legacy(t.name)).map(t => t.name));
      for (const t of u.teams) if (legacy(t.name)) t.name = generateTeamName(Math.random);
    }
    // Tiers/roster history postdate the original orgs: every existing tracked team
    // was a crystallized org, so backfill that tier and a founding lineup entry.
    u.stacks ??= [];
    const playerById = new Map(u.players.map(p => [p.id, p] as const));
    for (const t of u.teams ?? []) {
      t.tier ??= "org";
      t.rosterHistory ??= [{ day: t.foundedDay, playerIds: [...t.playerIds], note: "Founded" }];
      t.country ??= playerById.get(captainOf(t.playerIds, u.elos))?.country;
      // Wages/budget postdate the fees-only market: seed spendable cash from the
      // accumulated earnings (which the v1 market already used as a balance).
      t.balance ??= t.earnings ?? STARTING_BALANCE;
    }
    this.ensureCircuit(u); // lazy-init the circuit scheduler for saves predating it
    if (!u.yearStats) rebuildYearStats(u); // backfill per-year stat buckets from history
    recomputePlayerValues(u); // backfill/refresh market values (incl. pre-economy saves)
    // Older saves may have rolled a day into history without generating the
    // next day's matchups. The day view now always expects a pendingDay, so
    // backfill one (phase-aware) before rendering.
    if (!u.pendingDay && u.history.length > 0) {
      u.pendingDay = { day: u.day, matchups: this.nextDayMatchups(u) };
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
      eventCareers: u.eventCareers ??= {},
      maps: u.maps ?? [],
      pendingDay: u.pendingDay,
      day: u.day,
      period: yearOf(u.day),
      yearStats: u.yearStats ??= {},
    };
  }

  // Persistent-team context for matchup generation — ensures the registry exists
  // and is keyed to the day the matchups belong to (for foundedDay/lastPlayed).
  private teamCtx(u: Universe): TeamContext {
    return {
      teams: (u.teams ??= []),
      stacks: (u.stacks ??= []),
      byId: new Map(u.players.map(p => [p.id, p] as const)),
      day: u.day,
    };
  }

  // Ensure circuit state exists (lazy init for new + pre-circuit saves). A fresh
  // scheduler counts down to the first event and starts the world's first year.
  private ensureCircuit(u: Universe): Circuit {
    u.titles ??= [];
    return (u.circuit ??= {
      nextEventId: 1, daysUntilNext: EVENT_INTERVAL_DAYS, lastLifecycleYear: yearOf(u.day),
    });
  }

  // A team's current 5-man roster, for building tournament matchups.
  private rosterOf(u: Universe): (teamId: string) => string[] {
    const byId = new Map((u.teams ?? []).map(t => [t.id, t] as const));
    return (id: string) => byId.get(id)?.playerIds ?? [];
  }

  // Player ids committed to the active tournament (so they sit out the ladder).
  private eventPlayerIds(u: Universe): Set<string> {
    const ids = new Set<string>();
    const rosterOf = this.rosterOf(u);
    for (const rp of u.playoffs?.regions ?? []) {
      for (const e of rp.entrants) for (const pid of rosterOf(e.teamId)) ids.add(pid);
    }
    return ids;
  }

  // Matchups for the upcoming day (u.day): the active tournament's round (if any)
  // plus the daily ladder for everyone not currently committed to an event. A
  // due event is started here so its first round joins the same day's board.
  private nextDayMatchups(u: Universe): Matchup[] {
    const c = this.ensureCircuit(u);
    if (!u.playoffs && c.daysUntilNext <= 0) this.startEvent(u);
    const tournament = u.playoffs ? playoffRoundMatchups(u.playoffs, this.rosterOf(u)) : [];
    const exclude = u.playoffs ? this.eventPlayerIds(u) : undefined;
    const ladder = generateMatchups(u.players, u.elos, u.maps?.length ?? 1, this.teamCtx(u), exclude);
    return [...tournament, ...ladder];
  }

  // Fold a completed day into team records and advance the circuit calendar. Call
  // once per day, with u.day still the day that just finished (before increment).
  private advanceCalendar(u: Universe, done: CompletedDay): void {
    const c = this.ensureCircuit(u);
    u.teams ??= [];
    // Lifetime team records update from every tagged org-vs-org result (ladder or
    // tournament). Elo/form/age have settled — refresh market values.
    recordTeamResults(u.teams, done.matchups);
    recomputePlayerValues(u);

    if (u.playoffs) {
      // Tournament in progress: advance its brackets; finish when every region's done.
      if (advancePlayoffs(u.playoffs, done.matchups)) this.finishEvent(u, done.day);
    } else if (c.daysUntilNext > 0) {
      c.daysUntilNext--; // tick down to the next event
    }
    // Age the world once per calendar year, but only between events so a bracket's
    // rosters never shift mid-tournament. Deferred years catch up here.
    if (!u.playoffs) this.runDueLifecycle(u, done.day);
  }

  // Seed a tournament in every region that can field one. Invitees are the top
  // INVITE_FIELD by ranking points / Elo, drawn from tracked orgs AND recurring
  // full-5 friend-stacks — so brackets fill out early and a stack good enough to
  // qualify graduates into a tracked org (it can then win prize money + ranking
  // points like anyone else). Decays standing points first so the ranking tracks
  // recent form. No-op (just rearm the timer) if nobody can play.
  private startEvent(u: Universe) {
    const c = this.ensureCircuit(u);
    for (const t of u.teams ?? []) t.rankingPoints = (t.rankingPoints ?? 0) * RANKING_DECAY;
    const byId = new Map(u.players.map(p => [p.id, p] as const));
    const isActive = (id: string) => { const p = byId.get(id); return !!p && !p.retired; };
    const invitees = eventInvitees(u.teams ?? [], u.stacks ?? [], u.elos, isActive);
    const ctx = this.teamCtx(u);
    // Players already committed to a team or seeded stack — never drafted onto a
    // free-agent contender. Grows as contenders form so no one is double-picked.
    const committed = new Set<string>();
    for (const t of u.teams ?? []) if (!t.disbandedDay) for (const id of t.playerIds) committed.add(id);
    for (const s of u.stacks ?? []) for (const id of s.playerIds) committed.add(id);
    const seededByRegion = new Map<Region, UniverseTeam[]>();
    for (const [region, list] of invitees) {
      const seeded: UniverseTeam[] = [];
      for (const inv of list) {
        if (inv.kind === "team") { seeded.push(inv.team); continue; }
        // Graduate the stack: crystallize it into a tracked org and drop the
        // provisional record (same hand-off resolveOrgSide does on the ladder).
        const id = crystallizeTeam(ctx, region, inv.stack.playerIds, u.elos);
        const si = (u.stacks ?? []).indexOf(inv.stack);
        if (si >= 0) u.stacks!.splice(si, 1);
        const team = (u.teams ?? []).find(t => t.id === id);
        if (team) seeded.push(team);
      }
      // Free-agent contenders: strong ungrouped players band into fresh orgs, but
      // only while they out-seed the weakest qualified team (no field padding).
      if (seeded.length >= 2) {
        const weakest = Math.min(...seeded.map(t => t.elo ?? STARTING_ELO));
        for (const roster of freeAgentContenders(region, u.players, u.elos, committed, weakest)) {
          seedCliqueBonds(roster.map(id => byId.get(id)!).filter(Boolean), RECRUIT_BOND);
          const id = crystallizeTeam(ctx, region, roster, u.elos);
          const team = (u.teams ?? []).find(t => t.id === id);
          if (team) { seeded.push(team); roster.forEach(pid => committed.add(pid)); }
        }
      }
      // Qualification is by ranking points (eventInvitees), but seed the event by
      // current roster strength so a freshly-formed free-agent contender lands at
      // a seed that survives the power-of-two cut — bumping a weaker qualifier
      // rather than sitting at the bottom on zero ranking points.
      seeded.sort((a, b) => (b.elo ?? STARTING_ELO) - (a.elo ?? STARTING_ELO));
      if (seeded.length >= 2) seededByRegion.set(region, seeded);
    }
    const event = startPlayoffs(c.nextEventId, seededByRegion);
    if (event.regions.length === 0) { c.daysUntilNext = EVENT_INTERVAL_DAYS; return; }
    u.playoffs = event;
  }

  // Crown each region's champion into the trophy log, pay prize money + ranking
  // points by finish, then clear the event and rearm the timer for the next one.
  private finishEvent(u: Universe, day: number) {
    const c = this.ensureCircuit(u);
    const byId = new Map((u.teams ?? []).map(t => [t.id, t] as const));
    const titles = (u.titles ??= []);
    for (const rp of u.playoffs?.regions ?? []) {
      // Prize money: into spendable balance AND the lifetime earnings stat.
      for (const [teamId, amt] of regionPayouts(rp)) {
        const t = byId.get(teamId);
        if (t) { t.balance = (t.balance ?? 0) + amt; t.earnings = (t.earnings ?? 0) + amt; }
      }
      for (const [teamId, pts] of rankingPointsFor(rp)) {
        const t = byId.get(teamId);
        if (t) t.rankingPoints = (t.rankingPoints ?? 0) + pts;
      }
      const champ = rp.championTeamId ? byId.get(rp.championTeamId) : undefined;
      if (!champ) continue;
      const runnerUp = this.runnerUpOf(rp, byId);
      titles.push({
        eventId: c.nextEventId, name: `${REGION_LABELS[rp.region] ?? rp.region} Circuit #${c.nextEventId}`,
        region: rp.region, day, championTeamId: champ.id, championName: champ.name,
        runnerUpTeamId: runnerUp?.id, runnerUpName: runnerUp?.name,
        prize: PLAYOFF_PRIZES.champion,
      });
    }
    if (titles.length > TITLES_LOG_MAX) titles.splice(0, titles.length - TITLES_LOG_MAX);
    u.playoffs = null;
    c.nextEventId += 1;
    c.daysUntilNext = EVENT_INTERVAL_DAYS;

    // Finances tick once per event cycle: credit sponsorship, pay wages (prize
    // money was just added above), THEN run the transfer window — so a sellable
    // org in the red can be bailed out by poach fees — and only THEN fold the
    // orgs still insolvent. Roster moves flow into rosterHistory → news; the
    // structured transfer log feeds the Market screen.
    const teams = u.teams ?? [];
    runFinancialCycle(teams, u.players);
    const log = (u.transfers ??= []);
    log.push(...runTransferWindow(teams, u.players, u.elos, day));
    if (log.length > TRANSFERS_LOG_MAX) log.splice(0, log.length - TRANSFERS_LOG_MAX);
    foldInsolventOrgs(teams, day);
  }

  // The team that lost the final of a finished region bracket, if any.
  private runnerUpOf(rp: RegionPlayoff, byId: Map<string, UniverseTeam>): UniverseTeam | undefined {
    if (!rp.championTeamId || rp.bracket.length === 0) return undefined;
    const finalRound = Math.max(...rp.bracket.map(m => m.round));
    const finalMatch = rp.bracket.find(m => m.round === finalRound && m.winnerTeamId === rp.championTeamId);
    if (!finalMatch) return undefined;
    const loserId = finalMatch.aTeamId === rp.championTeamId ? finalMatch.bTeamId : finalMatch.aTeamId;
    return loserId ? byId.get(loserId) : undefined;
  }

  // Run any calendar years the world owes (aging/retirement/youth + roster fills),
  // catching up if a year boundary fell during an event. Updates lastLifecycleYear.
  private runDueLifecycle(u: Universe, day: number) {
    const c = this.ensureCircuit(u);
    const currentYear = yearOf(day);
    while (c.lastLifecycleYear < currentYear) {
      runSeasonLifecycle(u.players, u.elos, u.teams ?? [], day);
      recomputePlayerValues(u); // ages/rosters moved — refresh market values now
      trimYearStats(u);         // drop per-player breakdowns older than the window
      c.lastLifecycleYear++;
    }
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
    const pool = new SimPool(simPoolSize(), u.maps ?? []);
    const completed: CompletedDay[] = [];
    try {
      for (let i = 0; i < nDays; i++) {
        // Rebuilt each iteration: a season rollover (advanceCalendar) can retire
        // players and debut youth, so the index must pick up the new pool before
        // the next day's matches are simulated/folded.
        const byId = new Map(u.players.map(p => [p.id, p] as const));
        // Attribute this day's folds to its own calendar year.
        state.period = yearOf(u.day);
        if (!u.pendingDay) {
          u.pendingDay = { day: u.day, matchups: this.nextDayMatchups(u) };
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
        this.advanceCalendar(u, done); // standings + season/playoff calendar, once per day
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
        u.pendingDay = { day: u.day, matchups: this.nextDayMatchups(u) };
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
    const retiredCount = u.players.reduce((n, p) => n + (p.retired ? 1 : 0), 0);

    // Active pool by default; a toggle reveals retired players (the hall of fame).
    // Only show the toggle once anyone has actually retired.
    if (retiredCount > 0) {
      const toggle = document.createElement("div");
      toggle.className = "uni-seg-toggle";
      const mk = (key: "active" | "retired", label: string) => {
        const b = document.createElement("button");
        b.className = "uni-seg" + (this.playersView === key ? " active" : "");
        b.textContent = label;
        b.onclick = () => { if (this.playersView !== key) { this.playersView = key; this.render(); } };
        return b;
      };
      toggle.append(mk("active", "Active"), mk("retired", `Retired (${retiredCount})`));
      body.appendChild(toggle);
    } else {
      this.playersView = "active";
    }

    const showRetired = this.playersView === "retired";
    const players = u.players.filter(p => !!p.retired === showRetired);
    const table = playerTable(players, u.elos, /* showElo */ true, id => this.openPlayer(id));
    body.appendChild(table);
  }

  // ---- Matchups screen ----

  private startDay() {
    if (!this.universe) return;
    if (!this.universe.pendingDay) {
      this.universe.pendingDay = {
        day: this.universe.day,
        matchups: this.nextDayMatchups(this.universe),
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
    const teamNameById = new Map((u.teams ?? []).map(t => [t.id, t.name] as const));

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
      const poLabel = regionMatchups[0]?.playoff ? playoffRoundLabel(regionMatchups[0], u) : null;
      section.textContent = poLabel
        ? `${label} · Tournament · ${poLabel}`
        : `${label} · ${regionMatchups.length} match${regionMatchups.length === 1 ? "" : "es"}`;
      if (poLabel) section.classList.add("is-playoff");
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
      const poLabel = m.playoff ? playoffRoundLabel(m, u) : null;
      // Playoff games show their round; series show format; Bo1 shows the map.
      header.textContent = poLabel
        ? `${poLabel} · Bo${m.bestOf}`
        : isSeries
          ? `Match ${i + 1} · Bo${m.bestOf}`
          : (m.status === "completed" && mapName ? `Match ${i + 1} · ${mapName}` : `Match ${i + 1}`);
      if (poLabel) header.classList.add("is-playoff");
      card.appendChild(header);

      const teams = document.createElement("div");
      teams.className = "umc-teams";
      teams.appendChild(rosterColumn("CT", m.ctPlayerIds, playerById, elos, m, id => this.openPlayer(id), m.ctTeamId ? teamNameById.get(m.ctTeamId) : undefined, id => this.openTeam(id)));
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
      teams.appendChild(rosterColumn("T", m.tPlayerIds, playerById, elos, m, id => this.openPlayer(id), m.tTeamId ? teamNameById.get(m.tTeamId) : undefined, id => this.openTeam(id)));
      card.appendChild(teams);

      const actions = document.createElement("div");
      actions.className = "umc-actions";
      if (m.status === "pending") {
        actions.appendChild(btn("Sim", "", () => this.simMatchup(m.id)));
        // Bo1 plays as one match; a series is watched game-by-game (renderMatch).
        actions.appendChild(btn(isSeries ? "Play series" : "Play", "primary", () => this.playMatchup(m.id)));
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
    if (!u.maps || u.maps.length === 0) u.maps = [loadCustomMap() ?? deepCloneMap(defaultMap())];
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
    if (!u.maps || u.maps.length === 0) u.maps = [loadCustomMap() ?? deepCloneMap(defaultMap())];
    // A series is watched one game at a time.
    if ((m.bestOf ?? 1) > 1) { await this.renderSeriesGame(body, m); return; }
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
      ctName: teamNameFor(ctPlayers, u.elos, orgNameOf(u, m.ctTeamId)),
      tName:  teamNameFor(tPlayers,  u.elos, orgNameOf(u, m.tTeamId)),
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

  // Watch a Bo3/Bo5 series live, one game at a time. The map order is fixed by
  // the veto up front; each game is observed with a fresh seed, results accrue
  // in `seriesPlay`, and the whole series folds once a side clinches a majority
  // (mirroring the headless path: morale is snapshotted once and folded after).
  private async renderSeriesGame(body: HTMLElement, m: Matchup) {
    const u = this.universe!;
    const byId = new Map(u.players.map(p => [p.id, p] as const));
    const bestOf = m.bestOf ?? 3;

    // (Re)initialize series state for this matchup.
    let sp = this.seriesPlay;
    if (!sp || sp.matchupId !== m.id) {
      const { order, steps } = runVeto(u.maps!, bestOf, m.ctPlayerIds, m.tPlayerIds, byId);
      const moods: Record<string, number> = {};
      for (const id of [...m.ctPlayerIds, ...m.tPlayerIds]) moods[id] = byId.get(id)?.morale ?? 50;
      sp = this.seriesPlay = { matchupId: m.id, mapOrder: order, veto: steps, moods, games: [], ctWon: 0, tWon: 0 };
    }

    const need = Math.ceil(bestOf / 2);
    const gameIdx = sp.games.length;
    const mapIndex = sp.mapOrder[gameIdx % sp.mapOrder.length];
    const map = u.maps![mapIndex];
    const seed = newSeed();
    const ctPlayers = m.ctPlayerIds.map(id => byId.get(id)!).filter(Boolean);
    const tPlayers  = m.tPlayerIds.map (id => byId.get(id)!).filter(Boolean);
    const ctBase = teamNameFor(ctPlayers, u.elos, orgNameOf(u, m.ctTeamId));
    const tBase  = teamNameFor(tPlayers,  u.elos, orgNameOf(u, m.tTeamId));

    await observeMatch(body, {
      // Series score rides in the name so the live HUD shows the standing.
      ctName: `${ctBase} [${sp.ctWon}]`,
      tName:  `${tBase} [${sp.tWon}]`,
      ctPlayers, tPlayers, map, seed,
      moods: sp.moods,
      onDone: (result) => {
        sp!.games.push({
          seed, mapIndex,
          ctScore: result.ctScore, tScore: result.tScore, winnerSide: result.winnerSide,
          clutches: result.clutches, playerStats: result.playerStats, moods: sp!.moods,
        });
        if (result.winnerSide === "CT") sp!.ctWon++; else sp!.tWon++;

        if (sp!.ctWon >= need || sp!.tWon >= need) {
          // Series clinched — fold the whole thing through the normal path.
          const outcome: MatchupOutcome = {
            id: m.id,
            winnerSide: sp!.ctWon > sp!.tWon ? "CT" : "T",
            ctScore: sp!.ctWon, tScore: sp!.tWon,
            games: sp!.games, veto: sp!.veto,
          };
          foldOutcome(this.foldState(u), m, outcome, byId);
          this.seriesPlay = null;
          this.activeMatchupId = null;
          this.persist();
          this.screen = "matchups";
          this.render();
        } else {
          // Next game of the series.
          this.render();
        }
      },
      onCancel: () => {
        // Abandon the series — nothing recorded, matchup stays pending.
        this.seriesPlay = null;
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
    this.advanceCalendar(u, done); // standings + season/playoff calendar, once per day
    u.history.push(done);
    trimHistory(u);
    void appendDays(u.id, [done]); // archive the completed day (append-only)
    decayRelationships(u.players); // bonds fade day-to-day without upkeep
    u.day++;
    u.pendingDay = { day: u.day, matchups: this.nextDayMatchups(u) };
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
    await this.runDaysWithOverlay(Math.min(n, 1000)); // soft guard — 1000 days is a lot
  }

  // Fast-forward to the next milestone: if a tournament is running, sim until it
  // finishes; otherwise sim up to the day the next event begins. Bounded so a
  // pathological state can't loop forever.
  private async simToNextEvent() {
    if (!this.universe) return;
    const u = this.universe;
    const c = this.ensureCircuit(u);
    if (u.playoffs) {
      // Sim one day at a time until the active event resolves (or a safety cap).
      for (let i = 0; i < 60 && u.playoffs; i++) await this.runDaysWithOverlay(1);
      return;
    }
    const days = Math.max(1, c.daysUntilNext);
    await this.runDaysWithOverlay(days);
  }

  // Run `count` days behind the full-screen sim overlay, then archive + persist.
  // Shared by "Sim X days", "Sim to end of season", etc.
  private async runDaysWithOverlay(count: number) {
    if (!this.universe || count <= 0) return;
    const u = this.universe;
    const overlay = makeSimOverlay(count);
    this.root.appendChild(overlay.el);
    // Let the browser paint the overlay before we hand off to the worker.
    await nextFrame();

    // try/finally so the full-screen overlay is ALWAYS removed and the screen
    // re-renders — otherwise a throw leaves the blocking overlay up and the app
    // appears frozen.
    try {
      // Each day's matches run in parallel across the worker pool; days roll
      // sequentially (matchmaking depends on the prior day's elo/chemistry).
      const completed = await this.runDaySim(u, count, /* roll */ true, done => overlay.update(done));
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

  // ---- Teams standings screen ----

  private renderTeams(body: HTMLElement) {
    if (!this.universe) return;
    const u = this.universe;
    // Disbanded orgs drop out of the active ranking/ladder (still reachable via
    // links from titles and player histories).
    const teams = (u.teams ?? []).filter(t => !t.disbandedDay);
    if (teams.length === 0) {
      const empty = document.createElement("div");
      empty.className = "universe-empty-note";
      empty.textContent =
        "No teams yet. A team forms when five friends queue together as a full stack — " +
        "play out more days and tight-knit groups will crystallize into tracked orgs.";
      body.appendChild(empty);
      return;
    }
    const byId = new Map(u.players.map(p => [p.id, p] as const));
    const c = this.ensureCircuit(u);

    // Circuit banner: event in progress, or countdown to the next one.
    const banner = document.createElement("div");
    banner.className = "uni-season-banner";
    if (u.playoffs) {
      banner.innerHTML =
        `<span class="uss-title">Circuit</span>` +
        `<span class="uss-progress uss-playoffs">★ Tournament live · Day ${u.playoffs.day}</span>`;
    } else {
      const d = Math.max(0, c.daysUntilNext);
      banner.innerHTML =
        `<span class="uss-title">Circuit</span>` +
        `<span class="uss-progress">Next event ${d === 0 ? "today" : `in ${d} day${d === 1 ? "" : "s"}`}</span>`;
    }
    body.appendChild(banner);

    // Live tournament bracket/Swiss panel.
    if (u.playoffs) body.appendChild(this.playoffPanel(u));

    // View toggle: world ranking (by ranking points) vs all-time ladder.
    const toggle = document.createElement("div");
    toggle.className = "uni-seg-toggle";
    const mk = (key: "season" | "alltime", label: string) => {
      const b = document.createElement("button");
      b.className = "uni-seg" + (this.teamsView === key ? " active" : "");
      b.textContent = label;
      b.onclick = () => { if (this.teamsView !== key) { this.teamsView = key; this.render(); } };
      return b;
    };
    toggle.append(mk("season", "World ranking"), mk("alltime", "All-time ladder"));
    body.appendChild(toggle);

    if (this.teamsView === "alltime") {
      body.appendChild(teamsTable(teams, byId, id => this.openTeam(id)));
      return;
    }

    // Per-region world ranking by ranking points.
    const grid = document.createElement("div");
    grid.className = "uni-standings-grid";
    let anyRanked = false;
    for (const region of REGION_ORDER) {
      const inRegion = teams.filter(t => t.region === region).sort(compareRanking);
      if (inRegion.length === 0) continue;
      anyRanked = true;
      grid.appendChild(this.regionRankingCard(region, inRegion, byId));
    }
    if (!anyRanked) {
      const note = document.createElement("div");
      note.className = "universe-empty-note";
      note.textContent = "No ranked teams yet — sim until orgs form and play an event.";
      body.appendChild(note);
    } else {
      body.appendChild(grid);
    }

    // Trophy history (most recent first).
    const titles = u.titles ?? [];
    if (titles.length > 0) body.appendChild(this.titlesSection(titles));
  }

  // One region's world ranking: teams sorted by ranking points, points + record
  // shown. The top row is highlighted as the region's #1.
  private regionRankingCard(region: Region, teams: UniverseTeam[], byId: Map<string, Player>): HTMLElement {
    const card = document.createElement("div");
    card.className = "uni-standings-card";
    const head = document.createElement("div");
    head.className = "uni-standings-head";
    head.textContent = REGION_LABELS[region] ?? region;
    card.appendChild(head);

    const table = document.createElement("table");
    table.className = "uni-standings-table";
    table.innerHTML =
      `<thead><tr><th class="usc-rank">#</th><th class="usc-team">Team</th>` +
      `<th>Pts</th><th>W-L</th><th>Strk</th></tr></thead>`;
    const tbody = document.createElement("tbody");
    teams.forEach((t, i) => {
      const tr = document.createElement("tr");
      if (i === 0) tr.className = "usc-leader";
      const pts = Math.round(t.rankingPoints ?? 0);
      const roster = t.playerIds.map(id => byId.get(id)?.handle ?? "?").join(", ");
      const strk = t.streak === 0 ? "—" : (t.streak > 0 ? `W${t.streak}` : `L${-t.streak}`);
      tr.innerHTML =
        `<td class="usc-rank">${i + 1}</td>` +
        `<td class="usc-team"><span class="pt-handle">${t.country ? `${flagEmoji(t.country)} ` : ""}${escapeHtml(t.name)}</span>` +
        `<span class="pt-realname">${escapeHtml(roster)}</span></td>` +
        `<td class="usc-pts">${pts}</td>` +
        `<td>${t.wins}-${t.losses}</td>` +
        `<td class="${t.streak > 0 ? "usc-pos" : t.streak < 0 ? "usc-neg" : ""}">${strk}</td>`;
      tr.classList.add("clickable-row");
      tr.onclick = () => this.openTeam(t.id);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    card.appendChild(table);
    return card;
  }

  // Past tournament winners, grouped by event (most recent first).
  private titlesSection(titles: TournamentTitle[]): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "uni-champions";
    const h = document.createElement("div");
    h.className = "uni-champions-head";
    h.textContent = "Trophy cabinet";
    wrap.appendChild(h);

    const byEvent = new Map<number, TournamentTitle[]>();
    for (const t of titles) (byEvent.get(t.eventId) ?? byEvent.set(t.eventId, []).get(t.eventId)!).push(t);
    const events = [...byEvent.keys()].sort((a, b) => b - a);
    for (const ev of events) {
      const row = document.createElement("div");
      row.className = "uni-champions-row";
      const items = (byEvent.get(ev) ?? [])
        .map(t => `<span class="ucr-item">${REGION_LABELS[t.region] ?? t.region}: ` +
          `<b class="clickable" data-tid="${t.championTeamId}">🏆 ${escapeHtml(t.championName)}</b>` +
          (t.prize ? ` <span class="ucr-prize">${formatMoney(t.prize)}</span>` : "") +
          (t.runnerUpName
            ? ` <span class="ucr-rs">def. ${t.runnerUpTeamId
                ? `<span class="clickable" data-tid="${t.runnerUpTeamId}">${escapeHtml(t.runnerUpName)}</span>`
                : escapeHtml(t.runnerUpName)}</span>` : "") +
          `</span>`)
        .join("");
      row.innerHTML = `<span class="ucr-season">#${ev}</span>${items}`;
      wrap.appendChild(row);
    }
    wrap.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-tid]") as HTMLElement | null;
      if (el?.dataset.tid) this.openTeam(el.dataset.tid);
    });
    return wrap;
  }

  // Live playoff panel: per-region Swiss standings + knockout bracket. Team names
  // link to the team page (delegated click via data-tid).
  private playoffPanel(u: Universe): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "uni-playoffs";
    const teamById = new Map((u.teams ?? []).map(t => [t.id, t] as const));
    const nameOf = (id?: string) => (id ? (teamById.get(id)?.name ?? "?") : "TBD");
    const seedOf = (rp: RegionPlayoff, id?: string) => rp.entrants.find(e => e.teamId === id)?.seed;

    // Series score for a bracket match, looked up by its deciding matchup id.
    const matchupById = new Map<string, Matchup>();
    for (const d of u.history) for (const m of d.matchups) if (m.playoff) matchupById.set(m.id, m);
    if (u.pendingDay) for (const m of u.pendingDay.matchups) if (m.playoff) matchupById.set(m.id, m);
    const scoreOf = (bm: BracketMatch): string | null => {
      const m = bm.matchupId ? matchupById.get(bm.matchupId) : undefined;
      if (!m || m.ctScore === undefined || m.tScore === undefined) return null;
      // Order the score to read winner-first isn't necessary; show a:b by slot side.
      const aIsCt = m.ctTeamId === bm.aTeamId;
      return aIsCt ? `${m.ctScore}-${m.tScore}` : `${m.tScore}-${m.ctScore}`;
    };
    // A clickable team label (or plain "TBD").
    const teamSpan = (id?: string, won = false) => {
      const cls = `upo-team${won ? " upo-win" : ""}${id ? " clickable" : ""}`;
      const tid = id ? ` data-tid="${id}"` : "";
      return `<span class="${cls}"${tid}>${escapeHtml(nameOf(id))}</span>`;
    };

    const grid = document.createElement("div");
    grid.className = "uni-playoff-grid";
    for (const rp of u.playoffs?.regions ?? []) {
      const card = document.createElement("div");
      card.className = "uni-playoff-card";
      const stageLabel = rp.stage === "swiss" ? `Swiss · Round ${rp.swissRound}`
        : rp.stage === "bracket" ? "Knockout bracket" : "Complete";
      let html = `<div class="upo-head">${REGION_LABELS[rp.region] ?? rp.region}` +
        `<span class="upo-stage">${stageLabel}</span></div>`;

      if (rp.stage === "done" && rp.championTeamId) {
        html += `<div class="upo-champ">🏆 ${teamSpan(rp.championTeamId)}</div>`;
      }

      // Swiss table (shown while in Swiss, or for a region that never reached the bracket).
      if (rp.stage === "swiss" || (rp.entrants.length > 0 && rp.bracket.length === 0)) {
        const rows = [...rp.entrants]
          .sort((a, b) => (b.wins - b.losses) - (a.wins - a.losses) || a.seed - b.seed)
          .map(e => {
            const cls = e.status === "advanced" ? "upo-adv" : e.status === "eliminated" ? "upo-elim" : "";
            const mark = e.status === "advanced" ? "✓" : e.status === "eliminated" ? "✗" : "";
            return `<tr class="${cls}"><td class="upo-seed">${e.seed}</td>` +
              `<td>${teamSpan(e.teamId)}</td><td class="upo-rec">${e.wins}-${e.losses}</td>` +
              `<td class="upo-mark">${mark}</td></tr>`;
          }).join("");
        html += `<table class="upo-table"><tbody>${rows}</tbody></table>`;
      }

      // Knockout bracket, laid out as one column per round.
      if (rp.bracket.length > 0) {
        const total = bracketTotalRounds(u, rp.region);
        const rounds = [...new Set(rp.bracket.map(m => m.round))].sort((a, b) => a - b);
        let cols = `<div class="upo-bracket">`;
        for (const r of rounds) {
          cols += `<div class="upo-col"><div class="upo-round">${bracketRoundName(total, r)}</div>`;
          for (const m of rp.bracket.filter(x => x.round === r).sort((a, b) => a.slot - b.slot)) {
            const aW = !!m.winnerTeamId && m.winnerTeamId === m.aTeamId;
            const bW = !!m.winnerTeamId && m.winnerTeamId === m.bTeamId;
            const score = scoreOf(m);
            const seedTag = (id?: string) => { const s = seedOf(rp, id); return s ? `<span class="upo-bseed">${s}</span>` : ""; };
            cols += `<div class="upo-bmatch">` +
              `<div class="upo-bteam">${seedTag(m.aTeamId)}${teamSpan(m.aTeamId, aW)}${score ? `<span class="upo-bscore">${score.split("-")[0]}</span>` : ""}</div>` +
              `<div class="upo-bteam">${seedTag(m.bTeamId)}${teamSpan(m.bTeamId, bW)}${score ? `<span class="upo-bscore">${score.split("-")[1]}</span>` : ""}</div>` +
              `</div>`;
          }
          cols += `</div>`;
        }
        cols += `</div>`;
        html += cols;
      }
      card.innerHTML = html;
      grid.appendChild(card);
    }
    // Delegated team-link clicks.
    grid.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-tid]") as HTMLElement | null;
      if (el?.dataset.tid) this.openTeam(el.dataset.tid);
    });
    wrap.appendChild(grid);
    return wrap;
  }

  // ---- Career stats screen ----

  private renderCareer(body: HTMLElement) {
    if (!this.universe) return;
    // Scope toggle: all games vs tournament (event) games only.
    const toggle = document.createElement("div");
    toggle.className = "uni-seg-toggle";
    const mk = (key: "all" | "event", label: string) => {
      const b = document.createElement("button");
      b.className = "uni-seg" + (this.careerMode === key ? " active" : "");
      b.textContent = label;
      b.onclick = () => { if (this.careerMode !== key) { this.careerMode = key; this.render(); } };
      return b;
    };
    toggle.append(mk("all", "All games"), mk("event", "Event games"));
    body.appendChild(toggle);
    body.appendChild(careerStatsTable(this.universe, id => this.openPlayer(id), this.careerMode));
  }

  // ---- Transfer market ----

  // The market is autonomous (orgs shuffle rosters in post-event windows); this
  // screen is the observability view: who's available, who can spend, and what
  // just moved. Three panels: spending power, free agents, recent transfers.
  private renderMarket(body: HTMLElement) {
    if (!this.universe) return;
    const u = this.universe;
    const FA_CAP = 60, XFER_CAP = 60;

    const wrap = document.createElement("div");
    wrap.className = "uni-market";
    wrap.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-tid],[data-pid]") as HTMLElement | null;
      if (el?.dataset.tid) this.openTeam(el.dataset.tid);
      else if (el?.dataset.pid) this.openPlayer(el.dataset.pid);
    });

    const active = (u.teams ?? []).filter(t => !t.disbandedDay && t.playerIds.length > 0);
    const onOrg = new Set<string>();
    for (const t of active) for (const id of t.playerIds) onOrg.add(id);
    const teamName = (id?: string) => (id ? u.teams?.find(t => t.id === id)?.name : undefined);

    // --- Spending power (top orgs by spendable balance) ---
    const rich = [...active].sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0)).slice(0, 8);
    if (rich.length > 0) {
      const sec = document.createElement("div");
      sec.className = "uni-market-sec";
      sec.innerHTML = `<h3 class="uni-market-h">Spending power <span class="uni-market-sub">cash on hand</span></h3>`;
      const strip = document.createElement("div");
      strip.className = "uni-budgets";
      for (const t of rich) {
        const chip = document.createElement("div");
        chip.className = "uni-budget clickable";
        chip.dataset.tid = t.id;
        const bal = t.balance ?? 0;
        chip.innerHTML = `<span class="uni-budget-name">${t.country ? `${flagEmoji(t.country)} ` : ""}${escapeHtml(t.name)}</span>` +
          `<span class="uni-budget-amt" style="color:${bal < 0 ? "var(--bad)" : "var(--good)"}">${formatMoney(bal)}</span>`;
        strip.appendChild(chip);
      }
      sec.appendChild(strip);
      wrap.appendChild(sec);
    }

    // --- Free agents (best available, by market value) ---
    const fas = u.players
      .filter(p => !p.retired && !onOrg.has(p.id))
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0) || (u.elos[b.id] ?? STARTING_ELO) - (u.elos[a.id] ?? STARTING_ELO))
      .slice(0, FA_CAP);
    const faSec = document.createElement("div");
    faSec.className = "uni-market-sec";
    faSec.innerHTML = `<h3 class="uni-market-h">Free agents <span class="uni-market-sub">top ${fas.length} by value</span></h3>`;
    if (fas.length === 0) {
      faSec.insertAdjacentHTML("beforeend", `<div class="universe-empty-note">No unsigned players right now.</div>`);
    } else {
      const rows = fas.map(p =>
        `<tr class="clickable" data-pid="${p.id}">` +
        `<td class="umk-name"><span class="pt-handle">${escapeHtml(p.handle)}</span> <span class="pt-realname">${escapeHtml(p.name)}</span></td>` +
        `<td>${flagEmoji(p.country)} ${escapeHtml(p.country)}</td>` +
        `<td>${escapeHtml(p.role)}</td><td>${p.age}</td>` +
        `<td>${Math.round(u.elos[p.id] ?? STARTING_ELO)}</td>` +
        `<td class="umk-val">${formatMoney(p.value ?? 0)}</td></tr>`).join("");
      faSec.insertAdjacentHTML("beforeend",
        `<table class="uni-fa-table"><thead><tr><th>Player</th><th>From</th><th>Role</th><th>Age</th><th>Elo</th><th>Value</th></tr></thead><tbody>${rows}</tbody></table>`);
    }
    wrap.appendChild(faSec);

    // --- Recent transfers (newest first) ---
    const xfers = [...(u.transfers ?? [])].reverse().slice(0, XFER_CAP);
    const xSec = document.createElement("div");
    xSec.className = "uni-market-sec";
    xSec.innerHTML = `<h3 class="uni-market-h">Recent transfers</h3>`;
    if (xfers.length === 0) {
      xSec.insertAdjacentHTML("beforeend", `<div class="universe-empty-note">No transfers yet — they happen in the window after each event.</div>`);
    } else {
      const list = document.createElement("div");
      list.className = "uni-xfer-list";
      for (const x of xfers) {
        const fromName = x.fromTeamName ?? teamName(x.fromTeamId);
        const route = fromName
          ? `<button class="uni-news-chip" data-tid="${x.fromTeamId}">${escapeHtml(fromName)}</button> → <button class="uni-news-chip" data-tid="${x.toTeamId}">${escapeHtml(x.toTeamName)}</button>`
          : `free agent → <button class="uni-news-chip" data-tid="${x.toTeamId}">${escapeHtml(x.toTeamName)}</button>`;
        const fee = x.fee > 0 ? `<span class="uni-xfer-fee">${formatMoney(x.fee)}</span>` : `<span class="uni-xfer-free">free</span>`;
        const row = document.createElement("div");
        row.className = "uni-xfer-row";
        row.innerHTML =
          `<span class="uni-news-day">D${x.day}</span>` +
          `<button class="uni-news-chip ucp-player" data-pid="${x.playerId}">${escapeHtml(x.playerHandle)}</button>` +
          `<span class="uni-xfer-route">${route}</span>${fee}`;
        list.appendChild(row);
      }
      xSec.appendChild(list);
    }
    wrap.appendChild(xSec);

    body.appendChild(wrap);
  }

  // ---- News feed ----

  // A firehose of derived stories (trophies, results, roster moves, retirements)
  // with category + region filters. Derived on render from existing universe data
  // (see news.ts) — no separate persisted log.
  private renderNews(body: HTMLElement) {
    if (!this.universe) return;
    const u = this.universe;
    const NEWS_RENDER_CAP = 300;

    const wrap = document.createElement("div");
    wrap.className = "uni-news";
    // One delegated handler for every clickable chip (storylines + feed).
    wrap.addEventListener("click", (e) => {
      const el = (e.target as HTMLElement).closest("[data-tid],[data-pid]") as HTMLElement | null;
      if (el?.dataset.tid) this.openTeam(el.dataset.tid);
      else if (el?.dataset.pid) this.openPlayer(el.dataset.pid);
    });

    // --- Featured storylines (curated, ongoing threads; respects region) ---
    const stories = buildStorylines(u, { region: this.newsRegion, limit: 6 });
    if (stories.length > 0) {
      const sec = document.createElement("div");
      sec.className = "uni-stories";
      const h = document.createElement("div");
      h.className = "uni-stories-head";
      h.textContent = "Storylines";
      sec.appendChild(h);
      const grid = document.createElement("div");
      grid.className = "uni-stories-grid";
      const teamName = (id: string) => u.teams?.find(t => t.id === id)?.name ?? "team";
      const playerName = (id: string) => u.players.find(p => p.id === id)?.handle ?? "player";
      for (const s of stories) {
        const chips = [
          ...s.teamIds.map(id => `<button class="uni-news-chip" data-tid="${id}">${escapeHtml(teamName(id))}</button>`),
          ...s.playerIds.map(id => `<button class="uni-news-chip ucp-player" data-pid="${id}">${escapeHtml(playerName(id))}</button>`),
        ].join("");
        const card = document.createElement("div");
        card.className = `uni-story uni-story-${s.kind}`;
        card.innerHTML =
          `<div class="uni-story-title">${escapeHtml(s.title)}</div>` +
          `<div class="uni-story-detail">${escapeHtml(s.detail)}</div>` +
          (chips ? `<div class="uni-news-chips">${chips}</div>` : "");
        grid.appendChild(card);
      }
      sec.appendChild(grid);
      wrap.appendChild(sec);
    }

    // --- Filter bars ---
    const filters = document.createElement("div");
    filters.className = "uni-news-filters";
    const segment = (
      label: string, options: { key: string; label: string }[],
      current: string, onPick: (key: string) => void,
    ) => {
      const row = document.createElement("div");
      row.className = "uni-news-seg";
      const lab = document.createElement("span");
      lab.className = "uni-news-seg-label";
      lab.textContent = label;
      row.appendChild(lab);
      for (const o of options) {
        const b = document.createElement("button");
        b.className = "uni-seg" + (current === o.key ? " active" : "");
        b.textContent = o.label;
        b.onclick = () => { if (current !== o.key) { onPick(o.key); this.render(); } };
        row.appendChild(b);
      }
      return row;
    };
    filters.appendChild(segment("Type", [
      { key: "all", label: "All" }, { key: "trophy", label: "Trophies" },
      { key: "match", label: "Results" }, { key: "roster", label: "Roster" },
      { key: "career", label: "Careers" },
    ], this.newsCat, k => { this.newsCat = k as NewsCategory | "all"; }));
    filters.appendChild(segment("Region", [
      { key: "all", label: "All" },
      ...REGION_ORDER.map(r => ({ key: r, label: REGION_LABELS[r] ?? r })),
    ], this.newsRegion, k => { this.newsRegion = k as Region | "all"; }));
    wrap.appendChild(filters);

    // --- Feed ---
    const items = buildNews(u, {
      category: this.newsCat,
      region: this.newsRegion,
      limit: NEWS_RENDER_CAP + 1,
    });

    if (items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "universe-empty-note";
      empty.textContent = "No news yet — play out some days and the scene will start making headlines.";
      wrap.appendChild(empty);
      body.appendChild(wrap);
      return;
    }

    const teamName = (id: string) => u.teams?.find(t => t.id === id)?.name ?? "team";
    const playerName = (id: string) => u.players.find(p => p.id === id)?.handle ?? "player";

    const list = document.createElement("div");
    list.className = "uni-news-list";
    for (const it of items.slice(0, NEWS_RENDER_CAP)) {
      const row = document.createElement("div");
      row.className = `uni-news-row uni-news-${it.category}`;
      const tag = it.tag ? `<span class="uni-news-tag">${escapeHtml(it.tag)}</span>` : "";
      const region = it.region ? `<span class="uni-news-region">${REGION_LABELS[it.region] ?? it.region}</span>` : "";
      // Clickable chips for every involved org/player (jump to their page).
      const chips = [
        ...it.teamIds.map(id => `<button class="uni-news-chip" data-tid="${id}">${escapeHtml(teamName(id))}</button>`),
        ...it.playerIds.map(id => `<button class="uni-news-chip ucp-player" data-pid="${id}">${escapeHtml(playerName(id))}</button>`),
      ].join("");
      row.innerHTML =
        `<span class="uni-news-day">D${it.day}</span>` +
        `<div class="uni-news-body">` +
          `<div class="uni-news-head">${tag}<span class="uni-news-text">${escapeHtml(it.headline)}</span>${region}</div>` +
          (chips ? `<div class="uni-news-chips">${chips}</div>` : "") +
        `</div>`;
      list.appendChild(row);
    }
    wrap.appendChild(list);

    if (items.length > NEWS_RENDER_CAP) {
      const more = document.createElement("div");
      more.className = "uni-news-more";
      more.textContent = `Showing the ${NEWS_RENDER_CAP} most recent — narrow the filters to see more.`;
      wrap.appendChild(more);
    }
    body.appendChild(wrap);
  }

  // ---- Settings screen ----

  private renderSettings(body: HTMLElement) {
    if (!this.universe) return;
    const u = this.universe;
    if (!u.maps || u.maps.length === 0) u.maps = [loadCustomMap() ?? deepCloneMap(defaultMap())];

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
    body.appendChild(playerPage(p, u, (day, idx, round, gameIdx) => this.openReplay(day, idx, round, gameIdx), id => this.openTeam(id)));
  }

  private renderTeam(body: HTMLElement) {
    if (!this.universe || !this.activeTeamId) { this.screen = this.teamReturnScreen; this.render(); return; }
    const u = this.universe;
    const team = (u.teams ?? []).find(t => t.id === this.activeTeamId);
    if (!team) { this.screen = this.teamReturnScreen; this.render(); return; }
    body.appendChild(teamPage(team, u, {
      onPlayer: id => this.openPlayer(id),
      onReplay: (day, idx, round, gameIdx) => this.openReplay(day, idx, round, gameIdx),
    }));
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

// Every map available to add to a rotation. Saved maps come from the editor's
// store (the default map is seeded there on first run).
function collectMapSources(): { group: string; items: MapSource[] }[] {
  const saved = loadSavedMapsAll();
  const savedNames = Object.keys(saved).sort();
  if (savedNames.length === 0) return [];
  return [{
    group: "Saved",
    items: savedNames.map(name => ({ key: `s:${name}`, label: name, map: () => deepCloneMap(saved[name]) })),
  }];
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

// Team display name. A crystallized org uses its real name (`orgName`); a pickup
// lobby gets a "Team_Handle" label built from its highest-elo player (the de
// facto IGL), distinct from org names. Stable tiebreak by id so the pug label
// doesn't drift if elos happen to tie. Mirrors rosterColumn's captain-pick.
function teamNameFor(players: Player[], elos: Record<string, number>, orgName?: string): string {
  if (orgName) return orgName;
  if (players.length === 0) return "Team";
  const captain = [...players].sort((a, b) => {
    const da = elos[a.id] ?? STARTING_ELO;
    const db = elos[b.id] ?? STARTING_ELO;
    if (db !== da) return db - da;
    return a.id.localeCompare(b.id);
  })[0];
  return `Team_${shortName(captain)}`;
}

// Resolve a matchup side's crystallized-org name (if any) from the universe.
function orgNameOf(u: Universe, teamId: string | undefined): string | undefined {
  if (!teamId) return undefined;
  return u.teams?.find(t => t.id === teamId)?.name;
}

// Knockout rounds in a region's current bracket (0 if not in/at bracket stage).
function bracketTotalRounds(u: Universe, region: Region): number {
  const rp = u.playoffs?.regions.find(r => r.region === region);
  if (!rp) return 0;
  const r1 = rp.bracket.filter(m => m.round === 1).length;
  return r1 > 0 ? Math.round(Math.log2(r1 * 2)) : 0;
}

// Name a knockout round by its depth from the final.
function bracketRoundName(total: number, round: number): string {
  const depth = total - round;
  if (depth === 0) return "Final";
  if (depth === 1) return "Semifinals";
  if (depth === 2) return "Quarterfinals";
  if (depth === 3) return "Round of 16";
  return `Round ${round}`;
}

// Human label for a playoff matchup's round ("Swiss Round 2", "Semifinal", …).
function playoffRoundLabel(m: Matchup, u: Universe): string | null {
  if (!m.playoff || !m.region) return null;
  if (m.playoff.stage === "swiss") return `Swiss Round ${m.playoff.round}`;
  const total = bracketTotalRounds(u, m.region as Region);
  const depth = total - m.playoff.round; // 0 = final
  if (depth === 0) return "Grand Final";
  if (depth === 1) return "Semifinal";
  if (depth === 2) return "Quarterfinal";
  if (depth === 3) return "Round of 16";
  return `Bracket Round ${m.playoff.round}`;
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
  teamName?: string,   // crystallized org name; absent => pickup lobby (Team_Handle)
  onTeam?: (teamId: string) => void,
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

  // Friend-stacks in this lineup (a side can field more than one, e.g. a 2+2+1).
  // Each member gets a marker so you can see who queued together vs. who was
  // filled in around them.
  const idSet = new Set(ids);
  const sideStacks = (matchup.parties ?? []).filter(grp => grp.some(id => idSet.has(id)));
  const stackSizeOf = new Map<string, number>();
  for (const grp of sideStacks) for (const id of grp) if (idSet.has(id)) stackSizeOf.set(id, grp.length);
  const stackSizes = sideStacks.map(g => g.length).filter(n => n >= 2).sort((a, b) => b - a);

  const header = document.createElement("div");
  header.className = "umc-team-header";
  const stackBadge = stackSizes.length
    ? `<span class="umc-stack-badge" title="Queued together: ${stackSizes.join(" + ")}">🔗${stackSizes.join("+")}</span>`
    : "";
  // Crystallized orgs show their real name; pickup lobbies get a distinct
  // "Team_Handle" label built from their highest-elo player (the de facto IGL).
  const isOrg = !!teamName;
  const teamId = side === "CT" ? matchup.ctTeamId : matchup.tTeamId;
  const displayName = isOrg ? escapeHtml(teamName!) : `Team_${escapeHtml(shortName(captain))}`;
  const clickable = isOrg && teamId && onTeam;
  header.innerHTML =
    `<div class="umc-team-name${isOrg ? " org" : ""}${clickable ? " clickable" : ""}">${displayName}${stackBadge}</div>` +
    `<div class="umc-team-elo">Avg ${Math.round(avgElo)}</div>`;
  if (clickable) {
    const nameEl = header.querySelector(".umc-team-name") as HTMLElement;
    nameEl.title = "View team";
    nameEl.onclick = () => onTeam!(teamId!);
  }
  col.appendChild(header);

  for (const p of players) {
    const row = document.createElement("div");
    const stackSize = stackSizeOf.get(p.id);
    const inStack = stackSize !== undefined;
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
      row.title = inStack ? `Queued as a ${stackSize}-stack · view player` : "View player";
      const pid = p.id;
      row.onclick = () => onPick(pid);
    } else if (inStack) {
      row.title = `Queued as a ${stackSize}-stack`;
    }
    col.appendChild(row);
  }
  return col;
}

type SortKey = "name" | "country" | "age" | "role" | "elo" | "value" | "aim" | "mechanical" | "cognitive" | "mental" | "utility" | "leader" | "overall";

const COLUMNS: { key: SortKey; label: string; needsElo?: boolean; getter: (p: Player, elo: number) => number | string }[] = [
  { key: "name",       label: "Name",      getter: (p) => p.handle },
  { key: "country",    label: "From",      getter: (p) => p.country },
  { key: "age",        label: "Age",       getter: (p) => p.age },
  { key: "role",       label: "Role",      getter: (p) => p.role },
  { key: "elo",        label: "Elo", needsElo: true, getter: (_p, e) => Math.round(e) },
  { key: "value",      label: "Value",     getter: (p) => p.value ?? 0 },
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

// Persistent-team standings table. Sortable like the player tables; the name
// cell carries the team's region and a roster preview (player handles).
function teamsTable(teams: UniverseTeam[], byId: Map<string, Player>, onPick?: (teamId: string) => void): HTMLElement {
  const winPct = (t: UniverseTeam) => {
    const g = t.wins + t.losses;
    return g > 0 ? (t.wins / g) * 100 : 0;
  };
  const streakLabel = (t: UniverseTeam) =>
    t.streak === 0 ? "—" : (t.streak > 0 ? `W${t.streak}` : `L${-t.streak}`);

  const vcols: VCol<UniverseTeam>[] = [
    {
      label: "Team", thClass: "pt-col-name",
      cmp: (a, b) => a.name.localeCompare(b.name),
      fill: (t, td) => {
        const roster = t.playerIds.map(id => byId.get(id)?.handle ?? "?").join(", ");
        td.innerHTML =
          `<span class="pt-handle">${t.country ? `${flagEmoji(t.country)} ` : ""}${escapeHtml(t.name)}</span>` +
          `<span class="pt-realname">${escapeHtml(roster)}</span>`;
        td.className = "name-cell";
      },
    },
    {
      label: "Region",
      cmp: (a, b) => a.region.localeCompare(b.region),
      fill: (t, td) => { td.textContent = REGION_LABELS[t.region] ?? t.region; },
    },
    {
      label: "Elo",
      cmp: (a, b) => a.elo - b.elo,
      fill: (t, td) => { td.textContent = String(Math.round(t.elo)); },
    },
    {
      label: "W-L",
      cmp: (a, b) => (a.wins - a.losses) - (b.wins - b.losses),
      fill: (t, td) => { td.textContent = `${t.wins}-${t.losses}`; },
    },
    {
      label: "Win%",
      cmp: (a, b) => winPct(a) - winPct(b),
      fill: (t, td) => {
        const g = t.wins + t.losses;
        td.textContent = g > 0 ? `${winPct(t).toFixed(0)}%` : "—";
        if (g > 0) td.style.color = ratingColor(winPct(t));
      },
    },
    {
      label: "Rounds",
      cmp: (a, b) => (a.roundsWon - a.roundsLost) - (b.roundsWon - b.roundsLost),
      fill: (t, td) => { td.textContent = `${t.roundsWon}-${t.roundsLost}`; },
    },
    {
      label: "Streak",
      cmp: (a, b) => a.streak - b.streak,
      fill: (t, td) => {
        td.textContent = streakLabel(t);
        if (t.streak !== 0) td.style.color = t.streak > 0 ? "var(--good)" : "var(--bad)";
      },
    },
    {
      label: "Earnings",
      cmp: (a, b) => (a.earnings ?? 0) - (b.earnings ?? 0),
      fill: (t, td) => {
        td.textContent = (t.earnings ?? 0) > 0 ? formatMoney(t.earnings!) : "—";
        if ((t.earnings ?? 0) > 0) td.style.color = "var(--accent)";
      },
    },
    {
      label: "Founded",
      cmp: (a, b) => a.foundedDay - b.foundedDay,
      fill: (t, td) => { td.textContent = `Day ${t.foundedDay}`; },
    },
  ];
  // Sort by Elo descending initially (index 2).
  return virtualTable(teams, vcols, 2, -1, onPick ? t => onPick(t.id) : undefined);
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
      } else if (col.key === "value") {
        td.textContent = formatMoney(typeof v === "number" ? v : 0);
      } else {
        td.textContent = typeof v === "number" ? String(Math.round(v)) : String(v);
      }
      if (typeof v === "number" && col.key !== "elo" && col.key !== "age" && col.key !== "value") {
        td.style.color = ratingColor(v);
      }
    },
  }));

  const initialIdx = Math.max(0, cols.findIndex(c => c.key === (showElo ? "elo" : "overall")));
  return virtualTable(players, vcols, initialIdx, -1, onPick ? p => onPick(p.id) : undefined);
}

// Career stats table — aggregates each player's game log into a sortable
// per-player overview of their performance across the whole universe history.
function careerStatsTable(u: Universe, onPick?: (id: string) => void, mode: "all" | "event" = "all"): HTMLElement {
  // Source aggregate: lifetime (all games) or tournament-only.
  const src = mode === "event" ? (u.eventCareers ?? {}) : (u.careers ?? {});
  const statOf = (id: string) => src[id] ?? emptyCareer();
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
    const c = careerView(statOf(p.id));
    const clutchBuckets = careerClutchBuckets(statOf(p.id));
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
  }).filter(r => mode !== "event" || r.matches > 0); // event view: only players with event games

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
    const ctName = teamNameFor(playersOf(m.ctPlayerIds), u.elos, orgNameOf(u, m.ctTeamId));
    const tName = teamNameFor(playersOf(m.tPlayerIds), u.elos, orgNameOf(u, m.tTeamId));
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

// One spell a player spent on a tracked org, derived from the team's roster
// history. `leaveDay` is undefined while the player is still on the roster.
interface TeamStint { team: UniverseTeam; joinDay: number; leaveDay?: number; }

// Reconstruct a player's team history by walking every org's roster history and
// recording the contiguous spans the player appears in. Handles multiple stints
// on the same org (left and later re-signed). Most recent join first.
function playerTeamHistory(playerId: string, u: Universe): TeamStint[] {
  const stints: TeamStint[] = [];
  for (const team of u.teams ?? []) {
    const hist = team.rosterHistory
      ?? [{ day: team.foundedDay, playerIds: team.playerIds, note: "Founded" }];
    let inSquad = false;
    let joinDay = 0;
    for (const e of hist) {
      const present = e.playerIds.includes(playerId);
      if (present && !inSquad) { inSquad = true; joinDay = e.day; }
      else if (!present && inSquad) { inSquad = false; stints.push({ team, joinDay, leaveDay: e.day }); }
    }
    if (inSquad) stints.push({ team, joinDay });
  }
  stints.sort((a, b) => b.joinDay - a.joinDay);
  return stints;
}

// A player's per-year stat lines, most recent year first. Each line is a
// careerView over that year's bucket, so it renders with the same helpers as
// lifetime totals. Empty until the per-year breakdown has accrued.
interface YearStatLine { year: number; view: ReturnType<typeof careerView>; }
function playerYearLines(playerId: string, u: Universe): YearStatLine[] {
  const lines: YearStatLine[] = [];
  for (const [num, bucket] of Object.entries(u.yearStats ?? {})) {
    const c = bucket[playerId];
    if (!c || c.played === 0) continue;
    lines.push({ year: Number(num), view: careerView(c) });
  }
  lines.sort((a, b) => b.year - a.year);
  return lines;
}

function playerPage(
  p: Player, u: Universe,
  onReplay: (day: number, matchIdx: number, startAtRound?: number, gameIdx?: number) => void,
  onTeam?: (teamId: string) => void,
): HTMLElement {
  const root = document.createElement("div");
  root.className = "universe-player-page";
  const team = u.teams?.find(t => !t.disbandedDay && t.playerIds.includes(p.id));

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
        <div class="upp-meta">${escapeHtml(p.country)} · Age ${p.age} · ${escapeHtml(p.role)}` +
          (team ? ` · <span class="upp-team-link clickable" data-tid="${team.id}">${escapeHtml(team.name)}</span>` : "") +
          (p.retired ? ` · <span class="upp-retired">Retired${p.retiredDay ? ` (Day ${p.retiredDay})` : ""}</span>` : "") +
        `</div>
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
  if (team && onTeam) {
    const link = header.querySelector(".upp-team-link") as HTMLElement | null;
    if (link) { link.title = "View team"; link.onclick = () => onTeam(team.id); }
  }
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
    <div class="upp-dyn-item"><span>Market value</span><b>${formatMoney(p.value ?? 0)}</b></div>
    <div class="upp-dyn-item"><span>Form</span><b style="color:${ratingColor(p.morale)}" title="${Math.round(p.morale)}/100 morale">${formLabel(p.morale)}</b></div>
    <div class="upp-dyn-item"><span>Buy bank</span><b>$${p.money}</b></div>
    <div class="upp-dyn-item"><span>Values</span><b title="${p.ambition ?? 50}/100 ambition">${valuesLabel(p.ambition ?? 50)}</b></div>
    <div class="upp-dyn-item"><span>CT assignment</span><b>${p.ctAssignment}</b></div>
  `;
  root.appendChild(dyn);

  // ----- Team history (orgs played for, derived from roster history) -----
  const stints = playerTeamHistory(p.id, u);
  const thCard = document.createElement("div");
  thCard.className = "upp-teamhist";
  const thTitle = document.createElement("div");
  thTitle.className = "upp-stat-title";
  thTitle.textContent = `Team history (${stints.length})`;
  thCard.appendChild(thTitle);
  if (stints.length === 0) {
    const empty = document.createElement("div");
    empty.className = "upp-gamelog-empty";
    empty.textContent = "Never been part of a tracked team.";
    thCard.appendChild(empty);
  } else {
    for (const st of stints) {
      const row = document.createElement("div");
      row.className = "upp-th-row clickable-row";
      const current = st.leaveDay === undefined;
      const span = current ? `Day ${st.joinDay} – present` : `Day ${st.joinDay} – ${st.leaveDay}`;
      row.innerHTML =
        `<span class="upp-th-name">${st.team.country ? `${flagEmoji(st.team.country)} ` : ""}${escapeHtml(st.team.name)}</span>` +
        `<span class="upp-th-region">${REGION_LABELS[st.team.region] ?? st.team.region}</span>` +
        `<span class="upp-th-span">${span}${current ? ` <span class="upp-th-current">CURRENT</span>` : ""}</span>`;
      if (onTeam) { row.title = "View team"; row.onclick = () => onTeam(st.team.id); }
      thCard.appendChild(row);
    }
  }
  root.appendChild(thCard);

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

  // ----- Stats by year -----
  const yearLines = playerYearLines(p.id, u);
  const yearCard = document.createElement("div");
  yearCard.className = "upp-seasons";
  const yearTitle = document.createElement("div");
  yearTitle.className = "upp-stat-title";
  yearTitle.textContent = `Stats by year (${yearLines.length})`;
  yearCard.appendChild(yearTitle);
  if (yearLines.length === 0) {
    const empty = document.createElement("div");
    empty.className = "upp-gamelog-empty";
    empty.textContent = "No yearly stats recorded yet.";
    yearCard.appendChild(empty);
  } else {
    const table = document.createElement("table");
    table.className = "upp-season-table";
    table.innerHTML = `<thead><tr>
      <th>Year</th><th>Matches</th><th>W-L</th><th>Win %</th><th>Rounds</th>
      <th>K</th><th>D</th><th>A</th><th>ADR</th><th>Rating</th>
    </tr></thead>`;
    const tbody = document.createElement("tbody");
    for (const { year, view: v } of yearLines) {
      const tr = document.createElement("tr");
      const winPct = v.played > 0 ? Math.round((v.wins / v.played) * 100) : 0;
      const adrCell = v.adr !== null ? v.adr.toFixed(1) : "—";
      const ratingCell = v.rating === null
        ? `<td class="upp-gl-stat upp-gl-missing">—</td>`
        : `<td class="upp-gl-stat upp-gl-rating" style="color:${v.rating >= 1 ? "var(--good)" : "var(--bad)"}">${v.rating.toFixed(2)}</td>`;
      tr.innerHTML = `
        <td><b>Y${year}</b></td>
        <td class="upp-gl-stat">${v.played}</td>
        <td>${v.wins}-${v.losses}</td>
        <td class="upp-gl-stat">${winPct}%</td>
        <td class="upp-gl-stat">${v.roundsWon}-${v.roundsLost}</td>
        ${v.hasStats ? `<td class="upp-gl-stat">${v.kills}</td><td class="upp-gl-stat">${v.deaths}</td><td class="upp-gl-stat">${v.assists}</td><td class="upp-gl-stat">${adrCell}</td>${ratingCell}`
                     : `<td class="upp-gl-stat upp-gl-missing">—</td><td class="upp-gl-stat upp-gl-missing">—</td><td class="upp-gl-stat upp-gl-missing">—</td><td class="upp-gl-stat upp-gl-missing">—</td><td class="upp-gl-stat upp-gl-missing">—</td>`}
      `;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    yearCard.appendChild(table);
  }
  root.appendChild(yearCard);

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
      const oppLabel = orgNameOf(u, g.opponentTeamId)
        ?? (oppCaptain ? `Team_${shortName(oppCaptain)}` : "—");
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
  opponentTeamId?: string;   // set when the opponent was a crystallized org
  // Only successful clutches end up here — used for the 1vX/round chips.
  // `bucket` is the number of enemies faced (matches the career table); kills
  // is how many the clutcher actually got.
  clutches: { bucket: number; kills: number; round: number | undefined }[];
  // Full attempt list (won + lost) for opportunity tracking.
  clutchAttempts: { bucket: number; won: boolean; round: number | undefined }[];
  stats: import("./types.ts").PlayerMatchStats | null;
}

interface TeamPageHandlers {
  onPlayer: (playerId: string) => void;
  onReplay: (day: number, matchIdx: number, startAtRound?: number, gameIdx?: number) => void;
}

// Org page: identity + lifetime stats, roster, trophy cabinet, and recent match
// history (with replay links), mirroring the player page's shape.
function teamPage(team: UniverseTeam, u: Universe, h: TeamPageHandlers): HTMLElement {
  const root = document.createElement("div");
  root.className = "universe-team-page";
  const playerById = new Map(u.players.map(p => [p.id, p] as const));
  const games = team.wins + team.losses;
  const winPct = games > 0 ? Math.round((team.wins / games) * 100) : 0;
  const diff = team.roundsWon - team.roundsLost;
  const streak = team.streak === 0 ? "—" : (team.streak > 0 ? `W${team.streak}` : `L${-team.streak}`);
  const titles = (u.titles ?? []).filter(t => t.championTeamId === team.id);

  // ----- Header -----
  const header = document.createElement("div");
  header.className = "utm-header";
  header.innerHTML = `
    <div class="utm-identity">
      <div class="utm-crest">${titles.length > 0 ? "🏆" : "★"}</div>
      <div>
        <div class="utm-name">${team.country ? `${flagEmoji(team.country)} ` : ""}${escapeHtml(team.name)}</div>
        <div class="utm-meta">${REGION_LABELS[team.region] ?? team.region} · founded day ${team.foundedDay}` +
          `${titles.length > 0 ? ` · ${titles.length} title${titles.length === 1 ? "" : "s"}` : ""}` +
          `${team.disbandedDay ? ` · <span class="upp-retired">Disbanded (Day ${team.disbandedDay})</span>` : ""}</div>
      </div>
    </div>
    <div class="utm-headline-stats">
      <div class="utm-hl"><div class="utm-hl-label">Elo</div><div class="utm-hl-val">${Math.round(team.elo)}</div></div>
      <div class="utm-hl"><div class="utm-hl-label">Record</div><div class="utm-hl-val">${team.wins}-${team.losses}</div></div>
      <div class="utm-hl"><div class="utm-hl-label">Win %</div><div class="utm-hl-val">${winPct}%</div></div>
      <div class="utm-hl"><div class="utm-hl-label">Round diff</div><div class="utm-hl-val">${diff >= 0 ? "+" : ""}${diff}</div></div>
      <div class="utm-hl"><div class="utm-hl-label">Streak</div><div class="utm-hl-val" style="color:${team.streak > 0 ? "var(--good)" : team.streak < 0 ? "var(--bad)" : "inherit"}">${streak}</div></div>
      <div class="utm-hl"><div class="utm-hl-label">Ranking pts</div><div class="utm-hl-val">${Math.round(team.rankingPoints ?? 0)}</div></div>
      <div class="utm-hl"><div class="utm-hl-label">Balance</div><div class="utm-hl-val" style="color:${(team.balance ?? 0) < 0 ? "var(--bad)" : "var(--good)"}">${formatMoney(team.balance ?? 0)}</div></div>
      <div class="utm-hl"><div class="utm-hl-label">Wage bill</div><div class="utm-hl-val">${formatMoney(wageBill(team, playerById))}/cyc</div></div>
      <div class="utm-hl"><div class="utm-hl-label">Earnings</div><div class="utm-hl-val">${formatMoney(team.earnings ?? 0)}</div></div>
    </div>`;
  root.appendChild(header);

  // ----- Roster -----
  const rosterSection = document.createElement("div");
  rosterSection.className = "utm-section";
  rosterSection.innerHTML = `<h3 class="utm-section-h">Roster</h3>`;
  const roster = document.createElement("div");
  roster.className = "utm-roster";
  for (const id of team.playerIds) {
    const p = playerById.get(id);
    const row = document.createElement("div");
    row.className = "utm-roster-row clickable-row";
    if (p) {
      row.innerHTML =
        `<span class="utm-rr-flag">${flagEmoji(p.country)}</span>` +
        `<span class="utm-rr-handle">${escapeHtml(p.handle)}</span>` +
        `<span class="utm-rr-name">${escapeHtml(p.name)}</span>` +
        `<span class="utm-rr-role">${escapeHtml(p.role)}</span>` +
        `<span class="utm-rr-elo">${Math.round(u.elos[id] ?? STARTING_ELO)}</span>`;
      row.onclick = () => h.onPlayer(id);
    } else {
      row.innerHTML = `<span class="utm-rr-handle">${escapeHtml(id)}</span><span class="utm-rr-name">(former member)</span>`;
    }
    roster.appendChild(row);
  }
  rosterSection.appendChild(roster);
  root.appendChild(rosterSection);

  // ----- Trophy cabinet -----
  if (titles.length > 0) {
    const sec = document.createElement("div");
    sec.className = "utm-section";
    sec.innerHTML = `<h3 class="utm-section-h">Trophy cabinet</h3>`;
    const list = document.createElement("div");
    list.className = "utm-trophies";
    for (const t of [...titles].sort((a, b) => b.eventId - a.eventId)) {
      const chip = document.createElement("div");
      chip.className = "utm-trophy";
      chip.innerHTML = `🏆 <b>${escapeHtml(t.name)}</b> <span>Day ${t.day}</span>`;
      list.appendChild(chip);
    }
    sec.appendChild(list);
    root.appendChild(sec);
  }

  // ----- Roster history (founding lineup + later changes) -----
  const history = team.rosterHistory
    ?? [{ day: team.foundedDay, playerIds: team.playerIds, note: "Founded" }];
  if (history.length > 0) {
    const rh = document.createElement("div");
    rh.className = "utm-section";
    rh.innerHTML = `<h3 class="utm-section-h">Roster history</h3>`;
    const list = document.createElement("div");
    list.className = "utm-roster-history";
    for (const e of [...history].reverse()) {
      const handles = e.playerIds.map(id => playerById.get(id)?.handle ?? "?").join(", ");
      const row = document.createElement("div");
      row.className = "utm-rh-row";
      row.innerHTML =
        `<span class="utm-rh-day">Day ${e.day}</span>` +
        `<span class="utm-rh-note">${escapeHtml(e.note)}</span>` +
        `<span class="utm-rh-roster">${escapeHtml(handles)}</span>`;
      list.appendChild(row);
    }
    rh.appendChild(list);
    root.appendChild(rh);
  }

  // ----- Match history (recent window + today) -----
  const sec = document.createElement("div");
  sec.className = "utm-section";
  sec.innerHTML = `<h3 class="utm-section-h">Match history</h3>`;
  const days: { day: number; matchups: Matchup[] }[] = [...u.history];
  if (u.pendingDay) days.push({ day: u.pendingDay.day, matchups: u.pendingDay.matchups });
  const rows: HTMLElement[] = [];
  for (let d = days.length - 1; d >= 0 && rows.length < 40; d--) {
    const day = days[d];
    day.matchups.forEach((m, idx) => {
      if (m.status !== "completed") return;
      const onCt = m.ctTeamId === team.id, onT = m.tTeamId === team.id;
      if (!onCt && !onT) return;
      const side: "CT" | "T" = onCt ? "CT" : "T";
      const oppId = onCt ? m.tTeamId : m.ctTeamId;
      const oppIds = onCt ? m.tPlayerIds : m.ctPlayerIds;
      const oppName = orgNameOf(u, oppId)
        ?? teamNameFor(oppIds.map(i => playerById.get(i)).filter((p): p is Player => !!p), u.elos);
      const own = onCt ? m.ctScore ?? 0 : m.tScore ?? 0;
      const opp = onCt ? m.tScore ?? 0 : m.ctScore ?? 0;
      const won = m.winnerSide === side;
      const poLabel = m.playoff ? playoffRoundLabel(m, u) : null;
      const isSeries = !!m.games?.length;

      const row = document.createElement("div");
      row.className = "utm-mh-row";
      row.innerHTML =
        `<span class="utm-mh-day">D${day.day}</span>` +
        `<span class="utm-mh-res ${won ? "win" : "loss"}">${won ? "W" : "L"}</span>` +
        `<span class="utm-mh-score">${own}-${opp}</span>` +
        `<span class="utm-mh-vs">vs</span>` +
        `<span class="utm-mh-opp">${escapeHtml(oppName)}</span>` +
        (poLabel ? `<span class="utm-mh-tag">${poLabel}</span>` : (isSeries ? `<span class="utm-mh-tag">Bo${m.bestOf}</span>` : ""));
      const actions = document.createElement("span");
      actions.className = "utm-mh-actions";
      if (isSeries && m.games?.length) {
        m.games.forEach((_g, gi) => {
          actions.appendChild(btn(`G${gi + 1}`, "tiny", () => h.onReplay(day.day, idx, undefined, gi)));
        });
      } else if (m.seed !== undefined) {
        actions.appendChild(btn("Replay", "tiny", () => h.onReplay(day.day, idx)));
      }
      row.appendChild(actions);
      rows.push(row);
    });
  }
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "utm-mh-empty";
    empty.textContent = "No recent matches in the history window.";
    sec.appendChild(empty);
  } else {
    const list = document.createElement("div");
    list.className = "utm-mh";
    rows.forEach(r => list.appendChild(r));
    sec.appendChild(list);
  }
  root.appendChild(sec);

  return root;
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

// Backfill the event-only career aggregate from the retained history window
// (playoff matchups only). Lifetime event totals from before the window can't be
// reconstructed — going forward every tournament game accrues here at fold time.
function rebuildEventCareers(u: Universe): void {
  const ev: Record<string, CareerStats> = {};
  for (const day of u.history) {
    for (const m of day.matchups) if (m.playoff) recordMatchupCareers(ev, m);
  }
  for (const m of u.pendingDay?.matchups ?? []) if (m.playoff) recordMatchupCareers(ev, m);
  u.eventCareers = ev;
}

// Backfill `Universe.yearStats` from history. The calendar year is a pure
// function of the day, so every retained day (and the pending day) maps to a
// definite year — older years simply aren't in the history window. Going forward
// every folded match accrues into the right bucket.
function rebuildYearStats(u: Universe): void {
  const yearStats: Record<number, Record<string, CareerStats>> = {};
  const bucketFor = (day: number) => (yearStats[yearOf(day)] ??= {});
  for (const day of u.history) {
    const bucket = bucketFor(day.day);
    for (const m of day.matchups) recordMatchupCareers(bucket, m);
  }
  for (const m of u.pendingDay?.matchups ?? []) recordMatchupCareers(bucketFor(u.pendingDay!.day), m);
  u.yearStats = yearStats;
  trimYearStats(u);
}

// Drop per-player breakdowns for years older than the retention window, keeping
// core storage bounded over a long campaign. Lifetime `careers` still hold those
// games, so nothing about lifetime totals changes.
function trimYearStats(u: Universe): void {
  if (!u.yearStats) return;
  const nums = Object.keys(u.yearStats).map(Number).sort((a, b) => a - b);
  for (const n of nums.slice(0, Math.max(0, nums.length - YEAR_STATS_KEEP))) {
    delete u.yearStats[n];
  }
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
      const opponentTeamId = onCt ? m.tTeamId : m.ctTeamId;
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
          opponentIds, opponentTeamId,
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
