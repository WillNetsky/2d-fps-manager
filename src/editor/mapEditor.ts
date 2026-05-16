import type { GameMap, Vec2 } from "../domain/types.ts";
import { makeMap } from "../domain/factory.ts";

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

function makeBlankMap(): GameMap {
  const base = makeMap();
  return {
    name: "Untitled",
    width: base.width,
    height: base.height,
    tileSize: base.tileSize,
    walls: new Array(base.width * base.height).fill(true),
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
    mkBtn("Reset to default", "", () => {
      this.map = makeMap();
      this.currentName = this.map.name || "Default";
      this.updateNameLabel();
      this.draw();
    });
    mkBtn("Clear (all walls)", "", () => { this.clearMap(); this.draw(); });
    mkBtn("Back to game", "", () => { window.location.hash = ""; window.location.reload(); });
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
    this.map.walls = new Array(this.map.width * this.map.height).fill(true);
    this.map.ctSpawns = [];
    this.map.tSpawns = [];
    this.map.bombsites = [];
  }

  private updateNameLabel() {
    if (this.nameLabel) this.nameLabel.textContent = `Current: ${this.currentName}`;
  }

  private newMap() {
    if (!confirm("Discard current map and start a new blank one?")) return;
    this.map = makeBlankMap();
    this.currentName = "Untitled";
    this.map.name = this.currentName;
    this.updateNameLabel();
    this.draw();
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

  private loadMapDialog() {
    const maps = loadSavedMaps();
    const names = Object.keys(maps).sort();
    if (!names.length) { alert("No saved maps yet. Use Save As… first."); return; }
    const list = names.map((n, i) => `${i + 1}. ${n}`).join("\n");
    const choice = prompt(`Load which map? (enter number or name)\n\n${list}\n\nType 'del N' to delete entry N.`);
    if (!choice) return;
    const trimmed = choice.trim();
    if (/^del\s+/i.test(trimmed)) {
      const rest = trimmed.replace(/^del\s+/i, "").trim();
      const idx = Number(rest);
      const target = !isNaN(idx) && idx >= 1 && idx <= names.length ? names[idx - 1] : (maps[rest] ? rest : null);
      if (!target) { alert("No matching map to delete."); return; }
      if (!confirm(`Delete "${target}"?`)) return;
      delete maps[target];
      writeSavedMaps(maps);
      return;
    }
    const asNum = Number(trimmed);
    const name = !isNaN(asNum) && asNum >= 1 && asNum <= names.length ? names[asNum - 1] : (maps[trimmed] ? trimmed : null);
    if (!name) { alert("No matching map."); return; }
    this.map = JSON.parse(JSON.stringify(maps[name])) as GameMap;
    this.currentName = name;
    this.map.name = name;
    this.updateNameLabel();
    this.draw();
  }

  private playMap() {
    if (this.map.ctSpawns.length < 5) return alert("Need at least 5 CT spawns.");
    if (this.map.tSpawns.length < 5) return alert("Need at least 5 T spawns.");
    if (!this.map.bombsites.find(s => s.id === "A")) return alert("Place bombsite A.");
    if (!this.map.bombsites.find(s => s.id === "B")) return alert("Place bombsite B.");

    // Reject spawn tiles painted on walls.
    const onWall = (t: Vec2) => this.map.walls[t.y * this.map.width + t.x];
    if (this.map.ctSpawns.some(onWall)) return alert("Some CT spawn tiles are on walls — clear the floor under them.");
    if (this.map.tSpawns.some(onWall)) return alert("Some T spawn tiles are on walls — clear the floor under them.");
    for (const s of this.map.bombsites) {
      if (onWall(s.center)) return alert(`Bombsite ${s.id} is on a wall — move it to a floor tile.`);
    }

    // Connectivity check: every spawn must reach every bombsite.
    const issue = this.checkConnectivity();
    if (issue) return alert(issue);

    localStorage.setItem(CUSTOM_MAP_KEY, JSON.stringify(this.map));
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
    ctx.fillStyle = "#0a0c10";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Tiles
    for (let y = 0; y < this.map.height; y++) {
      for (let x = 0; x < this.map.width; x++) {
        const wall = this.map.walls[y * this.map.width + x];
        ctx.fillStyle = wall ? "#3a414f" : "#1a1e27";
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
