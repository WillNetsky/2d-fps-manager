import type { GameMap, Vec2 } from "../domain/types.ts";
import { makeMap } from "../domain/factory.ts";
import { defaultMaps } from "../domain/defaultMaps.ts";
import { RECOVERED_MAPS } from "../domain/recoveredMaps.ts";
import { BalanceMode } from "../balance/balanceMode.ts";
import type { HeatGrids } from "../balance/balanceWorker.ts";

// Heatmap layers the analyze panel can overlay on the map.
type HeatLayer = "none" | "ct-kills" | "t-kills" | "ct-deaths" | "t-deaths" | "ct-pos" | "t-pos";
const HEAT_LAYERS: { id: HeatLayer; label: string; color: string }[] = [
  { id: "none", label: "Off", color: "" },
  { id: "ct-kills", label: "CT kills", color: "#4a90e2" },
  { id: "t-kills", label: "T kills", color: "#c9692e" },
  { id: "ct-deaths", label: "CT deaths", color: "#4a90e2" },
  { id: "t-deaths", label: "T deaths", color: "#c9692e" },
  { id: "ct-pos", label: "CT positioning", color: "#4a90e2" },
  { id: "t-pos", label: "T positioning", color: "#c9692e" },
];

type Tool =
  | "wall" | "floor"
  | "ct-spawn" | "t-spawn"
  | "site-a" | "site-b"
  | "eraser";

const CUSTOM_MAP_KEY = "2d-fps-manager-custom-map";
const SAVED_MAPS_KEY = "2d-fps-manager-saved-maps";

export function loadSavedMapsAll(): Record<string, GameMap> { return loadSavedMaps(); }
function loadSavedMaps(): Record<string, GameMap> {
  const raw = localStorage.getItem(SAVED_MAPS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

function writeSavedMaps(maps: Record<string, GameMap>) {
  localStorage.setItem(SAVED_MAPS_KEY, JSON.stringify(maps));
}

const SEED_FLAG_KEY = "2d-fps-manager-seeded-default-maps-v2";

// One-time seed of the default map(s) into the saved-map store, so a fresh
// install has something to play and the default appears as an ordinary editable
// "Saved" map. Guarded by a flag so a map the user later deletes stays deleted.
export function seedDefaultMaps(): void {
  if (localStorage.getItem(SEED_FLAG_KEY)) return;
  const saved = loadSavedMaps();
  for (const m of defaultMaps()) if (!saved[m.name]) saved[m.name] = m;
  writeSavedMaps(saved);
  localStorage.setItem(SEED_FLAG_KEY, "1");
}

// One-time, merge-only restore of maps that were lost from localStorage (only
// the seeded default survived). Recovered from a session transcript; see
// recoveredMaps.ts. Guarded by its own flag so it runs once and never clobbers
// an existing map of the same name or resurrects one the user later deletes.
const RECOVERY_FLAG_KEY = "2d-fps-manager-recovered-edited-maps-v1";
export function seedRecoveredMaps(): void {
  if (localStorage.getItem(RECOVERY_FLAG_KEY)) return;
  const saved = loadSavedMaps();
  for (const m of RECOVERED_MAPS) if (!saved[m.name]) saved[m.name] = m;
  writeSavedMaps(saved);
  localStorage.setItem(RECOVERY_FLAG_KEY, "1");
}

// All saved maps, guaranteeing at least the default if the store is somehow empty.
export function savedMapsList(): GameMap[] {
  const maps = Object.values(loadSavedMaps());
  return maps.length > 0 ? maps : defaultMaps();
}

function makeBlankMap(): GameMap {
  const base = makeMap();
  return {
    name: "Untitled",
    width: base.width,
    height: base.height,
    tileSize: base.tileSize,
    walls: new Array(base.width * base.height).fill(false),
    ctSpawns: [],
    tSpawns: [],
    bombsites: [],
  };
}

export class MapEditor {
  private map: GameMap;
  private currentName: string;
  private currentTool: Tool = "wall";
  private wallPaintMode: "set" | "clear" = "set"; // determined on mousedown for drag-paint
  private canvas!: HTMLCanvasElement;
  private ctx!: CanvasRenderingContext2D;
  private isMouseDown = false;
  private lastTile: Vec2 | null = null;
  private root: HTMLElement;
  private nameLabel!: HTMLElement;
  private showCenterLines = false;
  private wallColorInput!: HTMLInputElement;
  private floorColorInput!: HTMLInputElement;
  private heat: HeatGrids | null = null;
  private heatLayer: HeatLayer = "none";
  private heatLayerSelect!: HTMLSelectElement;

  constructor(parent: HTMLElement) {
    this.map = loadCustomMap() ?? makeMap();
    this.currentName = this.map.name || "Untitled";
    this.root = parent;
    parent.innerHTML = "";
    this.buildUI();
    this.draw();
  }

  private buildUI() {
    this.root.className = "editor-app";

    // Sidebar
    const sidebar = document.createElement("div");
    sidebar.className = "editor-sidebar";

    const title = document.createElement("h2");
    title.textContent = "Map Editor";
    sidebar.appendChild(title);

    const groups: { name: string; tools: { id: Tool; label: string; color: string }[] }[] = [
      {
        name: "Terrain",
        tools: [
          { id: "wall", label: "Wall", color: "#3a414f" },
          { id: "floor", label: "Floor", color: "#1a1e27" },
        ],
      },
      {
        name: "Spawns / Sites",
        tools: [
          { id: "ct-spawn", label: "CT Spawn", color: "#4a90e2" },
          { id: "t-spawn", label: "T Spawn", color: "#c9692e" },
          { id: "site-a", label: "Bombsite A", color: "#e3a857" },
          { id: "site-b", label: "Bombsite B", color: "#e3a857" },
        ],
      },
      {
        name: "Other",
        tools: [{ id: "eraser", label: "Eraser", color: "#d9534f" }],
      },
    ];

    for (const grp of groups) {
      const heading = document.createElement("div");
      heading.className = "editor-group";
      heading.textContent = grp.name;
      sidebar.appendChild(heading);
      for (const tool of grp.tools) {
        const btn = document.createElement("button");
        btn.className = "editor-tool";
        btn.textContent = tool.label;
        btn.dataset.tool = tool.id;
        btn.style.borderLeft = `4px solid ${tool.color}`;
        btn.onclick = () => this.selectTool(tool.id);
        sidebar.appendChild(btn);
      }
    }

    // Actions
    const actions = document.createElement("div");
    actions.className = "editor-actions";
    const mkBtn = (label: string, cls: string, onClick: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.className = cls;
      b.onclick = onClick;
      actions.appendChild(b);
      return b;
    };
    mkBtn("Play this map", "primary", () => this.playMap());

    const nameRow = document.createElement("div");
    nameRow.className = "editor-name-row";
    nameRow.style.cssText = "margin:8px 0;font-size:12px;opacity:0.8;";
    this.nameLabel = document.createElement("span");
    this.updateNameLabel();
    nameRow.appendChild(this.nameLabel);
    sidebar.appendChild(nameRow);

    mkBtn("New", "", () => this.newMap());
    mkBtn("Save", "", () => this.saveMap(false));
    mkBtn("Save As…", "", () => this.saveMap(true));
    mkBtn("Load…", "", () => this.loadMapDialog());
    mkBtn("Copy JSON", "", () => this.copyMapJson());
    mkBtn("Export all maps", "", () => this.exportAllMaps());
    mkBtn("Import maps…", "", () => this.importMaps());
    mkBtn("Reset to default", "", () => {
      this.map = makeMap();
      this.currentName = this.map.name || "Default";
      this.updateNameLabel();
      this.clearHeat();
      this.draw();
    });
    mkBtn("Clear (all floor)", "", () => { this.clearMap(); this.draw(); });

    const colorRow = document.createElement("div");
    colorRow.style.cssText = "display:flex;flex-direction:column;gap:4px;margin:8px 0;font-size:12px;opacity:0.85;";
    const mkColor = (labelText: string, initial: string, onChange: (v: string) => void) => {
      const row = document.createElement("label");
      row.style.cssText = "display:flex;align-items:center;gap:6px;cursor:pointer;";
      const input = document.createElement("input");
      input.type = "color";
      input.value = initial;
      input.style.cssText = "width:28px;height:20px;border:none;padding:0;background:transparent;cursor:pointer;";
      input.onchange = () => { onChange(input.value); this.draw(); };
      row.appendChild(input);
      row.appendChild(document.createTextNode(labelText));
      colorRow.appendChild(row);
      return input;
    };
    this.wallColorInput = mkColor("Wall color", this.map.wallColor ?? "#3a414f", v => { this.map.wallColor = v; });
    this.floorColorInput = mkColor("Floor color", this.map.floorColor ?? "#1a1e27", v => { this.map.floorColor = v; });
    actions.appendChild(colorRow);

    const centerRow = document.createElement("label");
    centerRow.style.cssText = "display:flex;align-items:center;gap:6px;margin:6px 0;font-size:12px;opacity:0.85;cursor:pointer;";
    const centerCb = document.createElement("input");
    centerCb.type = "checkbox";
    centerCb.checked = this.showCenterLines;
    centerCb.onchange = () => { this.showCenterLines = centerCb.checked; this.draw(); };
    centerRow.appendChild(centerCb);
    centerRow.appendChild(document.createTextNode("Show center lines"));
    actions.appendChild(centerRow);

    mkBtn("Back to menu", "", () => { window.location.hash = ""; window.location.reload(); });
    sidebar.appendChild(actions);

    // Help text
    const help = document.createElement("div");
    help.className = "editor-help";
    help.innerHTML = `
      <p><strong>Tip:</strong> Click & drag walls/floor to paint. Spawn/site tools toggle a single tile.</p>
      <p>Min: ≥5 CT spawns, ≥5 T spawns, A & B bombsites.</p>
      <p>Util throw spots are now auto-detected from the map's chokepoints — no need to place them.</p>
    `;
    sidebar.appendChild(help);

    this.root.appendChild(sidebar);

    // Canvas area
    const canvasWrap = document.createElement("div");
    canvasWrap.className = "editor-canvas-wrap";
    this.canvas = document.createElement("canvas");
    this.canvas.width = this.map.width * this.map.tileSize;
    this.canvas.height = this.map.height * this.map.tileSize;
    this.canvas.className = "editor-canvas";
    canvasWrap.appendChild(this.canvas);
    this.ctx = this.canvas.getContext("2d")!;

    this.canvas.addEventListener("mousedown", (e) => this.onMouseDown(e));
    this.canvas.addEventListener("mousemove", (e) => this.onMouseMove(e));
    window.addEventListener("mouseup", () => {
      this.isMouseDown = false;
      this.lastTile = null;
    });
    // Prevent context menu so right-drag could later be used
    this.canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    this.root.appendChild(canvasWrap);

    // Analyze panel (right column): balance tester + heatmap overlay controls.
    const analyze = document.createElement("div");
    analyze.className = "editor-analyze";
    const aTitle = document.createElement("h2");
    aTitle.textContent = "Analyze";
    analyze.appendChild(aTitle);

    // Heatmap layer selector — drives the overlay drawn on the map canvas.
    const heatGroup = document.createElement("div");
    heatGroup.className = "editor-group";
    heatGroup.textContent = "Heatmap overlay";
    analyze.appendChild(heatGroup);
    this.heatLayerSelect = document.createElement("select");
    this.heatLayerSelect.className = "balance-select";
    for (const l of HEAT_LAYERS) {
      const opt = document.createElement("option");
      opt.value = l.id;
      opt.textContent = l.label;
      this.heatLayerSelect.appendChild(opt);
    }
    this.heatLayerSelect.disabled = true; // until a run produces heat data
    this.heatLayerSelect.onchange = () => {
      this.heatLayer = this.heatLayerSelect.value as HeatLayer;
      this.draw();
    };
    analyze.appendChild(this.heatLayerSelect);
    const heatHint = document.createElement("div");
    heatHint.className = "editor-help";
    heatHint.innerHTML = `<p>Run a sim below to populate the heatmap. Deaths show where each side dies; positioning shows where each side spends time.</p>`;
    analyze.appendChild(heatHint);

    // Balance tester, hosted in its own sub-panel; tests the live draft map.
    const balanceHost = document.createElement("div");
    analyze.appendChild(balanceHost);
    new BalanceMode(balanceHost, {
      getMap: () => this.map,
      onResult: (heat) => {
        this.heat = heat;
        this.heatLayerSelect.disabled = heat == null;
        if (heat == null) {
          this.heatLayer = "none";
          this.heatLayerSelect.value = "none";
        } else if (this.heatLayer === "none") {
          // Auto-show a useful layer the first time data arrives.
          this.heatLayer = "ct-kills";
          this.heatLayerSelect.value = "ct-kills";
        }
        this.draw();
      },
    });

    this.root.appendChild(analyze);

    this.selectTool("wall");
  }

  private selectTool(tool: Tool) {
    this.currentTool = tool;
    this.root.querySelectorAll(".editor-tool").forEach(el => {
      el.classList.toggle("active", (el as HTMLElement).dataset.tool === tool);
    });
  }

  private onMouseDown(e: MouseEvent) {
    this.isMouseDown = true;
    // Wall: determine paint mode based on first clicked tile (toggle behavior)
    const tile = this.tileAt(e);
    if (!tile) return;
    if (this.currentTool === "wall" || this.currentTool === "floor") {
      const idx = tile.y * this.map.width + tile.x;
      const currently = this.map.walls[idx];
      this.wallPaintMode = this.currentTool === "wall" ? "set" : "clear";
      // Override: if you start a wall click on an already-wall tile, switch to clear (toggle convenience).
      if (this.currentTool === "wall" && currently) this.wallPaintMode = "clear";
      else if (this.currentTool === "floor" && !currently) this.wallPaintMode = "set";
    }
    this.applyAtTile(tile);
    this.draw();
  }

  private onMouseMove(e: MouseEvent) {
    if (!this.isMouseDown) return;
    const tile = this.tileAt(e);
    if (!tile) return;
    if (this.lastTile && this.lastTile.x === tile.x && this.lastTile.y === tile.y) return;
    this.applyAtTile(tile);
    this.draw();
  }

  private tileAt(e: MouseEvent): Vec2 | null {
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width / rect.width;
    const scaleY = this.canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    const tx = Math.floor(x / this.map.tileSize);
    const ty = Math.floor(y / this.map.tileSize);
    if (tx < 0 || ty < 0 || tx >= this.map.width || ty >= this.map.height) return null;
    return { x: tx, y: ty };
  }

  private applyAtTile(tile: Vec2) {
    this.lastTile = tile;
    const idx = tile.y * this.map.width + tile.x;

    switch (this.currentTool) {
      case "wall":
      case "floor":
        this.map.walls[idx] = this.wallPaintMode === "set";
        return;
      case "eraser":
        this.map.ctSpawns = this.map.ctSpawns.filter(s => !(s.x === tile.x && s.y === tile.y));
        this.map.tSpawns = this.map.tSpawns.filter(s => !(s.x === tile.x && s.y === tile.y));
        // Don't erase bombsites with eraser — use site tools to relocate them.
        return;
      case "ct-spawn":
        toggleTileInList(this.map.ctSpawns, tile);
        return;
      case "t-spawn":
        toggleTileInList(this.map.tSpawns, tile);
        return;
      case "site-a": {
        const s = this.map.bombsites.find(x => x.id === "A");
        if (s) s.center = tile;
        else this.map.bombsites.push({ id: "A", center: tile, radius: 2.5 });
        return;
      }
      case "site-b": {
        const s = this.map.bombsites.find(x => x.id === "B");
        if (s) s.center = tile;
        else this.map.bombsites.push({ id: "B", center: tile, radius: 2.5 });
        return;
      }
    }
  }

  private clearMap() {
    this.map.walls = new Array(this.map.width * this.map.height).fill(false);
    this.map.ctSpawns = [];
    this.map.tSpawns = [];
    this.map.bombsites = [];
  }

  private updateNameLabel() {
    if (this.nameLabel) this.nameLabel.textContent = `Current: ${this.currentName}`;
  }

  private syncColorInputs() {
    if (this.wallColorInput) this.wallColorInput.value = this.map.wallColor ?? "#3a414f";
    if (this.floorColorInput) this.floorColorInput.value = this.map.floorColor ?? "#1a1e27";
  }

  private newMap() {
    if (!confirm("Discard current map and start a new blank one?")) return;
    this.map = makeBlankMap();
    this.currentName = "Untitled";
    this.map.name = this.currentName;
    this.updateNameLabel();
    this.syncColorInputs();
    this.clearHeat();
    this.draw();
  }

  // Drop heatmap data tied to the previous map: loading/creating a different
  // map invalidates the old sim's death/kill/occupancy grids, so reset the
  // overlay to "off" and disable the selector until the next sim run.
  private clearHeat() {
    this.heat = null;
    this.heatLayer = "none";
    if (this.heatLayerSelect) {
      this.heatLayerSelect.value = "none";
      this.heatLayerSelect.disabled = true;
    }
  }

  private saveMap(saveAs: boolean) {
    let name = this.currentName;
    if (saveAs || !name || name === "Untitled") {
      const input = prompt("Save map as:", name === "Untitled" ? "" : name);
      if (!input) return;
      name = input.trim();
      if (!name) return;
    }
    const maps = loadSavedMaps();
    if (saveAs && maps[name] && !confirm(`Overwrite existing map "${name}"?`)) return;
    this.map.name = name;
    maps[name] = this.map;
    writeSavedMaps(maps);
    this.currentName = name;
    this.updateNameLabel();
    alert(`Saved "${name}".`);
  }

  private async copyMapJson() {
    const json = JSON.stringify(this.map, null, 2);
    try {
      await navigator.clipboard.writeText(json);
      alert(`Copied "${this.currentName}" JSON (${json.length} chars) to clipboard.`);
    } catch {
      // Clipboard API can fail (e.g. non-secure context). Fall back to a prompt.
      prompt("Copy map JSON:", json);
    }
  }

  // Download every saved map as a single JSON file — a portable backup that
  // survives localStorage wipes / origin changes. Re-importable via importMaps().
  private exportAllMaps() {
    const maps = loadSavedMaps();
    const names = Object.keys(maps);
    if (names.length === 0) { alert("No saved maps to export."); return; }
    const json = JSON.stringify(maps, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `2d-fps-maps-${stamp}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // Import maps from a JSON file (either an export from exportAllMaps — a
  // name->map object — or a single map object). Merges into the saved store;
  // existing maps of the same name are overwritten only after confirmation.
  private importMaps() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "application/json,.json";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      let parsed: unknown;
      try { parsed = JSON.parse(await file.text()); }
      catch { alert("Couldn't parse that file as JSON."); return; }

      // Normalize to a name->GameMap record. Accept a single map or a bundle.
      const incoming: Record<string, GameMap> = {};
      const isMap = (o: any): o is GameMap =>
        o && typeof o === "object" && Array.isArray(o.walls) && Array.isArray(o.ctSpawns) && Array.isArray(o.bombsites) && o.width && o.height;
      if (isMap(parsed)) {
        incoming[(parsed as GameMap).name || "Imported"] = parsed as GameMap;
      } else if (parsed && typeof parsed === "object") {
        for (const v of Object.values(parsed as Record<string, unknown>)) {
          if (isMap(v)) incoming[(v as GameMap).name] = v as GameMap;
        }
      }
      const names = Object.keys(incoming);
      if (names.length === 0) { alert("No valid maps found in that file."); return; }

      const saved = loadSavedMaps();
      const clashes = names.filter(n => saved[n]);
      if (clashes.length > 0 &&
          !confirm(`${clashes.length} map(s) already exist and will be overwritten:\n${clashes.join(", ")}\n\nContinue?`)) {
        return;
      }
      for (const n of names) saved[n] = incoming[n];
      writeSavedMaps(saved);
      alert(`Imported ${names.length} map(s): ${names.join(", ")}`);
    };
    input.click();
  }

  private loadMapDialog() {
    const userMaps = loadSavedMaps();
    const names = Object.keys(userMaps).sort();
    if (!names.length) { alert("No saved maps yet — design one and save it."); return; }
    const list = names.map((n, i) => `${i + 1}. ${n}`).join("\n");
    const choice = prompt(`Load which map? (enter number or name)\n\n${list}\n\nType 'del N' to delete a saved map.`);
    if (!choice) return;
    const trimmed = choice.trim();
    if (/^del\s+/i.test(trimmed)) {
      const rest = trimmed.replace(/^del\s+/i, "").trim();
      const idx = Number(rest);
      const picked = !isNaN(idx) && idx >= 1 && idx <= names.length ? names[idx - 1] : (userMaps[rest] ? rest : null);
      if (!picked || !userMaps[picked]) { alert("No matching saved map to delete."); return; }
      if (!confirm(`Delete "${picked}"?`)) return;
      delete userMaps[picked];
      writeSavedMaps(userMaps);
      return;
    }
    const asNum = Number(trimmed);
    const picked = !isNaN(asNum) && asNum >= 1 && asNum <= names.length
      ? names[asNum - 1]
      : (userMaps[trimmed] ? trimmed : null);
    if (!picked) { alert("No matching map."); return; }
    this.map = JSON.parse(JSON.stringify(userMaps[picked])) as GameMap;
    this.currentName = picked;
    this.map.name = picked;
    this.updateNameLabel();
    this.syncColorInputs();
    this.clearHeat();
    this.draw();
  }

  private validateAndStage(): boolean {
    if (this.map.ctSpawns.length < 5) { alert("Need at least 5 CT spawns."); return false; }
    if (this.map.tSpawns.length < 5) { alert("Need at least 5 T spawns."); return false; }
    if (!this.map.bombsites.find(s => s.id === "A")) { alert("Place bombsite A."); return false; }
    if (!this.map.bombsites.find(s => s.id === "B")) { alert("Place bombsite B."); return false; }

    const onWall = (t: Vec2) => this.map.walls[t.y * this.map.width + t.x];
    if (this.map.ctSpawns.some(onWall)) { alert("Some CT spawn tiles are on walls — clear the floor under them."); return false; }
    if (this.map.tSpawns.some(onWall)) { alert("Some T spawn tiles are on walls — clear the floor under them."); return false; }
    for (const s of this.map.bombsites) {
      if (onWall(s.center)) { alert(`Bombsite ${s.id} is on a wall — move it to a floor tile.`); return false; }
    }
    const issue = this.checkConnectivity();
    if (issue) { alert(issue); return false; }

    localStorage.setItem(CUSTOM_MAP_KEY, JSON.stringify(this.map));
    return true;
  }

  private playMap() {
    if (!this.validateAndStage()) return;
    window.location.hash = "";
    window.location.reload();
  }

  private checkConnectivity(): string | null {
    // BFS over floor tiles from each spawn; the bombsites must be reachable.
    const W = this.map.width, H = this.map.height;
    const idx = (x: number, y: number) => y * W + x;
    const reachableFrom = (start: Vec2): Set<number> => {
      const seen = new Set<number>();
      if (this.map.walls[idx(start.x, start.y)]) return seen;
      const queue: Vec2[] = [start];
      seen.add(idx(start.x, start.y));
      while (queue.length) {
        const cur = queue.shift()!;
        for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]] as const) {
          const nx = cur.x + dx, ny = cur.y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const k = idx(nx, ny);
          if (seen.has(k) || this.map.walls[k]) continue;
          seen.add(k);
          queue.push({ x: nx, y: ny });
        }
      }
      return seen;
    };
    for (const spawn of [...this.map.ctSpawns, ...this.map.tSpawns]) {
      const reach = reachableFrom(spawn);
      for (const site of this.map.bombsites) {
        if (!reach.has(idx(site.center.x, site.center.y))) {
          const sideLabel = this.map.ctSpawns.includes(spawn) ? "CT" : "T";
          return `A ${sideLabel} spawn at (${spawn.x},${spawn.y}) can't reach bombsite ${site.id}. Connect the map.`;
        }
      }
    }
    return null;
  }

  // ---- Drawing ----

  private draw() {
    const ctx = this.ctx;
    const ts = this.map.tileSize;
    const floorCol = normalizeHex(this.map.floorColor) ?? "#1a1e27";
    const wallCol = normalizeHex(this.map.wallColor) ?? "#3a414f";
    ctx.fillStyle = "#0a0c10";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Tiles
    for (let y = 0; y < this.map.height; y++) {
      for (let x = 0; x < this.map.width; x++) {
        const wall = this.map.walls[y * this.map.width + x];
        ctx.fillStyle = wall ? wallCol : floorCol;
        ctx.fillRect(x * ts, y * ts, ts, ts);
      }
    }
    // Grid lines
    ctx.strokeStyle = "rgba(50,58,70,0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= this.map.width; x++) {
      ctx.moveTo(x * ts + 0.5, 0);
      ctx.lineTo(x * ts + 0.5, this.canvas.height);
    }
    for (let y = 0; y <= this.map.height; y++) {
      ctx.moveTo(0, y * ts + 0.5);
      ctx.lineTo(this.canvas.width, y * ts + 0.5);
    }
    ctx.stroke();

    // Bombsites
    for (const s of this.map.bombsites) {
      ctx.fillStyle = "rgba(42,47,58,0.6)";
      ctx.beginPath();
      ctx.arc((s.center.x + 0.5) * ts, (s.center.y + 0.5) * ts, s.radius * ts, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "bold 22px ui-sans-serif, system-ui, sans-serif";
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(s.id, (s.center.x + 0.5) * ts, (s.center.y + 0.5) * ts);
    }

    // Spawn zones
    this.drawZone(this.map.ctSpawns, "#4a90e2", "CT");
    this.drawZone(this.map.tSpawns, "#c9692e", "T");

    // Heatmap overlay (from the analyze panel's last sim run).
    this.drawHeat();

    if (this.showCenterLines) {
      // With odd width/height there's a single middle column and middle row;
      // highlight those tiles as a band so the center cell is obvious.
      const midCol = Math.floor(this.map.width / 2);
      const midRow = Math.floor(this.map.height / 2);
      ctx.fillStyle = "rgba(255, 220, 90, 0.18)";
      ctx.fillRect(midCol * ts, 0, ts, this.canvas.height);
      ctx.fillRect(0, midRow * ts, this.canvas.width, ts);
      ctx.strokeStyle = "rgba(255, 220, 90, 0.7)";
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(midCol * ts + 0.5, 0); ctx.lineTo(midCol * ts + 0.5, this.canvas.height);
      ctx.moveTo((midCol + 1) * ts + 0.5, 0); ctx.lineTo((midCol + 1) * ts + 0.5, this.canvas.height);
      ctx.moveTo(0, midRow * ts + 0.5); ctx.lineTo(this.canvas.width, midRow * ts + 0.5);
      ctx.moveTo(0, (midRow + 1) * ts + 0.5); ctx.lineTo(this.canvas.width, (midRow + 1) * ts + 0.5);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // Overlay the selected heatmap layer. Tiles are colored by the layer's side
  // color with alpha scaled by per-tile intensity (relative to the layer's max).
  private drawHeat() {
    if (this.heatLayer === "none" || !this.heat) return;
    const layer = HEAT_LAYERS.find(l => l.id === this.heatLayer);
    if (!layer || !layer.color) return;
    const grid =
      this.heatLayer === "ct-kills" ? this.heat.ctKills
      : this.heatLayer === "t-kills" ? this.heat.tKills
      : this.heatLayer === "ct-deaths" ? this.heat.ctDeaths
      : this.heatLayer === "t-deaths" ? this.heat.tDeaths
      : this.heatLayer === "ct-pos" ? this.heat.ctPos
      : this.heat.tPos;
    // Grid dims may differ from the current draft if the map was edited after a
    // run; only overlay when they still line up.
    if (this.heat.width !== this.map.width || this.heat.height !== this.map.height) return;

    let max = 0;
    for (const v of grid) if (v > max) max = v;
    if (max <= 0) return;

    const ctx = this.ctx;
    const ts = this.map.tileSize;
    for (let i = 0; i < grid.length; i++) {
      const v = grid[i];
      if (v <= 0) continue;
      // Perceptual boost so mid-range cells stay visible against the peak.
      const intensity = Math.pow(v / max, 0.6);
      ctx.fillStyle = hexWithAlpha(layer.color, 0.12 + 0.72 * intensity);
      const x = (i % this.map.width) * ts;
      const y = Math.floor(i / this.map.width) * ts;
      ctx.fillRect(x, y, ts, ts);
    }
  }

  private drawZone(tiles: Vec2[], color: string, label: string) {
    if (!tiles.length) return;
    const ctx = this.ctx;
    const ts = this.map.tileSize;
    for (const tile of tiles) {
      ctx.fillStyle = hexWithAlpha(color, 0.18);
      ctx.fillRect(tile.x * ts, tile.y * ts, ts, ts);
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(tile.x * ts + 1, tile.y * ts + 1, ts - 2, ts - 2);
      ctx.fillStyle = color;
      ctx.font = "bold 10px ui-sans-serif, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, (tile.x + 0.5) * ts, (tile.y + 0.5) * ts);
    }
  }

}

function toggleTileInList(list: Vec2[], tile: Vec2) {
  const i = list.findIndex(s => s.x === tile.x && s.y === tile.y);
  if (i >= 0) list.splice(i, 1);
  else list.push(tile);
}

function normalizeHex(h: string | undefined): string | null {
  if (!h) return null;
  const m = h.trim();
  if (!/^#[0-9a-fA-F]{6}$/.test(m)) return null;
  return m.toLowerCase();
}

function hexWithAlpha(hex: string, alpha: number): string {
  const a = Math.round(alpha * 255).toString(16).padStart(2, "0");
  return `${hex}${a}`;
}

export function loadCustomMap(): GameMap | null {
  const stored = localStorage.getItem(CUSTOM_MAP_KEY);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as GameMap;
    // Light sanity check.
    if (!Array.isArray(parsed.walls) || !parsed.width || !parsed.height) return null;
    return parsed;
  } catch {
    return null;
  }
}
