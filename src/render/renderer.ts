import { Application, Container, Graphics, Text } from "pixi.js";
import type { DroppedWeapon, GameMap, Side, Smoke, Vec2, WeaponId } from "../domain/types.ts";
import type { TickShot } from "../sim/round.ts";

// Subset of state the renderer reads — satisfied by both live RoundSim and a replay snapshot.
export interface SimView {
  t: number;
  map: GameMap;
  agents: Array<{
    playerId: string; side: Side; pos: Vec2; facing: number;
    hp: number; armor: number; helmet: boolean; alive: boolean;
    weapon: WeaponId; ammo: number; reloadingUntil: number;
    moveMode: "walk" | "run";
  }>;
  smokes: Smoke[];
  drops: DroppedWeapon[];
  bombPlanted: boolean;
  bombPlantedAt: Vec2 | null;
  bombCarrier: string | null;
  bombPlantedTime: number;
  tickShots: TickShot[];
}

const COLORS = {
  bg: 0x0a0c10,
  floor: 0x1a1e27,
  wall: 0x3a414f,
  ct: 0x4a90e2,
  t: 0xc9692e,
  bomb: 0xe3a857,
  site: 0x2a2f3a,
  shotCt: 0x9ec2ee,
  shotT: 0xefb98e,
};

export class Renderer {
  app: Application;
  private mapLayer: Container;
  private smokeLayer: Container;
  private fxLayer: Container;
  private agentLayer: Container;
  private uiLayer: Container;
  private agentGfx = new Map<string, Graphics>();
  private hpBars = new Map<string, Graphics>();
  private nameTexts = new Map<string, Text>();
  private weaponTexts = new Map<string, Text>();
  private nameFor: (id: string) => string = () => "";
  private bombGfx: Graphics;
  private siteText: Text | null = null;
  private map!: GameMap;
  private lastShots: { from: { x: number; y: number }; to: { x: number; y: number }; side: "CT" | "T"; t: number; hit: boolean }[] = [];
  private timeText: Text;

  constructor() {
    this.app = new Application();
    this.mapLayer = new Container();
    this.smokeLayer = new Container();
    this.fxLayer = new Container();
    this.agentLayer = new Container();
    this.uiLayer = new Container();
    this.bombGfx = new Graphics();
    this.timeText = new Text({ text: "", style: { fill: 0xe6e8ee, fontSize: 12, fontFamily: "ui-monospace, monospace" } });
  }

  async init(parent: HTMLElement, map: GameMap) {
    this.map = map;
    await this.app.init({
      width: map.width * map.tileSize,
      height: map.height * map.tileSize,
      background: COLORS.bg,
      antialias: true,
    });
    parent.appendChild(this.app.canvas);
    this.app.stage.addChild(this.mapLayer);
    this.app.stage.addChild(this.smokeLayer);
    this.app.stage.addChild(this.fxLayer);
    this.app.stage.addChild(this.agentLayer);
    this.app.stage.addChild(this.uiLayer);
    this.uiLayer.addChild(this.timeText);
    this.timeText.x = 8;
    this.timeText.y = 8;
    this.drawMap();
    this.agentLayer.addChild(this.bombGfx);
  }

  setNameFor(fn: (id: string) => string) { this.nameFor = fn; }

  private drawMap() {
    const g = new Graphics();
    const ts = this.map.tileSize;
    // floor
    g.rect(0, 0, this.map.width * ts, this.map.height * ts).fill(COLORS.floor);
    // bombsites
    for (const s of this.map.bombsites) {
      g.circle((s.center.x + 0.5) * ts, (s.center.y + 0.5) * ts, s.radius * ts).fill({ color: COLORS.site, alpha: 0.6 });
    }
    // walls
    for (let y = 0; y < this.map.height; y++) {
      for (let x = 0; x < this.map.width; x++) {
        if (this.map.walls[y * this.map.width + x]) {
          g.rect(x * ts, y * ts, ts, ts).fill(COLORS.wall);
        }
      }
    }
    this.mapLayer.addChild(g);

    // Site labels
    for (const s of this.map.bombsites) {
      const t = new Text({
        text: s.id,
        style: { fill: 0xffffff, fontSize: 24, fontWeight: "bold", fontFamily: "ui-sans-serif" },
      });
      t.alpha = 0.25;
      t.anchor.set(0.5);
      t.x = (s.center.x + 0.5) * ts;
      t.y = (s.center.y + 0.5) * ts;
      this.mapLayer.addChild(t);
    }

    // Spawn zones — tinted bounding box + label per side.
    const drawSpawn = (tiles: { x: number; y: number }[], color: number, label: string) => {
      if (!tiles.length) return;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const tile of tiles) {
        minX = Math.min(minX, tile.x); minY = Math.min(minY, tile.y);
        maxX = Math.max(maxX, tile.x); maxY = Math.max(maxY, tile.y);
      }
      const x = minX * ts, y = minY * ts;
      const w = (maxX - minX + 1) * ts, h = (maxY - minY + 1) * ts;
      const zone = new Graphics();
      zone.rect(x, y, w, h).fill({ color, alpha: 0.18 }).stroke({ color, width: 1, alpha: 0.5 });
      this.mapLayer.addChild(zone);
      const t = new Text({
        text: label,
        style: { fill: color, fontSize: 11, fontWeight: "bold", letterSpacing: 2 },
      });
      t.alpha = 0.85;
      t.anchor.set(0.5);
      t.x = x + w / 2;
      t.y = y + h / 2;
      this.mapLayer.addChild(t);
    };
    drawSpawn(this.map.ctSpawns, COLORS.ct, "CT");
    drawSpawn(this.map.tSpawns, COLORS.t, "T");
  }

  // Clear transient render state (used when switching between live and replay).
  clearTransient() {
    this.lastShots.length = 0;
    this.fxLayer.removeChildren();
  }

  syncAgents(sim: SimView) {
    // Drain new shots from sim → render buffer
    const now = performance.now();
    for (const s of sim.tickShots) {
      this.lastShots.push({
        from: { x: s.from.x, y: s.from.y },
        to: { x: s.to.x, y: s.to.y },
        side: s.side,
        t: now,
        hit: s.hit,
      });
    }

    for (const a of sim.agents) {
      const color = a.side === "CT" ? COLORS.ct : COLORS.t;
      let g = this.agentGfx.get(a.playerId);
      if (!g) {
        g = new Graphics();
        this.agentGfx.set(a.playerId, g);
        this.agentLayer.addChild(g);
        const hp = new Graphics();
        this.hpBars.set(a.playerId, hp);
        this.agentLayer.addChild(hp);
        const name = new Text({
          text: this.nameFor(a.playerId),
          style: { fill: color, fontSize: 9, fontFamily: "ui-sans-serif", fontWeight: "600" },
        });
        name.anchor.set(0.5, 1);
        this.nameTexts.set(a.playerId, name);
        this.agentLayer.addChild(name);
        const wlabel = new Text({
          text: "",
          style: { fill: 0xffffff, fontSize: 8, fontFamily: "ui-monospace, monospace", fontWeight: "700" },
        });
        wlabel.anchor.set(0.5, 0);
        this.weaponTexts.set(a.playerId, wlabel);
        this.agentLayer.addChild(wlabel);
      }
      g.clear();
      const hp = this.hpBars.get(a.playerId)!;
      hp.clear();
      const name = this.nameTexts.get(a.playerId)!;
      const wlabel = this.weaponTexts.get(a.playerId)!;

      if (!a.alive) {
        g.circle(a.pos.x, a.pos.y, 6).fill({ color: 0x444a55, alpha: 0.6 });
        name.x = a.pos.x; name.y = a.pos.y - 11;
        name.alpha = 0.35;
        wlabel.text = "";
        continue;
      }

      // Footstep ring (only while running) — pulses outward.
      if (a.moveMode === "run") {
        const phase = (performance.now() % 600) / 600;
        const radius = 9 + phase * 14;
        const alpha = 0.35 * (1 - phase);
        g.circle(a.pos.x, a.pos.y, radius).stroke({ color, width: 1.5, alpha });
      }
      // Armor indicator: outer ring whose opacity tracks remaining armor.
      // Helmet shows as a gold-tinted ring; vest-only is light gray.
      if (a.armor > 0) {
        const ringColor = a.helmet ? 0xe3a857 : 0xd2d5db;
        g.circle(a.pos.x, a.pos.y, 9.5).stroke({ color: ringColor, width: 1.5, alpha: Math.min(1, a.armor / 100) });
      }
      // body
      g.circle(a.pos.x, a.pos.y, 7).fill(color).stroke({ color: 0x111418, width: 1.5 });
      // facing tick
      const fx = a.pos.x + Math.cos(a.facing) * 12;
      const fy = a.pos.y + Math.sin(a.facing) * 12;
      g.moveTo(a.pos.x, a.pos.y).lineTo(fx, fy).stroke({ color, width: 2 });
      // hp bar
      const w = 18;
      const ratio = Math.max(0, a.hp / 100);
      hp.rect(a.pos.x - w / 2, a.pos.y - 14, w, 2).fill(0x222831);
      hp.rect(a.pos.x - w / 2, a.pos.y - 14, w * ratio, 2).fill(0x6bbf59);
      // name above
      name.x = a.pos.x; name.y = a.pos.y - 17;
      name.alpha = 1;
      // weapon below — show "reloading…" while in reload, normal abbrev otherwise
      const reloading = a.reloadingUntil > sim.t;
      wlabel.text = reloading ? "↻" : weaponAbbrev(a.weapon);
      wlabel.style.fill = reloading ? 0xe3a857 : 0xffffff;
      wlabel.x = a.pos.x; wlabel.y = a.pos.y + 9;
      wlabel.alpha = 0.85;
    }

    // Smokes
    this.smokeLayer.removeChildren();
    const smokeGfx = new Graphics();
    for (const sm of sim.smokes) {
      const remaining = sm.expiresAt - sim.t;
      const fade = Math.min(1, remaining / 1500);
      // Soft puffy circle: a few overlapping discs
      const baseAlpha = 0.85 * fade;
      smokeGfx.circle(sm.pos.x, sm.pos.y, sm.radius).fill({ color: 0xc8ccd2, alpha: baseAlpha });
      smokeGfx.circle(sm.pos.x - sm.radius * 0.35, sm.pos.y - sm.radius * 0.15, sm.radius * 0.8)
        .fill({ color: 0xb8bdc6, alpha: baseAlpha * 0.7 });
      smokeGfx.circle(sm.pos.x + sm.radius * 0.3, sm.pos.y + sm.radius * 0.25, sm.radius * 0.75)
        .fill({ color: 0xd2d5db, alpha: baseAlpha * 0.6 });
    }
    this.smokeLayer.addChild(smokeGfx);

    // Dropped weapons
    const dropGfx = new Graphics();
    for (const d of sim.drops) {
      // Color hint by weapon
      const c = d.weapon === "awp" ? 0xe35757
        : d.weapon === "rifle" ? 0xe3a857
        : d.weapon === "smg" ? 0xa8c8e3
        : 0x7e858f;
      dropGfx.rect(d.pos.x - 4, d.pos.y - 1.5, 8, 3).fill(c).stroke({ color: 0x0a0c10, width: 0.5 });
    }
    this.smokeLayer.addChild(dropGfx); // draw above floor, under agents

    // Bomb
    this.bombGfx.clear();
    if (sim.bombPlanted && sim.bombPlantedAt) {
      const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 150);
      this.bombGfx.circle(sim.bombPlantedAt.x, sim.bombPlantedAt.y, 6).fill({ color: COLORS.bomb, alpha: pulse });
    } else if (sim.bombCarrier) {
      const carrier = sim.agents.find(x => x.playerId === sim.bombCarrier && x.alive);
      if (carrier) {
        this.bombGfx.circle(carrier.pos.x + 8, carrier.pos.y - 8, 3).fill(COLORS.bomb);
      }
    }

    // Shot fx — decay (~200ms)
    this.fxLayer.removeChildren();
    this.lastShots = this.lastShots.filter(s => now - s.t < 200);
    const fx = new Graphics();
    for (const s of this.lastShots) {
      const a = 1 - (now - s.t) / 200;
      const color = s.side === "CT" ? COLORS.shotCt : COLORS.shotT;
      fx.moveTo(s.from.x, s.from.y).lineTo(s.to.x, s.to.y)
        .stroke({ color, width: s.hit ? 1.5 : 1, alpha: a * (s.hit ? 1 : 0.55) });
      // Impact dot on hits
      if (s.hit) fx.circle(s.to.x, s.to.y, 2).fill({ color: 0xffe7a8, alpha: a });
    }
    this.fxLayer.addChild(fx);

    // Time
    const sec = Math.max(0, Math.ceil((90_000 - sim.t) / 1000));
    this.timeText.text = sim.bombPlanted
      ? `BOMB ${Math.max(0, Math.ceil((30_000 - (sim.t - sim.bombPlantedTime)) / 1000))}s`
      : `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
  }

  flashSite(site: "A" | "B") {
    if (this.siteText) this.siteText.destroy();
    const s = this.map.bombsites.find(x => x.id === site);
    if (!s) return;
    const t = new Text({
      text: `${site} PLANTED`,
      style: { fill: 0xe3a857, fontSize: 20, fontWeight: "bold" },
    });
    t.anchor.set(0.5);
    t.x = (s.center.x + 0.5) * this.map.tileSize;
    t.y = (s.center.y + 0.5) * this.map.tileSize - 30;
    this.uiLayer.addChild(t);
    this.siteText = t;
    setTimeout(() => { t.destroy(); if (this.siteText === t) this.siteText = null; }, 1500);
  }

  destroy() { this.app.destroy(true, { children: true }); }
}

function weaponAbbrev(w: string): string {
  switch (w) {
    case "pistol": return "P";
    case "smg":    return "SMG";
    case "rifle":  return "R";
    case "awp":    return "AWP";
    default:       return "";
  }
}
