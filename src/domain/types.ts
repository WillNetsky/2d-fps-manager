// Core domain types for the 2D FPS manager.
// Designed to support a "full personality sim": stats + traits + mood drive sim outcomes.

export type Side = "CT" | "T";

export type Role = "entry" | "awper" | "support" | "igl" | "lurker";

// 0-100 attribute scale across the board for legibility.
// Six categories of fine-grained ratings — sim reads these, UI usually shows aggregated summaries.
export interface PlayerStats {
  // Aim
  accuracy: number;          // base hit chance
  crosshairPlacement: number; // pre-aim quality
  sprayControl: number;      // sustained-fire accuracy
  tapping: number;           // first-shot discipline
  flickAim: number;          // snap acquisition
  counterStrafe: number;     // accuracy after stopping

  // Mechanical
  reflexes: number;          // reaction time (target acquisition delay)
  handSpeed: number;         // turn/aim rotation speed
  movement: number;          // overall pace
  jiggle: number;            // peek discipline (unused for now; reserved)

  // Cognitive
  mapAwareness: number;      // spatial model of the map
  positioning: number;       // chooses good defensive/offensive spots
  gameSense: number;         // general decision making
  timing: number;            // peek/push timing
  adaptability: number;      // adjusts mid-round (reassess cadence)

  // Mental
  composure: number;         // pressure resistance (replaces nerve)
  aggression: number;        // base push tendency
  patience: number;          // willingness to wait (e.g., for smokes)
  discipline: number;        // sticks to IGL plan
  recovery: number;          // bounceback from setbacks

  // Utility
  utility: number;           // general util mastery
  smokeLineups: number;      // knows where to throw smokes
  flashTiming: number;       // pops flashes effectively
  molotovUse: number;        // area denial

  // Weapon specialty (50 = neutral, >50 = bonus, <50 = penalty)
  pistolPref: number;
  riflePref: number;
  awpPref: number;
  smgPref: number;

  // Team
  igl: number;               // shotcalling
  communication: number;     // info sharing
}

export type Trait =
  | "clutch"           // performs better when last alive
  | "tilts-easy"       // performance drops when behind
  | "smoke-savant"     // utility +
  | "rifler"           // bonus with rifles, malus with awp
  | "awp-prodigy"      // bonus with awp
  | "shaky-eco"        // nerve drops on eco rounds
  | "loyal"            // morale boost from teammates
  | "entry-fragger";   // bonus when taking first contact

export interface Player {
  id: string;
  name: string;
  role: Role;
  stats: PlayerStats;
  traits: Trait[];

  // Dynamic state — updated round to round.
  money: number;       // per-player bank
  mood: number;        // 0-100, drifts based on outcomes
  morale: number;      // 0-100, longer-term
  // Relationships keyed by other player id (-100 to 100).
  relationships: Record<string, number>;
  // Coach-set CT-side placement. "auto" means RoundSim picks based on setup.
  ctAssignment: "A" | "B" | "mid" | "auto";
}

export type WeaponId =
  | "knife"
  | "glock"    // T default pistol
  | "usp"      // CT default pistol
  | "deagle"
  | "mp9"      // CT SMG
  | "mac10"    // T SMG
  | "m4"       // CT rifle
  | "ak"       // T rifle
  | "awp";

export type WeaponSlot = "knife" | "pistol" | "smg" | "rifle" | "awp";

export interface Weapon {
  id: WeaponId;
  name: string;
  slot: WeaponSlot;    // category for stat prefs / pistol-round rules
  faction?: Side;      // CT/T-only weapons (omitted = universal)
  cost: number;
  damage: number;      // per hit, before falloff
  fireRate: number;    // shots per second
  accuracy: number;    // 0-1 base, modulated by player stats
  range: number;       // effective range in world units
  magSize: number;     // bullets per magazine (0 = N/A)
  reserveAmmo: number; // spare bullets at spawn
  reloadMs: number;    // time to reload one full magazine
  // CS2-style damage falloff: damage *= rangeModifier ^ (distance / FALLOFF_UNIT).
  // 1.0 = no falloff (AWP-like); ~0.75 = drops off fast (pistols).
  rangeModifier: number;
  // Fraction of damage that bypasses armor on body shots (0-1). High = ignores vest.
  armorPen: number;
  // Headshot multiplier — almost always 4 in CS; AWP irrelevant since one-shot.
  headshotMultiplier: number;
}

export type UtilityId = "smoke" | "flash" | "he" | "molotov";

export interface Utility {
  id: UtilityId;
  name: string;
  cost: number;
}

export interface Loadout {
  weapon: WeaponId;
  utility: UtilityId[];
  armor: boolean;
  helmet: boolean;
  // Items the player already owns at the start of the buy phase (free).
  keptWeapon: WeaponId | null;
  keptArmor: boolean;
  keptHelmet: boolean;
  keptUtility: UtilityId[];
}

export interface DroppedWeapon {
  pos: Vec2;
  weapon: WeaponId;
}

export interface MatchStats {
  kills: number;
  deaths: number;
  damage: number;       // total damage dealt this match
  roundsPlayed: number;
}

export interface Team {
  id: string;
  name: string;
  side: Side;          // current side this half
  players: Player[];
  roundsWon: number;
  // Per-player current loadout for the upcoming round.
  loadouts: Record<string, Loadout>;
  // Per-player rolling stats for the current match.
  matchStats: Record<string, MatchStats>;
}

// World / map representation — grid-based for the minimal sim.
export interface GameMap {
  name: string;
  width: number;       // tiles
  height: number;      // tiles
  tileSize: number;    // pixels per tile
  walls: boolean[];    // length = width*height
  ctSpawns: Vec2[];
  tSpawns: Vec2[];
  bombsites: { id: "A" | "B"; center: Vec2; radius: number }[];
  // Optional per-map flavor colors (hex strings, e.g. "#3a414f"). Renderer/editor fall back to defaults if absent.
  wallColor?: string;
  floorColor?: string;
}

export interface Vec2 { x: number; y: number; }

export type SiteAssignment = "A" | "B" | "mid";

// A single agent in the sim — bound to a Player but with runtime state.
export interface Agent {
  playerId: string;
  side: Side;
  pos: Vec2;
  facing: number;       // radians
  hp: number;
  armor: number;
  helmet: boolean;      // halves HS damage; breaks after first HS taken
  weapon: WeaponId;
  ammo: number;         // rounds in current magazine
  reserve: number;      // rounds in reserve
  reloadingUntil: number; // sim ms when reload completes (0 if not reloading)
  utility: UtilityId[];
  alive: boolean;
  lastShotAt: number;   // sim time (ms)
  target: Vec2 | null;  // current move target (final destination)
  path: Vec2[];         // remaining waypoints to target (world coords)
  // Per-enemy first-spotted timestamps for reaction-delay gating.
  spotted: Record<string, number>;
  holdAngle: number | null;
  // Tactical assignment for the round.
  assignedSite: SiteAssignment;
  // Specific hold-point id within the assigned region (e.g., "A-choke",
  // "mid-info"). Null when no hold points are derivable for this map.
  holdPoint: string | null;
  nextThinkAt: number;
  dirty: boolean;
  moveMode: "walk" | "run";
  // Scanning: agent rotates 'facing' toward direction(of lookTarget). Updated periodically.
  lookTarget: Vec2 | null;
  lookChangeAt: number;
  // Decision on what to do when an enemy is acquired.
  stance: "none" | "hold" | "rush" | "disengage";
  stanceUntil: number;
  // Flash effect — agent can't acquire targets or move while blinded.
  blindedUntil: number;
  // Fire avoidance — when set, agent is fleeing a burning area, can't think/shoot.
  fleeingFireUntil: number;
  // Peek-and-retreat: oscillate between cover and a brief exposed step.
  coverPos: Vec2 | null;
  peekPos: Vec2 | null;
  peekState: "cover" | "peek" | "none";
  peekUntil: number;
  // Number of full cover→peek oscillations since the current peek loop began.
  // Caps a stalemate where neither side can land a shot through their jiggle.
  peekCycles: number;
  // Saving: agent has decided this round is unwinnable and wants to keep
  // their gun for the next round. Avoids engagements, hides far from contact.
  saving: boolean;
  reassessSaveAt: number;
}

export type TStrategy = "rush-A" | "rush-B" | "default" | "split-A" | "split-B";

export interface Smoke {
  pos: Vec2;
  radius: number;        // world units
  expiresAt: number;     // sim ms
  side: Side;            // who threw it (for stats later)
}

export interface Flash {
  pos: Vec2;
  detonatesAt: number;   // sim ms when blind effect fires
  side: Side;
}

export interface Molotov {
  pos: Vec2;
  radius: number;
  expiresAt: number;
  side: Side;
  thrower: string;       // playerId — for kill credit
}

export interface HE {
  pos: Vec2;
  detonatesAt: number;
  side: Side;
  thrower: string;
}

export type GrenadeKind = "smoke" | "flash" | "molotov" | "he";

export interface GrenadeInFlight {
  kind: GrenadeKind;
  thrower: string;
  side: Side;
  start: Vec2;
  landing: Vec2;
  startedAt: number;
  landsAt: number;
}

export interface SmokeHole {
  pos: Vec2;
  radius: number;
  expiresAt: number;
}

export type KillCause = WeaponId | "molotov" | "he";

export type RoundOutcome = "ct-elim" | "t-elim" | "bomb-detonated" | "bomb-defused" | "time-expired";

export interface RoundResult {
  outcome: RoundOutcome;
  winningSide: Side;
  durationMs: number;
  events: SimEvent[];
}

export type SimEvent =
  | { t: number; kind: "kill"; killer: string; victim: string; weapon: KillCause; headshot: boolean }
  | { t: number; kind: "bomb-plant"; planter: string }
  | { t: number; kind: "bomb-defuse"; defuser: string }
  | { t: number; kind: "bomb-detonate" }
  | { t: number; kind: "bomb-pickup"; player: string }
  | { t: number; kind: "pickup"; player: string; weapon: WeaponId; dropped: WeaponId | null }
  | { t: number; kind: "util-throw"; thrower: string; util: UtilityId }
  | { t: number; kind: "save"; player: string; on: boolean }
  | { t: number; kind: "round-start" }
  | { t: number; kind: "round-end"; winner: Side };

export interface MatchState {
  ct: Team;
  t: Team;
  map: GameMap;
  roundNumber: number;
  maxRounds: number;       // e.g. 16 (first to 9 wins) for a short demo match
  history: RoundResult[];
}
