import type { GameMap } from "../domain/types.ts";
import BalanceWorker from "./balanceWorker.ts?worker";
import type {
  BalanceMatrixResult, BalanceProgress, BalanceRequest, BalanceResult,
  HeatGrids, LoadoutPreset, RunStats, SeriesStats,
} from "./balanceWorker.ts";
import { ALL_PRESETS, ALL_T_STRATEGIES, PRESET_LABELS } from "./balanceWorker.ts";

export interface BalancePanelOpts {
  // The map to test — read fresh on every run so it tracks the live draft.
  getMap: () => GameMap;
  // Called when a run finishes: heat grids for a single run, or null for a
  // matrix run / cleared state. Lets the host overlay a heatmap.
  onResult?: (heat: HeatGrids | null) => void;
}

// Balance tester rendered as a self-contained panel (no full-screen layout).
// Embedded in the map editor's analyze column; runs against the live draft map.
export class BalanceMode {
  private root: HTMLElement;
  private getMap: () => GameMap;
  private onResult?: (heat: HeatGrids | null) => void;

  private roundsLabel!: HTMLElement;
  private roundsInput!: HTMLInputElement;
  private neutralToggle!: HTMLInputElement;
  private resetEconToggle!: HTMLInputElement;
  private ctLoadoutSelect!: HTMLSelectElement;
  private tLoadoutSelect!: HTMLSelectElement;
  private matrixToggle!: HTMLInputElement;
  private seriesToggle!: HTMLInputElement;
  private runBtn!: HTMLButtonElement;
  private status!: HTMLElement;
  private resultsEl!: HTMLElement;

  constructor(parent: HTMLElement, opts: BalancePanelOpts) {
    this.root = parent;
    this.getMap = opts.getMap;
    this.onResult = opts.onResult;
    parent.innerHTML = "";
    parent.classList.add("balance-panel");
    this.buildUI();
  }

  private buildUI() {
    const sidebar = this.root;

    // Rounds (relabelled "Series" in MR12 mode)
    this.roundsLabel = document.createElement("div");
    this.roundsLabel.className = "editor-group";
    this.roundsLabel.textContent = "Rounds";
    sidebar.appendChild(this.roundsLabel);
    this.roundsInput = document.createElement("input");
    this.roundsInput.type = "number";
    this.roundsInput.min = "1";
    this.roundsInput.max = "100000";
    this.roundsInput.value = "200";
    this.roundsInput.className = "balance-input";
    sidebar.appendChild(this.roundsInput);

    // MR12 series mode — sim whole games (real economy) instead of independent
    // rounds. Drives the economy itself, so loadout/matrix/reset controls go off.
    const seriesRow = document.createElement("label");
    seriesRow.className = "balance-toggle";
    this.seriesToggle = document.createElement("input");
    this.seriesToggle.type = "checkbox";
    this.seriesToggle.onchange = () => this.onSeriesToggle();
    seriesRow.append(this.seriesToggle, " MR12 series — sim full games");
    sidebar.appendChild(seriesRow);

    // Loadouts
    const loadoutLabel = document.createElement("div");
    loadoutLabel.className = "editor-group";
    loadoutLabel.textContent = "Loadouts";
    sidebar.appendChild(loadoutLabel);

    const mkLoadoutSelect = (defaultVal: LoadoutPreset = "auto") => {
      const sel = document.createElement("select");
      sel.className = "balance-select";
      for (const k of ["auto", ...ALL_PRESETS] as LoadoutPreset[]) {
        const opt = document.createElement("option");
        opt.value = k;
        opt.textContent = PRESET_LABELS[k];
        sel.appendChild(opt);
      }
      sel.value = defaultVal;
      return sel;
    };

    const ctRow = document.createElement("label");
    ctRow.className = "balance-toggle";
    ctRow.style.flexDirection = "column";
    ctRow.style.alignItems = "stretch";
    ctRow.append("CT loadout");
    this.ctLoadoutSelect = mkLoadoutSelect("auto");
    ctRow.appendChild(this.ctLoadoutSelect);
    sidebar.appendChild(ctRow);

    const tRow = document.createElement("label");
    tRow.className = "balance-toggle";
    tRow.style.flexDirection = "column";
    tRow.style.alignItems = "stretch";
    tRow.append("T loadout");
    this.tLoadoutSelect = mkLoadoutSelect("auto");
    tRow.appendChild(this.tLoadoutSelect);
    sidebar.appendChild(tRow);

    const matrixRow = document.createElement("label");
    matrixRow.className = "balance-toggle";
    this.matrixToggle = document.createElement("input");
    this.matrixToggle.type = "checkbox";
    this.matrixToggle.onchange = () => {
      const on = this.matrixToggle.checked;
      this.ctLoadoutSelect.disabled = on || this.seriesToggle.checked;
      this.tLoadoutSelect.disabled = on || this.seriesToggle.checked;
      this.seriesToggle.disabled = on;
    };
    matrixRow.append(this.matrixToggle, ` Compare all matchups (${ALL_PRESETS.length}×${ALL_PRESETS.length} grid)`);
    sidebar.appendChild(matrixRow);

    // Options
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
    const runRow = document.createElement("div");
    runRow.className = "balance-run-row";
    this.runBtn = document.createElement("button");
    this.runBtn.textContent = "Run";
    this.runBtn.className = "primary";
    this.runBtn.onclick = () => this.run();
    runRow.appendChild(this.runBtn);

    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.onclick = () => this.cancel();
    runRow.appendChild(cancel);
    sidebar.appendChild(runRow);

    this.status = document.createElement("div");
    this.status.className = "balance-status";
    sidebar.appendChild(this.status);

    // Results
    this.resultsEl = document.createElement("div");
    this.resultsEl.className = "balance-results";
    this.resultsEl.innerHTML = `<p style="color: var(--muted);">Configure above, hit <strong>Run</strong> to simulate this map.</p>`;
    sidebar.appendChild(this.resultsEl);
  }

  private worker: Worker | null = null;
  private runStartedAt = 0;

  private cancel() {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    this.runBtn.disabled = false;
    this.status.textContent = "Cancelled";
  }

  // Series mode owns the economy and always uses auto buys, so the loadout
  // pickers, the matchup matrix, and the per-round money reset are all moot.
  private onSeriesToggle() {
    const on = this.seriesToggle.checked;
    this.ctLoadoutSelect.disabled = on || this.matrixToggle.checked;
    this.tLoadoutSelect.disabled = on || this.matrixToggle.checked;
    this.matrixToggle.disabled = on;
    this.resetEconToggle.disabled = on;
    this.roundsLabel.textContent = on ? "Series (full games)" : "Rounds";
    this.roundsInput.value = on ? "50" : "200";
  }

  private run() {
    const rounds = Math.max(1, Math.min(100000, parseInt(this.roundsInput.value, 10) || 100));
    this.runBtn.disabled = true;
    this.resultsEl.innerHTML = "";

    this.worker?.terminate();
    this.worker = new BalanceWorker();
    this.runStartedAt = performance.now();
    this.status.textContent = "Running… 0%";

    const seriesMode = this.seriesToggle.checked;
    const matrix = !seriesMode && this.matrixToggle.checked;

    this.worker.addEventListener("message", (e: MessageEvent<BalanceProgress | BalanceResult | BalanceMatrixResult>) => {
      const msg = e.data;
      if (msg.kind === "progress") {
        const pct = ((msg.done / msg.total) * 100).toFixed(0);
        if (msg.cell) {
          this.status.textContent =
            `Cell ${msg.cell.index}/${msg.cell.count} (CT=${PRESET_LABELS[msg.cell.ct]} vs T=${PRESET_LABELS[msg.cell.t]}) — ${pct}%`;
        } else {
          this.status.textContent = `Running… ${pct}% (${msg.done}/${msg.total})`;
        }
      } else if (msg.kind === "done") {
        const elapsed = ((performance.now() - this.runStartedAt) / 1000).toFixed(1);
        this.status.textContent = msg.series
          ? `Done — ${msg.series.seriesPlayed} games (${msg.stats.rounds} rounds) in ${elapsed}s`
          : `Done — ${msg.stats.rounds} rounds in ${elapsed}s`;
        this.renderResults(msg.stats, msg.series);
        this.onResult?.(msg.heat ?? null);
        this.runBtn.disabled = false;
        this.worker?.terminate();
        this.worker = null;
      } else if (msg.kind === "done-matrix") {
        const elapsed = ((performance.now() - this.runStartedAt) / 1000).toFixed(1);
        const totalRounds = msg.cells.reduce((a, c) => a + c.stats.rounds, 0);
        this.status.textContent = `Done — ${msg.cells.length} cells, ${totalRounds} rounds in ${elapsed}s`;
        this.renderMatrix(msg.cells);
        // Matrix runs don't collect heat (no single map of positions to show).
        this.onResult?.(null);
        this.runBtn.disabled = false;
        this.worker?.terminate();
        this.worker = null;
      }
    });

    const req: BalanceRequest = {
      kind: "run",
      map: this.getMap(),
      rounds,
      neutralize: this.neutralToggle.checked,
      resetEachRound: this.resetEconToggle.checked,
      ctLoadout: this.ctLoadoutSelect.value as LoadoutPreset,
      tLoadout: this.tLoadoutSelect.value as LoadoutPreset,
      matrix,
      seriesMode,
    };
    this.worker.postMessage(req);
  }

  // MR12 series summary: how lopsided games are, OT frequency, and how decisive
  // pistol rounds are — the things a full-game sim shows that single rounds can't.
  private renderSeries(s: SeriesStats): string {
    const games = Math.max(1, s.seriesPlayed);
    const avgWin = (s.totalWinnerScore / games).toFixed(1);
    const avgLose = (s.totalLoserScore / games).toFixed(1);
    const otPct = ((s.overtimes / games) * 100).toFixed(1);
    const pistols = Math.max(1, s.pistolRounds);
    const pistolCt = ((s.pistolCtWins / pistols) * 100).toFixed(1);
    const pistolT = ((s.pistolTWins / pistols) * 100).toFixed(1);
    const conv = s.halvesPlayed > 0
      ? `${((s.pistolWinnerHalfWins / s.halvesPlayed) * 100).toFixed(1)}%`
      : "—";
    return `
      <h3>Series (${s.seriesPlayed} full MR12 games)</h3>
      <table class="balance-table">
        <tr><th>Avg final score</th><td>${avgWin} – ${avgLose}</td></tr>
        <tr><th>Overtime</th><td>${s.overtimes} (${otPct}%)</td></tr>
        <tr><th>Pistol round wins</th><td>CT ${pistolCt}% · T ${pistolT}%</td></tr>
        <tr><th>Pistol → half conversion</th><td>${conv}</td></tr>
      </table>`;
  }

  private renderResults(s: RunStats, series?: SeriesStats) {
    const pct = (n: number) => `${((n / Math.max(1, s.rounds)) * 100).toFixed(1)}%`;
    const avg = (n: number) => (n / Math.max(1, s.rounds)).toFixed(1);
    const avgSec = (ms: number) => (ms / Math.max(1, s.rounds) / 1000).toFixed(1);
    this.resultsEl.innerHTML = `
      ${series ? this.renderSeries(series) : ""}
      <h3>${series ? `Rounds (${s.rounds} across ${series.seriesPlayed} games)` : `Results (${s.rounds} rounds)`}</h3>
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
      </table>
      ${this.renderBreakdowns(s)}`;
  }

  private renderBreakdowns(s: RunStats): string {
    const tStratEntries = ALL_T_STRATEGIES.map(k => [k, s.byTStrategy[k]] as const);
    const ctSetupEntries = Object.entries(s.byCtSetup).sort(([a], [b]) => a.localeCompare(b));
    return this.renderBreakdownTable("By T strategy", "Strategy", tStratEntries)
         + this.renderBreakdownTable("By CT setup", "Setup", ctSetupEntries);
  }

  private renderBreakdownTable(
    title: string, keyLabel: string,
    entries: ReadonlyArray<readonly [string, import("./balanceWorker.ts").StrategyStats]>,
  ): string {
    let html = `<h4 style="margin-top:16px;">${title}</h4>`;
    html += `<table class="balance-table"><tr>`;
    const headers = [keyLabel, "Rounds", "CT win %", "T win %", "CT K/D", "T K/D", "Avg CT kills", "Avg T kills", "Plant %", "Defuse %", "Det %", "Timeout %", "Avg dur (s)"];
    for (const h of headers) html += `<th>${h}</th>`;
    html += `</tr>`;
    if (entries.length === 0) {
      html += `<tr><td colspan="${headers.length}" style="opacity:0.6;">No rounds played.</td></tr>`;
    }
    for (const [key, r] of entries) {
      if (r.rounds === 0) {
        html += `<tr><td>${key}</td>` + `<td>0</td>` + `<td>—</td>`.repeat(headers.length - 2) + `</tr>`;
        continue;
      }
      const pct = (n: number) => `${((n / r.rounds) * 100).toFixed(1)}%`;
      const avg = (n: number) => (n / r.rounds).toFixed(1);
      const kd = (k: number, d: number) => (d === 0 ? "∞" : (k / d).toFixed(2));
      const dur = (r.totalDurationMs / r.rounds / 1000).toFixed(1);
      html += `<tr>
        <td>${key}</td>
        <td>${r.rounds}</td>
        <td>${pct(r.ctWins)}</td>
        <td>${pct(r.tWins)}</td>
        <td>${kd(r.ctKills, r.tKills)}</td>
        <td>${kd(r.tKills, r.ctKills)}</td>
        <td>${avg(r.ctKills)}</td>
        <td>${avg(r.tKills)}</td>
        <td>${pct(r.plants)}</td>
        <td>${pct(r.defuses)}</td>
        <td>${pct(r.detonations)}</td>
        <td>${pct(r.timeouts)}</td>
        <td>${dur}</td>
      </tr>`;
    }
    html += `</table>`;
    return html;
  }

  private renderMatrix(cells: { ct: LoadoutPreset; t: LoadoutPreset; stats: RunStats }[]) {
    const get = (ct: LoadoutPreset, t: LoadoutPreset) => cells.find(c => c.ct === ct && c.t === t)!;
    const cellPct = (s: RunStats) => (s.ctWins / Math.max(1, s.rounds)) * 100;
    // Heat color: red (0%, T dominant) → yellow (50%, fair) → green (100%, CT dominant)
    const heat = (p: number) => {
      const t = p / 100;
      const r = t < 0.5 ? 220 : Math.round(220 - (t - 0.5) * 320);
      const g = t < 0.5 ? Math.round(60 + t * 320) : 220;
      return `rgb(${r}, ${g}, 80)`;
    };

    let html = `<h3>Matrix (rows = CT, columns = T) — cell shows CT win %</h3>`;
    html += `<table class="balance-table" style="border-collapse:collapse;">`;
    html += `<tr><th></th>`;
    for (const t of ALL_PRESETS) html += `<th style="padding:8px;">${PRESET_LABELS[t]}</th>`;
    html += `</tr>`;
    for (const ct of ALL_PRESETS) {
      html += `<tr><th style="padding:8px;text-align:right;">${PRESET_LABELS[ct]}</th>`;
      for (const t of ALL_PRESETS) {
        const s = get(ct, t).stats;
        const p = cellPct(s);
        html += `<td style="padding:10px;text-align:center;background:${heat(p)};color:#111;font-weight:600;min-width:80px;" title="${s.ctWins}/${s.rounds}">${p.toFixed(1)}%</td>`;
      }
      html += `</tr>`;
    }
    html += `</table>`;

    // Per-cell detail toggle: a small table beneath
    html += `<h4 style="margin-top:20px;">Per-cell details</h4>`;
    html += `<table class="balance-table"><tr><th>CT</th><th>T</th><th>Rounds</th><th>CT win %</th><th>Plant %</th><th>Avg dur (s)</th></tr>`;
    for (const c of cells) {
      const s = c.stats;
      const ctW = (s.ctWins / Math.max(1, s.rounds)) * 100;
      const plantP = (s.plants / Math.max(1, s.rounds)) * 100;
      const dur = (s.totalDurationMs / Math.max(1, s.rounds) / 1000).toFixed(1);
      html += `<tr><td>${PRESET_LABELS[c.ct]}</td><td>${PRESET_LABELS[c.t]}</td><td>${s.rounds}</td><td>${ctW.toFixed(1)}%</td><td>${plantP.toFixed(0)}%</td><td>${dur}</td></tr>`;
    }
    html += `</table>`;

    // Aggregate strategy + setup stats across all cells so the matrix run
    // also surfaces which T strategies / CT setups actually win on this map.
    const agg: RunStats = { byTStrategy: {} as RunStats["byTStrategy"], byCtSetup: {} } as RunStats;
    type Bucket = RunStats["byCtSetup"][string];
    const empty = (): Bucket => ({ rounds: 0, ctWins: 0, tWins: 0, plants: 0, defuses: 0, detonations: 0, timeouts: 0, ctKills: 0, tKills: 0, totalDurationMs: 0 });
    for (const st of ALL_T_STRATEGIES) agg.byTStrategy[st] = empty();
    const accum = (dst: Bucket, src: Bucket) => {
      dst.rounds += src.rounds; dst.ctWins += src.ctWins; dst.tWins += src.tWins;
      dst.plants += src.plants; dst.defuses += src.defuses; dst.detonations += src.detonations; dst.timeouts += src.timeouts;
      dst.ctKills += src.ctKills; dst.tKills += src.tKills;
      dst.totalDurationMs += src.totalDurationMs;
    };
    for (const c of cells) {
      for (const st of ALL_T_STRATEGIES) accum(agg.byTStrategy[st], c.stats.byTStrategy[st]);
      for (const [key, src] of Object.entries(c.stats.byCtSetup)) {
        const dst = agg.byCtSetup[key] ?? (agg.byCtSetup[key] = empty());
        accum(dst, src);
      }
    }
    html += this.renderBreakdowns(agg);

    this.resultsEl.innerHTML = html;
  }
}
