import type { GameMap, RoundOutcome, Side } from "../domain/types.ts";
import { makeMap, makeTeam, neutralizeTeamStats, setSeed, STARTING_PER_PLAYER } from "../domain/factory.ts";
import { loadCustomMap, loadSavedMapsAll } from "../editor/mapEditor.ts";
import { RoundSim } from "../sim/round.ts";
import { applyRoundReward } from "../sim/economy.ts";

interface RunStats {
  rounds: number;
  ctWins: number;
  tWins: number;
  outcomes: Record<RoundOutcome, number>;
  totalDurationMs: number;
  ctKills: number;
  tKills: number;
  plants: number;
  defuses: number;
  detonations: number;
  ctElims: number;
  tElims: number;
  timeouts: number;
}

function emptyStats(): RunStats {
  return {
    rounds: 0, ctWins: 0, tWins: 0,
    outcomes: {
      "ct-elim": 0, "t-elim": 0,
      "bomb-detonated": 0, "bomb-defused": 0, "time-expired": 0,
    },
    totalDurationMs: 0,
    ctKills: 0, tKills: 0,
    plants: 0, defuses: 0, detonations: 0,
    ctElims: 0, tElims: 0, timeouts: 0,
  };
}

export class BalanceMode {
  private root: HTMLElement;
  private mapSelect!: HTMLSelectElement;
  private roundsInput!: HTMLInputElement;
  private neutralToggle!: HTMLInputElement;
  private resetEconToggle!: HTMLInputElement;
  private runBtn!: HTMLButtonElement;
  private status!: HTMLElement;
  private resultsEl!: HTMLElement;

  constructor(parent: HTMLElement) {
    this.root = parent;
    parent.innerHTML = "";
    this.buildUI();
  }

  private buildUI() {
    this.root.className = "editor-app";

    const sidebar = document.createElement("div");
    sidebar.className = "editor-sidebar";
    sidebar.innerHTML = `<h2>Balance Test</h2>`;

    // Map selection
    const mapLabel = document.createElement("div");
    mapLabel.className = "editor-group";
    mapLabel.textContent = "Map";
    sidebar.appendChild(mapLabel);
    this.mapSelect = document.createElement("select");
    this.mapSelect.className = "balance-select";
    const savedMaps = loadSavedMapsAll();
    const opts = [{ key: "__default__", label: "Default (built-in)" }];
    if (localStorage.getItem("2d-fps-manager-custom-map")) {
      opts.push({ key: "__active__", label: "Active custom map" });
    }
    for (const name of Object.keys(savedMaps).sort()) opts.push({ key: name, label: name });
    for (const o of opts) {
      const opt = document.createElement("option");
      opt.value = o.key;
      opt.textContent = o.label;
      this.mapSelect.appendChild(opt);
    }
    sidebar.appendChild(this.mapSelect);

    // Rounds
    const roundsLabel = document.createElement("div");
    roundsLabel.className = "editor-group";
    roundsLabel.textContent = "Rounds";
    sidebar.appendChild(roundsLabel);
    this.roundsInput = document.createElement("input");
    this.roundsInput.type = "number";
    this.roundsInput.min = "1";
    this.roundsInput.max = "10000";
    this.roundsInput.value = "100";
    this.roundsInput.className = "balance-input";
    sidebar.appendChild(this.roundsInput);

    // Toggles
    const togGroup = document.createElement("div");
    togGroup.className = "editor-group";
    togGroup.textContent = "Options";
    sidebar.appendChild(togGroup);

    const neutralRow = document.createElement("label");
    neutralRow.className = "balance-toggle";
    this.neutralToggle = document.createElement("input");
    this.neutralToggle.type = "checkbox";
    this.neutralToggle.checked = true;
    neutralRow.append(this.neutralToggle, " Neutralize stats (60 across the board)");
    sidebar.appendChild(neutralRow);

    const econRow = document.createElement("label");
    econRow.className = "balance-toggle";
    this.resetEconToggle = document.createElement("input");
    this.resetEconToggle.type = "checkbox";
    this.resetEconToggle.checked = false;
    econRow.append(this.resetEconToggle, " Reset money each round (independent rounds)");
    sidebar.appendChild(econRow);

    // Run
    this.runBtn = document.createElement("button");
    this.runBtn.textContent = "Run";
    this.runBtn.className = "primary";
    this.runBtn.onclick = () => this.run();
    sidebar.appendChild(this.runBtn);

    const back = document.createElement("button");
    back.textContent = "Back to game";
    back.onclick = () => { window.location.hash = ""; window.location.reload(); };
    sidebar.appendChild(back);

    this.status = document.createElement("div");
    this.status.className = "balance-status";
    sidebar.appendChild(this.status);

    this.root.appendChild(sidebar);

    // Results
    const main = document.createElement("div");
    main.className = "editor-canvas-wrap";
    main.style.padding = "20px";
    main.style.overflow = "auto";
    this.resultsEl = document.createElement("div");
    this.resultsEl.className = "balance-results";
    this.resultsEl.innerHTML = `<p style="color: var(--muted);">Configure on the left, hit <strong>Run</strong>.</p>`;
    main.appendChild(this.resultsEl);
    this.root.appendChild(main);
  }

  private pickMap(): GameMap {
    const key = this.mapSelect.value;
    if (key === "__default__") return makeMap();
    if (key === "__active__") return loadCustomMap() ?? makeMap();
    const saved = loadSavedMapsAll()[key];
    return saved ? JSON.parse(JSON.stringify(saved)) as GameMap : makeMap();
  }

  private async run() {
    const rounds = Math.max(1, Math.min(10000, parseInt(this.roundsInput.value, 10) || 100));
    this.runBtn.disabled = true;
    this.status.textContent = "Running…";
    this.resultsEl.innerHTML = "";

    // Defer so the "Running…" paint happens before the blocking loop.
    await new Promise(r => setTimeout(r, 50));

    const stats = this.simulate(rounds);

    this.status.textContent = `Done — ${rounds} rounds`;
    this.renderResults(stats);
    this.runBtn.disabled = false;
  }

  private simulate(rounds: number): RunStats {
    setSeed(Date.now());
    const map = this.pickMap();
    const home = makeTeam("home", "Home", "CT");
    const away = makeTeam("away", "Away", "T");

    if (this.neutralToggle.checked) {
      neutralizeTeamStats(home, 60);
      neutralizeTeamStats(away, 60);
    }

    // Default loadouts
    for (const team of [home, away]) for (const p of team.players) {
      team.loadouts[p.id] = {
        weapon: "pistol", utility: [], armor: false, helmet: false,
        keptWeapon: null, keptArmor: false, keptHelmet: false, keptUtility: [],
      };
    }

    let ctLossStreak = 0, tLossStreak = 0;
    const stats = emptyStats();
    const resetEconEach = this.resetEconToggle.checked;

    for (let i = 0; i < rounds; i++) {
      if (resetEconEach) {
        for (const team of [home, away]) for (const p of team.players) p.money = STARTING_PER_PLAYER;
      }

      // Headless AI buy for both sides — same simple logic for both, just spend
      // each player's bank on a rifle if affordable.
      this.simpleBuy(home);
      this.simpleBuy(away);

      const sim = new RoundSim(home, away, map, Math.floor(Math.random() * 1e9));
      let safety = 100000;
      while (!sim.finished && safety-- > 0) sim.tick();
      if (!sim.result) continue;

      const r = sim.result;
      stats.rounds++;
      stats.totalDurationMs += r.durationMs;
      stats.outcomes[r.outcome]++;
      if (r.winningSide === "CT") stats.ctWins++; else stats.tWins++;
      if (r.outcome === "ct-elim") stats.tElims++;       // Ts win by eliminating CTs? actually ct-elim = CTs eliminated → T wins
      if (r.outcome === "t-elim") stats.ctElims++;
      if (r.outcome === "bomb-detonated") stats.detonations++;
      if (r.outcome === "bomb-defused") stats.defuses++;
      if (r.outcome === "time-expired") stats.timeouts++;

      for (const e of r.events) {
        if (e.kind === "kill") {
          if (home.players.some(p => p.id === e.killer)) stats.ctKills++;
          else stats.tKills++;
        } else if (e.kind === "bomb-plant") {
          stats.plants++;
        }
      }

      // Carry weapons/armor/util forward for survivors so the economy chains.
      for (const ag of sim.agents) {
        const team = home.players.some(p => p.id === ag.playerId) ? home : away;
        if (ag.alive) {
          const hasVest = ag.armor > 30;
          const keptUtil = [...ag.utility];
          team.loadouts[ag.playerId] = {
            weapon: ag.weapon, utility: keptUtil, armor: hasVest, helmet: ag.helmet,
            keptWeapon: ag.weapon === "knife" ? null : ag.weapon,
            keptArmor: hasVest, keptHelmet: ag.helmet, keptUtility: keptUtil,
          };
        } else {
          team.loadouts[ag.playerId] = {
            weapon: "pistol", utility: [], armor: false, helmet: false,
            keptWeapon: null, keptArmor: false, keptHelmet: false, keptUtility: [],
          };
        }
      }

      const next = applyRoundReward(home, away, r, ctLossStreak, tLossStreak);
      ctLossStreak = next.ctLossStreak;
      tLossStreak = next.tLossStreak;
    }
    return stats;
  }

  // Buy as much rifle + armor as each player can afford.
  private simpleBuy(team: { side: Side; players: { id: string; role: string; money: number }[]; loadouts: Record<string, any> }) {
    const rifle = team.side === "CT" ? "m4" : "ak";
    const rifleCost = team.side === "CT" ? 3100 : 2700;
    const VEST = 650, HELMET = 350;
    for (const p of team.players) {
      const l = team.loadouts[p.id];
      let spent = 0;
      // Keep existing kept weapon if any.
      if (!l.keptWeapon && p.money >= rifleCost) { l.weapon = rifle; spent += rifleCost; }
      else if (l.keptWeapon) l.weapon = l.keptWeapon;
      if (!l.keptArmor && p.money - spent >= VEST) { l.armor = true; spent += VEST; }
      if (l.armor && !l.keptHelmet && p.money - spent >= HELMET) { l.helmet = true; spent += HELMET; }
      p.money = Math.max(0, p.money - spent);
    }
  }

  private renderResults(s: RunStats) {
    const pct = (n: number) => `${((n / Math.max(1, s.rounds)) * 100).toFixed(1)}%`;
    const avg = (n: number) => (n / Math.max(1, s.rounds)).toFixed(1);
    const avgSec = (ms: number) => (ms / Math.max(1, s.rounds) / 1000).toFixed(1);
    this.resultsEl.innerHTML = `
      <h3>Results (${s.rounds} rounds)</h3>
      <table class="balance-table">
        <tr><th>CT wins</th><td>${s.ctWins} (${pct(s.ctWins)})</td></tr>
        <tr><th>T wins</th><td>${s.tWins} (${pct(s.tWins)})</td></tr>
        <tr><th>Avg duration</th><td>${avgSec(s.totalDurationMs)} s</td></tr>
        <tr><th>Avg kills CT</th><td>${avg(s.ctKills)}</td></tr>
        <tr><th>Avg kills T</th><td>${avg(s.tKills)}</td></tr>
        <tr><th>Plants</th><td>${s.plants} (${pct(s.plants)})</td></tr>
        <tr><th>Detonations</th><td>${s.detonations} (${pct(s.detonations)})</td></tr>
        <tr><th>Defuses</th><td>${s.defuses} (${pct(s.defuses)})</td></tr>
        <tr><th>CT elim wins</th><td>${s.tElims}</td></tr>
        <tr><th>T elim wins</th><td>${s.ctElims}</td></tr>
        <tr><th>Time-expired</th><td>${s.timeouts}</td></tr>
      </table>`;
  }
}
