import { Application, Container, Graphics, Text } from "pixi.js";
import type { DroppedWeapon, Flash, GameMap, GrenadeInFlight, HE, Molotov, Side, Smoke, SmokeHole, Vec2, WeaponId } from "../domain/types.ts";
import type { TickShot } from "../sim/round.ts";
import { WEAPONS } from "../domain/weapons.ts";

// Subset of state the renderer reads — satisfied by both live RoundSim and a replay snapshot.
export interface SimView {
  t: number;
  map: GameMap;
  agents: Array<{
    playerId: string; side: Side; pos: Vec2; facing: number;
    hp: number; armor: number; helmet: boolean; alive: boolean;
    weapon: WeaponId; ammo: number; reloadingUntil: number;
    blindedUntil: number;
    moveMode: "walk" | "run";
  }>;
  smokes: Smoke[];
  flashes: Flash[];
  tickFlashes: { pos: Vec2; side: Side }[];
  molotovs: Molotov[];
  hes: HE[];
  tickHEs: { pos: Vec2; side: Side }[];
  smokeHoles: SmokeHole[];
  grenadeFlights: GrenadeInFlight[];
  drops: DroppedWeapon[];
  bombPlanted: boolean;
  bombPlantedAt: Vec2 | null;
  bombCarrier: string | null;
  bombDropped: Vec2 | null;
  bombPlantedTime: number;
  bombDefuseProgress: number;
  defuseTimeMs: number;
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
  private lastFlashes: { pos: { x: number; y: number }; t: number }[] = [];
  private lastHEs: { pos: { x: number; y: number }; t: number }[] = [];
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
    this.lastFlashes.length = 0;
    this.lastHEs.length = 0;
    this.fxLayer.removeChildren();
  }

  syncAgents(sim: SimView) {
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
    // Drain new flash detonations
    for (const f of sim.tickFlashes) {
      this.lastFlashes.push({ pos: { x: f.pos.x, y: f.pos.y }, t: now });
    }
    // Drain new HE detonations
    for (const h of sim.tickHEs) {
      this.lastHEs.push({ pos: { x: h.pos.x, y: h.pos.y }, t: now });
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
      if (a.armor > 0) {
        const ringColor = a.helmet ? 0xe3a857 : 0xd2d5db;
        g.circle(a.pos.x, a.pos.y, 9.5).stroke({ color: ringColor, width: 1.5, alpha: Math.min(1, a.armor / 100) });
      }
      // Blinded indicator: pulsing bright white outer ring.
      if (a.blindedUntil > sim.t) {
        const phase = (performance.now() % 350) / 350;
        const alpha = 0.5 + 0.4 * Math.sin(phase * Math.PI * 2);
        g.circle(a.pos.x, a.pos.y, 12).stroke({ color: 0xffffff, width: 2, alpha });
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
      const color = sm.side === "CT" ? 0xd0d4da : 0xa89682; // white-grey / brown-grey
      smokeGfx.circle(sm.pos.x, sm.pos.y, sm.radius).fill({ color, alpha: 0.85 * fade });
    }
    this.smokeLayer.addChild(smokeGfx);

    // Smoke countdown labels
    for (const sm of sim.smokes) {
      const remaining = Math.max(0, sm.expiresAt - sim.t);
      const label = new Text({
        text: (remaining / 1000).toFixed(1),
        style: { fill: 0x111418, fontSize: 11, fontWeight: "bold", fontFamily: "ui-sans-serif" },
      });
      label.anchor.set(0.5);
      label.x = sm.pos.x;
      label.y = sm.pos.y;
      label.alpha = 0.85;
      this.smokeLayer.addChild(label);
    }

    // Grenades in flight — arc body + ground shadow.
    const flightGfx = new Graphics();
    for (const g of sim.grenadeFlights) {
      const phase = Math.max(0, Math.min(1, (sim.t - g.startedAt) / (g.landsAt - g.startedAt)));
      const gx = g.start.x + (g.landing.x - g.start.x) * phase;
      const gy = g.start.y + (g.landing.y - g.start.y) * phase;
      const arc = Math.sin(phase * Math.PI) * 28;
      // Shadow on the ground
      flightGfx.circle(gx, gy, 2.5).fill({ color: 0x000000, alpha: 0.35 });
      // Body lifted by the arc
      flightGfx.circle(gx, gy - arc, 3.5)
        .fill({ color: grenadeColor(g.kind) })
        .stroke({ color: 0x111418, width: 0.6, alpha: 0.8 });
    }
    this.smokeLayer.addChild(flightGfx);

    // Active molotov fires — flickering orange/red layered circles.
    const fireGfx = new Graphics();
    const fireNow = performance.now();
    for (const m of sim.molotovs) {
      const igniteAt = m.expiresAt - 7000;
      // Fuse phase: small spark dot, not yet a fire.
      if (sim.t < igniteAt) {
        fireGfx.circle(m.pos.x, m.pos.y, 3).fill({ color: 0xffa030, alpha: 0.9 });
        continue;
      }
      const remaining = m.expiresAt - sim.t;
      const fade = Math.min(1, remaining / 1500);
      const phase = ((fireNow * 0.005) + m.pos.x * 0.13 + m.pos.y * 0.07) % (Math.PI * 2);
      const flicker = 0.75 + 0.25 * Math.sin(phase * 3.1);
      // Outer orange aura
      fireGfx.circle(m.pos.x, m.pos.y, m.radius).fill({ color: 0xff6b1f, alpha: 0.55 * fade * flicker });
      // Mid red puff
      fireGfx.circle(m.pos.x + Math.sin(phase) * 6, m.pos.y - Math.cos(phase) * 4, m.radius * 0.75)
        .fill({ color: 0xff2a10, alpha: 0.65 * fade * flicker });
      // Bright core
      fireGfx.circle(m.pos.x - Math.sin(phase) * 3, m.pos.y + Math.cos(phase) * 3, m.radius * 0.45)
        .fill({ color: 0xffd060, alpha: 0.55 * fade * flicker });
    }
    this.smokeLayer.addChild(fireGfx);

    // Pending flashes (pre-detonation grenades) — small pulsing white dot.
    const inFlightGfx = new Graphics();
    for (const f of sim.flashes) {
      const phase = (performance.now() % 300) / 300;
      const radius = 3 + Math.sin(phase * Math.PI * 2) * 1.5;
      inFlightGfx.circle(f.pos.x, f.pos.y, radius).fill(0xfff8df).stroke({ color: 0x666666, width: 0.6 });
    }
    this.smokeLayer.addChild(inFlightGfx);

    // Detonation bursts — expanding white circle over ~400ms.
    this.lastFlashes = this.lastFlashes.filter(f => now - f.t < 450);
    const flashFxGfx = new Graphics();
    for (const f of this.lastFlashes) {
      const age = (now - f.t) / 450;
      const radius = 30 + age * 320;
      const alpha = 0.85 * (1 - age);
      flashFxGfx.circle(f.pos.x, f.pos.y, radius).fill({ color: 0xffffff, alpha });
    }
    this.fxLayer.addChild(flashFxGfx);

    // Pending HEs — small dark dot at the spot.
    const hePreGfx = new Graphics();
    for (const h of sim.hes) {
      hePreGfx.circle(h.pos.x, h.pos.y, 3).fill({ color: 0x4a4f5a }).stroke({ color: 0x111418, width: 0.5 });
    }
    this.smokeLayer.addChild(hePreGfx);

    // HE detonation bursts — orange-red expanding ring over ~500ms.
    this.lastHEs = this.lastHEs.filter(h => now - h.t < 500);
    const heFxGfx = new Graphics();
    for (const h of this.lastHEs) {
      const age = (now - h.t) / 500;
      const radius = 24 + age * 130;
      const alpha = 0.9 * (1 - age);
      heFxGfx.circle(h.pos.x, h.pos.y, radius).stroke({ color: 0xff5e1a, width: 4, alpha });
      heFxGfx.circle(h.pos.x, h.pos.y, radius * 0.55).fill({ color: 0xffb060, alpha: alpha * 0.5 });
    }
    this.fxLayer.addChild(heFxGfx);

    // Smoke holes — darker translucent circle where smoke is currently punctured.
    const holeGfx = new Graphics();
    for (const h of sim.smokeHoles) {
      const remaining = h.expiresAt - sim.t;
      const fade = Math.min(1, remaining / 500);
      holeGfx.circle(h.pos.x, h.pos.y, h.radius).fill({ color: 0x0a0c10, alpha: 0.6 * fade });
    }
    this.smokeLayer.addChild(holeGfx);

    // Dropped weapons
    const dropGfx = new Graphics();
    for (const d of sim.drops) {
      // Color hint by weapon
      const slot = WEAPONS[d.weapon].slot;
      const c = slot === "awp" ? 0xe35757
        : slot === "rifle" ? 0xe3a857
        : slot === "smg" ? 0xa8c8e3
        : d.weapon === "deagle" ? 0xc4a268
        : 0x7e858f;
      dropGfx.rect(d.pos.x - 4, d.pos.y - 1.5, 8, 3).fill(c).stroke({ color: 0x0a0c10, width: 0.5 });
    }
    this.smokeLayer.addChild(dropGfx); // draw above floor, under agents

    // Bomb
    this.bombGfx.clear();
    if (sim.bombPlanted && sim.bombPlantedAt) {
      const pulse = 0.6 + 0.4 * Math.sin(performance.now() / 150);
      this.bombGfx.circle(sim.bombPlantedAt.x, sim.bombPlantedAt.y, 6).fill({ color: COLORS.bomb, alpha: pulse });
      // Defuse progress ring
      if (sim.bombDefuseProgress > 0) {
        const frac = Math.min(1, sim.bombDefuseProgress / sim.defuseTimeMs);
        const ringR = 16;
        this.bombGfx.circle(sim.bombPlantedAt.x, sim.bombPlantedAt.y, ringR)
          .stroke({ color: 0x4a90e2, width: 2, alpha: 0.4 });
        // Filled arc as a wedge of small dots — Pixi Graphics has arc() in v8.
        this.bombGfx.arc(sim.bombPlantedAt.x, sim.bombPlantedAt.y, ringR, -Math.PI / 2, -Math.PI / 2 + frac * Math.PI * 2)
          .stroke({ color: 0x4a90e2, width: 3 });
        const remaining = Math.max(0, (sim.defuseTimeMs - sim.bombDefuseProgress) / 1000);
        const label = new Text({
          text: remaining.toFixed(1),
          style: { fill: 0xffffff, fontSize: 11, fontWeight: "bold", fontFamily: "ui-sans-serif" },
        });
        label.anchor.set(0.5);
        label.x = sim.bombPlantedAt.x;
        label.y = sim.bombPlantedAt.y - 26;
        this.smokeLayer.addChild(label);
      }
    } else if (sim.bombDropped) {
      const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 220);
      this.bombGfx.circle(sim.bombDropped.x, sim.bombDropped.y, 22).fill({ color: 0xf5c842, alpha: 0.18 * pulse });
      this.bombGfx.circle(sim.bombDropped.x, sim.bombDropped.y, 13).fill({ color: 0xf5c842, alpha: 0.35 });
      this.bombGfx.circle(sim.bombDropped.x, sim.bombDropped.y, 4).fill({ color: 0xf5c842 });
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
    case "deagle": return "DE";
    case "mp9":    return "MP9";
    case "mac10":  return "MAC";
    case "m4":     return "M4";
    case "ak":     return "AK";
    case "awp":    return "AWP";
    default:       return "";
  }
}

function grenadeColor(kind: string): number {
  switch (kind) {
    case "smoke":   return 0xcfd3da;
    case "flash":   return 0xfff8df;
    case "molotov": return 0xff6b1f;
    case "he":      return 0x6b707b;
    default:        return 0xffffff;
  }
}
