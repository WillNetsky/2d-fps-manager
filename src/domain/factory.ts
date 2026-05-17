import type { GameMap, Player, PlayerStats, Role, Team, Trait, Vec2 } from "./types.ts";

const FIRST_NAMES = ["Aleks","Niko","Kai","Jin","Theo","Luc","Mateo","Ezra","Otto","Ravi","Sasha","Yuri","Bram","Cy","Dax","Finn"];
const LAST_NAMES = ["Vale","Reyes","Park","Okafor","Lindholm","Costa","Becker","Marek","Singh","Hass","Doyle","Brandt","Voss","Ahn","Renn","Kazan"];

// Deterministic-ish RNG so we can seed runs later.
let rngState = 0xC0FFEE;
export function setSeed(seed: number) { rngState = seed >>> 0; }
function rand(): number {
  rngState = (rngState * 1664525 + 1013904223) >>> 0;
  return rngState / 0x1_0000_0000;
}
function randInt(lo: number, hi: number) { return Math.floor(rand() * (hi - lo + 1)) + lo; }
function pick<T>(arr: T[]): T { return arr[Math.floor(rand() * arr.length)]; }

function rollStat(base: number, spread: number): number {
  return Math.max(20, Math.min(95, Math.round(base + (rand() - 0.5) * 2 * spread)));
}

// Per-role base/spread per stat. Missing keys fall through to a neutral baseline.
const NEUTRAL: [number, number] = [60, 12];

const ROLE_PROFILES: Record<Role, Partial<Record<keyof PlayerStats, [number, number]>>> = {
  entry: {
    accuracy: [72, 10], crosshairPlacement: [70, 10], sprayControl: [70, 10],
    tapping: [62, 12], flickAim: [78, 10], counterStrafe: [65, 10],
    reflexes: [80, 8], handSpeed: [80, 8], movement: [76, 8], jiggle: [70, 10],
    mapAwareness: [62, 10], positioning: [58, 10], gameSense: [60, 10],
    timing: [60, 10], adaptability: [62, 10],
    composure: [62, 12], aggression: [82, 8], patience: [38, 10],
    discipline: [55, 12], recovery: [60, 12],
    utility: [50, 10], smokeLineups: [45, 10], flashTiming: [55, 10], molotovUse: [50, 10],
    pistolPref: [55, 8], riflePref: [70, 8], awpPref: [40, 10], smgPref: [60, 10],
    igl: [35, 10], communication: [55, 10],
  },
  awper: {
    accuracy: [82, 8], crosshairPlacement: [80, 8], sprayControl: [50, 10],
    tapping: [78, 8], flickAim: [82, 8], counterStrafe: [75, 8],
    reflexes: [78, 8], handSpeed: [76, 8], movement: [60, 10], jiggle: [72, 10],
    mapAwareness: [70, 10], positioning: [74, 10], gameSense: [70, 10],
    timing: [72, 10], adaptability: [60, 10],
    composure: [76, 8], aggression: [55, 12], patience: [70, 10],
    discipline: [60, 12], recovery: [60, 12],
    utility: [48, 10], smokeLineups: [45, 10], flashTiming: [45, 10], molotovUse: [45, 10],
    pistolPref: [55, 8], riflePref: [50, 8], awpPref: [82, 8], smgPref: [45, 10],
    igl: [40, 10], communication: [55, 10],
  },
  support: {
    accuracy: [66, 10], crosshairPlacement: [66, 10], sprayControl: [68, 10],
    tapping: [60, 10], flickAim: [55, 10], counterStrafe: [62, 10],
    reflexes: [64, 10], handSpeed: [62, 10], movement: [66, 8], jiggle: [60, 10],
    mapAwareness: [76, 8], positioning: [74, 8], gameSense: [74, 8],
    timing: [70, 10], adaptability: [68, 10],
    composure: [72, 10], aggression: [50, 10], patience: [75, 10],
    discipline: [78, 8], recovery: [65, 10],
    utility: [82, 6], smokeLineups: [82, 8], flashTiming: [78, 8], molotovUse: [76, 10],
    pistolPref: [55, 10], riflePref: [65, 10], awpPref: [40, 10], smgPref: [60, 10],
    igl: [45, 10], communication: [70, 10],
  },
  igl: {
    accuracy: [62, 10], crosshairPlacement: [66, 10], sprayControl: [58, 10],
    tapping: [62, 10], flickAim: [55, 10], counterStrafe: [60, 10],
    reflexes: [62, 10], handSpeed: [60, 10], movement: [62, 8], jiggle: [58, 10],
    mapAwareness: [88, 6], positioning: [78, 8], gameSense: [88, 6],
    timing: [78, 8], adaptability: [82, 8],
    composure: [82, 8], aggression: [50, 12], patience: [68, 10],
    discipline: [82, 8], recovery: [72, 10],
    utility: [74, 8], smokeLineups: [72, 10], flashTiming: [70, 10], molotovUse: [68, 10],
    pistolPref: [55, 10], riflePref: [60, 10], awpPref: [42, 10], smgPref: [55, 10],
    igl: [85, 6], communication: [82, 8],
  },
  lurker: {
    accuracy: [74, 10], crosshairPlacement: [76, 10], sprayControl: [62, 10],
    tapping: [72, 10], flickAim: [74, 10], counterStrafe: [70, 10],
    reflexes: [72, 8], handSpeed: [68, 10], movement: [70, 8], jiggle: [72, 10],
    mapAwareness: [80, 8], positioning: [80, 8], gameSense: [76, 8],
    timing: [78, 8], adaptability: [62, 10],
    composure: [78, 8], aggression: [48, 12], patience: [82, 8],
    discipline: [55, 12], recovery: [65, 10],
    utility: [55, 10], smokeLineups: [50, 10], flashTiming: [50, 10], molotovUse: [50, 10],
    pistolPref: [60, 10], riflePref: [70, 10], awpPref: [55, 10], smgPref: [55, 10],
    igl: [40, 10], communication: [50, 10],
  },
};

function statsForRole(role: Role): PlayerStats {
  const profile = ROLE_PROFILES[role];
  const out: Partial<PlayerStats> = {};
  const ALL_KEYS: Array<keyof PlayerStats> = [
    "accuracy","crosshairPlacement","sprayControl","tapping","flickAim","counterStrafe",
    "reflexes","handSpeed","movement","jiggle",
    "mapAwareness","positioning","gameSense","timing","adaptability",
    "composure","aggression","patience","discipline","recovery",
    "utility","smokeLineups","flashTiming","molotovUse",
    "pistolPref","riflePref","awpPref","smgPref",
    "igl","communication",
  ];
  for (const key of ALL_KEYS) {
    const [base, spread] = profile[key] ?? NEUTRAL;
    out[key] = rollStat(base, spread);
  }
  return out as PlayerStats;
}

const ROLE_TRAITS: Record<Role, Trait[]> = {
  entry: ["entry-fragger", "rifler", "tilts-easy"],
  awper: ["awp-prodigy", "clutch", "shaky-eco"],
  support: ["smoke-savant", "loyal"],
  igl: ["clutch", "loyal", "smoke-savant"],
  lurker: ["clutch", "rifler", "tilts-easy"],
};

function rollTraits(role: Role): Trait[] {
  const pool = ROLE_TRAITS[role];
  const count = randInt(1, 2);
  const out: Trait[] = [];
  for (let i = 0; i < count; i++) {
    const t = pick(pool);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

let playerCounter = 0;
export function makePlayer(role: Role): Player {
  const id = `p${++playerCounter}`;
  const name = `${pick(FIRST_NAMES)} "${pick(["zen","fox","ace","ghost","king","ice","null","drift","pulse","raze"])}" ${pick(LAST_NAMES)}`;
  return {
    id, name, role,
    stats: statsForRole(role),
    traits: rollTraits(role),
    money: STARTING_PER_PLAYER,
    mood: 65,
    morale: 65,
    relationships: {},
    ctAssignment: "auto",
  };
}

export const STARTING_PER_PLAYER = 800;

const ALL_STAT_KEYS: Array<keyof PlayerStats> = [
  "accuracy","crosshairPlacement","sprayControl","tapping","flickAim","counterStrafe",
  "reflexes","handSpeed","movement","jiggle",
  "mapAwareness","positioning","gameSense","timing","adaptability",
  "composure","aggression","patience","discipline","recovery",
  "utility","smokeLineups","flashTiming","molotovUse",
  "pistolPref","riflePref","awpPref","smgPref",
  "igl","communication",
];

// Force every stat on every player on this team to `value` (default 60).
// Useful for balance tests where you want player skill out of the equation.
export function neutralizeTeamStats(team: Team, value = 60) {
  for (const p of team.players) {
    for (const k of ALL_STAT_KEYS) p.stats[k] = value;
  }
}

const STANDARD_ROSTER: Role[] = ["igl", "awper", "entry", "support", "lurker"];

export function makeTeam(id: string, name: string, side: "CT" | "T"): Team {
  const players = STANDARD_ROSTER.map(makePlayer);
  // Initialize neutral relationships.
  for (const p of players) {
    for (const q of players) {
      if (p.id !== q.id) p.relationships[q.id] = randInt(-15, 30);
    }
  }
  return {
    id, name, side,
    players,
    roundsWon: 0,
    loadouts: Object.fromEntries(players.map(p => [p.id, {
      weapon: "pistol" as const, utility: [], armor: false, helmet: false,
      keptWeapon: null, keptArmor: false, keptHelmet: false, keptUtility: [],
    }])),
    matchStats: Object.fromEntries(players.map(p => [p.id, { kills: 0, deaths: 0, damage: 0, roundsPlayed: 0 }])),
  };
}

// Dust2-shaped map: A site top-right, B site top-left, CT spawn top-center,
// T spawn bottom-center. Three routes — B tunnels (left), mid (center),
// long A (right) — meet at the bombsites.
export function makeMap(): GameMap {
  const width = 33;
  const height = 21;
  const tileSize = 29;
  // Start fully walled; carve rooms and corridors.
  const walls = new Array<boolean>(width * height).fill(true);
  const at = (x: number, y: number) => y * width + x;
  const carve = (x1: number, y1: number, x2: number, y2: number) => {
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        if (x >= 0 && y >= 0 && x < width && y < height) walls[at(x, y)] = false;
      }
    }
  };
  const wall = (x: number, y: number) => { walls[at(x, y)] = true; };

  // --- Bombsites & spawns ---
  // B site (top-left)
  carve(1, 1, 6, 5);
  // A site (top-right)
  carve(25, 1, 30, 5);
  // CT spawn (top-center)
  carve(13, 1, 18, 3);
  // T spawn (bottom-center, two pockets)
  carve(8, 16, 13, 18);
  carve(18, 16, 23, 18);
  carve(13, 17, 18, 18);

  // --- Corridors from CT spawn ---
  // CT → B (top-left horizontal)
  carve(6, 1, 13, 3);
  // CT → A (top-right horizontal)
  carve(18, 1, 25, 3);
  // CT → mid (down through center)
  carve(14, 3, 17, 7);

  // --- Mid corridor ---
  carve(13, 5, 18, 12);
  // Mid doors choke (between CT-side mid and lower mid)
  wall(13, 8); wall(18, 8);
  carve(14, 8, 17, 8);

  // --- B tunnels (left vertical) ---
  carve(1, 5, 5, 16);
  // T → B tunnels (lower-left horizontal)
  carve(1, 15, 13, 16);

  // --- Long A (right vertical) ---
  carve(26, 5, 30, 16);
  // T → long (lower-right horizontal)
  carve(18, 15, 30, 16);

  // --- Catwalk: mid → A short ---
  carve(17, 6, 25, 8);

  // --- Lower mid / pit (T mid approach) ---
  carve(11, 11, 20, 15);

  // --- Cover blobs (small interior walls for tactical interest) ---
  // B site cover
  wall(3, 3);
  // A site cover (default plant area)
  wall(28, 3);
  // Mid pillar
  wall(15, 10); wall(16, 10);
  // Catwalk cover
  wall(21, 7);
  // Long corner
  wall(28, 11);
  // B tunnels jog
  wall(3, 10);

  // --- Corridor chokes (break spawn-to-spawn LOS, force zigzag) ---
  // Mid corridor — staggered partitions force a kink past mid doors.
  for (let x = 13; x <= 16; x++) wall(x, 7);
  for (let x = 15; x <= 18; x++) wall(x, 9);
  // Long A — "long doors" plus a second offset wall lower down.
  for (let x = 27; x <= 30; x++) wall(x, 9);
  for (let x = 26; x <= 29; x++) wall(x, 13);
  // B tunnels — same idea, mirrored.
  for (let x = 1; x <= 4; x++) wall(x, 9);
  for (let x = 2; x <= 5; x++) wall(x, 13);

  // --- Spawns ---
  const ctSpawns: Vec2[] = [
    { x: 14, y: 1 }, { x: 15, y: 1 }, { x: 16, y: 1 }, { x: 17, y: 1 }, { x: 15, y: 2 },
  ];
  const tSpawns: Vec2[] = [
    { x: 10, y: 17 }, { x: 11, y: 17 }, { x: 21, y: 17 }, { x: 20, y: 17 }, { x: 15, y: 18 },
  ];

  return {
    name: "de_dust2_legally_distinct",
    width, height, tileSize,
    walls,
    ctSpawns, tSpawns,
    bombsites: [
      { id: "A", center: { x: 28, y: 3 }, radius: 2.5 },
      { id: "B", center: { x: 3, y: 3 }, radius: 2.5 },
    ],
  };
}
