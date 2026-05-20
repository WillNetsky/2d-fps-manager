import type { Player } from "../domain/types.ts";
import { makeMap, makePlayer, setSeed } from "../domain/factory.ts";
import { flagEmoji } from "../domain/countries.ts";
import { loadCustomMap } from "../editor/mapEditor.ts";
import { applyMatchElo } from "./elo.ts";
import { buildTeam, simulateMatchInstant } from "./matchSim.ts";
import { observeMatch } from "./observeMatch.ts";
import {
  deleteUniverse, listUniverses, loadUniverse, newUniverseId, saveUniverse,
} from "./storage.ts";
import {
  MATCHUPS_PER_DAY, PLAYER_COUNT, STARTING_ELO, TEAM_SIZE,
  type Matchup, type Universe,
} from "./types.ts";

type Screen = "menu" | "players" | "matchups" | "match" | "standings" | "player";

export class UniverseMode {
  private root: HTMLElement;
  private universe: Universe | null = null;
  private screen: Screen = "menu";
  private activeMatchupId: string | null = null;
  private activePlayerId: string | null = null;
  // Screen to return to from the player page (set when navigating in).
  private playerReturnScreen: Screen = "standings";

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

    // Top bar (visible on every screen except the match canvas).
    if (this.screen !== "match") {
      main.appendChild(this.topBar());
    }

    const body = document.createElement("div");
    body.className = "universe-body";
    main.appendChild(body);

    switch (this.screen) {
      case "menu":      this.renderMenu(body); break;
      case "players":   this.renderPlayers(body); break;
      case "matchups":  this.renderMatchups(body); break;
      case "match":     this.renderMatch(body); break;
      case "standings": this.renderStandings(body); break;
      case "player":    this.renderPlayer(body); break;
    }
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
      const cont = btn("Continue to matchups →", "primary", () => this.startDay());
      right.appendChild(cont);
    } else if (this.screen === "matchups" && this.universe) {
      const allDone = this.universe.pendingDay?.matchups.every(m => m.status === "completed");
      const label = allDone ? "View standings →" : "Sim all remaining + continue →";
      const cont = btn(label, "primary", () => this.continueFromMatchups());
      right.appendChild(cont);
    } else if (this.screen === "standings" && this.universe) {
      right.appendChild(btn("Sim X days", "", () => this.simManyDays()));
      right.appendChild(btn("Next day →", "primary", () => this.nextDay()));
    } else if (this.screen === "players" && this.universe && this.universe.history.length === 0) {
      // Allow skipping ahead from the initial roster screen too.
      right.insertBefore(btn("Sim X days", "", () => this.simManyDays()), right.firstChild);
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
    };
    this.persist();
    this.screen = "players";
    this.render();
  }

  private loadUniverseById(id: string) {
    const u = loadUniverse(id);
    if (!u) return;
    this.universe = u;
    // Resume on the relevant screen: pending matchups → matchups, otherwise
    // standings if any days have been played, else the initial roster view.
    if (u.pendingDay) this.screen = "matchups";
    else if (u.history.length > 0) this.screen = "standings";
    else this.screen = "players";
    this.render();
  }

  private persist() {
    if (this.universe) saveUniverse(this.universe);
  }

  // ---- Players (roster) screen ----

  private renderPlayers(body: HTMLElement) {
    if (!this.universe) return;
    const u = this.universe;
    const table = playerTable(u.players, u.elos, /* showElo */ false, id => this.openPlayer(id));
    body.appendChild(table);
  }

  // ---- Matchups screen ----

  private startDay() {
    if (!this.universe) return;
    if (!this.universe.pendingDay) {
      this.universe.pendingDay = {
        day: this.universe.day,
        matchups: generateMatchups(this.universe.players),
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

    const grid = document.createElement("div");
    grid.className = "universe-matchup-grid";

    day.matchups.forEach((m, i) => {
      const card = document.createElement("div");
      card.className = "universe-matchup-card " + (m.status === "completed" ? "completed" : "");

      const header = document.createElement("div");
      header.className = "umc-header";
      header.textContent = `Match ${i + 1}`;
      card.appendChild(header);

      const teams = document.createElement("div");
      teams.className = "umc-teams";
      teams.appendChild(rosterColumn("CT", m.ctPlayerIds, playerById, elos));
      const vs = document.createElement("div");
      vs.className = "umc-vs";
      if (m.status === "completed") {
        const ctWon = m.winnerSide === "CT";
        vs.innerHTML = `<div class="umc-score"><span class="ct${ctWon ? " winner" : ""}">${m.ctScore}</span><span>:</span><span class="t${ctWon ? "" : " winner"}">${m.tScore}</span></div>`;
      } else {
        vs.textContent = "vs";
      }
      teams.appendChild(vs);
      teams.appendChild(rosterColumn("T", m.tPlayerIds, playerById, elos));
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
    const map = loadCustomMap() ?? makeMap();
    const ctPlayers = m.ctPlayerIds.map(id => u.players.find(p => p.id === id)!).filter(Boolean);
    const tPlayers  = m.tPlayerIds.map (id => u.players.find(p => p.id === id)!).filter(Boolean);
    const ctTeam = buildTeam("ct", "CT-side", ctPlayers, "CT");
    const tTeam  = buildTeam("t",  "T-side",  tPlayers,  "T");
    const result = simulateMatchInstant(ctTeam, tTeam, map);
    m.status = "completed";
    m.ctScore = result.ctScore;
    m.tScore  = result.tScore;
    m.winnerSide = result.winnerSide;
    m.clutches = result.clutches;
    m.playerStats = result.playerStats;
    const winners = result.winnerSide === "CT" ? m.ctPlayerIds : m.tPlayerIds;
    const losers  = result.winnerSide === "CT" ? m.tPlayerIds  : m.ctPlayerIds;
    applyMatchElo(winners, losers, u.elos);
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
    const map = loadCustomMap() ?? makeMap();
    const ctPlayers = m.ctPlayerIds.map(id => u.players.find(p => p.id === id)!).filter(Boolean);
    const tPlayers  = m.tPlayerIds.map (id => u.players.find(p => p.id === id)!).filter(Boolean);

    await observeMatch(body, {
      ctName: "CT-side",
      tName: "T-side",
      ctPlayers, tPlayers, map,
      onDone: (result) => {
        m.status = "completed";
        m.ctScore = result.ctScore;
        m.tScore  = result.tScore;
        m.winnerSide = result.winnerSide;
        m.clutches = result.clutches;
    m.playerStats = result.playerStats;
        const winners = result.winnerSide === "CT" ? m.ctPlayerIds : m.tPlayerIds;
        const losers  = result.winnerSide === "CT" ? m.tPlayerIds  : m.ctPlayerIds;
        applyMatchElo(winners, losers, u.elos);
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

  private continueFromMatchups() {
    if (!this.universe || !this.universe.pendingDay) return;
    // Auto-sim any remaining pending matchups.
    for (const m of this.universe.pendingDay.matchups) {
      if (m.status !== "completed") this.runInstantSim(m);
    }
    // Roll completed matchups into history and clear pending.
    this.universe.history.push({
      day: this.universe.pendingDay.day,
      matchups: this.universe.pendingDay.matchups,
    });
    this.universe.pendingDay = null;
    this.persist();
    this.screen = "standings";
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

    for (let i = 0; i < capped; i++) {
      if (!u.pendingDay) {
        u.pendingDay = { day: u.day, matchups: generateMatchups(u.players) };
      }
      for (const m of u.pendingDay.matchups) {
        if (m.status !== "completed") this.runInstantSim(m);
      }
      u.history.push({ day: u.pendingDay.day, matchups: u.pendingDay.matchups });
      u.pendingDay = null;
      u.day++;

      // Yield to the browser every few days so the progress bar updates and
      // the page stays responsive. Tuned so even 1000 days feels live.
      if (i % 3 === 0 || i === capped - 1) {
        overlay.update(i + 1);
        await nextFrame();
      }
    }

    this.persist();
    overlay.el.remove();
    this.screen = "standings";
    this.render();
  }

  private nextDay() {
    if (!this.universe) return;
    this.universe.day++;
    this.persist();
    this.startDay();
  }

  // ---- Standings screen ----

  private renderStandings(body: HTMLElement) {
    if (!this.universe) return;
    const u = this.universe;
    const table = playerTable(u.players, u.elos, /* showElo */ true, id => this.openPlayer(id));
    body.appendChild(table);
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
    body.appendChild(playerPage(p, u));
  }
}

// ---- Matchup generation (random for MVP — Swiss + chemistry come later) ----

function generateMatchups(players: Player[]): Matchup[] {
  const shuffled = [...players];
  // Fisher-Yates
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const matchups: Matchup[] = [];
  for (let i = 0; i < MATCHUPS_PER_DAY; i++) {
    const block = shuffled.slice(i * TEAM_SIZE * 2, (i + 1) * TEAM_SIZE * 2);
    matchups.push({
      id: `m${i}`,
      ctPlayerIds: block.slice(0, TEAM_SIZE).map(p => p.id),
      tPlayerIds:  block.slice(TEAM_SIZE, TEAM_SIZE * 2).map(p => p.id),
      status: "pending",
    });
  }
  return matchups;
}

// ---- UI helpers ----

function rosterColumn(
  side: "CT" | "T",
  ids: string[],
  byId: Map<string, Player>,
  elos: Record<string, number>,
): HTMLElement {
  const col = document.createElement("div");
  col.className = `umc-roster ${side === "CT" ? "ct" : "t"}`;

  // Faceit-style team naming: the highest-elo player names the team. Tie-break
  // deterministically by player id so the display stays stable across renders.
  const players = ids.map(id => byId.get(id)).filter((p): p is Player => !!p);
  const captain = [...players].sort((a, b) => {
    const da = elos[a.id] ?? STARTING_ELO;
    const db = elos[b.id] ?? STARTING_ELO;
    if (db !== da) return db - da;
    return a.id.localeCompare(b.id);
  })[0];
  const avgElo = players.length
    ? players.reduce((s, p) => s + (elos[p.id] ?? STARTING_ELO), 0) / players.length
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
    row.innerHTML = `<span class="umc-flag">${flagEmoji(p.country)}</span><span class="umc-name">${escapeHtml(shortName(p))}</span><span class="umc-elo">${Math.round(elos[p.id] ?? STARTING_ELO)}</span>`;
    col.appendChild(row);
  }
  return col;
}

type SortKey = "name" | "country" | "age" | "role" | "elo" | "aim" | "mechanical" | "cognitive" | "mental" | "utility" | "leader" | "overall";

const COLUMNS: { key: SortKey; label: string; needsElo?: boolean; getter: (p: Player, elo: number) => number | string }[] = [
  { key: "name",       label: "Name",      getter: (p) => p.name },
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
        } else {
          td.textContent = typeof v === "number" ? String(Math.round(v)) : String(v);
        }
        if (col.key === "name") td.className = "name-cell";
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

function shortName(p: Player): string {
  const m = p.name.match(/"([^"]+)"/);
  return m ? m[1] : p.name.split(" ")[0];
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

function playerPage(p: Player, u: Universe): HTMLElement {
  const root = document.createElement("div");
  root.className = "universe-player-page";

  const elo = Math.round(u.elos[p.id] ?? STARTING_ELO);
  const log = buildGameLog(p.id, u);
  const career = summarizeCareer(log);
  const clutchBuckets = summarizeClutches(log);
  const totalClutches = clutchBuckets.reduce((s, b) => s + b.count, 0);

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

  // ----- Clutches -----
  const clutchCard = document.createElement("div");
  clutchCard.className = "upp-clutches";
  const clutchTitle = document.createElement("div");
  clutchTitle.className = "upp-stat-title";
  clutchTitle.textContent = `Clutches (${totalClutches})`;
  clutchCard.appendChild(clutchTitle);
  if (totalClutches === 0) {
    const empty = document.createElement("div");
    empty.className = "upp-gamelog-empty";
    empty.textContent = "No clutches yet.";
    clutchCard.appendChild(empty);
  } else {
    const row = document.createElement("div");
    row.className = "upp-clutch-row";
    for (const b of clutchBuckets) {
      const cell = document.createElement("div");
      cell.className = "upp-clutch-cell";
      cell.innerHTML = `<div class="upp-clutch-label">${escapeHtml(b.label)}</div><div class="upp-clutch-val">${b.count}</div>`;
      row.appendChild(cell);
    }
    clutchCard.appendChild(row);
  }
  root.appendChild(clutchCard);

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
      const clutchLabel = g.clutches.length
        ? g.clutches.map(k => `1v${k}`).join(", ")
        : "";
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
        <td class="upp-gl-clutch">${clutchLabel}</td>
      `;
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
  side: "CT" | "T";
  ownScore: number;
  oppScore: number;
  won: boolean;
  opponentIds: string[];
  clutches: number[];        // per-clutch kill counts (e.g. [2, 3] = 1v2 + 1v3)
  stats: import("./types.ts").PlayerMatchStats | null;
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
    for (const m of day.matchups) {
      if (m.status !== "completed" || !m.winnerSide
          || m.ctScore === undefined || m.tScore === undefined) continue;
      const onCt = m.ctPlayerIds.includes(playerId);
      const onT  = m.tPlayerIds.includes(playerId);
      if (!onCt && !onT) continue;
      const side: "CT" | "T" = onCt ? "CT" : "T";
      const ownScore = onCt ? m.ctScore : m.tScore;
      const oppScore = onCt ? m.tScore : m.ctScore;
      const clutches = (m.clutches ?? [])
        .filter(c => c.playerId === playerId)
        .map(c => c.kills);
      out.push({
        day: day.day,
        side,
        ownScore,
        oppScore,
        won: (onCt && m.winnerSide === "CT") || (onT && m.winnerSide === "T"),
        opponentIds: onCt ? m.tPlayerIds : m.ctPlayerIds,
        clutches,
        stats: m.playerStats?.[playerId] ?? null,
      });
    }
  }
  // Most recent first.
  out.sort((a, b) => b.day - a.day);
  return out;
}

// Group clutches into 1v1..1v5 buckets by the number of kills the player got
// while last alive. Any clutch with 0 kills (e.g. T-side clutch where the bomb
// detonates) is bucketed as 1v0 only if present.
function summarizeClutches(log: GameLogEntry[]): { label: string; count: number }[] {
  const counts = new Map<number, number>();
  for (const g of log) {
    for (const k of g.clutches) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const keys = [...counts.keys()].sort((a, b) => a - b);
  return keys.map(k => ({ label: `1v${k}`, count: counts.get(k)! }));
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
