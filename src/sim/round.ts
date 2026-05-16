import type {
  Agent, DroppedWeapon, GameMap, Player, RoundResult, Side, SimEvent, SiteAssignment, Smoke, TStrategy, Team, Vec2,
} from "../domain/types.ts";
import { HEADSHOT_BASE, HEADSHOT_MULTIPLIER, HELMET_HS_REDUCTION, WEAPONS } from "../domain/weapons.ts";
import { findPath } from "./pathfind.ts";

const TICK_MS = 50;
const ROUND_TIME_MS = 90_000;
const BOMB_TIMER_MS = 30_000;
const PLANT_TIME_MS = 3000;
const DEFUSE_TIME_MS = 5000;

const SMOKE_DURATION_MS = 14_000;
const SMOKE_RADIUS_WORLD = 60; // ~2 tiles

const TRADE_WINDOW_MS = 2000;
const TRADE_AIM_BONUS = 0.15;

const INTEL_DECAY = 0.985;       // per tick (~26% / second)
const INTEL_BUMP = 1;            // per visible enemy per tick
const INTEL_CAP = 5;
const INTEL_DOMINANCE = 1.0;     // diff to trigger rotation
const ROTATE_MIN_T = 6000;       // don't rotate in first N ms of round
const ROTATE_LOG_COOLDOWN = 4000;

const VISION_RANGE = 540;        // pixels — uniform sight distance, independent of weapon
const HEARING_RANGE = 240;       // pixels — enemy footsteps audible within this
const SOUND_INTEL_BUMP = 0.5;    // less precise than LOS sighting
const WALK_SPEED_FACTOR = 0.55;
const CONTACT_RADIUS = 220;      // walk when within this of assigned contact zone

type SiteId = "A" | "B";
interface SiteIntel { score: number; updatedAt: number; bombSeenAt: number; }
interface SideIntel { A: SiteIntel; B: SiteIntel; }

const BOMB_SIGHTING_RECENT_MS = 5000;

// Hold-angle "threat focus" — face toward enemy spawn centroid by default.
function spawnCentroid(spawns: Vec2[], tile: number): Vec2 {
  let x = 0, y = 0;
  for (const s of spawns) { x += s.x; y += s.y; }
  return { x: ((x / spawns.length) + 0.5) * tile, y: ((y / spawns.length) + 0.5) * tile };
}

interface TradeMark {
  killerId: string;
  victimSide: Side;
  expiresAt: number;
}

interface PlayerLookup { (id: string): Player | undefined; }

export interface TickShot {
  from: Vec2;
  to: Vec2;
  side: Side;
  hit: boolean;
  killerId: string;
}

export interface AgentSnapshot {
  playerId: string;
  side: Side;
  pos: Vec2;
  facing: number;
  hp: number;
  armor: number;
  helmet: boolean;
  alive: boolean;
  weapon: import("../domain/types.ts").WeaponId;
  moveMode: "walk" | "run";
}

export interface RoundSnapshot {
  t: number;
  agents: AgentSnapshot[];
  smokes: Smoke[];
  drops: import("../domain/types.ts").DroppedWeapon[];
  bombPlanted: boolean;
  bombPlantedAt: Vec2 | null;
  bombCarrier: string | null;
  bombPlantedTime: number;
  tickShots: TickShot[];
}

export class RoundSim {
  agents: Agent[] = [];
  smokes: Smoke[] = [];
  drops: DroppedWeapon[] = [];
  t = 0;
  events: SimEvent[] = [];
  finished = false;
  result: RoundResult | null = null;
  // Per-tick shots, drained by renderer each frame.
  tickShots: TickShot[] = [];
  // Per-tick snapshots — used for replay after the round ends.
  snapshots: RoundSnapshot[] = [];

  bombCarrier: string | null = null;
  bombPlanted = false;
  bombPlantedAt: Vec2 | null = null;
  bombPlantedTime = 0;
  bombDefusing: string | null = null;
  bombDefuseProgress = 0;
  planter: string | null = null;
  planting: string | null = null;
  plantProgress = 0;

  private rng: () => number;
  private players: PlayerLookup;
  private ctThreatFocus: Vec2;
  private tThreatFocus: Vec2;
  private tradeMarks: TradeMark[] = [];
  private smokeQueue: { thrower: string; spot: Vec2; throwAt: number }[] = [];
  tStrategy: TStrategy;
  ctSetup: { A: number; B: number; mid: number };
  intel: Record<Side, SideIntel> = {
    CT: {
      A: { score: 0, updatedAt: 0, bombSeenAt: -Infinity },
      B: { score: 0, updatedAt: 0, bombSeenAt: -Infinity },
    },
    T: {
      A: { score: 0, updatedAt: 0, bombSeenAt: -Infinity },
      B: { score: 0, updatedAt: 0, bombSeenAt: -Infinity },
    },
  };
  // Agent → ms timestamp of their last "rotation" log, to avoid spam.
  private lastRotationLog: Record<string, number> = {};
  // Per-agent rotation log surfaced for UI.
  rotationLog: { t: number; agentId: string; from: SiteAssignment; to: SiteId }[] = [];

  constructor(
    public ct: Team,
    public tSide: Team,
    public map: GameMap,
    seed = 12345,
  ) {
    let s = seed >>> 0;
    this.rng = () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x1_0000_0000;
    };
    const all = [...ct.players, ...tSide.players];
    this.players = (id) => all.find(p => p.id === id);
    // Each side's "hold" direction is toward the opposite spawn centroid.
    this.ctThreatFocus = spawnCentroid(map.tSpawns, map.tileSize);
    this.tThreatFocus = spawnCentroid(map.ctSpawns, map.tileSize);
    this.tStrategy = this.pickTStrategy();
    this.ctSetup = this.pickCtSetup();
    this.spawnAgents();
    this.assignBombCarrier();
    this.assignSites();
    this.scheduleSmokes();
    this.push({ t: 0, kind: "round-start" });
  }

  private pickTStrategy(): TStrategy {
    const r = this.rng();
    if (r < 0.25) return "rush-A";
    if (r < 0.5) return "rush-B";
    if (r < 0.7) return "split-A";
    if (r < 0.85) return "split-B";
    return "default";
  }

  private pickCtSetup(): { A: number; B: number; mid: number } {
    const r = this.rng();
    if (r < 0.55) return { A: 2, B: 2, mid: 1 };
    if (r < 0.8) return { A: 3, B: 2, mid: 0 };
    return { A: 2, B: 3, mid: 0 };
  }

  // Assign each agent a SiteAssignment based on strategy/setup.
  private assignSites() {
    // CTs: distribute by ctSetup. IGL gets mid if available, else a site.
    const cts = this.agents.filter(a => a.side === "CT");
    const tA = this.ctSetup.A, tB = this.ctSetup.B, tMid = this.ctSetup.mid;
    const slots: SiteAssignment[] = [
      ...Array(tA).fill("A" as SiteAssignment),
      ...Array(tB).fill("B" as SiteAssignment),
      ...Array(tMid).fill("mid" as SiteAssignment),
    ];
    // Order CTs by role priority: AWPer prefers long angles (A), IGL prefers mid.
    cts.sort((x, y) => {
      const px = this.priority(x), py = this.priority(y);
      return px - py;
    });
    cts.forEach((a, i) => { a.assignedSite = slots[i] ?? "A"; });

    // Ts: based on strategy.
    const ts = this.agents.filter(a => a.side === "T");
    let primary: "A" | "B";
    let splitOne = false;
    switch (this.tStrategy) {
      case "rush-A": primary = "A"; break;
      case "rush-B": primary = "B"; break;
      case "split-A": primary = "A"; splitOne = true; break;
      case "split-B": primary = "B"; splitOne = true; break;
      case "default":
      default:
        primary = this.rng() < 0.5 ? "A" : "B";
        splitOne = true;
        break;
    }
    // Lurker peels to opposite site if splitting.
    ts.forEach(a => {
      const player = this.players(a.playerId)!;
      if (splitOne && player.role === "lurker") {
        a.assignedSite = primary === "A" ? "B" : "A";
      } else {
        a.assignedSite = primary;
      }
    });
  }

  private priority(a: Agent): number {
    const player = this.players(a.playerId)!;
    return { awper: 0, igl: 1, support: 2, entry: 3, lurker: 4 }[player.role];
  }

  private push(e: SimEvent) { this.events.push(e); }

  private spawnAgents() {
    const make = (p: Player, side: Side, spawn: Vec2): Agent => {
      const loadout = (side === "CT" ? this.ct : this.tSide).loadouts[p.id];
      const focus = side === "CT" ? this.ctThreatFocus : this.tThreatFocus;
      const sx = (spawn.x + 0.5) * this.map.tileSize;
      const sy = (spawn.y + 0.5) * this.map.tileSize;
      return {
        playerId: p.id,
        side,
        pos: { x: sx, y: sy },
        facing: Math.atan2(focus.y - sy, focus.x - sx),
        hp: 100,
        armor: loadout.armor ? 100 : 0,
        helmet: loadout.helmet,
        weapon: loadout.weapon,
        utility: [...loadout.utility],
        alive: true,
        lastShotAt: -9999,
        target: null,
        path: [],
        spotted: {},
        holdAngle: null,
        assignedSite: "A",
        nextThinkAt: 0,
        dirty: true,
        moveMode: "run",
        lookTarget: null,
        lookChangeAt: 0,
        stance: "none",
        stanceUntil: -Infinity,
      };
    };
    this.ct.players.forEach((p, i) => this.agents.push(make(p, "CT", this.map.ctSpawns[i % this.map.ctSpawns.length])));
    this.tSide.players.forEach((p, i) => this.agents.push(make(p, "T", this.map.tSpawns[i % this.map.tSpawns.length])));
  }

  private assignBombCarrier() {
    const ts = this.agents.filter(a => a.side === "T");
    this.bombCarrier = ts[Math.floor(this.rng() * ts.length)].playerId;
  }

  private scheduleSmokes() {
    // Each agent with a smoke throws to the nearest unassigned same-side smoke spot, 1-3s after round start.
    const usedSpots = new Set<number>();
    const sortedSpots = (side: Side) => this.map.smokeSpots
      .map((sp, idx) => ({ sp, idx }))
      .filter(({ sp }) => sp.side === side);

    for (const a of this.agents) {
      if (!a.utility.includes("smoke")) continue;
      const spots = sortedSpots(a.side);
      if (!spots.length) continue;
      // Pick nearest unused
      let best: { sp: typeof spots[number]["sp"]; idx: number; d: number } | null = null;
      for (const { sp, idx } of spots) {
        if (usedSpots.has(idx)) continue;
        const wx = (sp.tile.x + 0.5) * this.map.tileSize;
        const wy = (sp.tile.y + 0.5) * this.map.tileSize;
        const d = Math.hypot(wx - a.pos.x, wy - a.pos.y);
        if (!best || d < best.d) best = { sp, idx, d };
      }
      if (!best) continue;
      usedSpots.add(best.idx);
      this.smokeQueue.push({
        thrower: a.playerId,
        spot: { x: (best.sp.tile.x + 0.5) * this.map.tileSize, y: (best.sp.tile.y + 0.5) * this.map.tileSize },
        throwAt: 1000 + this.rng() * 2000,
      });
    }
  }

  tick(): void {
    if (this.finished) return;
    this.t += TICK_MS;
    this.tickShots.length = 0;

    this.tickSmokes();
    this.updateIntel();

    for (const a of this.agents) if (a.alive) this.think(a);
    for (const a of this.agents) if (a.alive) this.move(a);
    this.checkPickups();
    for (const a of this.agents) if (a.alive) this.updateLook(a);
    for (const a of this.agents) if (a.alive) this.applyFacing(a);
    for (const a of this.agents) if (a.alive) this.maybeShoot(a);

    // Prune expired trade marks
    this.tradeMarks = this.tradeMarks.filter(m => m.expiresAt > this.t);

    this.tickBomb();
    this.captureSnapshot();
    this.checkEnd();
  }

  private captureSnapshot() {
    this.snapshots.push({
      t: this.t,
      agents: this.agents.map(a => ({
        playerId: a.playerId, side: a.side,
        pos: { x: a.pos.x, y: a.pos.y }, facing: a.facing,
        hp: a.hp, armor: a.armor, helmet: a.helmet, alive: a.alive,
        weapon: a.weapon, moveMode: a.moveMode,
      })),
      smokes: this.smokes.map(s => ({ pos: { x: s.pos.x, y: s.pos.y }, radius: s.radius, expiresAt: s.expiresAt, side: s.side })),
      drops: this.drops.map(d => ({ pos: { x: d.pos.x, y: d.pos.y }, weapon: d.weapon })),
      bombPlanted: this.bombPlanted,
      bombPlantedAt: this.bombPlantedAt ? { x: this.bombPlantedAt.x, y: this.bombPlantedAt.y } : null,
      bombCarrier: this.bombCarrier,
      bombPlantedTime: this.bombPlantedTime,
      tickShots: this.tickShots.map(s => ({
        from: { x: s.from.x, y: s.from.y }, to: { x: s.to.x, y: s.to.y },
        side: s.side, hit: s.hit, killerId: s.killerId,
      })),
    });
  }

  // ---- Intel ----
  private updateIntel() {
    // Decay
    for (const side of ["CT", "T"] as const) {
      this.intel[side].A.score *= INTEL_DECAY;
      this.intel[side].B.score *= INTEL_DECAY;
    }
    // Each living agent bumps their team's intel for each visible enemy.
    for (const a of this.agents) {
      if (!a.alive) continue;
      for (const e of this.agents) {
        if (!e.alive || e.side === a.side) continue;
        if (dist(a.pos, e.pos) > VISION_RANGE) continue;
        if (!this.hasLineOfSight(a.pos, e.pos)) continue;
        const site = this.nearestSiteId(e.pos);
        const intel = this.intel[a.side][site];
        intel.score = Math.min(INTEL_CAP, intel.score + INTEL_BUMP);
        intel.updatedAt = this.t;
        // Spotting the bomb carrier is a much stronger signal than any other sighting.
        if (e.playerId === this.bombCarrier) {
          intel.bombSeenAt = this.t;
        }
      }
    }
    // Sound: running agents leak intel to enemies within hearing range (no LOS required).
    for (const a of this.agents) {
      if (!a.alive || a.moveMode !== "run") continue;
      for (const e of this.agents) {
        if (!e.alive || e.side === a.side) continue;
        if (dist(a.pos, e.pos) > HEARING_RANGE) continue;
        const site = this.nearestSiteId(a.pos);
        const intel = this.intel[e.side][site];
        intel.score = Math.min(INTEL_CAP, intel.score + SOUND_INTEL_BUMP);
        intel.updatedAt = this.t;
      }
    }
  }

  private nearestSiteId(pos: Vec2): SiteId {
    let best: SiteId = "A"; let bd = Infinity;
    for (const s of this.map.bombsites) {
      const c = worldCenterOfTile(s.center, this.map);
      const d = dist(c, pos);
      if (d < bd) { bd = d; best = s.id; }
    }
    return best;
  }

  // ---- Pickups ----
  private checkPickups() {
    for (const a of this.agents) {
      if (!a.alive) continue;
      for (let i = this.drops.length - 1; i >= 0; i--) {
        const d = this.drops[i];
        if (dist(a.pos, d.pos) > 14) continue;
        if (WEAPONS[d.weapon].cost > WEAPONS[a.weapon].cost) {
          // Drop their current gun in exchange so it's not lost to the round (and others can grab it).
          if (a.weapon !== "knife") {
            this.drops.push({ pos: { ...a.pos }, weapon: a.weapon });
          }
          a.weapon = d.weapon;
          this.drops.splice(i, 1);
          break;
        }
      }
    }
  }

  // ---- Smokes ----
  private tickSmokes() {
    // Deploy queued smokes
    for (let i = this.smokeQueue.length - 1; i >= 0; i--) {
      const q = this.smokeQueue[i];
      if (this.t >= q.throwAt) {
        const thrower = this.agents.find(a => a.playerId === q.thrower && a.alive);
        if (thrower) {
          this.smokes.push({
            pos: { ...q.spot },
            radius: SMOKE_RADIUS_WORLD,
            expiresAt: this.t + SMOKE_DURATION_MS,
            side: thrower.side,
          });
          // Consume the smoke from inventory
          const idx = thrower.utility.indexOf("smoke");
          if (idx >= 0) thrower.utility.splice(idx, 1);
        }
        this.smokeQueue.splice(i, 1);
      }
    }
    // Expire smokes
    this.smokes = this.smokes.filter(s => s.expiresAt > this.t);
  }

  // ---- AI ----
  private think(a: Agent) {
    const arrived = a.target && a.path.length === 0 && dist(a.pos, a.target) < 6;
    const needNew = !a.target || arrived || a.dirty || this.t >= a.nextThinkAt;
    if (!needNew) return;

    const goal = this.pickGoal(a);
    if (goal) this.setGoal(a, goal);

    // Periodic reassessment cadence — lower gameSense reconsiders less often.
    const player = this.players(a.playerId)!;
    const period = 1200 + (100 - player.stats.gameSense) * 12 + this.rng() * 800;
    a.nextThinkAt = this.t + period;
    a.dirty = false;

    if (a.target && dist(a.pos, a.target) < 6) {
      a.holdAngle = this.holdDirectionFor(a);
    }

    this.decideMoveMode(a);
  }

  private decideMoveMode(a: Agent) {
    const player = this.players(a.playerId)!;
    // Lurkers sneak by default.
    if (player.role === "lurker") { a.moveMode = "walk"; return; }
    // Carrier wants to move fast to plant; only walks near the actual site.
    const contact = this.contactZoneFor(a);
    const d = dist(a.pos, contact);
    a.moveMode = d < CONTACT_RADIUS ? "walk" : "run";
  }

  private contactZoneFor(a: Agent): Vec2 {
    if (this.bombPlanted && this.bombPlantedAt) return this.bombPlantedAt;
    if (a.assignedSite === "mid") {
      return { x: this.map.width * this.map.tileSize * 0.45, y: this.map.height * this.map.tileSize * 0.5 };
    }
    const site = this.siteByLetter(a.assignedSite);
    return worldCenterOfTile(site.center, this.map);
  }

  private pickGoal(a: Agent): Vec2 | null {
    if (a.side === "T") return this.tGoal(a);
    return this.ctGoal(a);
  }

  private tGoal(a: Agent): Vec2 | null {
    // Post-plant: hold around the planted bomb.
    if (this.bombPlanted && this.bombPlantedAt) {
      return jitter(this.bombPlantedAt, 70, this.rng);
    }

    // Intel-driven rotation: Ts prefer the lighter (less CT-defended) site.
    const player = this.players(a.playerId)!;
    const intel = this.intel.T;
    const sA = intel.A.score, sB = intel.B.score;
    const dominanceNeeded = INTEL_DOMINANCE * (1 - (player.stats.gameSense - 60) / 200);
    let preferred: SiteId | "mid" = a.assignedSite;
    const canRotate = (player.role !== "lurker" || a.playerId === this.bombCarrier) && this.t >= ROTATE_MIN_T;
    if (canRotate) {
      // Lighter side wins: A heavy → go B; B heavy → go A.
      if (sA - sB >= dominanceNeeded) preferred = "B";
      else if (sB - sA >= dominanceNeeded) preferred = "A";
    }
    if (preferred !== a.assignedSite && preferred !== "mid") {
      const last = this.lastRotationLog[a.playerId] ?? -Infinity;
      if (this.t - last >= ROTATE_LOG_COOLDOWN) {
        this.rotationLog.push({ t: this.t, agentId: a.playerId, from: a.assignedSite, to: preferred });
        this.lastRotationLog[a.playerId] = this.t;
      }
      a.assignedSite = preferred;
    }

    // Bomb carrier: head straight to assigned site.
    if (a.playerId === this.bombCarrier) {
      const site = this.siteByLetter(a.assignedSite === "mid" ? "A" : a.assignedSite);
      return worldCenterOfTile(site.center, this.map);
    }
    // Others jitter near assigned site.
    const target = a.assignedSite === "mid" ? this.map.bombsites[0] : this.siteByLetter(a.assignedSite);
    return jitter(worldCenterOfTile(target.center, this.map), 80, this.rng);
  }

  private ctGoal(a: Agent): Vec2 | null {
    // Bomb planted: rotate to the bomb's actual location, regardless of original assignment.
    if (this.bombPlanted && this.bombPlantedAt) {
      return jitter(this.bombPlantedAt, 80, this.rng);
    }
    // Intel-driven rotation: prefer the site with decisively more enemy activity.
    const player = this.players(a.playerId)!;
    const intel = this.intel.CT;
    const sA = intel.A.score, sB = intel.B.score;
    const dominanceNeeded = INTEL_DOMINANCE * (1 - (player.stats.gameSense - 60) / 200);
    let preferred: SiteId | "mid" = a.assignedSite;

    // Bomb sightings override everything — chase the bomb regardless of timing or score weight.
    const bombA = this.t - intel.A.bombSeenAt < BOMB_SIGHTING_RECENT_MS;
    const bombB = this.t - intel.B.bombSeenAt < BOMB_SIGHTING_RECENT_MS;
    if (bombA && !bombB) preferred = "A";
    else if (bombB && !bombA) preferred = "B";
    else if (bombA && bombB) preferred = intel.A.bombSeenAt > intel.B.bombSeenAt ? "A" : "B";
    else if (this.t >= ROTATE_MIN_T) {
      if (sA - sB >= dominanceNeeded) preferred = "A";
      else if (sB - sA >= dominanceNeeded) preferred = "B";
    }
    // Lurker stays anchored unless either intel is decisive OR the bomb itself is seen.
    if (player.role === "lurker" && !bombA && !bombB && Math.abs(sA - sB) < dominanceNeeded * 2) {
      preferred = a.assignedSite;
    }
    // Log rotation (rate-limited per agent)
    if (preferred !== a.assignedSite && preferred !== "mid") {
      const last = this.lastRotationLog[a.playerId] ?? -Infinity;
      if (this.t - last >= ROTATE_LOG_COOLDOWN) {
        this.rotationLog.push({ t: this.t, agentId: a.playerId, from: a.assignedSite, to: preferred });
        this.lastRotationLog[a.playerId] = this.t;
      }
      a.assignedSite = preferred; // commit the rotation
    }
    if (a.assignedSite === "mid") {
      const center: Vec2 = { x: this.map.width * this.map.tileSize * 0.45, y: this.map.height * this.map.tileSize * 0.5 };
      return jitter(center, 60, this.rng);
    }
    const site = this.siteByLetter(a.assignedSite);
    return jitter(worldCenterOfTile(site.center, this.map), 70, this.rng);
  }

  private siteByLetter(letter: "A" | "B") {
    return this.map.bombsites.find(s => s.id === letter)!;
  }

  private setGoal(a: Agent, goal: Vec2) {
    const path = findPath(this.map, a.pos, goal);
    if (path === null) { a.target = null; a.path = []; return; }
    a.target = goal;
    a.path = path;
    a.holdAngle = null;
  }

  private holdDirectionFor(a: Agent): number {
    // CTs hold toward T entry; Ts hold toward CT angles. If post-plant, face away from bomb.
    if (this.bombPlanted && this.bombPlantedAt && a.side === "T") {
      const dx = a.pos.x - this.bombPlantedAt.x, dy = a.pos.y - this.bombPlantedAt.y;
      return Math.atan2(dy, dx);
    }
    const focus = a.side === "CT" ? this.ctThreatFocus : this.tThreatFocus;
    return Math.atan2(focus.y - a.pos.y, focus.x - a.pos.x);
  }

  // ---- Movement (waypoint-based) ----
  private move(a: Agent) {
    // Hold stance keeps the agent planted to aim. Rush/disengage allow movement.
    if (a.stance === "hold" && this.t < a.stanceUntil) return;
    if (a.path.length === 0) {
      if (a.holdAngle !== null) a.facing = a.holdAngle;
      return;
    }
    const player = this.players(a.playerId)!;
    const baseSpeed = (60 + player.stats.movement * 0.8) / 1000 * TICK_MS;
    const speed = a.moveMode === "walk" ? baseSpeed * WALK_SPEED_FACTOR : baseSpeed;
    const wp = a.path[0];
    const dx = wp.x - a.pos.x;
    const dy = wp.y - a.pos.y;
    const d = Math.hypot(dx, dy);
    if (d < speed) {
      a.pos.x = wp.x; a.pos.y = wp.y;
      a.path.shift();
      return;
    }
    a.pos.x += (dx / d) * speed;
    a.pos.y += (dy / d) * speed;
    // facing is no longer snapped to movement vector — handled by scan/lerp pass.
  }

  // ---- Looking around ----
  private updateLook(a: Agent) {
    if (this.t < a.lookChangeAt && a.lookTarget) return;

    const player = this.players(a.playerId)!;
    const focus = a.side === "CT" ? this.ctThreatFocus : this.tThreatFocus;
    const threatDir = Math.atan2(focus.y - a.pos.y, focus.x - a.pos.x);

    // Bias the scan: blend threat direction with movement direction (if moving) plus random offset.
    let baseDir = threatDir;
    if (a.path.length > 0) {
      const wp = a.path[0];
      const moveDir = Math.atan2(wp.y - a.pos.y, wp.x - a.pos.x);
      // 60% look toward threat focus, 40% along movement — running blend.
      baseDir = this.rng() < 0.6 ? threatDir : moveDir;
    } else if (a.holdAngle !== null) {
      baseDir = a.holdAngle;
    }

    // High game-sense players scan tighter, focused arcs. Low-sense players sweep wildly.
    const senseFactor = Math.max(0.4, player.stats.gameSense / 100);
    const arcHalf = Math.PI * 0.5 * (1.1 - senseFactor); // ~27° at 100, ~55° at 40
    const offset = (this.rng() - 0.5) * 2 * arcHalf;
    const dir = baseDir + offset;

    a.lookTarget = { x: a.pos.x + Math.cos(dir) * 120, y: a.pos.y + Math.sin(dir) * 120 };
    const cadence = 500 + (100 - player.stats.gameSense) * 8 + this.rng() * 400;
    a.lookChangeAt = this.t + cadence;
  }

  // Smoothly rotate facing toward lookTarget.
  private applyFacing(a: Agent) {
    if (!a.lookTarget) return;
    const desired = Math.atan2(a.lookTarget.y - a.pos.y, a.lookTarget.x - a.pos.x);
    let diff = desired - a.facing;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const player = this.players(a.playerId)!;
    // Faster turn rate for higher reflexes.
    const maxStep = 0.10 + (player.stats.reflexes / 100) * 0.14; // 0.10..0.24 rad/tick
    const step = Math.max(-maxStep, Math.min(maxStep, diff));
    a.facing += step;
  }

  // ---- Combat ----
  private maybeShoot(a: Agent) {
    const player = this.players(a.playerId)!;
    const reactionMs = 80 + Math.max(0, (100 - player.stats.reflexes)) * 4;

    const enemy = this.acquireTarget(a, reactionMs);
    if (!enemy) return;

    // Refresh stance only when previous one has expired — avoids flapping.
    if (this.t >= a.stanceUntil) this.decideStance(a, enemy);

    // Disengage: skip firing; the path is already moving us toward cover.
    if (a.stance === "disengage") return;

    const weapon = WEAPONS[a.weapon];
    const cooldown = 1000 / weapon.fireRate;
    if (this.t - a.lastShotAt < cooldown) return;
    a.lastShotAt = this.t;
    // Snap-aim to the target when actually firing; also redirect scanning to them.
    a.facing = Math.atan2(enemy.pos.y - a.pos.y, enemy.pos.x - a.pos.x);
    a.lookTarget = { x: enemy.pos.x, y: enemy.pos.y };
    a.lookChangeAt = this.t + 300;

    const d = dist(a.pos, enemy.pos);
    const rangeFactor = Math.max(0.25, 1 - Math.max(0, d - weapon.range * 0.5) / weapon.range);

    let aimMod = player.stats.aim / 100;
    if (player.traits.includes("rifler") && (a.weapon === "rifle" || a.weapon === "smg")) aimMod += 0.08;
    if (player.traits.includes("rifler") && a.weapon === "awp") aimMod -= 0.1;
    if (player.traits.includes("awp-prodigy") && a.weapon === "awp") aimMod += 0.12;
    if (player.traits.includes("clutch") && this.lastAliveOnSide(a.side)) aimMod += 0.1;
    if (player.traits.includes("tilts-easy") && this.scoreDeficit(a.side) >= 3) aimMod -= 0.08;

    // Trade-frag bonus: did a teammate of mine recently die to this enemy?
    if (this.tradeMarks.some(m => m.killerId === enemy.playerId && m.victimSide === a.side)) {
      aimMod += TRADE_AIM_BONUS;
    }

    // Stationary aim bonus (held angle vs running)
    if (a.path.length === 0) aimMod += 0.05;
    else aimMod -= 0.05;

    const nerve = player.stats.nerve / 100;
    const mood = player.mood / 100;
    const composure = 0.6 + 0.25 * nerve + 0.15 * mood;
    const hitChance = clamp(weapon.accuracy * aimMod * rangeFactor * composure, 0.05, 0.95);
    const hit = this.rng() < hitChance;
    this.tickShots.push({
      from: { ...a.pos }, to: { ...enemy.pos }, side: a.side, hit, killerId: a.playerId,
    });
    if (!hit) return;

    let dmg = weapon.damage * (0.85 + this.rng() * 0.3);

    // Headshot roll: base by weapon + aim contribution. Clamped so even bad aim has some chance.
    const hsBase = HEADSHOT_BASE[a.weapon];
    const hsChance = clamp(hsBase + (player.stats.aim - 50) / 400, 0.03, 0.55);
    const isHeadshot = this.rng() < hsChance;
    if (isHeadshot) {
      dmg *= HEADSHOT_MULTIPLIER;
      if (enemy.helmet) {
        dmg *= HELMET_HS_REDUCTION;
        enemy.helmet = false; // helmet breaks after first HS
      }
    } else if (enemy.armor > 0) {
      dmg *= 0.65;
      enemy.armor = Math.max(0, enemy.armor - dmg * 0.5);
    }
    const applied = Math.min(enemy.hp, dmg);
    enemy.hp -= dmg;
    this.addDamage(a.playerId, applied);

    if (enemy.hp <= 0) {
      enemy.alive = false;
      enemy.hp = 0;
      if (enemy.weapon !== "knife") {
        this.drops.push({ pos: { ...enemy.pos }, weapon: enemy.weapon });
      }
      this.push({ t: this.t, kind: "kill", killer: a.playerId, victim: enemy.playerId, weapon: a.weapon, headshot: isHeadshot });
      const killer = this.players(a.playerId)!;
      killer.mood = clamp(killer.mood + 4, 0, 100);
      const victim = this.players(enemy.playerId)!;
      victim.mood = clamp(victim.mood - 3, 0, 100);
      this.bumpStat(a.playerId, "kills", 1);
      this.bumpStat(enemy.playerId, "deaths", 1);

      // Open trade window: enemy's teammates can punish a.playerId.
      this.tradeMarks.push({
        killerId: a.playerId,
        victimSide: enemy.side,
        expiresAt: this.t + TRADE_WINDOW_MS,
      });

      if (enemy.playerId === this.bombCarrier) {
        const ts = this.agents.filter(x => x.side === "T" && x.alive);
        this.bombCarrier = ts.length ? ts[0].playerId : null;
        // New carrier reassesses path to a bombsite right away.
        if (this.bombCarrier) {
          const carrierAgent = this.agents.find(x => x.playerId === this.bombCarrier);
          if (carrierAgent) carrierAgent.dirty = true;
        }
      }
    }
  }

  // ---- Engagement stance ----
  private decideStance(a: Agent, enemy: Agent) {
    const player = this.players(a.playerId)!;
    const isLastAlive = this.lastAliveOnSide(a.side);

    // Count visible enemies (LOS, vision range).
    let visibleEnemies = 0;
    for (const e of this.agents) {
      if (!e.alive || e.side === a.side) continue;
      if (dist(a.pos, e.pos) > VISION_RANGE) continue;
      if (!this.hasLineOfSight(a.pos, e.pos)) continue;
      visibleEnemies++;
    }
    // Count nearby allies (no LOS — comms/positional awareness). Low-nerve players want closer support.
    const allyRange = 280 + (60 - player.stats.nerve) * 0.5;
    let nearbyAllies = 0;
    for (const al of this.agents) {
      if (!al.alive || al.side !== a.side || al.playerId === a.playerId) continue;
      if (dist(a.pos, al.pos) < allyRange) nearbyAllies++;
    }

    // Tilts-easy + behind on score: even a 1v0 (solo contact, no support) becomes disengage.
    const tiltScared = player.traits.includes("tilts-easy") && this.scoreDeficit(a.side) >= 3;
    const enemyThreshold = tiltScared ? 1 : 2;

    // Clutch player when last alive: never disengage — fight on.
    const refuseDisengage = player.traits.includes("clutch") && isLastAlive;

    let stance: Agent["stance"];
    if (!refuseDisengage && visibleEnemies >= enemyThreshold && nearbyAllies === 0) {
      stance = "disengage";
    } else {
      // Rush when outgunned at medium-long range. HP gate avoids suicide rushes at low HP.
      const myCost = WEAPONS[a.weapon].cost;
      const theirCost = WEAPONS[enemy.weapon].cost;
      const ratio = myCost / Math.max(1, theirCost);
      const d = dist(a.pos, enemy.pos);
      let rushBias = 0;
      if (player.traits.includes("entry-fragger")) rushBias += 0.15;
      if (player.traits.includes("clutch") && isLastAlive) rushBias += 0.30;
      if (ratio < 0.5 + rushBias && d > 160 && a.hp > 45) stance = "rush";
      else stance = "hold";
    }

    a.stance = stance;
    const duration = stance === "rush" ? 900 : stance === "disengage" ? 1500 : 700;
    a.stanceUntil = this.t + duration;
    // Don't let think() overwrite the stance path.
    a.nextThinkAt = Math.max(a.nextThinkAt, a.stanceUntil + 200);

    if (stance === "rush") {
      this.setGoal(a, { x: enemy.pos.x, y: enemy.pos.y });
    } else if (stance === "disengage") {
      const dx = a.pos.x - enemy.pos.x, dy = a.pos.y - enemy.pos.y;
      const dd = Math.hypot(dx, dy) || 1;
      const goal: Vec2 = { x: a.pos.x + (dx / dd) * 220, y: a.pos.y + (dy / dd) * 220 };
      this.setGoal(a, goal);
    } else {
      // hold — stop moving, no path
      a.target = null;
      a.path = [];
    }
  }

  // Target acquisition with reaction delay.
  // The agent must have LOS to an enemy for at least reactionMs before they can fire.
  private acquireTarget(a: Agent, reactionMs: number): Agent | null {
    const visibleEnemies: { e: Agent; d: number }[] = [];
    const stillSeen = new Set<string>();

    for (const e of this.agents) {
      if (!e.alive || e.side === a.side) continue;
      const d = dist(a.pos, e.pos);
      if (d > VISION_RANGE) continue;
      if (!this.hasLineOfSight(a.pos, e.pos)) continue;
      visibleEnemies.push({ e, d });
      stillSeen.add(e.playerId);
      if (a.spotted[e.playerId] === undefined) {
        a.spotted[e.playerId] = this.t;
      }
    }

    // Forget enemies we no longer see (so re-spotting requires re-acquiring).
    for (const id of Object.keys(a.spotted)) {
      if (!stillSeen.has(id)) delete a.spotted[id];
    }

    // Among acquired enemies (spotted long enough), pick the closest.
    let best: Agent | null = null; let bestD = Infinity;
    for (const { e, d } of visibleEnemies) {
      if (this.t - a.spotted[e.playerId] < reactionMs) continue;
      if (d < bestD) { bestD = d; best = e; }
    }
    return best;
  }

  private hasLineOfSight(a: Vec2, b: Vec2): boolean {
    const distAB = Math.hypot(a.x - b.x, a.y - b.y);
    const steps = Math.ceil(distAB / (this.map.tileSize * 0.5));
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      const x = a.x + (b.x - a.x) * t;
      const y = a.y + (b.y - a.y) * t;
      if (this.solidAtWorld(x, y)) return false;
      // Smoke blocks LOS
      for (const sm of this.smokes) {
        const dx = x - sm.pos.x, dy = y - sm.pos.y;
        if (dx * dx + dy * dy < sm.radius * sm.radius) return false;
      }
    }
    return true;
  }

  private solidAtWorld(x: number, y: number): boolean {
    const tx = Math.floor(x / this.map.tileSize);
    const ty = Math.floor(y / this.map.tileSize);
    if (tx < 0 || ty < 0 || tx >= this.map.width || ty >= this.map.height) return true;
    return this.map.walls[ty * this.map.width + tx];
  }

  private lastAliveOnSide(side: Side) {
    return this.agents.filter(x => x.side === side && x.alive).length === 1;
  }
  private scoreDeficit(side: Side) {
    if (side === "CT") return this.tSide.roundsWon - this.ct.roundsWon;
    return this.ct.roundsWon - this.tSide.roundsWon;
  }

  // ---- Bomb ----
  private tickBomb() {
    if (this.bombPlanted) {
      const onSite = this.agents.find(a =>
        a.alive && a.side === "CT" &&
        dist(a.pos, this.bombPlantedAt!) < this.map.tileSize * 1.2
      );
      if (onSite) {
        this.bombDefusing = onSite.playerId;
        this.bombDefuseProgress += TICK_MS;
        if (this.bombDefuseProgress >= DEFUSE_TIME_MS) {
          this.push({ t: this.t, kind: "bomb-defuse", defuser: onSite.playerId });
          this.finish("bomb-defused", "CT");
        }
      } else {
        this.bombDefusing = null;
        this.bombDefuseProgress = Math.max(0, this.bombDefuseProgress - TICK_MS * 0.5);
      }
      if (this.t - this.bombPlantedTime >= BOMB_TIMER_MS) {
        this.push({ t: this.t, kind: "bomb-detonate" });
        this.finish("bomb-detonated", "T");
      }
      return;
    }

    if (!this.bombCarrier) return;
    const carrier = this.agents.find(a => a.playerId === this.bombCarrier && a.alive);
    if (!carrier) return;
    const site = this.map.bombsites.find(s => {
      const c = worldCenterOfTile(s.center, this.map);
      return dist(c, carrier.pos) < s.radius * this.map.tileSize;
    });
    if (site && !this.enemiesNearby(carrier, 90)) {
      this.planting = carrier.playerId;
      this.plantProgress += TICK_MS;
      if (this.plantProgress >= PLANT_TIME_MS) {
        this.bombPlanted = true;
        this.bombPlantedAt = { ...carrier.pos };
        this.bombPlantedTime = this.t;
        this.planter = carrier.playerId;
        this.push({ t: this.t, kind: "bomb-plant", planter: carrier.playerId });
        // All living agents reassess: CTs rotate to plant, Ts hold around it.
        for (const ag of this.agents) if (ag.alive) ag.dirty = true;
      }
    } else {
      this.planting = null;
      this.plantProgress = Math.max(0, this.plantProgress - TICK_MS);
    }
  }

  private enemiesNearby(a: Agent, range: number): boolean {
    return this.agents.some(e => e.alive && e.side !== a.side && dist(e.pos, a.pos) < range);
  }

  private checkEnd() {
    if (this.finished) return;
    const ctAlive = this.agents.some(a => a.side === "CT" && a.alive);
    const tAlive = this.agents.some(a => a.side === "T" && a.alive);
    if (!tAlive && !this.bombPlanted) return this.finish("t-elim", "CT");
    if (!ctAlive && !this.bombPlanted) return this.finish("ct-elim", "T");
    // Post-plant: if no CT is alive there's no possible defuse, so detonate now.
    if (this.bombPlanted && !ctAlive) {
      this.push({ t: this.t, kind: "bomb-detonate" });
      return this.finish("bomb-detonated", "T");
    }
    if (this.t >= ROUND_TIME_MS && !this.bombPlanted) return this.finish("time-expired", "CT");
  }

  private finish(outcome: RoundResult["outcome"], winningSide: Side) {
    this.finished = true;
    this.push({ t: this.t, kind: "round-end", winner: winningSide });
    this.result = { outcome, winningSide, durationMs: this.t, events: this.events };
    // Count round played for every agent that participated.
    for (const ag of this.agents) this.bumpStat(ag.playerId, "roundsPlayed", 1);
  }

  private teamOfPlayer(id: string): Team | null {
    if (this.ct.players.some(p => p.id === id)) return this.ct;
    if (this.tSide.players.some(p => p.id === id)) return this.tSide;
    return null;
  }

  private bumpStat(playerId: string, key: "kills" | "deaths" | "roundsPlayed", amount: number) {
    const team = this.teamOfPlayer(playerId);
    if (!team) return;
    team.matchStats[playerId][key] += amount;
  }

  private addDamage(playerId: string, amount: number) {
    const team = this.teamOfPlayer(playerId);
    if (!team) return;
    team.matchStats[playerId].damage += amount;
  }
}

function dist(a: Vec2, b: Vec2) { return Math.hypot(a.x - b.x, a.y - b.y); }
function clamp(v: number, lo: number, hi: number) { return Math.max(lo, Math.min(hi, v)); }
function worldCenterOfTile(t: Vec2, map: GameMap): Vec2 {
  return { x: (t.x + 0.5) * map.tileSize, y: (t.y + 0.5) * map.tileSize };
}
function jitter(p: Vec2, r: number, rng: () => number): Vec2 {
  const a = rng() * Math.PI * 2;
  const d = rng() * r;
  return { x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d };
}
