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

function statsForRole(role: Role): PlayerStats {
  switch (role) {
    case "entry":
      return { aim: rollStat(72, 10), reflexes: rollStat(78, 8), gameSense: rollStat(60, 10), nerve: rollStat(72, 10), utility: rollStat(55, 10), movement: rollStat(75, 8) };
    case "awper":
      return { aim: rollStat(82, 8), reflexes: rollStat(78, 8), gameSense: rollStat(70, 8), nerve: rollStat(74, 10), utility: rollStat(55, 10), movement: rollStat(65, 10) };
    case "support":
      return { aim: rollStat(66, 8), reflexes: rollStat(66, 8), gameSense: rollStat(72, 8), nerve: rollStat(70, 10), utility: rollStat(80, 8), movement: rollStat(66, 8) };
    case "igl":
      return { aim: rollStat(64, 10), reflexes: rollStat(64, 10), gameSense: rollStat(85, 6), nerve: rollStat(80, 8), utility: rollStat(72, 8), movement: rollStat(64, 8) };
    case "lurker":
      return { aim: rollStat(72, 10), reflexes: rollStat(70, 8), gameSense: rollStat(78, 8), nerve: rollStat(76, 8), utility: rollStat(60, 10), movement: rollStat(72, 8) };
  }
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
    mood: 65,
    morale: 65,
    relationships: {},
  };
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
    money: 3000,
    roundsWon: 0,
    loadouts: Object.fromEntries(players.map(p => [p.id, {
      weapon: "pistol" as const, utility: [], armor: false, helmet: false,
      keptWeapon: null, keptArmor: false, keptHelmet: false,
    }])),
    matchStats: Object.fromEntries(players.map(p => [p.id, { kills: 0, deaths: 0, damage: 0, roundsPlayed: 0 }])),
  };
}

// Dust2-shaped map: A site top-right, B site top-left, CT spawn top-center,
// T spawn bottom-center. Three routes — B tunnels (left), mid (center),
// long A (right) — meet at the bombsites.
export function makeMap(): GameMap {
  const width = 32;
  const height = 20;
  const tileSize = 28;
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
      // A: default plant area in the top-right room
      { id: "A", center: { x: 28, y: 3 }, radius: 2.5 },
      // B: top-left room
      { id: "B", center: { x: 3, y: 3 }, radius: 2.5 },
    ],
    smokeSpots: [
      // T smokes — block CT angles into the sites
      { side: "T", tile: { x: 27, y: 8 } },  // long-A corner / CT angle
      { side: "T", tile: { x: 15, y: 6 } },  // mid doors (block CT mid AWP)
      { side: "T", tile: { x: 4, y: 7 } },   // B doors / top of tunnels
      // CT smokes — slow T pushes
      { side: "CT", tile: { x: 15, y: 11 } }, // mid (block T mid push)
      { side: "CT", tile: { x: 30, y: 13 } }, // long (block T long push, outside long doors)
    ],
  };
}
