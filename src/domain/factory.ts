import type { GameMap, Player, PlayerStats, Role, Team, Trait, Vec2 } from "./types.ts";
import { defaultPistol } from "./weapons.ts";
import { pickCountry, pickCountryInRegion, type Region } from "./countries.ts";
import { generateUsername, resetUsernames } from "./usernames.ts";

// Deterministic-ish RNG so we can seed runs later.
let rngState = 0xC0FFEE;
export function setSeed(seed: number) {
  rngState = seed >>> 0;
  // A fresh seed implies a fresh batch of players — clear the handle ledger so
  // we don't carry collisions over from a prior universe.
  resetUsernames();
}
function rand(): number {
  rngState = (rngState * 1664525 + 1013904223) >>> 0;
  return rngState / 0x1_0000_0000;
}
function randInt(lo: number, hi: number) { return Math.floor(rand() * (hi - lo + 1)) + lo; }
function pick<T>(arr: T[]): T { return arr[Math.floor(rand() * arr.length)]; }

function rollStat(base: number, spread: number): number {
  return Math.max(20, Math.min(95, Math.round(base + (rand() - 0.5) * 2 * spread)));
}

const ALL_STATS: Array<keyof PlayerStats> = [
  "accuracy","crosshairPlacement","sprayControl","tapping","flickAim","counterStrafe",
  "reflexes","handSpeed","movement","jiggle",
  "mapAwareness","positioning","gameSense","timing","adaptability",
  "composure","aggression","patience","discipline","recovery",
  "utility","smokeLineups","flashTiming","molotovUse",
  "pistolPref","riflePref","awpPref","smgPref",
  "igl","communication",
];

// Stat clusters used to give players visible peaks without prescribing a role.
// Each player gets one or two clusters bumped — their role is then inferred
// from the resulting stat shape rather than picked up front.
const STAT_CLUSTERS: Record<string, Array<keyof PlayerStats>> = {
  aim:       ["accuracy", "crosshairPlacement", "tapping", "flickAim"],
  mechanics: ["reflexes", "handSpeed", "movement", "counterStrafe", "jiggle"],
  awp:       ["awpPref", "tapping", "flickAim", "composure"],
  rifle:     ["riflePref", "sprayControl", "accuracy"],
  smg:       ["smgPref", "movement", "sprayControl"],
  pistol:    ["pistolPref", "tapping", "composure"],
  tactical:  ["mapAwareness", "gameSense", "positioning", "timing", "adaptability"],
  leader:    ["igl", "communication", "gameSense", "discipline"],
  utility:   ["utility", "smokeLineups", "flashTiming", "molotovUse"],
  aggressive:["aggression", "reflexes", "flickAim"],
  patient:   ["patience", "positioning", "composure"],
  steady:    ["composure", "discipline", "recovery"],
};

function rollStats(): PlayerStats {
  const out: Partial<PlayerStats> = {};
  for (const key of ALL_STATS) out[key] = rollStat(60, 14);

  // Pick 1-2 clusters and bump them. Some clusters also dent an opposing one
  // so players end up with believable trade-offs.
  const clusterKeys = Object.keys(STAT_CLUSTERS);
  const count = randInt(1, 2);
  const picked = new Set<string>();
  for (let i = 0; i < count; i++) {
    const c = pick(clusterKeys);
    if (picked.has(c)) continue;
    picked.add(c);
    const bump = randInt(10, 22);
    for (const k of STAT_CLUSTERS[c]) {
      out[k] = Math.min(95, (out[k] ?? 60) + bump);
    }
  }
  // Soft trade-offs between opposed temperaments.
  if (picked.has("aggressive") && !picked.has("patient")) {
    out.patience = Math.max(20, (out.patience ?? 60) - 12);
  }
  if (picked.has("patient") && !picked.has("aggressive")) {
    out.aggression = Math.max(20, (out.aggression ?? 60) - 10);
  }
  if (picked.has("awp")) {
    out.sprayControl = Math.max(20, (out.sprayControl ?? 60) - 8);
  }
  return out as PlayerStats;
}

// Score each role against a stat sheet and pick the best fit. Roles are
// descriptive labels for the player's shape, not inputs to generation.
function inferRole(s: PlayerStats): Role {
  const avg = (...keys: Array<keyof PlayerStats>) =>
    keys.reduce((sum, k) => sum + s[k], 0) / keys.length;
  const scores: Record<Role, number> = {
    awper:   avg("awpPref", "tapping", "flickAim", "composure") - 0.3 * s.sprayControl + 30,
    igl:     avg("igl", "communication", "gameSense", "mapAwareness", "discipline"),
    support: avg("utility", "smokeLineups", "flashTiming", "molotovUse", "discipline"),
    entry:   avg("aggression", "flickAim", "reflexes", "handSpeed") - 0.25 * s.patience + 20,
    lurker:  avg("patience", "positioning", "mapAwareness", "timing") - 0.25 * s.aggression + 20,
  };
  let best: Role = "entry";
  let bestScore = -Infinity;
  for (const r of Object.keys(scores) as Role[]) {
    if (scores[r] > bestScore) { bestScore = scores[r]; best = r; }
  }
  return best;
}

// Traits drawn from a pool keyed by the (inferred) role — same idea as before,
// but role is now an output of stats rather than an input.
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

// Advance the id counter past every `pN` already present in `players`. The
// counter is module state that resets to 0 on page load, but a universe loaded
// from storage carries players minted in an earlier session — without this, the
// next youth intake would re-issue p1, p2, … and collide with existing ids
// (two players sharing an id desync the Map-based roster lookups from the
// find-based player pages). Call after loading or creating a universe, before
// any further makePlayer.
export function reservePlayerIds(players: Array<{ id: string }>): void {
  let max = playerCounter;
  for (const p of players) {
    const m = /^p(\d+)$/.exec(p.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  playerCounter = max;
}

// A team's front-office staff member (manager/coach). Identity only for now —
// a locale-flavored name and nationality drawn from the team's region.
export function generateManager(region: Region, day: number): { name: string; country: string; since: number } {
  const country = pickCountryInRegion(rand, region);
  return {
    name: `${country.faker.person.firstName()} ${country.faker.person.lastName()}`,
    country: country.code,
    since: day,
  };
}

// Pass `region` to draw the player's nationality from that region only — used
// to seed a guaranteed headcount per competitive region. Omit for a globally
// weighted pick.
export function makePlayer(region?: Region): Player {
  const id = `p${++playerCounter}`;
  const country = region ? pickCountryInRegion(rand, region) : pickCountry(rand);
  // Locale-flavored first/last names via faker. Faker has its own RNG, so the
  // result isn't tied to our seed — acceptable for now; we can wire seeded
  // faker later if we need fully deterministic universes.
  const firstName = country.faker.person.firstName();
  const lastName = country.faker.person.lastName();
  const handle = generateUsername(rand);
  // Most pros are 18-28; allow a long tail of prospects and veterans.
  const age = rollAge();
  const name = `${firstName} ${lastName}`;
  const stats = rollStats();
  const role = inferRole(stats);
  // Broad ambition spread mixes social/fun players with ambitious ones; form
  // starts at the matching baseline (fun players sit higher/happier).
  const ambition = Math.round(15 + rand() * 80);
  const baselineMorale = Math.round(58 + (1 - ambition / 100) * 17);
  return {
    id, name, handle,
    country: country.code,
    age,
    role,
    stats,
    traits: rollTraits(role),
    // Broad spread so the pool mixes social/fun players with ambitious ones.
    ambition,
    money: STARTING_PER_PLAYER,
    // Career economy starts empty: new players are broke until they earn prize
    // splits / wages. A freshly crystallized amateur org seeded from a broke
    // founder is exactly the "can't pay players" state we want.
    wallet: 0,
    careerEarnings: 0,
    // Start form at the personality baseline (fun players sit higher/happier).
    mood: baselineMorale,
    morale: baselineMorale,
    relationships: {},
    ctAssignment: "auto",
  };
}

// Roughly bell-shaped around 22, with long tails down to 15 and up to 45 so
// you occasionally get a teen prospect or a journeyman veteran.
function rollAge(): number {
  // Sum of two uniforms gives a triangular distribution; scale to 15..45.
  const r = (rand() + rand()) / 2; // 0..1, peaked at 0.5
  const skewed = Math.pow(r, 1.4); // pull mode a bit younger
  const age = Math.round(15 + skewed * 30);
  return Math.max(15, Math.min(45, age));
}

export const STARTING_PER_PLAYER = 800;

// Force every stat on every player on this team to `value` (default 60).
// Useful for balance tests where you want player skill out of the equation.
export function neutralizeTeamStats(team: Team, value = 60) {
  for (const p of team.players) {
    for (const k of ALL_STATS) p.stats[k] = value;
  }
}

export function makeTeam(id: string, name: string, side: "CT" | "T"): Team {
  const players = [makePlayer(), makePlayer(), makePlayer(), makePlayer(), makePlayer()];
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
      weapon: defaultPistol(side), utility: [], armor: false, helmet: false,
      keptWeapon: null, keptArmor: false, keptHelmet: false, keptUtility: [],
    }])),
    matchStats: Object.fromEntries(players.map(p => [p.id, { kills: 0, deaths: 0, assists: 0, damage: 0, roundsPlayed: 0 }])),
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
