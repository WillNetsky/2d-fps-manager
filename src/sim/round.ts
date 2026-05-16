import type {
  Agent, DroppedWeapon, Flash, GameMap, GrenadeInFlight, GrenadeKind, HE, Molotov, Player, RoundResult, Side, SimEvent, SiteAssignment, Smoke, SmokeHole, TStrategy, Team, UtilityId, Vec2,
} from "../domain/types.ts";
import { HEADSHOT_BASE, HEADSHOT_MULTIPLIER, HELMET_HS_REDUCTION, HELMET_UPGRADE_COST, VEST_COST, WEAPONS } from "../domain/weapons.ts";
import { findPath } from "./pathfind.ts";
import { analyzeMap, type Choke, type MapAnalysis } from "./mapAnalysis.ts";

const TICK_MS = 50;
const ROUND_TIME_MS = 90_000;
const BOMB_TIMER_MS = 30_000;
const PLANT_TIME_MS = 3000;
const DEFUSE_TIME_MS = 5000;

const SMOKE_DURATION_MS = 14_000;
const SMOKE_RADIUS_WORLD = 80; // ~2.8 tiles — wide enough to fully plug a 4-tile choke

const FLASH_FUSE_MS = 1500;
const FLASH_RANGE = 320;
const FLASH_MAX_DURATION_MS = 3500;
const FLASH_MIN_DURATION_MS = 600;
const FLASH_CONE_HALF = Math.PI / 2; // ±90°

const MOLOTOV_FUSE_MS = 1500;
const MOLOTOV_DURATION_MS = 7000;
const MOLOTOV_RADIUS_WORLD = 70;
const MOLOTOV_DOT_PER_SEC = 14;

const HE_FUSE_MS = 1500;
const HE_RADIUS = 120;
const HE_MAX_DAMAGE = 80;
const HE_HOLE_RADIUS = 70;
const HE_HOLE_DURATION_MS = 1500;

const GRENADE_FLIGHT_MS = 600;
const GRENADE_NOISE_PER_SKILL_GAP = 1.5; // px per (100 - skill)

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
  ammo: number;
  reloadingUntil: number;
  blindedUntil: number;
  moveMode: "walk" | "run";
}

export interface RoundSnapshot {
  t: number;
  agents: AgentSnapshot[];
  smokes: Smoke[];
  flashes: Flash[];
  tickFlashes: { pos: Vec2; side: Side }[];
  molotovs: Molotov[];
  hes: HE[];
  tickHEs: { pos: Vec2; side: Side }[];
  smokeHoles: SmokeHole[];
  grenadeFlights: GrenadeInFlight[];
  drops: import("../domain/types.ts").DroppedWeapon[];
  bombPlanted: boolean;
  bombPlantedAt: Vec2 | null;
  bombCarrier: string | null;
  bombDropped: Vec2 | null;
  bombPlantedTime: number;
  bombDefuseProgress: number;
  defuseTimeMs: number;
  tickShots: TickShot[];
}

export class RoundSim {
  agents: Agent[] = [];
  smokes: Smoke[] = [];
  flashes: Flash[] = [];      // in-flight grenades waiting on fuse
  tickFlashes: { pos: Vec2; side: Side }[] = []; // detonation events this tick
  molotovs: Molotov[] = [];   // burning patches
  hes: HE[] = [];             // in-flight HE grenades
  tickHEs: { pos: Vec2; side: Side }[] = []; // detonation events this tick
  smokeHoles: SmokeHole[] = []; // brief LOS gaps punched through smoke by HEs
  grenadeFlights: GrenadeInFlight[] = []; // flying grenades between throw and land
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
  bombDropped: Vec2 | null = null;
  defuseTimeMs = DEFUSE_TIME_MS;
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
  private mapAnalysis: MapAnalysis;
  private tradeMarks: TradeMark[] = [];
  private smokeQueue: { thrower: string; spot: Vec2; throwAt: number }[] = [];
  private flashQueue: { thrower: string; spot: Vec2; throwAt: number }[] = [];
  private molotovQueue: { thrower: string; spot: Vec2; throwAt: number }[] = [];
  private heQueue: { thrower: string; spot: Vec2; throwAt: number }[] = [];
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
    this.mapAnalysis = analyzeMap(map);
    this.tStrategy = this.pickTStrategy();
    this.ctSetup = this.pickCtSetup();
    this.spawnAgents();
    this.assignBombCarrier();
    this.assignSites();
    this.scheduleSmokes();
    this.scheduleFlashes();
    this.scheduleMolotovs();
    this.scheduleHEs();
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
    // CTs: coach-set placements first, then ctSetup fills remaining.
    const cts = this.agents.filter(a => a.side === "CT");
    const tA = this.ctSetup.A, tB = this.ctSetup.B, tMid = this.ctSetup.mid;
    const slots: SiteAssignment[] = [
      ...Array(tA).fill("A" as SiteAssignment),
      ...Array(tB).fill("B" as SiteAssignment),
      ...Array(tMid).fill("mid" as SiteAssignment),
    ];
    // Apply coach overrides; subtract those from the slot pool.
    const autoCts: Agent[] = [];
    for (const a of cts) {
      const player = this.players(a.playerId)!;
      const fixed = player.ctAssignment;
      if (fixed === "A" || fixed === "B" || fixed === "mid") {
        a.assignedSite = fixed;
        const idx = slots.indexOf(fixed);
        if (idx >= 0) slots.splice(idx, 1);
      } else {
        autoCts.push(a);
      }
    }
    // Order remaining autos by role priority.
    autoCts.sort((x, y) => this.priority(x) - this.priority(y));
    autoCts.forEach((a, i) => { a.assignedSite = slots[i] ?? "A"; });

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
      const w = WEAPONS[loadout.weapon];
      return {
        playerId: p.id,
        side,
        pos: { x: sx, y: sy },
        facing: Math.atan2(focus.y - sy, focus.x - sx),
        hp: 100,
        armor: loadout.armor ? 100 : 0,
        helmet: loadout.helmet,
        weapon: loadout.weapon,
        ammo: w.magSize,
        reserve: w.reserveAmmo,
        reloadingUntil: 0,
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
        blindedUntil: -Infinity,
        fleeingFireUntil: -Infinity,
        coverPos: null,
        peekPos: null,
        peekState: "none",
        peekUntil: 0,
        saving: false,
        reassessSaveAt: 0,
      };
    };
    this.ct.players.forEach((p, i) => this.agents.push(make(p, "CT", this.map.ctSpawns[i % this.map.ctSpawns.length])));
    this.tSide.players.forEach((p, i) => this.agents.push(make(p, "T", this.map.tSpawns[i % this.map.tSpawns.length])));
  }

  // Compute path from agent to assigned site center, then find chokes along it.
  // Returns chokes with skill-modulated quality preference.
  private chokesOnAgentPath(a: Agent): Choke[] {
    const sitePos = this.agentSiteWorldPos(a);
    if (!sitePos) return [];
    const path = findPath(this.map, a.pos, sitePos);
    if (!path) return [];
    const pathTiles = new Set<string>();
    const ts = this.map.tileSize;
    pathTiles.add(`${Math.floor(a.pos.x / ts)},${Math.floor(a.pos.y / ts)}`);
    for (const wp of path) pathTiles.add(`${Math.floor(wp.x / ts)},${Math.floor(wp.y / ts)}`);
    return this.mapAnalysis.chokes.filter(c => pathTiles.has(`${c.tile.x},${c.tile.y}`));
  }

  private agentSiteWorldPos(a: Agent): Vec2 | null {
    if (a.assignedSite === "mid") {
      return {
        x: this.map.width * this.map.tileSize * 0.5,
        y: this.map.height * this.map.tileSize * 0.5,
      };
    }
    const site = this.map.bombsites.find(s => s.id === a.assignedSite);
    if (!site) return null;
    return this.tileCenter(site.center);
  }

  private tileCenter(tile: Vec2): Vec2 {
    return { x: (tile.x + 0.5) * this.map.tileSize, y: (tile.y + 0.5) * this.map.tileSize };
  }

  // For an agent, choose the most useful choke on their path.
  // Strategy: pick the choke closest to enemy spawn (most forward / aggressive).
  // High smokeLineups picks optimally; low picks worse choices.
  private pickChokeForAgent(a: Agent, mode: "in" | "enemy-side", usedTiles: Set<string>): Choke | null {
    const candidates = this.chokesOnAgentPath(a).filter(c => !usedTiles.has(`${c.tile.x},${c.tile.y}`));
    if (!candidates.length) return null;
    const player = this.players(a.playerId)!;
    const skill = (player.stats.smokeLineups + player.stats.utility) / 200; // 0..1
    // High-skill players pick the most-forward choke. Low-skill randomize.
    if (this.rng() > skill) {
      return candidates[Math.floor(this.rng() * candidates.length)];
    }
    const W = this.map.width;
    const enemyDist = a.side === "T" ? this.mapAnalysis.ctDist : this.mapAnalysis.tDist;
    let best = candidates[0];
    let bestD = enemyDist[best.tile.y * W + best.tile.x];
    for (const c of candidates) {
      const d = enemyDist[c.tile.y * W + c.tile.x];
      if (d < bestD) { bestD = d; best = c; }
    }
    void mode;
    return best;
  }

  // Like pickChokeForAgent but returns the actual throw position (in choke or its enemy-side neighbor).
  private pickChokeTargetForAgent(
    a: Agent,
    mode: "in" | "enemy-side",
    usedTiles: Set<string>,
  ): { choke: Choke; spot: Vec2 } | null {
    const choke = this.pickChokeForAgent(a, mode, usedTiles);
    if (!choke) return null;
    if (mode === "in") return { choke, spot: this.tileCenter(choke.tile) };
    // enemy-side: throw past the choke into the enemy's holding area
    const enemyNeighbor = a.side === "T" ? choke.ctSide : choke.tSide;
    const target = enemyNeighbor ?? choke.tile;
    return { choke, spot: this.tileCenter(target) };
  }

  private assignBombCarrier() {
    const ts = this.agents.filter(a => a.side === "T");
    this.bombCarrier = ts[Math.floor(this.rng() * ts.length)].playerId;
  }

  private scheduleSmokes() {
    const usedTiles = new Set<string>();
    for (const a of this.agents) {
      if (!a.utility.includes("smoke")) continue;
      const choke = this.pickChokeForAgent(a, "in", usedTiles);
      if (!choke) continue;
      const spot = this.tileCenter(choke.tile);
      usedTiles.add(`${choke.tile.x},${choke.tile.y}`);
      this.smokeQueue.push({
        thrower: a.playerId,
        spot,
        throwAt: 1000 + this.rng() * 2000,
      });
    }
  }

  tick(): void {
    if (this.finished) return;
    this.t += TICK_MS;
    this.tickShots.length = 0;
    this.tickFlashes.length = 0;
    this.tickHEs.length = 0;

    this.tickGrenadeFlights();
    this.tickSmokes();
    this.tickFlashesUpdate();
    this.tickMolotovsUpdate();
    this.tickHEsUpdate();
    this.updateIntel();

    for (const a of this.agents) if (a.alive) this.think(a);
    for (const a of this.agents) if (a.alive) this.tickPeek(a);
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
        weapon: a.weapon, ammo: a.ammo, reloadingUntil: a.reloadingUntil,
        blindedUntil: a.blindedUntil,
        moveMode: a.moveMode,
      })),
      smokes: this.smokes.map(s => ({ pos: { x: s.pos.x, y: s.pos.y }, radius: s.radius, expiresAt: s.expiresAt, side: s.side })),
      flashes: this.flashes.map(f => ({ pos: { x: f.pos.x, y: f.pos.y }, detonatesAt: f.detonatesAt, side: f.side })),
      tickFlashes: this.tickFlashes.map(f => ({ pos: { x: f.pos.x, y: f.pos.y }, side: f.side })),
      molotovs: this.molotovs.map(m => ({ pos: { x: m.pos.x, y: m.pos.y }, radius: m.radius, expiresAt: m.expiresAt, side: m.side, thrower: m.thrower })),
      hes: this.hes.map(h => ({ pos: { x: h.pos.x, y: h.pos.y }, detonatesAt: h.detonatesAt, side: h.side, thrower: h.thrower })),
      tickHEs: this.tickHEs.map(h => ({ pos: { x: h.pos.x, y: h.pos.y }, side: h.side })),
      smokeHoles: this.smokeHoles.map(h => ({ pos: { x: h.pos.x, y: h.pos.y }, radius: h.radius, expiresAt: h.expiresAt })),
      grenadeFlights: this.grenadeFlights.map(g => ({
        kind: g.kind, thrower: g.thrower, side: g.side,
        start: { x: g.start.x, y: g.start.y },
        landing: { x: g.landing.x, y: g.landing.y },
        startedAt: g.startedAt, landsAt: g.landsAt,
      })),
      drops: this.drops.map(d => ({ pos: { x: d.pos.x, y: d.pos.y }, weapon: d.weapon })),
      bombPlanted: this.bombPlanted,
      bombPlantedAt: this.bombPlantedAt ? { x: this.bombPlantedAt.x, y: this.bombPlantedAt.y } : null,
      bombCarrier: this.bombCarrier,
      bombDropped: this.bombDropped ? { x: this.bombDropped.x, y: this.bombDropped.y } : null,
      bombDefuseProgress: this.bombDefuseProgress,
      defuseTimeMs: DEFUSE_TIME_MS,
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

  // ---- Flashes ----
  private scheduleFlashes() {
    const usedTiles = new Set<string>();
    for (const a of this.agents) {
      if (!a.utility.includes("flash")) continue;
      const target = this.pickChokeTargetForAgent(a, "enemy-side", usedTiles);
      if (!target) continue;
      const player = this.players(a.playerId)!;
      const earliness = (player.stats.aggression - 50) / 100;
      const baseThrow = 4500 - earliness * 2000;
      this.flashQueue.push({
        thrower: a.playerId,
        spot: target.spot,
        throwAt: baseThrow + this.rng() * 1500,
      });
      usedTiles.add(`${target.choke.tile.x},${target.choke.tile.y}`);
    }
  }

  private tickFlashesUpdate() {
    // Detonate
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      if (this.t >= f.detonatesAt) {
        this.tickFlashes.push({ pos: { ...f.pos }, side: f.side });
        this.applyFlashBlind(f);
        this.flashes.splice(i, 1);
      }
    }
  }

  private applyFlashBlind(f: Flash) {
    for (const a of this.agents) {
      if (!a.alive) continue;
      const dx = f.pos.x - a.pos.x, dy = f.pos.y - a.pos.y;
      const d = Math.hypot(dx, dy);
      if (d > FLASH_RANGE) continue;
      if (!this.hasLineOfSight(a.pos, f.pos)) continue;
      const flashDir = Math.atan2(dy, dx);
      let angDiff = Math.abs(flashDir - a.facing);
      while (angDiff > Math.PI) angDiff = Math.PI * 2 - angDiff;
      if (angDiff > FLASH_CONE_HALF) continue;
      const facingFactor = 1 - angDiff / FLASH_CONE_HALF;
      const distFactor = 1 - d / FLASH_RANGE;
      const duration = FLASH_MIN_DURATION_MS + (FLASH_MAX_DURATION_MS - FLASH_MIN_DURATION_MS) * facingFactor * distFactor;
      a.blindedUntil = Math.max(a.blindedUntil, this.t + duration);
    }
  }

  // ---- Molotovs ----
  private scheduleMolotovs() {
    const usedTiles = new Set<string>();
    for (const a of this.agents) {
      if (!a.utility.includes("molotov")) continue;
      const target = this.pickChokeTargetForAgent(a, "enemy-side", usedTiles);
      if (!target) continue;
      const player = this.players(a.playerId)!;
      const baseThrow = 5000 - (player.stats.utility - 50) * 30;
      this.molotovQueue.push({
        thrower: a.playerId,
        spot: target.spot,
        throwAt: baseThrow + this.rng() * 1500,
      });
      usedTiles.add(`${target.choke.tile.x},${target.choke.tile.y}`);
    }
  }

  private tickMolotovsUpdate() {
    // Smoke extinguish: any smoke whose center is inside the fire's reach kills the fire.
    for (let i = this.molotovs.length - 1; i >= 0; i--) {
      const m = this.molotovs[i];
      const extinguished = this.smokes.some(s => {
        const dx = m.pos.x - s.pos.x, dy = m.pos.y - s.pos.y;
        const d = Math.hypot(dx, dy);
        return d < m.radius + s.radius * 0.6;
      });
      if (extinguished || this.t >= m.expiresAt) {
        this.molotovs.splice(i, 1);
      }
    }

    // DOT + flee for agents in active fire (after fuse).
    const dmgPerTick = (MOLOTOV_DOT_PER_SEC * TICK_MS) / 1000;
    for (const m of this.molotovs) {
      const igniteAt = m.expiresAt - MOLOTOV_DURATION_MS;
      if (this.t < igniteAt) continue; // still in fuse phase
      for (const a of this.agents) {
        if (!a.alive) continue;
        const dx = a.pos.x - m.pos.x, dy = a.pos.y - m.pos.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > m.radius * m.radius) continue;
        const applied = Math.min(a.hp, dmgPerTick);
        a.hp -= dmgPerTick;
        this.addDamage(m.thrower, applied);
        // Flee — set a goal away from the fire.
        const d = Math.sqrt(d2) || 1;
        const flee: Vec2 = { x: a.pos.x + (dx / d) * 200, y: a.pos.y + (dy / d) * 200 };
        this.setGoal(a, flee);
        a.fleeingFireUntil = this.t + 600;
        a.nextThinkAt = Math.max(a.nextThinkAt, a.fleeingFireUntil);
        if (a.hp <= 0) {
          a.alive = false; a.hp = 0;
          if (a.weapon !== "knife") {
            this.drops.push({ pos: { x: a.pos.x, y: a.pos.y }, weapon: a.weapon });
          }
          if (a.playerId === this.bombCarrier) this.dropBomb(a);
          this.push({ t: this.t, kind: "kill", killer: m.thrower, victim: a.playerId, weapon: "molotov", headshot: false });
          this.bumpStat(m.thrower, "kills", 1);
          this.bumpStat(a.playerId, "deaths", 1);
        }
        break; // one fire DOT per tick per agent
      }
    }
  }

  // ---- HE grenades ----
  private scheduleHEs() {
    const usedTiles = new Set<string>();
    for (const a of this.agents) {
      if (!a.utility.includes("he")) continue;
      const target = this.pickChokeTargetForAgent(a, "enemy-side", usedTiles);
      if (!target) continue;
      const player = this.players(a.playerId)!;
      const baseThrow = 4000 - (player.stats.aggression - 50) * 20;
      this.heQueue.push({
        thrower: a.playerId,
        spot: target.spot,
        throwAt: baseThrow + this.rng() * 1500,
      });
      usedTiles.add(`${target.choke.tile.x},${target.choke.tile.y}`);
    }
  }

  private tickHEsUpdate() {
    // Detonate
    for (let i = this.hes.length - 1; i >= 0; i--) {
      const he = this.hes[i];
      if (this.t >= he.detonatesAt) {
        this.tickHEs.push({ pos: { ...he.pos }, side: he.side });
        this.applyHEDamage(he);
        // Punch a hole in any nearby smoke for a brief moment.
        for (const sm of this.smokes) {
          const dx = sm.pos.x - he.pos.x, dy = sm.pos.y - he.pos.y;
          const d = Math.hypot(dx, dy);
          if (d < sm.radius + HE_HOLE_RADIUS) {
            this.smokeHoles.push({
              pos: { x: he.pos.x, y: he.pos.y },
              radius: HE_HOLE_RADIUS,
              expiresAt: this.t + HE_HOLE_DURATION_MS,
            });
            break;
          }
        }
        this.hes.splice(i, 1);
      }
    }
    // Expire smoke holes
    this.smokeHoles = this.smokeHoles.filter(h => h.expiresAt > this.t);
  }

  private applyHEDamage(he: HE) {
    for (const a of this.agents) {
      if (!a.alive) continue;
      if (a.side === he.side) continue; // no friendly fire
      const dx = a.pos.x - he.pos.x, dy = a.pos.y - he.pos.y;
      const d = Math.hypot(dx, dy);
      if (d > HE_RADIUS) continue;
      if (!this.hasLineOfSight(a.pos, he.pos)) continue; // walls block damage
      let dmg = HE_MAX_DAMAGE * (1 - d / HE_RADIUS);
      if (a.armor > 0) {
        dmg *= 0.6;
        a.armor = Math.max(0, a.armor - dmg * 0.5);
      }
      const applied = Math.min(a.hp, dmg);
      a.hp -= dmg;
      this.addDamage(he.thrower, applied);
      if (a.hp <= 0) {
        a.alive = false; a.hp = 0;
        if (a.weapon !== "knife") {
          this.drops.push({ pos: { x: a.pos.x, y: a.pos.y }, weapon: a.weapon });
        }
        if (a.playerId === this.bombCarrier) this.dropBomb(a);
        this.push({ t: this.t, kind: "kill", killer: he.thrower, victim: a.playerId, weapon: "he", headshot: false });
        this.bumpStat(he.thrower, "kills", 1);
        this.bumpStat(a.playerId, "deaths", 1);
      }
    }
  }

  // ---- Pickups ----
  private checkPickups() {
    for (const a of this.agents) {
      if (!a.alive) continue;
      for (let i = this.drops.length - 1; i >= 0; i--) {
        const d = this.drops[i];
        if (dist(a.pos, d.pos) > 14) continue;
        if (WEAPONS[d.weapon].cost > WEAPONS[a.weapon].cost) {
          if (a.weapon !== "knife") {
            this.drops.push({ pos: { ...a.pos }, weapon: a.weapon });
          }
          a.weapon = d.weapon;
          const newW = WEAPONS[d.weapon];
          a.ammo = newW.magSize;
          a.reserve = newW.reserveAmmo;
          a.reloadingUntil = 0;
          this.drops.splice(i, 1);
          break;
        }
      }
    }
  }

  // ---- Smokes ----
  private tickSmokes() {
    this.smokes = this.smokes.filter(s => s.expiresAt > this.t);
  }

  // ---- Grenade flight pipeline ----
  // Handles all four util types' transitions: queue → in-flight → spawn-at-landing.
  // Each flight has skill-based noise applied to the landing relative to the intended target.
  private tickGrenadeFlights() {
    const launchFromQueue = <Q extends { thrower: string; spot: Vec2; throwAt: number }>(
      queue: Q[],
      kind: GrenadeKind,
      utilName: UtilityId,
    ) => {
      for (let i = queue.length - 1; i >= 0; i--) {
        const q = queue[i];
        if (this.t < q.throwAt) continue;
        const thrower = this.agents.find(a => a.playerId === q.thrower && a.alive);
        if (thrower) {
          const noise = this.grenadeNoise(q.thrower, kind);
          const landing = this.applyNoise(q.spot, noise);
          this.grenadeFlights.push({
            kind, thrower: q.thrower, side: thrower.side,
            start: { x: thrower.pos.x, y: thrower.pos.y },
            landing,
            startedAt: this.t,
            landsAt: this.t + GRENADE_FLIGHT_MS,
          });
          const idx = thrower.utility.indexOf(utilName);
          if (idx >= 0) thrower.utility.splice(idx, 1);
        }
        queue.splice(i, 1);
      }
    };
    launchFromQueue(this.smokeQueue, "smoke", "smoke");
    launchFromQueue(this.flashQueue, "flash", "flash");
    launchFromQueue(this.molotovQueue, "molotov", "molotov");
    launchFromQueue(this.heQueue, "he", "he");

    // In-flight → spawn at landing.
    for (let i = this.grenadeFlights.length - 1; i >= 0; i--) {
      const g = this.grenadeFlights[i];
      if (this.t < g.landsAt) continue;
      switch (g.kind) {
        case "smoke":
          this.smokes.push({
            pos: { x: g.landing.x, y: g.landing.y },
            radius: SMOKE_RADIUS_WORLD,
            expiresAt: this.t + SMOKE_DURATION_MS,
            side: g.side,
          });
          break;
        case "flash":
          this.flashes.push({
            pos: { x: g.landing.x, y: g.landing.y },
            detonatesAt: this.t + FLASH_FUSE_MS,
            side: g.side,
          });
          break;
        case "molotov":
          this.molotovs.push({
            pos: { x: g.landing.x, y: g.landing.y },
            radius: MOLOTOV_RADIUS_WORLD,
            expiresAt: this.t + MOLOTOV_FUSE_MS + MOLOTOV_DURATION_MS,
            side: g.side,
            thrower: g.thrower,
          });
          break;
        case "he":
          this.hes.push({
            pos: { x: g.landing.x, y: g.landing.y },
            detonatesAt: this.t + HE_FUSE_MS,
            side: g.side,
            thrower: g.thrower,
          });
          break;
      }
      this.grenadeFlights.splice(i, 1);
    }
  }

  private grenadeNoise(playerId: string, kind: GrenadeKind): number {
    const player = this.players(playerId);
    if (!player) return 0;
    let skill: number;
    switch (kind) {
      case "smoke":   skill = player.stats.smokeLineups; break;
      case "flash":   skill = player.stats.flashTiming; break;
      case "molotov": skill = player.stats.molotovUse; break;
      case "he":      skill = player.stats.utility; break;
    }
    return Math.max(0, 100 - skill) * GRENADE_NOISE_PER_SKILL_GAP;
  }

  private applyNoise(target: Vec2, noise: number): Vec2 {
    if (noise <= 0) return { x: target.x, y: target.y };
    const angle = this.rng() * Math.PI * 2;
    const d = this.rng() * noise;
    return { x: target.x + Math.cos(angle) * d, y: target.y + Math.sin(angle) * d };
  }

  // ---- AI ----
  private think(a: Agent) {
    if (this.t < a.fleeingFireUntil) return;
    this.maybeSaveDecision(a);
    const arrived = a.target && a.path.length === 0 && dist(a.pos, a.target) < 6;
    const needNew = !a.target || arrived || a.dirty || this.t >= a.nextThinkAt;
    if (!needNew) return;

    const goal = this.pickGoal(a);
    if (goal) {
      // Picking a new high-level goal invalidates the peek anchor.
      a.coverPos = null;
      a.peekPos = null;
      a.peekState = "none";
      this.setGoal(a, goal);
    }

    // Adaptability + gameSense drive how often agents reconsider.
    const player = this.players(a.playerId)!;
    const decisionScore = (player.stats.adaptability + player.stats.gameSense) / 2;
    const period = 1200 + (100 - decisionScore) * 12 + this.rng() * 800;
    a.nextThinkAt = this.t + period;
    a.dirty = false;

    if (a.target && dist(a.pos, a.target) < 6) {
      a.holdAngle = this.holdDirectionFor(a);
    }

    this.decideMoveMode(a);
  }

  private decideMoveMode(a: Agent) {
    const player = this.players(a.playerId)!;
    const stats = player.stats;
    // Saving: stealth no matter what.
    if (a.saving) { a.moveMode = "walk"; return; }
    // Lurkers sneak by default.
    if (player.role === "lurker") { a.moveMode = "walk"; return; }
    // Bomb retriever walks for the last stretch so they don't run blind into ambushes.
    if (a.side === "T" && this.bombDropped && this.bombRetrieverId() === a.playerId) {
      if (dist(a.pos, this.bombDropped) < this.map.tileSize * 5) { a.moveMode = "walk"; return; }
    }
    // Cautious temperament — low aggression + high composure extends the
    // "walk near contact" radius. Reckless players run all the way in.
    const caution = clamp(((100 - stats.aggression) + stats.composure) / 200, 0, 1);
    const walkRadius = CONTACT_RADIUS * (0.6 + caution * 0.9);
    const contact = this.contactZoneFor(a);
    const d = dist(a.pos, contact);
    a.moveMode = d < walkRadius ? "walk" : "run";
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
    if (a.saving) return this.saveSpotFor(a);
    if (a.side === "T") return this.tGoal(a);
    return this.ctGoal(a);
  }

  // ---- Saving (keep your gun for next round) ----
  // Every save decision flows through one continuous score. Role-based
  // responsibility (bomb carrier, last CT vs plant, bomb retriever) is a
  // bias, not a gate — so a panicked low-composure carrier can still bail.
  private maybeSaveDecision(a: Agent) {
    if (this.t < a.reassessSaveAt) return;
    a.reassessSaveAt = this.t + 1200 + this.rng() * 800;

    const player = this.players(a.playerId)!;
    const stats = player.stats;
    const w = WEAPONS[a.weapon];
    const gunValue = w.cost
      + (a.armor > 0 ? VEST_COST : 0)
      + (a.helmet ? HELMET_UPGRADE_COST : 0);

    // --- Situation read ---
    const us = this.agents.filter(x => x.alive && x.side === a.side).length;
    const them = this.agents.filter(x => x.alive && x.side !== a.side).length;
    const trueWin = this.teamWinChance(a.side);
    // gameSense noise: low-GS players misread the round state.
    const noise = (this.rng() - 0.5) * 2 * (1 - stats.gameSense / 100) * 0.15;
    const perceivedWin = clamp(trueWin + noise, 0, 1);
    const numericalDisadvantage = clamp((them - us) / 4, 0, 1);
    const gunValueNorm = clamp((gunValue - 1000) / 4000, 0, 1);
    const scoreDef = Math.max(0, this.scoreDeficit(a.side));

    // --- Score ---
    let saveScore = 0;
    saveScore += (1 - perceivedWin) * 0.55;
    saveScore += numericalDisadvantage * 0.20;
    saveScore += gunValueNorm * 0.30;
    saveScore -= (stats.aggression / 100) * 0.40;
    saveScore -= (stats.discipline / 100) * 0.10;
    saveScore -= Math.min(scoreDef, 6) * 0.03;
    saveScore += (stats.composure - 50) / 200;

    // --- Role responsibilities push against saving, scaled by composure/discipline ---
    if (a.playerId === this.bombCarrier) {
      // Strong push to plant; shaky carriers can still break.
      saveScore -= 0.50 + (stats.discipline / 100) * 0.20;
    }
    if (this.bombPlanted && a.side === "CT" && this.lastAliveOnSide("CT")) {
      // The team needs you on defuse; disciplined + composed CTs honor it.
      saveScore -= 0.20 + (stats.discipline / 100) * 0.20 + (stats.composure / 100) * 0.20;
    }
    if (a.side === "T" && this.bombDropped && !this.bombCarrier) {
      // If you've decided to retrieve the bomb, you don't also save.
      const retrieverId = this.bombRetrieverId();
      if (retrieverId === a.playerId) saveScore -= 0.40;
    }

    if (a.saving) {
      if (saveScore < 0.30) { a.saving = false; a.dirty = true; }
      return;
    }
    if (saveScore > 0.55) {
      a.saving = true;
      a.dirty = true;
    }
  }

  // Which T (if any) is heading for the dropped bomb? Driven by stats, not
  // proximity alone. Players with low gameSense / map awareness may not
  // register the bomb situation at all and just deathmatch.
  private bombRetrieverId(): string | null {
    if (!this.bombDropped || this.bombCarrier) return null;
    let best: Agent | null = null;
    let bestScore = -Infinity;
    for (const a of this.agents) {
      if (!a.alive || a.side !== "T") continue;
      if (a.saving) continue;
      const player = this.players(a.playerId)!;
      const stats = player.stats;
      const d = dist(a.pos, this.bombDropped);
      const proximity = clamp(1 - d / 800, 0, 1);
      // Knowing the bomb matters and where it is.
      const awareness = (stats.gameSense + stats.mapAwareness) / 200;
      // Willingness to play support over fragging.
      const teamMind = (stats.discipline + stats.communication) / 200;
      const aggressionPenalty = clamp((stats.aggression - 50) / 100, 0, 1);
      const roleBonus = player.role === "support" ? 0.10
        : player.role === "igl" ? 0.08
        : player.role === "entry" ? -0.08
        : player.role === "lurker" ? -0.10
        : 0;
      const desire =
          proximity * 0.40
        + awareness * 0.35
        + teamMind  * 0.20
        - aggressionPenalty * 0.20
        + roleBonus;
      if (desire > bestScore) { bestScore = desire; best = a; }
    }
    return bestScore > 0.30 ? (best?.playerId ?? null) : null;
  }

  private closestAliveOnSide(side: Side, ref: Vec2): Agent | null {
    let best: Agent | null = null;
    let bd = Infinity;
    for (const ag of this.agents) {
      if (!ag.alive || ag.side !== side) continue;
      const d = dist(ag.pos, ref);
      if (d < bd) { bd = d; best = ag; }
    }
    return best;
  }

  private teamWinChance(side: Side): number {
    const us = this.agents.filter(a => a.alive && a.side === side).length;
    const them = this.agents.filter(a => a.alive && a.side !== side).length;
    if (us === 0) return 0;
    if (them === 0) return 1;
    // Weight slightly by total HP so a wounded team is rated lower.
    const hpUs = this.agents.filter(a => a.alive && a.side === side).reduce((s, a) => s + a.hp, 0);
    const hpThem = this.agents.filter(a => a.alive && a.side !== side).reduce((s, a) => s + a.hp, 0);
    const headcount = us / (us + them);
    const hpRatio = hpUs / Math.max(1, hpUs + hpThem);
    let r = headcount * 0.7 + hpRatio * 0.3;
    if (this.bombPlanted) {
      if (side === "T") r = r * 0.55 + 0.4;
      else              r = r * 0.85;
    }
    return r;
  }

  private saveSpotFor(a: Agent): Vec2 {
    const spawns = a.side === "CT" ? this.map.ctSpawns : this.map.tSpawns;
    const ref = this.bombPlanted && this.bombPlantedAt
      ? this.bombPlantedAt
      : this.contactZoneFor(a);
    let best = spawns[0];
    let bestD = -Infinity;
    for (const s of spawns) {
      const w = this.tileCenter(s);
      const d = dist(w, ref);
      if (d > bestD) { bestD = d; best = s; }
    }
    return this.tileCenter(best);
  }

  private tGoal(a: Agent): Vec2 | null {
    // Post-plant: hold around the planted bomb.
    if (this.bombPlanted && this.bombPlantedAt) {
      return jitter(this.bombPlantedAt, 70, this.rng);
    }
    // Bomb dropped: a T with the highest "go-get-it" desire (stats-driven,
    // not just proximity) heads to retrieve. Could be nobody — if no one's
    // game sense / discipline registers the bomb, the team plays it as
    // deathmatch instead. Other Ts fall through to normal site duty.
    if (this.bombDropped) {
      const retrieverId = this.bombRetrieverId();
      if (retrieverId && a.playerId === retrieverId) {
        return { x: this.bombDropped.x, y: this.bombDropped.y };
      }
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
    // Bomb dropped (not yet picked up): only the closest CT routes to the
    // drop to guard. Others continue with their normal site duty so the team
    // doesn't collapse onto one point.
    if (this.bombDropped && !this.bombPlanted) {
      const closest = this.closestAliveOnSide("CT", this.bombDropped);
      if (closest && a.playerId === closest.playerId) {
        return jitter(this.bombDropped, 90, this.rng);
      }
      // fall through to normal ctGoal logic below
    }
    // Bomb planted: designated defuser routes exactly to the bomb; others orbit for cover.
    if (this.bombPlanted && this.bombPlantedAt) {
      const cts = this.agents.filter(x => x.side === "CT" && x.alive);
      let defuser = cts[0];
      let bestD = Infinity;
      for (const c of cts) {
        const d = dist(c.pos, this.bombPlantedAt);
        if (d < bestD) { bestD = d; defuser = c; }
      }
      if (defuser && a.playerId === defuser.playerId) {
        return { x: this.bombPlantedAt.x, y: this.bombPlantedAt.y };
      }
      return jitter(this.bombPlantedAt, 70, this.rng);
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

  // ---- Peek and retreat ----
  // When an agent has reached their hold position and is not in combat, look
  // for nearby cover and oscillate between a covered tile and an exposed
  // (peek) tile one step toward the threat direction.
  private tickPeek(a: Agent) {
    if (this.t < a.fleeingFireUntil) return;
    if (this.t < a.blindedUntil) return;
    if (a.stance === "rush" || a.stance === "disengage") return;
    if (this.bombPlanted) return; // post-plant: be present, not peeking
    // Mid-move toward a non-peek goal: don't disturb it.
    if (a.path.length > 0 && a.peekState === "none") return;

    if (a.peekState === "none") {
      if (a.path.length > 0) return;
      if (!this.setupPeek(a)) return;
    }

    if (this.t < a.peekUntil) return;
    const player = this.players(a.playerId)!;
    if (a.peekState === "cover" && a.peekPos) {
      a.peekState = "peek";
      const timing = player.stats.timing;
      a.peekUntil = this.t + 350 + timing * 4;
      this.setGoalForPeek(a, a.peekPos);
    } else if (a.peekState === "peek" && a.coverPos) {
      a.peekState = "cover";
      const patience = player.stats.patience;
      a.peekUntil = this.t + 800 + (100 - patience) * 10 + this.rng() * 400;
      this.setGoalForPeek(a, a.coverPos);
    }
  }

  private setGoalForPeek(a: Agent, goal: Vec2) {
    // Same as setGoal but doesn't clobber peek state.
    const path = findPath(this.map, a.pos, goal);
    if (path === null) return;
    a.target = goal;
    a.path = path;
    a.holdAngle = null;
  }

  private setupPeek(a: Agent): boolean {
    const ts = this.map.tileSize;
    const ax = Math.floor(a.pos.x / ts);
    const ay = Math.floor(a.pos.y / ts);
    const focus = a.side === "CT" ? this.ctThreatFocus : this.tThreatFocus;
    const tx = focus.x - a.pos.x, ty = focus.y - a.pos.y;
    // Cardinal-snap the threat direction.
    let dx = 0, dy = 0;
    if (Math.abs(tx) >= Math.abs(ty)) dx = tx > 0 ? 1 : -1;
    else dy = ty > 0 ? 1 : -1;

    // Search outward for a covered floor tile within a small radius.
    for (let r = 0; r <= 2; r++) {
      for (let oy = -r; oy <= r; oy++) {
        for (let ox = -r; ox <= r; ox++) {
          if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
          const cx = ax + ox, cy = ay + oy;
          if (!this.inBoundsTile(cx, cy) || this.wallAt(cx, cy)) continue;
          // Cover requires a wall directly in the threat direction.
          if (!this.wallAt(cx + dx, cy + dy)) continue;
          // Try both perpendicular peek options; require the peek tile to be
          // floor AND have an open threat-direction so it's actually exposed.
          for (const [px, py] of [[-dy, dx], [dy, -dx]] as const) {
            const pxT = cx + px, pyT = cy + py;
            if (!this.inBoundsTile(pxT, pyT) || this.wallAt(pxT, pyT)) continue;
            if (this.wallAt(pxT + dx, pyT + dy)) continue;
            a.coverPos = this.tileCenter({ x: cx, y: cy });
            a.peekPos = this.tileCenter({ x: pxT, y: pyT });
            a.peekState = "cover";
            const patience = this.players(a.playerId)!.stats.patience;
            a.peekUntil = this.t + 600 + (100 - patience) * 8 + this.rng() * 400;
            // If we're not already at the cover tile, route there first.
            if (ox !== 0 || oy !== 0) this.setGoalForPeek(a, a.coverPos);
            return true;
          }
        }
      }
    }
    return false;
  }

  private inBoundsTile(tx: number, ty: number): boolean {
    return tx >= 0 && ty >= 0 && tx < this.map.width && ty < this.map.height;
  }
  private wallAt(tx: number, ty: number): boolean {
    if (!this.inBoundsTile(tx, ty)) return true;
    return this.map.walls[ty * this.map.width + tx];
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
    if (this.t < a.blindedUntil) return; // can't see, freeze
    if (a.stance === "hold" && this.t < a.stanceUntil) return;
    if (a.path.length === 0) {
      if (a.holdAngle !== null) a.facing = a.holdAngle;
      return;
    }
    const player = this.players(a.playerId)!;

    // Smoke avoidance: most agents wait at the edge of a smoke instead of walking through blind.
    const nextWp = a.path[0];
    const smokeAhead = this.smokes.find(s => dist(nextWp, s.pos) < s.radius);
    if (smokeAhead) {
      const isCarrier = a.playerId === this.bombCarrier;
      const isRushing = a.stance === "rush";
      const fading = (smokeAhead.expiresAt - this.t) < 3000;
      // Push if aggression decisively beats patience (rating-driven temperament).
      const willPushPersonality = player.stats.aggression > player.stats.patience + 15;
      if (!isCarrier && !isRushing && !fading && !willPushPersonality) {
        // Hold at smoke edge — face it, in case anyone comes through.
        a.holdAngle = Math.atan2(smokeAhead.pos.y - a.pos.y, smokeAhead.pos.x - a.pos.x);
        return;
      }
    }

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

    let baseDir = threatDir;
    // Stationary: pre-aim onto a smoke in our threat direction if there is one.
    if (a.path.length === 0) {
      const smoke = this.findThreatSmoke(a, threatDir);
      if (smoke) {
        baseDir = Math.atan2(smoke.pos.y - a.pos.y, smoke.pos.x - a.pos.x);
      } else if (a.holdAngle !== null) {
        baseDir = a.holdAngle;
      }
    } else {
      const wp = a.path[0];
      const moveDir = Math.atan2(wp.y - a.pos.y, wp.x - a.pos.x);
      baseDir = this.rng() < 0.6 ? threatDir : moveDir;
    }

    // Crosshair placement tightens the scan arc; adaptability speeds cadence.
    const cp = player.stats.crosshairPlacement / 100;
    const arcHalf = Math.PI * 0.5 * (1.1 - Math.max(0.4, cp));
    const offset = (this.rng() - 0.5) * 2 * arcHalf;
    const dir = baseDir + offset;

    a.lookTarget = { x: a.pos.x + Math.cos(dir) * 120, y: a.pos.y + Math.sin(dir) * 120 };
    const cadence = 500 + (100 - player.stats.adaptability) * 8 + this.rng() * 400;
    a.lookChangeAt = this.t + cadence;
  }

  // Smokes within ~280 px and roughly in the agent's threat direction (±60°).
  private findThreatSmoke(a: Agent, threatDir: number): Smoke | null {
    let best: Smoke | null = null;
    let bestD = 280;
    for (const s of this.smokes) {
      const d = dist(a.pos, s.pos);
      if (d > bestD) continue;
      const smokeDir = Math.atan2(s.pos.y - a.pos.y, s.pos.x - a.pos.x);
      let angDiff = Math.abs(smokeDir - threatDir);
      while (angDiff > Math.PI) angDiff = Math.PI * 2 - angDiff;
      if (angDiff > Math.PI / 3) continue;
      best = s; bestD = d;
    }
    return best;
  }

  // Smoothly rotate facing toward lookTarget.
  private applyFacing(a: Agent) {
    if (!a.lookTarget) return;
    const desired = Math.atan2(a.lookTarget.y - a.pos.y, a.lookTarget.x - a.pos.x);
    let diff = desired - a.facing;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const player = this.players(a.playerId)!;
    // Turn rate driven by handSpeed (with reflexes as a small contributor).
    const speed = (player.stats.handSpeed * 0.7 + player.stats.reflexes * 0.3) / 100;
    const maxStep = 0.08 + speed * 0.18;
    const step = Math.max(-maxStep, Math.min(maxStep, diff));
    a.facing += step;
  }

  // ---- Combat ----
  private maybeShoot(a: Agent) {
    const player = this.players(a.playerId)!;
    const weaponStats = WEAPONS[a.weapon];

    // Complete any in-progress reload.
    if (a.reloadingUntil > 0 && this.t >= a.reloadingUntil) {
      const needed = weaponStats.magSize - a.ammo;
      const taken = Math.min(needed, a.reserve);
      a.ammo += taken;
      a.reserve -= taken;
      a.reloadingUntil = 0;
    }
    if (a.reloadingUntil > 0) return; // still reloading

    if (this.t < a.fleeingFireUntil) return; // can't fight while fleeing fire
    const reactionMs = 80 + Math.max(0, (100 - player.stats.reflexes)) * 4;
    const stats = player.stats;
    const enemy = this.acquireTarget(a, reactionMs);

    if (!enemy) {
      // Idle auto-reload: top off when no contact, mag low, reserve available.
      if (a.weapon !== "knife" && a.ammo < weaponStats.magSize * 0.4 && a.reserve > 0) {
        a.reloadingUntil = this.t + weaponStats.reloadMs;
        return;
      }
      // Blind spray: hear a running enemy through smoke → shoot toward them.
      if (a.weapon !== "knife" && a.ammo > 0 && this.smokes.length > 0) {
        const blind = this.tryBlindSpray(a);
        if (blind) this.fireBlind(a, blind, weaponStats);
      }
      return;
    }

    // Refresh stance only when previous one has expired — avoids flapping.
    if (this.t >= a.stanceUntil) this.decideStance(a, enemy);

    // Disengage: skip firing; the path is already moving us toward cover.
    if (a.stance === "disengage") return;

    const weapon = weaponStats;
    const cooldown = 1000 / weapon.fireRate;
    if (this.t - a.lastShotAt < cooldown) return;

    // Forced reload when the mag is empty.
    if (a.weapon !== "knife" && a.ammo <= 0) {
      if (a.reserve > 0) a.reloadingUntil = this.t + weapon.reloadMs;
      return;
    }

    a.lastShotAt = this.t;
    if (a.weapon !== "knife") a.ammo--;
    // Snap-aim to the target when actually firing; also redirect scanning to them.
    a.facing = Math.atan2(enemy.pos.y - a.pos.y, enemy.pos.x - a.pos.x);
    a.lookTarget = { x: enemy.pos.x, y: enemy.pos.y };
    a.lookChangeAt = this.t + 300;

    const d = dist(a.pos, enemy.pos);
    const rangeFactor = Math.max(0.25, 1 - Math.max(0, d - weapon.range * 0.5) / weapon.range);

    // Base aim: accuracy with weapon-pref scaling 30% of the way toward the preferred-weapon rating.
    const slot = WEAPONS[a.weapon].slot;
    const prefMap: Record<typeof slot, number> = {
      knife: 50,
      pistol: stats.pistolPref,
      smg: stats.smgPref,
      rifle: stats.riflePref,
      awp: stats.awpPref,
    };
    const weaponPref = (prefMap[slot] ?? 50) / 100;
    let aimMod = (stats.accuracy / 100) * 0.7 + weaponPref * 0.3;

    // Last alive — composure carries you. Score deficit punishes low composure.
    if (this.lastAliveOnSide(a.side)) aimMod += (stats.composure - 60) / 200;
    if (this.scoreDeficit(a.side) >= 3) aimMod -= Math.max(0, 60 - stats.composure) / 400;

    // Trade-frag window
    if (this.tradeMarks.some(m => m.killerId === enemy.playerId && m.victimSide === a.side)) {
      aimMod += TRADE_AIM_BONUS;
    }

    // First shot vs sustained spray: tapping helps the first crisp shot; sprayControl helps follow-ups.
    const sinceLastShot = this.t - a.lastShotAt;
    if (a.lastShotAt > 0 && sinceLastShot < 500) {
      aimMod += (stats.sprayControl - 50) / 400;
    } else {
      aimMod += (stats.tapping - 50) / 500;
    }

    // Stationary aim bonus, weighted by counter-strafe (stopping accuracy).
    if (a.path.length === 0) {
      aimMod += 0.04 + (stats.counterStrafe - 50) / 600;
    } else {
      aimMod -= 0.05;
    }

    // Mood is a softer modifier — represents in-the-moment confidence.
    aimMod += (player.mood - 50) / 400;

    const hitChance = clamp(weapon.accuracy * aimMod * rangeFactor, 0.05, 0.95);
    const hit = this.rng() < hitChance;
    this.tickShots.push({
      from: { ...a.pos }, to: { ...enemy.pos }, side: a.side, hit, killerId: a.playerId,
    });
    if (!hit) return;

    let dmg = weapon.damage * (0.85 + this.rng() * 0.3);

    // Headshot roll — crosshair placement contributes most, then accuracy.
    const hsBase = HEADSHOT_BASE[a.weapon];
    const hsChance = clamp(hsBase + (stats.crosshairPlacement - 50) / 350 + (stats.accuracy - 50) / 600, 0.03, 0.55);
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

      if (enemy.playerId === this.bombCarrier) this.dropBomb(enemy);
    }
  }

  private dropBomb(victim: Agent) {
    this.bombDropped = { x: victim.pos.x, y: victim.pos.y };
    this.bombCarrier = null;
    for (const ag of this.agents) if (ag.alive) ag.dirty = true;
  }

  // ---- Engagement stance ----
  private decideStance(a: Agent, enemy: Agent) {
    const player = this.players(a.playerId)!;
    const stats = player.stats;
    const isLastAlive = this.lastAliveOnSide(a.side);

    // Saving: refuse engagement, just keep moving toward the hide spot.
    if (a.saving) {
      a.stance = "disengage";
      a.stanceUntil = this.t + 2000;
      this.setGoal(a, this.saveSpotFor(a));
      return;
    }

    // Count visible enemies.
    let visibleEnemies = 0;
    for (const e of this.agents) {
      if (!e.alive || e.side === a.side) continue;
      if (dist(a.pos, e.pos) > VISION_RANGE) continue;
      if (!this.hasLineOfSight(a.pos, e.pos)) continue;
      visibleEnemies++;
    }
    // Nearby allies — low-composure players want closer support to feel safe.
    const allyRange = 240 + (80 - stats.composure) * 0.8;
    let nearbyAllies = 0;
    for (const al of this.agents) {
      if (!al.alive || al.side !== a.side || al.playerId === a.playerId) continue;
      if (dist(a.pos, al.pos) < allyRange) nearbyAllies++;
    }

    // Low-composure player behind on score will retreat even from solo contact.
    const tiltPressure = stats.composure < 45 && this.scoreDeficit(a.side) >= 3;
    const enemyThreshold = tiltPressure ? 1 : 2;
    // Composed clutch players refuse to disengage when last alive.
    const refuseDisengage = isLastAlive && stats.composure > 70;

    let stance: Agent["stance"];
    if (!refuseDisengage && visibleEnemies >= enemyThreshold && nearbyAllies === 0) {
      stance = "disengage";
    } else {
      const myCost = WEAPONS[a.weapon].cost;
      const theirCost = WEAPONS[enemy.weapon].cost;
      const ratio = myCost / Math.max(1, theirCost);
      const d = dist(a.pos, enemy.pos);
      // Aggression scales rush threshold; clutch-last-alive adds extra push.
      const rushBias = (stats.aggression - 60) / 200 + (isLastAlive && stats.composure > 65 ? 0.25 : 0);
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

  // ---- Blind spray (audio cue through smoke) ----
  private tryBlindSpray(a: Agent): Agent | null {
    for (const e of this.agents) {
      if (!e.alive || e.side === a.side) continue;
      if (e.moveMode !== "run") continue;
      const d = dist(a.pos, e.pos);
      if (d > HEARING_RANGE) continue;
      if (this.hasLineOfSight(a.pos, e.pos)) continue; // direct LOS handled by acquireTarget
      if (this.wallOnLine(a.pos, e.pos)) continue;    // walls block bullets even through smoke
      if (!this.smokeOnLine(a.pos, e.pos)) continue;
      return e;
    }
    return null;
  }

  private wallOnLine(p1: Vec2, p2: Vec2): boolean {
    const ts = this.map.tileSize;
    const W = this.map.width, H = this.map.height;
    let tx = Math.floor(p1.x / ts);
    let ty = Math.floor(p1.y / ts);
    const ex = Math.floor(p2.x / ts);
    const ey = Math.floor(p2.y / ts);
    const dx = p2.x - p1.x, dy = p2.y - p1.y;
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const invDx = dx !== 0 ? 1 / dx : Infinity;
    const invDy = dy !== 0 ? 1 / dy : Infinity;
    const nextBoundaryX = (tx + (stepX > 0 ? 1 : 0)) * ts;
    const nextBoundaryY = (ty + (stepY > 0 ? 1 : 0)) * ts;
    let tMaxX = dx !== 0 ? (nextBoundaryX - p1.x) * invDx : Infinity;
    let tMaxY = dy !== 0 ? (nextBoundaryY - p1.y) * invDy : Infinity;
    const tDeltaX = dx !== 0 ? Math.abs(ts * invDx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(ts * invDy) : Infinity;
    const startTx = tx, startTy = ty;
    let safety = (W + H) * 2;
    while (safety-- > 0) {
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) return true;
      if (!(tx === startTx && ty === startTy)) {
        if (this.map.walls[ty * W + tx]) return true;
      }
      if (tx === ex && ty === ey) return false;
      if (tMaxX < tMaxY) { tx += stepX; tMaxX += tDeltaX; }
      else                { ty += stepY; tMaxY += tDeltaY; }
    }
    return false;
  }

  private smokeOnLine(p1: Vec2, p2: Vec2): boolean {
    const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
    const steps = Math.ceil(d / 10);
    for (let i = 1; i < steps; i++) {
      const tt = i / steps;
      const x = p1.x + (p2.x - p1.x) * tt;
      const y = p1.y + (p2.y - p1.y) * tt;
      for (const sm of this.smokes) {
        const dx = x - sm.pos.x, dy = y - sm.pos.y;
        if (dx * dx + dy * dy < sm.radius * sm.radius) return true;
      }
    }
    return false;
  }

  private fireBlind(a: Agent, target: Agent, weapon: typeof WEAPONS[keyof typeof WEAPONS]) {
    const cooldown = 1000 / weapon.fireRate;
    if (this.t - a.lastShotAt < cooldown) return;
    a.lastShotAt = this.t;
    if (a.weapon !== "knife") a.ammo--;
    const HIT_CHANCE = 0.08;
    const hit = this.rng() < HIT_CHANCE;
    this.tickShots.push({
      from: { x: a.pos.x, y: a.pos.y },
      to: { x: target.pos.x, y: target.pos.y },
      side: a.side, hit, killerId: a.playerId,
    });
    if (!hit) return;
    let dmg = weapon.damage * (0.6 + this.rng() * 0.3);
    if (target.armor > 0) {
      dmg *= 0.65;
      target.armor = Math.max(0, target.armor - dmg * 0.5);
    }
    const applied = Math.min(target.hp, dmg);
    target.hp -= dmg;
    this.addDamage(a.playerId, applied);
    if (target.hp <= 0) {
      target.alive = false;
      target.hp = 0;
      if (target.weapon !== "knife") {
        this.drops.push({ pos: { x: target.pos.x, y: target.pos.y }, weapon: target.weapon });
      }
      this.push({ t: this.t, kind: "kill", killer: a.playerId, victim: target.playerId, weapon: a.weapon, headshot: false });
      this.bumpStat(a.playerId, "kills", 1);
      this.bumpStat(target.playerId, "deaths", 1);
      if (target.playerId === this.bombCarrier) this.dropBomb(target);
    }
  }

  // Target acquisition with reaction delay.
  // The agent must have LOS to an enemy for at least reactionMs before they can fire.
  private acquireTarget(a: Agent, reactionMs: number): Agent | null {
    if (this.t < a.blindedUntil) {
      // Blinded — can't see anything, forget all prior sightings.
      for (const id of Object.keys(a.spotted)) delete a.spotted[id];
      return null;
    }
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
    // Grid traversal (Amanatides–Woo) — visits every tile the segment touches.
    const ts = this.map.tileSize;
    const W = this.map.width, H = this.map.height;
    let tx = Math.floor(a.x / ts);
    let ty = Math.floor(a.y / ts);
    const ex = Math.floor(b.x / ts);
    const ey = Math.floor(b.y / ts);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const stepX = dx > 0 ? 1 : dx < 0 ? -1 : 0;
    const stepY = dy > 0 ? 1 : dy < 0 ? -1 : 0;
    const invDx = dx !== 0 ? 1 / dx : Infinity;
    const invDy = dy !== 0 ? 1 / dy : Infinity;
    const nextBoundaryX = (tx + (stepX > 0 ? 1 : 0)) * ts;
    const nextBoundaryY = (ty + (stepY > 0 ? 1 : 0)) * ts;
    let tMaxX = dx !== 0 ? (nextBoundaryX - a.x) * invDx : Infinity;
    let tMaxY = dy !== 0 ? (nextBoundaryY - a.y) * invDy : Infinity;
    const tDeltaX = dx !== 0 ? Math.abs(ts * invDx) : Infinity;
    const tDeltaY = dy !== 0 ? Math.abs(ts * invDy) : Infinity;

    const checkSmoke = (px: number, py: number): boolean => {
      for (const sm of this.smokes) {
        const sdx = px - sm.pos.x, sdy = py - sm.pos.y;
        if (sdx * sdx + sdy * sdy >= sm.radius * sm.radius) continue;
        let inHole = false;
        for (const h of this.smokeHoles) {
          const hdx = px - h.pos.x, hdy = py - h.pos.y;
          if (hdx * hdx + hdy * hdy < h.radius * h.radius) { inHole = true; break; }
        }
        if (!inHole) return true; // blocked by smoke
      }
      return false;
    };

    // Walk tiles along the segment. Bail if we hit a wall or smoke.
    let safety = (W + H) * 2;
    while (safety-- > 0) {
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
      // Skip the start tile (shooter/eye is inside it).
      if (!(tx === Math.floor(a.x / ts) && ty === Math.floor(a.y / ts))) {
        if (this.map.walls[ty * W + tx]) return false;
      }
      // Sample point near the entry into this tile for smoke check.
      const tAlong = Math.min(tMaxX, tMaxY);
      const px = a.x + dx * Math.min(1, Math.max(0, tAlong));
      const py = a.y + dy * Math.min(1, Math.max(0, tAlong));
      if (checkSmoke(px, py)) return false;

      if (tx === ex && ty === ey) return true;
      if (tMaxX < tMaxY) { tx += stepX; tMaxX += tDeltaX; }
      else                { ty += stepY; tMaxY += tDeltaY; }
    }
    return true;
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

    // Dropped bomb pickup: any alive T who walks over it grabs it.
    if (this.bombDropped && !this.bombCarrier) {
      const PICKUP_RANGE = this.map.tileSize * 0.9;
      let closest: Agent | null = null;
      let bestD = Infinity;
      for (const ag of this.agents) {
        if (!ag.alive || ag.side !== "T") continue;
        const d = dist(ag.pos, this.bombDropped);
        if (d < PICKUP_RANGE && d < bestD) { bestD = d; closest = ag; }
      }
      if (closest) {
        this.bombCarrier = closest.playerId;
        this.bombDropped = null;
        closest.dirty = true;
      }
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
