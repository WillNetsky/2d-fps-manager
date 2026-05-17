import type { GameMap } from "../domain/types.ts";
import { makeMap } from "../domain/factory.ts";
import { loadCustomMap, loadSavedMapsAll } from "../editor/mapEditor.ts";
import BalanceWorker from "./balanceWorker.ts?worker";
import type { BalanceProgress, BalanceRequest, BalanceResult, RunStats } from "./balanceWorker.ts";

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
    // Prefer the active custom map (e.g. just-staged from the editor) if present.
    if (opts.find(o => o.key === "__active__")) this.mapSelect.value = "__active__";
    sidebar.appendChild(this.mapSelect);

    // Rounds
    const roundsLabel = document.createElement("div");
    roundsLabel.className = "editor-group";
    roundsLabel.textContent = "Rounds";
    sidebar.appendChild(roundsLabel);
    this.roundsInput = document.createElement("input");
    this.roundsInput.type = "number";
    this.roundsInput.min = "1";
    this.roundsInput.max = "100000";
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

    const cancel = document.createElement("button");
    cancel.textContent = "Cancel";
    cancel.onclick = () => this.cancel();
    sidebar.appendChild(cancel);

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

  private worker: Worker | null = null;
  private runStartedAt = 0;

  private cancel() {
    if (!this.worker) return;
    this.worker.terminate();
    this.worker = null;
    this.runBtn.disabled = false;
    this.status.textContent = "Cancelled";
  }

  private run() {
    const rounds = Math.max(1, Math.min(100000, parseInt(this.roundsInput.value, 10) || 100));
    this.runBtn.disabled = true;
    this.resultsEl.innerHTML = "";

    // Terminate any previous run.
    this.worker?.terminate();
    this.worker = new BalanceWorker();
    this.runStartedAt = performance.now();
    this.status.textContent = "Running… 0%";

    this.worker.addEventListener("message", (e: MessageEvent<BalanceProgress | BalanceResult>) => {
      const msg = e.data;
      if (msg.kind === "progress") {
        const pct = ((msg.done / msg.total) * 100).toFixed(0);
        this.status.textContent = `Running… ${pct}% (${msg.done}/${msg.total})`;
      } else if (msg.kind === "done") {
        const elapsed = ((performance.now() - this.runStartedAt) / 1000).toFixed(1);
        this.status.textContent = `Done — ${msg.stats.rounds} rounds in ${elapsed}s`;
        this.renderResults(msg.stats);
        this.runBtn.disabled = false;
        this.worker?.terminate();
        this.worker = null;
      }
    });

    const req: BalanceRequest = {
      kind: "run",
      map: this.pickMap(),
      rounds,
      neutralize: this.neutralToggle.checked,
      resetEachRound: this.resetEconToggle.checked,
    };
    this.worker.postMessage(req);
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
