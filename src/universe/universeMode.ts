import type { Player } from "../domain/types.ts";
import { makeMap, makePlayer, setSeed } from "../domain/factory.ts";
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

type Screen = "menu" | "players" | "matchups" | "match" | "standings";

export class UniverseMode {
  private root: HTMLElement;
  private universe: Universe | null = null;
  private screen: Screen = "menu";
  private activeMatchupId: string | null = null;

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
    }
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
      right.appendChild(btn("Next day →", "primary", () => this.nextDay()));
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
    const table = playerTable(u.players, u.elos, /* showElo */ false);
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
        vs.innerHTML = `<div class="umc-score"><span class="ct">${m.ctScore}</span><span>:</span><span class="t">${m.tScore}</span></div><div class="umc-winner">${m.winnerSide === "CT" ? "CT wins" : "T wins"}</div>`;
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
    const table = playerTable(u.players, u.elos, /* showElo */ true);
    body.appendChild(table);
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
  for (const id of ids) {
    const p = byId.get(id);
    if (!p) continue;
    const row = document.createElement("div");
    row.className = "umc-roster-row";
    row.innerHTML = `<span class="umc-name">${escapeHtml(shortName(p))}</span><span class="umc-elo">${Math.round(elos[id] ?? STARTING_ELO)}</span>`;
    col.appendChild(row);
  }
  return col;
}

type SortKey = "name" | "role" | "elo" | "aim" | "mechanical" | "cognitive" | "mental" | "utility" | "leader" | "overall";

const COLUMNS: { key: SortKey; label: string; needsElo?: boolean; getter: (p: Player, elo: number) => number | string }[] = [
  { key: "name",       label: "Name",      getter: (p) => p.name },
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

function playerTable(players: Player[], elos: Record<string, number>, showElo: boolean): HTMLElement {
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
      for (const col of COLUMNS) {
        if (col.needsElo && !showElo) continue;
        const td = document.createElement("td");
        const v = col.getter(p, elos[p.id] ?? STARTING_ELO);
        td.textContent = typeof v === "number" ? String(Math.round(v)) : String(v);
        if (col.key === "name") td.className = "name-cell";
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

function btn(label: string, cls: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.className = `universe-btn ${cls}`.trim();
  b.onclick = onClick;
  return b;
}
