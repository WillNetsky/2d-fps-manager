// src/domain/weapons.ts
var WEAPON_FALLOFF_UNIT = 500;
var WEAPONS = {
  knife: {
    id: "knife",
    name: "Knife",
    slot: "knife",
    cost: 0,
    damage: 55,
    fireRate: 2,
    accuracy: 0.9,
    range: 32,
    magSize: 0,
    reserveAmmo: 0,
    reloadMs: 0,
    rangeModifier: 1,
    armorPen: 0.85,
    headshotMultiplier: 3
  },
  // Glock-18 — T default. Big mag, low damage, weak armor pen, loose at range.
  glock: {
    id: "glock",
    name: "Glock",
    slot: "pistol",
    faction: "T",
    cost: 0,
    damage: 30,
    fireRate: 6.67,
    accuracy: 0.7,
    range: 320,
    magSize: 20,
    reserveAmmo: 120,
    reloadMs: 2200,
    rangeModifier: 0.75,
    armorPen: 0.475,
    headshotMultiplier: 4
  },
  // USP-S — CT default. Smaller mag but tighter, harder-hitting first shot.
  usp: {
    id: "usp",
    name: "USP-S",
    slot: "pistol",
    faction: "CT",
    cost: 0,
    damage: 35,
    fireRate: 5.88,
    accuracy: 0.78,
    range: 360,
    magSize: 12,
    reserveAmmo: 24,
    reloadMs: 2200,
    rangeModifier: 0.91,
    armorPen: 0.507,
    headshotMultiplier: 4
  },
  // Desert Eagle — one-tap potential, slow ROF, expensive.
  deagle: {
    id: "deagle",
    name: "Deagle",
    slot: "pistol",
    cost: 700,
    damage: 63,
    fireRate: 2.5,
    accuracy: 0.78,
    range: 420,
    magSize: 7,
    reserveAmmo: 35,
    reloadMs: 1900,
    rangeModifier: 0.81,
    armorPen: 0.93,
    headshotMultiplier: 4
  },
  // MP9 (CT SMG) — high fire rate, tight spray.
  mp9: {
    id: "mp9",
    name: "MP9",
    slot: "smg",
    faction: "CT",
    cost: 1250,
    damage: 26,
    fireRate: 14.7,
    accuracy: 0.72,
    range: 360,
    magSize: 30,
    reserveAmmo: 120,
    reloadMs: 2100,
    rangeModifier: 0.75,
    armorPen: 0.6,
    headshotMultiplier: 4
  },
  // MAC-10 (T SMG) — punchier rounds, looser spray, cheaper.
  mac10: {
    id: "mac10",
    name: "Mac10",
    slot: "smg",
    faction: "T",
    cost: 1050,
    damage: 29,
    fireRate: 13.3,
    accuracy: 0.66,
    range: 340,
    magSize: 30,
    reserveAmmo: 100,
    reloadMs: 2350,
    rangeModifier: 0.65,
    armorPen: 0.65,
    headshotMultiplier: 4
  },
  // M4A4 (CT rifle) — slightly less damage than AK but more accurate.
  m4: {
    id: "m4",
    name: "M4",
    slot: "rifle",
    faction: "CT",
    cost: 3100,
    damage: 33,
    fireRate: 10,
    accuracy: 0.86,
    range: 540,
    magSize: 30,
    reserveAmmo: 90,
    reloadMs: 3100,
    rangeModifier: 0.97,
    armorPen: 0.7,
    headshotMultiplier: 4
  },
  // AK-47 (T rifle) — one-shot HS vs helmet, harder spray.
  ak: {
    id: "ak",
    name: "AK",
    slot: "rifle",
    faction: "T",
    cost: 2700,
    damage: 36,
    fireRate: 10,
    accuracy: 0.8,
    range: 540,
    magSize: 30,
    reserveAmmo: 90,
    reloadMs: 2900,
    rangeModifier: 0.98,
    armorPen: 0.775,
    headshotMultiplier: 4
  },
  // AWP — one-shot body or HS to any target.
  awp: {
    id: "awp",
    name: "AWP",
    slot: "awp",
    cost: 4750,
    damage: 115,
    fireRate: 1.46,
    accuracy: 0.95,
    range: 640,
    magSize: 10,
    reserveAmmo: 30,
    reloadMs: 3700,
    rangeModifier: 0.99,
    armorPen: 0.975,
    headshotMultiplier: 4
  }
};
function defaultPistol(side) {
  return side === "CT" ? "usp" : "glock";
}
var VEST_COST = 650;
var HELMET_UPGRADE_COST = 350;
var HEADSHOT_BASE = {
  knife: 0,
  glock: 0.1,
  usp: 0.12,
  deagle: 0.22,
  mp9: 0.12,
  mac10: 0.11,
  m4: 0.18,
  ak: 0.2,
  awp: 0.3
};

// src/domain/factory.ts
var FIRST_NAMES = ["Aleks", "Niko", "Kai", "Jin", "Theo", "Luc", "Mateo", "Ezra", "Otto", "Ravi", "Sasha", "Yuri", "Bram", "Cy", "Dax", "Finn"];
var LAST_NAMES = ["Vale", "Reyes", "Park", "Okafor", "Lindholm", "Costa", "Becker", "Marek", "Singh", "Hass", "Doyle", "Brandt", "Voss", "Ahn", "Renn", "Kazan"];
var rngState = 12648430;
function setSeed(seed) {
  rngState = seed >>> 0;
}
function rand() {
  rngState = rngState * 1664525 + 1013904223 >>> 0;
  return rngState / 4294967296;
}
function randInt(lo, hi) {
  return Math.floor(rand() * (hi - lo + 1)) + lo;
}
function pick(arr) {
  return arr[Math.floor(rand() * arr.length)];
}
function rollStat(base, spread) {
  return Math.max(20, Math.min(95, Math.round(base + (rand() - 0.5) * 2 * spread)));
}
var NEUTRAL = [60, 12];
var ROLE_PROFILES = {
  entry: {
    accuracy: [72, 10],
    crosshairPlacement: [70, 10],
    sprayControl: [70, 10],
    tapping: [62, 12],
    flickAim: [78, 10],
    counterStrafe: [65, 10],
    reflexes: [80, 8],
    handSpeed: [80, 8],
    movement: [76, 8],
    jiggle: [70, 10],
    mapAwareness: [62, 10],
    positioning: [58, 10],
    gameSense: [60, 10],
    timing: [60, 10],
    adaptability: [62, 10],
    composure: [62, 12],
    aggression: [82, 8],
    patience: [38, 10],
    discipline: [55, 12],
    recovery: [60, 12],
    utility: [50, 10],
    smokeLineups: [45, 10],
    flashTiming: [55, 10],
    molotovUse: [50, 10],
    pistolPref: [55, 8],
    riflePref: [70, 8],
    awpPref: [40, 10],
    smgPref: [60, 10],
    igl: [35, 10],
    communication: [55, 10]
  },
  awper: {
    accuracy: [82, 8],
    crosshairPlacement: [80, 8],
    sprayControl: [50, 10],
    tapping: [78, 8],
    flickAim: [82, 8],
    counterStrafe: [75, 8],
    reflexes: [78, 8],
    handSpeed: [76, 8],
    movement: [60, 10],
    jiggle: [72, 10],
    mapAwareness: [70, 10],
    positioning: [74, 10],
    gameSense: [70, 10],
    timing: [72, 10],
    adaptability: [60, 10],
    composure: [76, 8],
    aggression: [55, 12],
    patience: [70, 10],
    discipline: [60, 12],
    recovery: [60, 12],
    utility: [48, 10],
    smokeLineups: [45, 10],
    flashTiming: [45, 10],
    molotovUse: [45, 10],
    pistolPref: [55, 8],
    riflePref: [50, 8],
    awpPref: [82, 8],
    smgPref: [45, 10],
    igl: [40, 10],
    communication: [55, 10]
  },
  support: {
    accuracy: [66, 10],
    crosshairPlacement: [66, 10],
    sprayControl: [68, 10],
    tapping: [60, 10],
    flickAim: [55, 10],
    counterStrafe: [62, 10],
    reflexes: [64, 10],
    handSpeed: [62, 10],
    movement: [66, 8],
    jiggle: [60, 10],
    mapAwareness: [76, 8],
    positioning: [74, 8],
    gameSense: [74, 8],
    timing: [70, 10],
    adaptability: [68, 10],
    composure: [72, 10],
    aggression: [50, 10],
    patience: [75, 10],
    discipline: [78, 8],
    recovery: [65, 10],
    utility: [82, 6],
    smokeLineups: [82, 8],
    flashTiming: [78, 8],
    molotovUse: [76, 10],
    pistolPref: [55, 10],
    riflePref: [65, 10],
    awpPref: [40, 10],
    smgPref: [60, 10],
    igl: [45, 10],
    communication: [70, 10]
  },
  igl: {
    accuracy: [62, 10],
    crosshairPlacement: [66, 10],
    sprayControl: [58, 10],
    tapping: [62, 10],
    flickAim: [55, 10],
    counterStrafe: [60, 10],
    reflexes: [62, 10],
    handSpeed: [60, 10],
    movement: [62, 8],
    jiggle: [58, 10],
    mapAwareness: [88, 6],
    positioning: [78, 8],
    gameSense: [88, 6],
    timing: [78, 8],
    adaptability: [82, 8],
    composure: [82, 8],
    aggression: [50, 12],
    patience: [68, 10],
    discipline: [82, 8],
    recovery: [72, 10],
    utility: [74, 8],
    smokeLineups: [72, 10],
    flashTiming: [70, 10],
    molotovUse: [68, 10],
    pistolPref: [55, 10],
    riflePref: [60, 10],
    awpPref: [42, 10],
    smgPref: [55, 10],
    igl: [85, 6],
    communication: [82, 8]
  },
  lurker: {
    accuracy: [74, 10],
    crosshairPlacement: [76, 10],
    sprayControl: [62, 10],
    tapping: [72, 10],
    flickAim: [74, 10],
    counterStrafe: [70, 10],
    reflexes: [72, 8],
    handSpeed: [68, 10],
    movement: [70, 8],
    jiggle: [72, 10],
    mapAwareness: [80, 8],
    positioning: [80, 8],
    gameSense: [76, 8],
    timing: [78, 8],
    adaptability: [62, 10],
    composure: [78, 8],
    aggression: [48, 12],
    patience: [82, 8],
    discipline: [55, 12],
    recovery: [65, 10],
    utility: [55, 10],
    smokeLineups: [50, 10],
    flashTiming: [50, 10],
    molotovUse: [50, 10],
    pistolPref: [60, 10],
    riflePref: [70, 10],
    awpPref: [55, 10],
    smgPref: [55, 10],
    igl: [40, 10],
    communication: [50, 10]
  }
};
function statsForRole(role) {
  const profile = ROLE_PROFILES[role];
  const out = {};
  const ALL_KEYS = [
    "accuracy",
    "crosshairPlacement",
    "sprayControl",
    "tapping",
    "flickAim",
    "counterStrafe",
    "reflexes",
    "handSpeed",
    "movement",
    "jiggle",
    "mapAwareness",
    "positioning",
    "gameSense",
    "timing",
    "adaptability",
    "composure",
    "aggression",
    "patience",
    "discipline",
    "recovery",
    "utility",
    "smokeLineups",
    "flashTiming",
    "molotovUse",
    "pistolPref",
    "riflePref",
    "awpPref",
    "smgPref",
    "igl",
    "communication"
  ];
  for (const key of ALL_KEYS) {
    const [base, spread] = profile[key] ?? NEUTRAL;
    out[key] = rollStat(base, spread);
  }
  return out;
}
var ROLE_TRAITS = {
  entry: ["entry-fragger", "rifler", "tilts-easy"],
  awper: ["awp-prodigy", "clutch", "shaky-eco"],
  support: ["smoke-savant", "loyal"],
  igl: ["clutch", "loyal", "smoke-savant"],
  lurker: ["clutch", "rifler", "tilts-easy"]
};
function rollTraits(role) {
  const pool = ROLE_TRAITS[role];
  const count = randInt(1, 2);
  const out = [];
  for (let i = 0; i < count; i++) {
    const t = pick(pool);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}
var playerCounter = 0;
function makePlayer(role) {
  const id = `p${++playerCounter}`;
  const name = `${pick(FIRST_NAMES)} "${pick(["zen", "fox", "ace", "ghost", "king", "ice", "null", "drift", "pulse", "raze"])}" ${pick(LAST_NAMES)}`;
  return {
    id,
    name,
    role,
    stats: statsForRole(role),
    traits: rollTraits(role),
    money: STARTING_PER_PLAYER,
    mood: 65,
    morale: 65,
    relationships: {},
    ctAssignment: "auto"
  };
}
var STARTING_PER_PLAYER = 800;
var ALL_STAT_KEYS = [
  "accuracy",
  "crosshairPlacement",
  "sprayControl",
  "tapping",
  "flickAim",
  "counterStrafe",
  "reflexes",
  "handSpeed",
  "movement",
  "jiggle",
  "mapAwareness",
  "positioning",
  "gameSense",
  "timing",
  "adaptability",
  "composure",
  "aggression",
  "patience",
  "discipline",
  "recovery",
  "utility",
  "smokeLineups",
  "flashTiming",
  "molotovUse",
  "pistolPref",
  "riflePref",
  "awpPref",
  "smgPref",
  "igl",
  "communication"
];
function neutralizeTeamStats(team, value = 60) {
  for (const p of team.players) {
    for (const k of ALL_STAT_KEYS) p.stats[k] = value;
  }
}
var STANDARD_ROSTER = ["igl", "awper", "entry", "support", "lurker"];
function makeTeam(id, name, side) {
  const players = STANDARD_ROSTER.map(makePlayer);
  for (const p of players) {
    for (const q of players) {
      if (p.id !== q.id) p.relationships[q.id] = randInt(-15, 30);
    }
  }
  return {
    id,
    name,
    side,
    players,
    roundsWon: 0,
    loadouts: Object.fromEntries(players.map((p) => [p.id, {
      weapon: defaultPistol(side),
      utility: [],
      armor: false,
      helmet: false,
      keptWeapon: null,
      keptArmor: false,
      keptHelmet: false,
      keptUtility: []
    }])),
    matchStats: Object.fromEntries(players.map((p) => [p.id, { kills: 0, deaths: 0, damage: 0, roundsPlayed: 0 }]))
  };
}

// src/sim/pathfind.ts
var NEIGHBORS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2]
];
function findPath(map, start, goal) {
  const sx = Math.floor(start.x / map.tileSize);
  const sy = Math.floor(start.y / map.tileSize);
  const gx = Math.floor(goal.x / map.tileSize);
  const gy = Math.floor(goal.y / map.tileSize);
  if (sx === gx && sy === gy) return [];
  if (!inBounds(map, gx, gy) || map.walls[gy * map.width + gx]) {
    let best = null;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = gx + dx, ny = gy + dy;
      if (!inBounds(map, nx, ny) || map.walls[ny * map.width + nx]) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      if (!best || d < best.d) best = { x: nx, y: ny, d };
    }
    if (!best) return null;
    return findPath(map, start, { x: (best.x + 0.5) * map.tileSize, y: (best.y + 0.5) * map.tileSize });
  }
  const open = [];
  const startNode = { x: sx, y: sy, g: 0, f: heuristic(sx, sy, gx, gy), parent: null };
  open.push(startNode);
  const closed = /* @__PURE__ */ new Set();
  const bestG = /* @__PURE__ */ new Map();
  bestG.set(sy * map.width + sx, 0);
  while (open.length) {
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bestIdx].f) bestIdx = i;
    const cur = open.splice(bestIdx, 1)[0];
    const key = cur.y * map.width + cur.x;
    if (closed.has(key)) continue;
    closed.add(key);
    if (cur.x === gx && cur.y === gy) {
      const path = [];
      let n = cur;
      while (n && n.parent) {
        path.push({ x: (n.x + 0.5) * map.tileSize, y: (n.y + 0.5) * map.tileSize });
        n = n.parent;
      }
      path.reverse();
      return path;
    }
    for (const [dx, dy, cost] of NEIGHBORS) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (!inBounds(map, nx, ny)) continue;
      if (map.walls[ny * map.width + nx]) continue;
      if (dx !== 0 && dy !== 0) {
        if (map.walls[cur.y * map.width + nx]) continue;
        if (map.walls[ny * map.width + cur.x]) continue;
      }
      const nKey = ny * map.width + nx;
      if (closed.has(nKey)) continue;
      const g = cur.g + cost;
      const prev = bestG.get(nKey);
      if (prev !== void 0 && prev <= g) continue;
      bestG.set(nKey, g);
      open.push({ x: nx, y: ny, g, f: g + heuristic(nx, ny, gx, gy), parent: cur });
    }
  }
  return null;
}
function inBounds(map, x, y) {
  return x >= 0 && y >= 0 && x < map.width && y < map.height;
}
function heuristic(x, y, gx, gy) {
  const dx = Math.abs(x - gx), dy = Math.abs(y - gy);
  return dx + dy + (Math.SQRT2 - 2) * Math.min(dx, dy);
}

// src/sim/mapAnalysis.ts
var N4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
var N8 = [...N4, [1, 1], [-1, 1], [1, -1], [-1, -1]];
function analyzeMap(map) {
  const W = map.width, H = map.height;
  const ctDist = bfs(map, map.ctSpawns);
  const tDist = bfs(map, map.tSpawns);
  const chokes = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const idx = y * W + x;
      if (map.walls[idx]) continue;
      if (!isFinite(ctDist[idx]) || !isFinite(tDist[idx])) continue;
      let wallCount = 0;
      for (const [dx, dy] of N8) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) wallCount++;
        else if (map.walls[ny * W + nx]) wallCount++;
      }
      if (wallCount < 5) continue;
      let ctSide = null, tSide = null;
      let ctSideD = Infinity, tSideD = Infinity;
      for (const [dx, dy] of N4) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (map.walls[ny * W + nx]) continue;
        const nIdx = ny * W + nx;
        if (ctDist[nIdx] < ctSideD) {
          ctSideD = ctDist[nIdx];
          ctSide = { x: nx, y: ny };
        }
        if (tDist[nIdx] < tSideD) {
          tSideD = tDist[nIdx];
          tSide = { x: nx, y: ny };
        }
      }
      if (!ctSide && !tSide) continue;
      chokes.push({ tile: { x, y }, ctSide, tSide });
    }
  }
  return { chokes, ctDist, tDist };
}
function bfs(map, sources) {
  const W = map.width, H = map.height;
  const dist2 = new Array(W * H).fill(Infinity);
  const queue = [];
  for (const s of sources) {
    if (s.x < 0 || s.y < 0 || s.x >= W || s.y >= H) continue;
    if (map.walls[s.y * W + s.x]) continue;
    if (dist2[s.y * W + s.x] === Infinity) {
      dist2[s.y * W + s.x] = 0;
      queue.push({ x: s.x, y: s.y });
    }
  }
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const d = dist2[cur.y * W + cur.x];
    for (const [dx, dy] of N4) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (map.walls[ny * W + nx]) continue;
      const nIdx = ny * W + nx;
      if (dist2[nIdx] > d + 1) {
        dist2[nIdx] = d + 1;
        queue.push({ x: nx, y: ny });
      }
    }
  }
  return dist2;
}

// src/sim/round.ts
var TICK_MS = 50;
var ROUND_TIME_MS = 9e4;
var BOMB_TIMER_MS = 3e4;
var PLANT_TIME_MS = 3e3;
var DEFUSE_TIME_MS = 5e3;
var SMOKE_DURATION_MS = 14e3;
var SMOKE_RADIUS_WORLD = 80;
var FLASH_FUSE_MS = 1500;
var FLASH_RANGE = 320;
var FLASH_MAX_DURATION_MS = 3500;
var FLASH_MIN_DURATION_MS = 600;
var FLASH_CONE_HALF = Math.PI / 2;
var MOLOTOV_FUSE_MS = 1500;
var MOLOTOV_DURATION_MS = 7e3;
var MOLOTOV_RADIUS_WORLD = 70;
var MOLOTOV_DOT_PER_SEC = 14;
var HE_FUSE_MS = 1500;
var HE_RADIUS = 120;
var HE_MAX_DAMAGE = 80;
var HE_HOLE_RADIUS = 70;
var HE_HOLE_DURATION_MS = 1500;
var GRENADE_FLIGHT_MS = 600;
var GRENADE_NOISE_PER_SKILL_GAP = 1.5;
var TRADE_WINDOW_MS = 2e3;
var TRADE_AIM_BONUS = 0.15;
var INTEL_DECAY = 0.985;
var INTEL_BUMP = 1;
var INTEL_CAP = 5;
var INTEL_DOMINANCE = 1;
var ROTATE_MIN_T = 6e3;
var ROTATE_LOG_COOLDOWN = 4e3;
var VISION_RANGE = 540;
var HEARING_RANGE = 240;
var SOUND_INTEL_BUMP = 0.5;
var WALK_SPEED_FACTOR = 0.55;
var CONTACT_RADIUS = 220;
var BOMB_SIGHTING_RECENT_MS = 5e3;
function spawnCentroid(spawns, tile) {
  let x = 0, y = 0;
  for (const s of spawns) {
    x += s.x;
    y += s.y;
  }
  return { x: (x / spawns.length + 0.5) * tile, y: (y / spawns.length + 0.5) * tile };
}
var RoundSim = class {
  constructor(ct, tSide, map, seed = 12345) {
    this.ct = ct;
    this.tSide = tSide;
    this.map = map;
    let s = seed >>> 0;
    this.rng = () => {
      s = s * 1664525 + 1013904223 >>> 0;
      return s / 4294967296;
    };
    const all = [...ct.players, ...tSide.players];
    this.players = (id) => all.find((p) => p.id === id);
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
  agents = [];
  smokes = [];
  flashes = [];
  // in-flight grenades waiting on fuse
  tickFlashes = [];
  // detonation events this tick
  molotovs = [];
  // burning patches
  hes = [];
  // in-flight HE grenades
  tickHEs = [];
  // detonation events this tick
  smokeHoles = [];
  // brief LOS gaps punched through smoke by HEs
  grenadeFlights = [];
  // flying grenades between throw and land
  drops = [];
  t = 0;
  events = [];
  finished = false;
  result = null;
  // Per-tick shots, drained by renderer each frame.
  tickShots = [];
  // Per-tick snapshots — used for replay after the round ends.
  snapshots = [];
  bombCarrier = null;
  bombDropped = null;
  defuseTimeMs = DEFUSE_TIME_MS;
  bombPlanted = false;
  bombPlantedAt = null;
  bombPlantedTime = 0;
  bombDefusing = null;
  bombDefuseProgress = 0;
  planter = null;
  planting = null;
  plantProgress = 0;
  rng;
  players;
  ctThreatFocus;
  tThreatFocus;
  mapAnalysis;
  tradeMarks = [];
  smokeQueue = [];
  flashQueue = [];
  molotovQueue = [];
  heQueue = [];
  tStrategy;
  ctSetup;
  intel = {
    CT: {
      A: { score: 0, updatedAt: 0, bombSeenAt: -Infinity },
      B: { score: 0, updatedAt: 0, bombSeenAt: -Infinity }
    },
    T: {
      A: { score: 0, updatedAt: 0, bombSeenAt: -Infinity },
      B: { score: 0, updatedAt: 0, bombSeenAt: -Infinity }
    }
  };
  // Agent → ms timestamp of their last "rotation" log, to avoid spam.
  lastRotationLog = {};
  // Per-agent rotation log surfaced for UI.
  rotationLog = [];
  pickTStrategy() {
    const r = this.rng();
    if (r < 0.25) return "rush-A";
    if (r < 0.5) return "rush-B";
    if (r < 0.7) return "split-A";
    if (r < 0.85) return "split-B";
    return "default";
  }
  pickCtSetup() {
    const r = this.rng();
    if (r < 0.55) return { A: 2, B: 2, mid: 1 };
    if (r < 0.8) return { A: 3, B: 2, mid: 0 };
    return { A: 2, B: 3, mid: 0 };
  }
  // Assign each agent a SiteAssignment based on strategy/setup.
  assignSites() {
    const cts = this.agents.filter((a) => a.side === "CT");
    const tA = this.ctSetup.A, tB = this.ctSetup.B, tMid = this.ctSetup.mid;
    const slots = [
      ...Array(tA).fill("A"),
      ...Array(tB).fill("B"),
      ...Array(tMid).fill("mid")
    ];
    const autoCts = [];
    for (const a of cts) {
      const player = this.players(a.playerId);
      const fixed = player.ctAssignment;
      if (fixed === "A" || fixed === "B" || fixed === "mid") {
        a.assignedSite = fixed;
        const idx = slots.indexOf(fixed);
        if (idx >= 0) slots.splice(idx, 1);
      } else {
        autoCts.push(a);
      }
    }
    autoCts.sort((x, y) => this.priority(x) - this.priority(y));
    autoCts.forEach((a, i) => {
      a.assignedSite = slots[i] ?? "A";
    });
    const ts = this.agents.filter((a) => a.side === "T");
    let primary;
    let splitOne = false;
    switch (this.tStrategy) {
      case "rush-A":
        primary = "A";
        break;
      case "rush-B":
        primary = "B";
        break;
      case "split-A":
        primary = "A";
        splitOne = true;
        break;
      case "split-B":
        primary = "B";
        splitOne = true;
        break;
      case "default":
      default:
        primary = this.rng() < 0.5 ? "A" : "B";
        splitOne = true;
        break;
    }
    ts.forEach((a) => {
      const player = this.players(a.playerId);
      if (splitOne && player.role === "lurker") {
        a.assignedSite = primary === "A" ? "B" : "A";
      } else {
        a.assignedSite = primary;
      }
    });
  }
  priority(a) {
    const player = this.players(a.playerId);
    return { awper: 0, igl: 1, support: 2, entry: 3, lurker: 4 }[player.role];
  }
  push(e) {
    this.events.push(e);
  }
  spawnAgents() {
    const make = (p, side, spawn) => {
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
        reassessSaveAt: 0
      };
    };
    this.ct.players.forEach((p, i) => this.agents.push(make(p, "CT", this.map.ctSpawns[i % this.map.ctSpawns.length])));
    this.tSide.players.forEach((p, i) => this.agents.push(make(p, "T", this.map.tSpawns[i % this.map.tSpawns.length])));
  }
  // Compute path from agent to assigned site center, then find chokes along it.
  // Returns chokes with skill-modulated quality preference.
  chokesOnAgentPath(a) {
    const sitePos = this.agentSiteWorldPos(a);
    if (!sitePos) return [];
    const path = findPath(this.map, a.pos, sitePos);
    if (!path) return [];
    const pathTiles = /* @__PURE__ */ new Set();
    const ts = this.map.tileSize;
    pathTiles.add(`${Math.floor(a.pos.x / ts)},${Math.floor(a.pos.y / ts)}`);
    for (const wp of path) pathTiles.add(`${Math.floor(wp.x / ts)},${Math.floor(wp.y / ts)}`);
    return this.mapAnalysis.chokes.filter((c) => pathTiles.has(`${c.tile.x},${c.tile.y}`));
  }
  agentSiteWorldPos(a) {
    if (a.assignedSite === "mid") {
      return {
        x: this.map.width * this.map.tileSize * 0.5,
        y: this.map.height * this.map.tileSize * 0.5
      };
    }
    const site = this.map.bombsites.find((s) => s.id === a.assignedSite);
    if (!site) return null;
    return this.tileCenter(site.center);
  }
  tileCenter(tile) {
    return { x: (tile.x + 0.5) * this.map.tileSize, y: (tile.y + 0.5) * this.map.tileSize };
  }
  // For an agent, choose the most useful choke on their path.
  // Strategy: pick the choke closest to enemy spawn (most forward / aggressive).
  // High smokeLineups picks optimally; low picks worse choices.
  pickChokeForAgent(a, mode, usedTiles) {
    const candidates = this.chokesOnAgentPath(a).filter((c) => !usedTiles.has(`${c.tile.x},${c.tile.y}`));
    if (!candidates.length) return null;
    const player = this.players(a.playerId);
    const skill = (player.stats.smokeLineups + player.stats.utility) / 200;
    if (this.rng() > skill) {
      return candidates[Math.floor(this.rng() * candidates.length)];
    }
    const W = this.map.width;
    const enemyDist = a.side === "T" ? this.mapAnalysis.ctDist : this.mapAnalysis.tDist;
    let best = candidates[0];
    let bestD = enemyDist[best.tile.y * W + best.tile.x];
    for (const c of candidates) {
      const d = enemyDist[c.tile.y * W + c.tile.x];
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    void mode;
    return best;
  }
  // Like pickChokeForAgent but returns the actual throw position (in choke or its enemy-side neighbor).
  pickChokeTargetForAgent(a, mode, usedTiles) {
    const choke = this.pickChokeForAgent(a, mode, usedTiles);
    if (!choke) return null;
    if (mode === "in") return { choke, spot: this.tileCenter(choke.tile) };
    const enemyNeighbor = a.side === "T" ? choke.ctSide : choke.tSide;
    const target = enemyNeighbor ?? choke.tile;
    return { choke, spot: this.tileCenter(target) };
  }
  assignBombCarrier() {
    const ts = this.agents.filter((a) => a.side === "T");
    this.bombCarrier = ts[Math.floor(this.rng() * ts.length)].playerId;
  }
  scheduleSmokes() {
    const usedTiles = /* @__PURE__ */ new Set();
    for (const a of this.agents) {
      if (!a.utility.includes("smoke")) continue;
      const choke = this.pickChokeForAgent(a, "in", usedTiles);
      if (!choke) continue;
      const spot = this.tileCenter(choke.tile);
      usedTiles.add(`${choke.tile.x},${choke.tile.y}`);
      this.smokeQueue.push({
        thrower: a.playerId,
        spot,
        throwAt: 1e3 + this.rng() * 2e3
      });
    }
  }
  tick() {
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
    this.tradeMarks = this.tradeMarks.filter((m) => m.expiresAt > this.t);
    this.tickBomb();
    this.captureSnapshot();
    this.checkEnd();
  }
  captureSnapshot() {
    this.snapshots.push({
      t: this.t,
      agents: this.agents.map((a) => ({
        playerId: a.playerId,
        side: a.side,
        pos: { x: a.pos.x, y: a.pos.y },
        facing: a.facing,
        hp: a.hp,
        armor: a.armor,
        helmet: a.helmet,
        alive: a.alive,
        weapon: a.weapon,
        ammo: a.ammo,
        reloadingUntil: a.reloadingUntil,
        blindedUntil: a.blindedUntil,
        moveMode: a.moveMode
      })),
      smokes: this.smokes.map((s) => ({ pos: { x: s.pos.x, y: s.pos.y }, radius: s.radius, expiresAt: s.expiresAt, side: s.side })),
      flashes: this.flashes.map((f) => ({ pos: { x: f.pos.x, y: f.pos.y }, detonatesAt: f.detonatesAt, side: f.side })),
      tickFlashes: this.tickFlashes.map((f) => ({ pos: { x: f.pos.x, y: f.pos.y }, side: f.side })),
      molotovs: this.molotovs.map((m) => ({ pos: { x: m.pos.x, y: m.pos.y }, radius: m.radius, expiresAt: m.expiresAt, side: m.side, thrower: m.thrower })),
      hes: this.hes.map((h) => ({ pos: { x: h.pos.x, y: h.pos.y }, detonatesAt: h.detonatesAt, side: h.side, thrower: h.thrower })),
      tickHEs: this.tickHEs.map((h) => ({ pos: { x: h.pos.x, y: h.pos.y }, side: h.side })),
      smokeHoles: this.smokeHoles.map((h) => ({ pos: { x: h.pos.x, y: h.pos.y }, radius: h.radius, expiresAt: h.expiresAt })),
      grenadeFlights: this.grenadeFlights.map((g) => ({
        kind: g.kind,
        thrower: g.thrower,
        side: g.side,
        start: { x: g.start.x, y: g.start.y },
        landing: { x: g.landing.x, y: g.landing.y },
        startedAt: g.startedAt,
        landsAt: g.landsAt
      })),
      drops: this.drops.map((d) => ({ pos: { x: d.pos.x, y: d.pos.y }, weapon: d.weapon })),
      bombPlanted: this.bombPlanted,
      bombPlantedAt: this.bombPlantedAt ? { x: this.bombPlantedAt.x, y: this.bombPlantedAt.y } : null,
      bombCarrier: this.bombCarrier,
      bombDropped: this.bombDropped ? { x: this.bombDropped.x, y: this.bombDropped.y } : null,
      bombDefuseProgress: this.bombDefuseProgress,
      defuseTimeMs: DEFUSE_TIME_MS,
      bombPlantedTime: this.bombPlantedTime,
      tickShots: this.tickShots.map((s) => ({
        from: { x: s.from.x, y: s.from.y },
        to: { x: s.to.x, y: s.to.y },
        side: s.side,
        hit: s.hit,
        killerId: s.killerId
      }))
    });
  }
  // ---- Intel ----
  updateIntel() {
    for (const side of ["CT", "T"]) {
      this.intel[side].A.score *= INTEL_DECAY;
      this.intel[side].B.score *= INTEL_DECAY;
    }
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
        if (e.playerId === this.bombCarrier) {
          intel.bombSeenAt = this.t;
        }
      }
    }
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
  nearestSiteId(pos) {
    let best = "A";
    let bd = Infinity;
    for (const s of this.map.bombsites) {
      const c = worldCenterOfTile(s.center, this.map);
      const d = dist(c, pos);
      if (d < bd) {
        bd = d;
        best = s.id;
      }
    }
    return best;
  }
  // ---- Flashes ----
  scheduleFlashes() {
    const usedTiles = /* @__PURE__ */ new Set();
    for (const a of this.agents) {
      if (!a.utility.includes("flash")) continue;
      const target = this.pickChokeTargetForAgent(a, "enemy-side", usedTiles);
      if (!target) continue;
      const player = this.players(a.playerId);
      const earliness = (player.stats.aggression - 50) / 100;
      const baseThrow = 4500 - earliness * 2e3;
      this.flashQueue.push({
        thrower: a.playerId,
        spot: target.spot,
        throwAt: baseThrow + this.rng() * 1500
      });
      usedTiles.add(`${target.choke.tile.x},${target.choke.tile.y}`);
    }
  }
  tickFlashesUpdate() {
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      if (this.t >= f.detonatesAt) {
        this.tickFlashes.push({ pos: { ...f.pos }, side: f.side });
        this.applyFlashBlind(f);
        this.flashes.splice(i, 1);
      }
    }
  }
  applyFlashBlind(f) {
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
  scheduleMolotovs() {
    const usedTiles = /* @__PURE__ */ new Set();
    for (const a of this.agents) {
      if (!a.utility.includes("molotov")) continue;
      const target = this.pickChokeTargetForAgent(a, "enemy-side", usedTiles);
      if (!target) continue;
      const player = this.players(a.playerId);
      const baseThrow = 5e3 - (player.stats.utility - 50) * 30;
      this.molotovQueue.push({
        thrower: a.playerId,
        spot: target.spot,
        throwAt: baseThrow + this.rng() * 1500
      });
      usedTiles.add(`${target.choke.tile.x},${target.choke.tile.y}`);
    }
  }
  tickMolotovsUpdate() {
    for (let i = this.molotovs.length - 1; i >= 0; i--) {
      const m = this.molotovs[i];
      const extinguished = this.smokes.some((s) => {
        const dx = m.pos.x - s.pos.x, dy = m.pos.y - s.pos.y;
        const d = Math.hypot(dx, dy);
        return d < m.radius + s.radius * 0.6;
      });
      if (extinguished || this.t >= m.expiresAt) {
        this.molotovs.splice(i, 1);
      }
    }
    const dmgPerTick = MOLOTOV_DOT_PER_SEC * TICK_MS / 1e3;
    for (const m of this.molotovs) {
      const igniteAt = m.expiresAt - MOLOTOV_DURATION_MS;
      if (this.t < igniteAt) continue;
      for (const a of this.agents) {
        if (!a.alive) continue;
        const dx = a.pos.x - m.pos.x, dy = a.pos.y - m.pos.y;
        const d2 = dx * dx + dy * dy;
        if (d2 > m.radius * m.radius) continue;
        const applied = Math.min(a.hp, dmgPerTick);
        a.hp -= dmgPerTick;
        this.addDamage(m.thrower, applied);
        const d = Math.sqrt(d2) || 1;
        const flee = { x: a.pos.x + dx / d * 200, y: a.pos.y + dy / d * 200 };
        this.setGoal(a, flee);
        a.fleeingFireUntil = this.t + 600;
        a.nextThinkAt = Math.max(a.nextThinkAt, a.fleeingFireUntil);
        if (a.hp <= 0) {
          a.alive = false;
          a.hp = 0;
          if (a.weapon !== "knife") {
            this.drops.push({ pos: { x: a.pos.x, y: a.pos.y }, weapon: a.weapon });
          }
          if (a.playerId === this.bombCarrier) this.dropBomb(a);
          this.push({ t: this.t, kind: "kill", killer: m.thrower, victim: a.playerId, weapon: "molotov", headshot: false });
          this.bumpStat(m.thrower, "kills", 1);
          this.bumpStat(a.playerId, "deaths", 1);
        }
        break;
      }
    }
  }
  // ---- HE grenades ----
  scheduleHEs() {
    const usedTiles = /* @__PURE__ */ new Set();
    for (const a of this.agents) {
      if (!a.utility.includes("he")) continue;
      const target = this.pickChokeTargetForAgent(a, "enemy-side", usedTiles);
      if (!target) continue;
      const player = this.players(a.playerId);
      const baseThrow = 4e3 - (player.stats.aggression - 50) * 20;
      this.heQueue.push({
        thrower: a.playerId,
        spot: target.spot,
        throwAt: baseThrow + this.rng() * 1500
      });
      usedTiles.add(`${target.choke.tile.x},${target.choke.tile.y}`);
    }
  }
  tickHEsUpdate() {
    for (let i = this.hes.length - 1; i >= 0; i--) {
      const he = this.hes[i];
      if (this.t >= he.detonatesAt) {
        this.tickHEs.push({ pos: { ...he.pos }, side: he.side });
        this.applyHEDamage(he);
        for (const sm of this.smokes) {
          const dx = sm.pos.x - he.pos.x, dy = sm.pos.y - he.pos.y;
          const d = Math.hypot(dx, dy);
          if (d < sm.radius + HE_HOLE_RADIUS) {
            this.smokeHoles.push({
              pos: { x: he.pos.x, y: he.pos.y },
              radius: HE_HOLE_RADIUS,
              expiresAt: this.t + HE_HOLE_DURATION_MS
            });
            break;
          }
        }
        this.hes.splice(i, 1);
      }
    }
    this.smokeHoles = this.smokeHoles.filter((h) => h.expiresAt > this.t);
  }
  applyHEDamage(he) {
    for (const a of this.agents) {
      if (!a.alive) continue;
      if (a.side === he.side) continue;
      const dx = a.pos.x - he.pos.x, dy = a.pos.y - he.pos.y;
      const d = Math.hypot(dx, dy);
      if (d > HE_RADIUS) continue;
      if (!this.hasLineOfSight(a.pos, he.pos)) continue;
      let dmg = HE_MAX_DAMAGE * (1 - d / HE_RADIUS);
      if (a.armor > 0) {
        dmg *= 0.6;
        a.armor = Math.max(0, a.armor - dmg * 0.5);
      }
      const applied = Math.min(a.hp, dmg);
      a.hp -= dmg;
      this.addDamage(he.thrower, applied);
      if (a.hp <= 0) {
        a.alive = false;
        a.hp = 0;
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
  checkPickups() {
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
  tickSmokes() {
    this.smokes = this.smokes.filter((s) => s.expiresAt > this.t);
  }
  // ---- Grenade flight pipeline ----
  // Handles all four util types' transitions: queue → in-flight → spawn-at-landing.
  // Each flight has skill-based noise applied to the landing relative to the intended target.
  tickGrenadeFlights() {
    const launchFromQueue = (queue, kind, utilName) => {
      for (let i = queue.length - 1; i >= 0; i--) {
        const q = queue[i];
        if (this.t < q.throwAt) continue;
        const thrower = this.agents.find((a) => a.playerId === q.thrower && a.alive);
        if (thrower) {
          const noise = this.grenadeNoise(q.thrower, kind);
          const landing = this.applyNoise(q.spot, noise);
          this.grenadeFlights.push({
            kind,
            thrower: q.thrower,
            side: thrower.side,
            start: { x: thrower.pos.x, y: thrower.pos.y },
            landing,
            startedAt: this.t,
            landsAt: this.t + GRENADE_FLIGHT_MS
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
    for (let i = this.grenadeFlights.length - 1; i >= 0; i--) {
      const g = this.grenadeFlights[i];
      if (this.t < g.landsAt) continue;
      switch (g.kind) {
        case "smoke":
          this.smokes.push({
            pos: { x: g.landing.x, y: g.landing.y },
            radius: SMOKE_RADIUS_WORLD,
            expiresAt: this.t + SMOKE_DURATION_MS,
            side: g.side
          });
          break;
        case "flash":
          this.flashes.push({
            pos: { x: g.landing.x, y: g.landing.y },
            detonatesAt: this.t + FLASH_FUSE_MS,
            side: g.side
          });
          break;
        case "molotov":
          this.molotovs.push({
            pos: { x: g.landing.x, y: g.landing.y },
            radius: MOLOTOV_RADIUS_WORLD,
            expiresAt: this.t + MOLOTOV_FUSE_MS + MOLOTOV_DURATION_MS,
            side: g.side,
            thrower: g.thrower
          });
          break;
        case "he":
          this.hes.push({
            pos: { x: g.landing.x, y: g.landing.y },
            detonatesAt: this.t + HE_FUSE_MS,
            side: g.side,
            thrower: g.thrower
          });
          break;
      }
      this.grenadeFlights.splice(i, 1);
    }
  }
  grenadeNoise(playerId, kind) {
    const player = this.players(playerId);
    if (!player) return 0;
    let skill;
    switch (kind) {
      case "smoke":
        skill = player.stats.smokeLineups;
        break;
      case "flash":
        skill = player.stats.flashTiming;
        break;
      case "molotov":
        skill = player.stats.molotovUse;
        break;
      case "he":
        skill = player.stats.utility;
        break;
    }
    return Math.max(0, 100 - skill) * GRENADE_NOISE_PER_SKILL_GAP;
  }
  applyNoise(target, noise) {
    if (noise <= 0) return { x: target.x, y: target.y };
    const angle = this.rng() * Math.PI * 2;
    const d = this.rng() * noise;
    return { x: target.x + Math.cos(angle) * d, y: target.y + Math.sin(angle) * d };
  }
  // ---- AI ----
  think(a) {
    if (this.t < a.fleeingFireUntil) return;
    this.maybeSaveDecision(a);
    const arrived = a.target && a.path.length === 0 && dist(a.pos, a.target) < 6;
    const needNew = !a.target || arrived || a.dirty || this.t >= a.nextThinkAt;
    if (!needNew) return;
    const goal = this.pickGoal(a);
    if (goal) {
      a.coverPos = null;
      a.peekPos = null;
      a.peekState = "none";
      this.setGoal(a, goal);
    }
    const player = this.players(a.playerId);
    const decisionScore = (player.stats.adaptability + player.stats.gameSense) / 2;
    const period = 1200 + (100 - decisionScore) * 12 + this.rng() * 800;
    a.nextThinkAt = this.t + period;
    a.dirty = false;
    if (a.target && dist(a.pos, a.target) < 6) {
      a.holdAngle = this.holdDirectionFor(a);
    }
    this.decideMoveMode(a);
  }
  decideMoveMode(a) {
    const player = this.players(a.playerId);
    const stats = player.stats;
    if (a.saving) {
      a.moveMode = "walk";
      return;
    }
    if (player.role === "lurker") {
      a.moveMode = "walk";
      return;
    }
    if (a.side === "T" && this.bombDropped && this.bombRetrieverId() === a.playerId) {
      if (dist(a.pos, this.bombDropped) < this.map.tileSize * 5) {
        a.moveMode = "walk";
        return;
      }
    }
    const caution = clamp((100 - stats.aggression + stats.composure) / 200, 0, 1);
    const walkRadius = CONTACT_RADIUS * (0.6 + caution * 0.9);
    const contact = this.contactZoneFor(a);
    const d = dist(a.pos, contact);
    a.moveMode = d < walkRadius ? "walk" : "run";
  }
  contactZoneFor(a) {
    if (this.bombPlanted && this.bombPlantedAt) return this.bombPlantedAt;
    if (a.assignedSite === "mid") {
      return { x: this.map.width * this.map.tileSize * 0.45, y: this.map.height * this.map.tileSize * 0.5 };
    }
    const site = this.siteByLetter(a.assignedSite);
    return worldCenterOfTile(site.center, this.map);
  }
  pickGoal(a) {
    if (a.saving) return this.saveSpotFor(a);
    if (a.side === "T") return this.tGoal(a);
    return this.ctGoal(a);
  }
  // ---- Saving (keep your gun for next round) ----
  // Every save decision flows through one continuous score. Role-based
  // responsibility (bomb carrier, last CT vs plant, bomb retriever) is a
  // bias, not a gate — so a panicked low-composure carrier can still bail.
  maybeSaveDecision(a) {
    if (this.t < a.reassessSaveAt) return;
    a.reassessSaveAt = this.t + 1200 + this.rng() * 800;
    const player = this.players(a.playerId);
    const stats = player.stats;
    const w = WEAPONS[a.weapon];
    const gunValue = w.cost + (a.armor > 0 ? VEST_COST : 0) + (a.helmet ? HELMET_UPGRADE_COST : 0);
    const us = this.agents.filter((x) => x.alive && x.side === a.side).length;
    const them = this.agents.filter((x) => x.alive && x.side !== a.side).length;
    const trueWin = this.teamWinChance(a.side);
    const noise = (this.rng() - 0.5) * 2 * (1 - stats.gameSense / 100) * 0.15;
    const perceivedWin = clamp(trueWin + noise, 0, 1);
    const numericalDisadvantage = clamp((them - us) / 4, 0, 1);
    const gunValueNorm = clamp((gunValue - 1e3) / 4e3, 0, 1);
    const scoreDef = Math.max(0, this.scoreDeficit(a.side));
    let saveScore = 0;
    saveScore += (1 - perceivedWin) * 0.55;
    saveScore += numericalDisadvantage * 0.2;
    saveScore += gunValueNorm * 0.3;
    saveScore -= stats.aggression / 100 * 0.4;
    saveScore -= stats.discipline / 100 * 0.1;
    saveScore -= Math.min(scoreDef, 6) * 0.03;
    saveScore += (stats.composure - 50) / 200;
    if (a.playerId === this.bombCarrier) {
      saveScore -= 0.5 + stats.discipline / 100 * 0.2;
    }
    if (this.bombPlanted && a.side === "CT" && this.lastAliveOnSide("CT")) {
      saveScore -= 0.2 + stats.discipline / 100 * 0.2 + stats.composure / 100 * 0.2;
    }
    if (a.side === "T" && this.bombDropped && !this.bombCarrier) {
      const retrieverId = this.bombRetrieverId();
      if (retrieverId === a.playerId) saveScore -= 0.4;
    }
    if (a.saving) {
      if (saveScore < 0.3) {
        a.saving = false;
        a.dirty = true;
      }
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
  bombRetrieverId() {
    if (!this.bombDropped || this.bombCarrier) return null;
    let best = null;
    let bestScore = -Infinity;
    for (const a of this.agents) {
      if (!a.alive || a.side !== "T") continue;
      if (a.saving) continue;
      const player = this.players(a.playerId);
      const stats = player.stats;
      const d = dist(a.pos, this.bombDropped);
      const proximity = clamp(1 - d / 800, 0, 1);
      const awareness = (stats.gameSense + stats.mapAwareness) / 200;
      const teamMind = (stats.discipline + stats.communication) / 200;
      const aggressionPenalty = clamp((stats.aggression - 50) / 100, 0, 1);
      const roleBonus = player.role === "support" ? 0.1 : player.role === "igl" ? 0.08 : player.role === "entry" ? -0.08 : player.role === "lurker" ? -0.1 : 0;
      const desire = proximity * 0.4 + awareness * 0.35 + teamMind * 0.2 - aggressionPenalty * 0.2 + roleBonus;
      if (desire > bestScore) {
        bestScore = desire;
        best = a;
      }
    }
    return bestScore > 0.3 ? best?.playerId ?? null : null;
  }
  closestAliveOnSide(side, ref) {
    let best = null;
    let bd = Infinity;
    for (const ag of this.agents) {
      if (!ag.alive || ag.side !== side) continue;
      const d = dist(ag.pos, ref);
      if (d < bd) {
        bd = d;
        best = ag;
      }
    }
    return best;
  }
  teamWinChance(side) {
    const us = this.agents.filter((a) => a.alive && a.side === side).length;
    const them = this.agents.filter((a) => a.alive && a.side !== side).length;
    if (us === 0) return 0;
    if (them === 0) return 1;
    const hpUs = this.agents.filter((a) => a.alive && a.side === side).reduce((s, a) => s + a.hp, 0);
    const hpThem = this.agents.filter((a) => a.alive && a.side !== side).reduce((s, a) => s + a.hp, 0);
    const headcount = us / (us + them);
    const hpRatio = hpUs / Math.max(1, hpUs + hpThem);
    let r = headcount * 0.7 + hpRatio * 0.3;
    if (this.bombPlanted) {
      if (side === "T") r = r * 0.55 + 0.4;
      else r = r * 0.85;
    }
    return r;
  }
  saveSpotFor(a) {
    const spawns = a.side === "CT" ? this.map.ctSpawns : this.map.tSpawns;
    const ref = this.bombPlanted && this.bombPlantedAt ? this.bombPlantedAt : this.contactZoneFor(a);
    let best = spawns[0];
    let bestD = -Infinity;
    for (const s of spawns) {
      const w = this.tileCenter(s);
      const d = dist(w, ref);
      if (d > bestD) {
        bestD = d;
        best = s;
      }
    }
    return this.tileCenter(best);
  }
  tGoal(a) {
    if (this.bombPlanted && this.bombPlantedAt) {
      return jitter(this.bombPlantedAt, 70, this.rng);
    }
    if (this.bombDropped) {
      const retrieverId = this.bombRetrieverId();
      if (retrieverId && a.playerId === retrieverId) {
        return { x: this.bombDropped.x, y: this.bombDropped.y };
      }
    }
    const player = this.players(a.playerId);
    const intel = this.intel.T;
    const sA = intel.A.score, sB = intel.B.score;
    const dominanceNeeded = INTEL_DOMINANCE * (1 - (player.stats.gameSense - 60) / 200);
    let preferred = a.assignedSite;
    const canRotate = (player.role !== "lurker" || a.playerId === this.bombCarrier) && this.t >= ROTATE_MIN_T;
    if (canRotate) {
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
    if (a.playerId === this.bombCarrier) {
      const site = this.siteByLetter(a.assignedSite === "mid" ? "A" : a.assignedSite);
      return worldCenterOfTile(site.center, this.map);
    }
    const target = a.assignedSite === "mid" ? this.map.bombsites[0] : this.siteByLetter(a.assignedSite);
    return jitter(worldCenterOfTile(target.center, this.map), 80, this.rng);
  }
  ctGoal(a) {
    if (this.bombDropped && !this.bombPlanted) {
      const closest = this.closestAliveOnSide("CT", this.bombDropped);
      if (closest && a.playerId === closest.playerId) {
        return jitter(this.bombDropped, 90, this.rng);
      }
    }
    if (this.bombPlanted && this.bombPlantedAt) {
      const cts = this.agents.filter((x) => x.side === "CT" && x.alive);
      let defuser = cts[0];
      let bestD = Infinity;
      for (const c of cts) {
        const d = dist(c.pos, this.bombPlantedAt);
        if (d < bestD) {
          bestD = d;
          defuser = c;
        }
      }
      if (defuser && a.playerId === defuser.playerId) {
        return { x: this.bombPlantedAt.x, y: this.bombPlantedAt.y };
      }
      return jitter(this.bombPlantedAt, 70, this.rng);
    }
    const player = this.players(a.playerId);
    const intel = this.intel.CT;
    const sA = intel.A.score, sB = intel.B.score;
    const dominanceNeeded = INTEL_DOMINANCE * (1 - (player.stats.gameSense - 60) / 200);
    let preferred = a.assignedSite;
    const bombA = this.t - intel.A.bombSeenAt < BOMB_SIGHTING_RECENT_MS;
    const bombB = this.t - intel.B.bombSeenAt < BOMB_SIGHTING_RECENT_MS;
    if (bombA && !bombB) preferred = "A";
    else if (bombB && !bombA) preferred = "B";
    else if (bombA && bombB) preferred = intel.A.bombSeenAt > intel.B.bombSeenAt ? "A" : "B";
    else if (this.t >= ROTATE_MIN_T) {
      if (sA - sB >= dominanceNeeded) preferred = "A";
      else if (sB - sA >= dominanceNeeded) preferred = "B";
    }
    if (player.role === "lurker" && !bombA && !bombB && Math.abs(sA - sB) < dominanceNeeded * 2) {
      preferred = a.assignedSite;
    }
    if (preferred !== a.assignedSite && preferred !== "mid") {
      const last = this.lastRotationLog[a.playerId] ?? -Infinity;
      if (this.t - last >= ROTATE_LOG_COOLDOWN) {
        this.rotationLog.push({ t: this.t, agentId: a.playerId, from: a.assignedSite, to: preferred });
        this.lastRotationLog[a.playerId] = this.t;
      }
      a.assignedSite = preferred;
    }
    if (a.assignedSite === "mid") {
      const center = { x: this.map.width * this.map.tileSize * 0.45, y: this.map.height * this.map.tileSize * 0.5 };
      return jitter(center, 60, this.rng);
    }
    const site = this.siteByLetter(a.assignedSite);
    return jitter(worldCenterOfTile(site.center, this.map), 70, this.rng);
  }
  siteByLetter(letter) {
    return this.map.bombsites.find((s) => s.id === letter);
  }
  // ---- Peek and retreat ----
  // When an agent has reached their hold position and is not in combat, look
  // for nearby cover and oscillate between a covered tile and an exposed
  // (peek) tile one step toward the threat direction.
  tickPeek(a) {
    if (this.t < a.fleeingFireUntil) return;
    if (this.t < a.blindedUntil) return;
    if (a.stance === "rush" || a.stance === "disengage") return;
    if (this.bombPlanted) return;
    if (a.path.length > 0 && a.peekState === "none") return;
    if (a.peekState === "none") {
      if (a.path.length > 0) return;
      if (!this.setupPeek(a)) return;
    }
    if (this.t < a.peekUntil) return;
    const player = this.players(a.playerId);
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
  setGoalForPeek(a, goal) {
    const path = findPath(this.map, a.pos, goal);
    if (path === null) return;
    a.target = goal;
    a.path = path;
    a.holdAngle = null;
  }
  setupPeek(a) {
    const ts = this.map.tileSize;
    const ax = Math.floor(a.pos.x / ts);
    const ay = Math.floor(a.pos.y / ts);
    const focus = a.side === "CT" ? this.ctThreatFocus : this.tThreatFocus;
    const tx = focus.x - a.pos.x, ty = focus.y - a.pos.y;
    let dx = 0, dy = 0;
    if (Math.abs(tx) >= Math.abs(ty)) dx = tx > 0 ? 1 : -1;
    else dy = ty > 0 ? 1 : -1;
    for (let r = 0; r <= 2; r++) {
      for (let oy = -r; oy <= r; oy++) {
        for (let ox = -r; ox <= r; ox++) {
          if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue;
          const cx = ax + ox, cy = ay + oy;
          if (!this.inBoundsTile(cx, cy) || this.wallAt(cx, cy)) continue;
          if (!this.wallAt(cx + dx, cy + dy)) continue;
          for (const [px, py] of [[-dy, dx], [dy, -dx]]) {
            const pxT = cx + px, pyT = cy + py;
            if (!this.inBoundsTile(pxT, pyT) || this.wallAt(pxT, pyT)) continue;
            if (this.wallAt(pxT + dx, pyT + dy)) continue;
            a.coverPos = this.tileCenter({ x: cx, y: cy });
            a.peekPos = this.tileCenter({ x: pxT, y: pyT });
            a.peekState = "cover";
            const patience = this.players(a.playerId).stats.patience;
            a.peekUntil = this.t + 600 + (100 - patience) * 8 + this.rng() * 400;
            if (ox !== 0 || oy !== 0) this.setGoalForPeek(a, a.coverPos);
            return true;
          }
        }
      }
    }
    return false;
  }
  inBoundsTile(tx, ty) {
    return tx >= 0 && ty >= 0 && tx < this.map.width && ty < this.map.height;
  }
  wallAt(tx, ty) {
    if (!this.inBoundsTile(tx, ty)) return true;
    return this.map.walls[ty * this.map.width + tx];
  }
  setGoal(a, goal) {
    const path = findPath(this.map, a.pos, goal);
    if (path === null) {
      a.target = null;
      a.path = [];
      return;
    }
    a.target = goal;
    a.path = path;
    a.holdAngle = null;
  }
  holdDirectionFor(a) {
    if (this.bombPlanted && this.bombPlantedAt && a.side === "T") {
      const dx = a.pos.x - this.bombPlantedAt.x, dy = a.pos.y - this.bombPlantedAt.y;
      return Math.atan2(dy, dx);
    }
    const focus = a.side === "CT" ? this.ctThreatFocus : this.tThreatFocus;
    return Math.atan2(focus.y - a.pos.y, focus.x - a.pos.x);
  }
  // ---- Movement (waypoint-based) ----
  move(a) {
    if (this.t < a.blindedUntil) return;
    if (a.stance === "hold" && this.t < a.stanceUntil) return;
    if (a.path.length === 0) {
      if (a.holdAngle !== null) a.facing = a.holdAngle;
      return;
    }
    const player = this.players(a.playerId);
    const nextWp = a.path[0];
    const smokeAhead = this.smokes.find((s) => dist(nextWp, s.pos) < s.radius);
    if (smokeAhead) {
      const isCarrier = a.playerId === this.bombCarrier;
      const isRushing = a.stance === "rush";
      const fading = smokeAhead.expiresAt - this.t < 3e3;
      const willPushPersonality = player.stats.aggression > player.stats.patience + 15;
      if (!isCarrier && !isRushing && !fading && !willPushPersonality) {
        a.holdAngle = Math.atan2(smokeAhead.pos.y - a.pos.y, smokeAhead.pos.x - a.pos.x);
        return;
      }
    }
    const baseSpeed = (60 + player.stats.movement * 0.8) / 1e3 * TICK_MS;
    const speed = a.moveMode === "walk" ? baseSpeed * WALK_SPEED_FACTOR : baseSpeed;
    const wp = a.path[0];
    const dx = wp.x - a.pos.x;
    const dy = wp.y - a.pos.y;
    const d = Math.hypot(dx, dy);
    if (d < speed) {
      a.pos.x = wp.x;
      a.pos.y = wp.y;
      a.path.shift();
      return;
    }
    a.pos.x += dx / d * speed;
    a.pos.y += dy / d * speed;
  }
  // ---- Looking around ----
  updateLook(a) {
    if (this.t < a.lookChangeAt && a.lookTarget) return;
    const player = this.players(a.playerId);
    const focus = a.side === "CT" ? this.ctThreatFocus : this.tThreatFocus;
    const threatDir = Math.atan2(focus.y - a.pos.y, focus.x - a.pos.x);
    let baseDir = threatDir;
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
    const cp = player.stats.crosshairPlacement / 100;
    const arcHalf = Math.PI * 0.5 * (1.1 - Math.max(0.4, cp));
    const offset = (this.rng() - 0.5) * 2 * arcHalf;
    const dir = baseDir + offset;
    a.lookTarget = { x: a.pos.x + Math.cos(dir) * 120, y: a.pos.y + Math.sin(dir) * 120 };
    const cadence = 500 + (100 - player.stats.adaptability) * 8 + this.rng() * 400;
    a.lookChangeAt = this.t + cadence;
  }
  // Smokes within ~280 px and roughly in the agent's threat direction (±60°).
  findThreatSmoke(a, threatDir) {
    let best = null;
    let bestD = 280;
    for (const s of this.smokes) {
      const d = dist(a.pos, s.pos);
      if (d > bestD) continue;
      const smokeDir = Math.atan2(s.pos.y - a.pos.y, s.pos.x - a.pos.x);
      let angDiff = Math.abs(smokeDir - threatDir);
      while (angDiff > Math.PI) angDiff = Math.PI * 2 - angDiff;
      if (angDiff > Math.PI / 3) continue;
      best = s;
      bestD = d;
    }
    return best;
  }
  // Smoothly rotate facing toward lookTarget.
  applyFacing(a) {
    if (!a.lookTarget) return;
    const desired = Math.atan2(a.lookTarget.y - a.pos.y, a.lookTarget.x - a.pos.x);
    let diff = desired - a.facing;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    const player = this.players(a.playerId);
    const speed = (player.stats.handSpeed * 0.7 + player.stats.reflexes * 0.3) / 100;
    const maxStep = 0.08 + speed * 0.18;
    const step = Math.max(-maxStep, Math.min(maxStep, diff));
    a.facing += step;
  }
  // ---- Combat ----
  maybeShoot(a) {
    const player = this.players(a.playerId);
    const weaponStats = WEAPONS[a.weapon];
    if (a.reloadingUntil > 0 && this.t >= a.reloadingUntil) {
      const needed = weaponStats.magSize - a.ammo;
      const taken = Math.min(needed, a.reserve);
      a.ammo += taken;
      a.reserve -= taken;
      a.reloadingUntil = 0;
    }
    if (a.reloadingUntil > 0) return;
    if (this.t < a.fleeingFireUntil) return;
    const reactionMs = 80 + Math.max(0, 100 - player.stats.reflexes) * 4;
    const stats = player.stats;
    const enemy = this.acquireTarget(a, reactionMs);
    if (!enemy) {
      if (a.weapon !== "knife" && a.ammo < weaponStats.magSize * 0.4 && a.reserve > 0) {
        a.reloadingUntil = this.t + weaponStats.reloadMs;
        return;
      }
      if (a.weapon !== "knife" && a.ammo > 0 && this.smokes.length > 0) {
        const blind = this.tryBlindSpray(a);
        if (blind) this.fireBlind(a, blind, weaponStats);
      }
      return;
    }
    if (this.t >= a.stanceUntil) this.decideStance(a, enemy);
    if (a.stance === "disengage") return;
    const weapon = weaponStats;
    const cooldown = 1e3 / weapon.fireRate;
    if (this.t - a.lastShotAt < cooldown) return;
    if (a.weapon !== "knife" && a.ammo <= 0) {
      if (a.reserve > 0) a.reloadingUntil = this.t + weapon.reloadMs;
      return;
    }
    a.lastShotAt = this.t;
    if (a.weapon !== "knife") a.ammo--;
    a.facing = Math.atan2(enemy.pos.y - a.pos.y, enemy.pos.x - a.pos.x);
    a.lookTarget = { x: enemy.pos.x, y: enemy.pos.y };
    a.lookChangeAt = this.t + 300;
    const d = dist(a.pos, enemy.pos);
    const rangeFactor = d <= weapon.range ? 1 : Math.max(0.25, 1 - (d - weapon.range) / weapon.range);
    const slot = WEAPONS[a.weapon].slot;
    const prefMap = {
      knife: 50,
      pistol: stats.pistolPref,
      smg: stats.smgPref,
      rifle: stats.riflePref,
      awp: stats.awpPref
    };
    const weaponPref = (prefMap[slot] ?? 50) / 100;
    let aimMod = stats.accuracy / 100 * 0.7 + weaponPref * 0.3;
    if (this.lastAliveOnSide(a.side)) aimMod += (stats.composure - 60) / 200;
    if (this.scoreDeficit(a.side) >= 3) aimMod -= Math.max(0, 60 - stats.composure) / 400;
    if (this.tradeMarks.some((m) => m.killerId === enemy.playerId && m.victimSide === a.side)) {
      aimMod += TRADE_AIM_BONUS;
    }
    const sinceLastShot = this.t - a.lastShotAt;
    if (a.lastShotAt > 0 && sinceLastShot < 500) {
      aimMod += (stats.sprayControl - 50) / 400;
    } else {
      aimMod += (stats.tapping - 50) / 500;
    }
    if (a.path.length === 0) {
      aimMod += 0.04 + (stats.counterStrafe - 50) / 600;
    } else {
      aimMod -= 0.05;
    }
    aimMod += (player.mood - 50) / 400;
    const hitChance = clamp(weapon.accuracy * aimMod * rangeFactor, 0.05, 0.95);
    const hit = this.rng() < hitChance;
    this.tickShots.push({
      from: { ...a.pos },
      to: { ...enemy.pos },
      side: a.side,
      hit,
      killerId: a.playerId
    });
    if (!hit) return;
    const falloff = Math.pow(weapon.rangeModifier, d / WEAPON_FALLOFF_UNIT);
    let dmg = weapon.damage * falloff * (0.92 + this.rng() * 0.16);
    const hsBase = HEADSHOT_BASE[a.weapon];
    const hsChance = clamp(hsBase + (stats.crosshairPlacement - 50) / 350 + (stats.accuracy - 50) / 600, 0.03, 0.55);
    const isHeadshot = this.rng() < hsChance;
    if (isHeadshot) {
      dmg *= weapon.headshotMultiplier;
      if (enemy.helmet) {
        dmg *= weapon.armorPen;
        enemy.helmet = false;
      }
    } else if (enemy.armor > 0) {
      const before = dmg;
      dmg *= weapon.armorPen;
      enemy.armor = Math.max(0, enemy.armor - (before - dmg) * 0.5);
    }
    const applied = Math.min(enemy.hp, dmg);
    enemy.hp -= dmg;
    this.addDamage(a.playerId, applied);
    if (enemy.saving) {
      enemy.saving = false;
      enemy.dirty = true;
    }
    if (enemy.hp <= 0) {
      enemy.alive = false;
      enemy.hp = 0;
      if (enemy.weapon !== "knife") {
        this.drops.push({ pos: { ...enemy.pos }, weapon: enemy.weapon });
      }
      this.push({ t: this.t, kind: "kill", killer: a.playerId, victim: enemy.playerId, weapon: a.weapon, headshot: isHeadshot });
      const killer = this.players(a.playerId);
      killer.mood = clamp(killer.mood + 4, 0, 100);
      const victim = this.players(enemy.playerId);
      victim.mood = clamp(victim.mood - 3, 0, 100);
      this.bumpStat(a.playerId, "kills", 1);
      this.bumpStat(enemy.playerId, "deaths", 1);
      this.tradeMarks.push({
        killerId: a.playerId,
        victimSide: enemy.side,
        expiresAt: this.t + TRADE_WINDOW_MS
      });
      if (enemy.playerId === this.bombCarrier) this.dropBomb(enemy);
    }
  }
  dropBomb(victim) {
    this.bombDropped = { x: victim.pos.x, y: victim.pos.y };
    this.bombCarrier = null;
    for (const ag of this.agents) if (ag.alive) ag.dirty = true;
  }
  // ---- Engagement stance ----
  decideStance(a, enemy) {
    const player = this.players(a.playerId);
    const stats = player.stats;
    const isLastAlive = this.lastAliveOnSide(a.side);
    if (a.saving) {
      const d = dist(a.pos, enemy.pos);
      const reactRange = 100 + stats.composure / 100 * 140;
      if (d < reactRange) {
        a.saving = false;
      } else {
        a.stance = "disengage";
        a.stanceUntil = this.t + 2e3;
        this.setGoal(a, this.saveSpotFor(a));
        return;
      }
    }
    let visibleEnemies = 0;
    for (const e of this.agents) {
      if (!e.alive || e.side === a.side) continue;
      if (dist(a.pos, e.pos) > VISION_RANGE) continue;
      if (!this.hasLineOfSight(a.pos, e.pos)) continue;
      visibleEnemies++;
    }
    const allyRange = 240 + (80 - stats.composure) * 0.8;
    let nearbyAllies = 0;
    for (const al of this.agents) {
      if (!al.alive || al.side !== a.side || al.playerId === a.playerId) continue;
      if (dist(a.pos, al.pos) < allyRange) nearbyAllies++;
    }
    const tiltPressure = stats.composure < 45 && this.scoreDeficit(a.side) >= 3;
    const enemyThreshold = tiltPressure ? 1 : 2;
    const refuseDisengage = isLastAlive && stats.composure > 70;
    let stance;
    if (!refuseDisengage && visibleEnemies >= enemyThreshold && nearbyAllies === 0) {
      stance = "disengage";
    } else {
      const myCost = WEAPONS[a.weapon].cost;
      const theirCost = WEAPONS[enemy.weapon].cost;
      const ratio = myCost / Math.max(1, theirCost);
      const d = dist(a.pos, enemy.pos);
      const rushBias = (stats.aggression - 60) / 200 + (isLastAlive && stats.composure > 65 ? 0.25 : 0);
      if (ratio < 0.5 + rushBias && d > 160 && a.hp > 45) stance = "rush";
      else stance = "hold";
    }
    a.stance = stance;
    const duration = stance === "rush" ? 900 : stance === "disengage" ? 1500 : 700;
    a.stanceUntil = this.t + duration;
    a.nextThinkAt = Math.max(a.nextThinkAt, a.stanceUntil + 200);
    if (stance === "rush") {
      this.setGoal(a, { x: enemy.pos.x, y: enemy.pos.y });
    } else if (stance === "disengage") {
      const dx = a.pos.x - enemy.pos.x, dy = a.pos.y - enemy.pos.y;
      const dd = Math.hypot(dx, dy) || 1;
      const goal = { x: a.pos.x + dx / dd * 220, y: a.pos.y + dy / dd * 220 };
      this.setGoal(a, goal);
    } else {
      a.target = null;
      a.path = [];
    }
  }
  // ---- Blind spray (audio cue through smoke) ----
  tryBlindSpray(a) {
    for (const e of this.agents) {
      if (!e.alive || e.side === a.side) continue;
      if (e.moveMode !== "run") continue;
      const d = dist(a.pos, e.pos);
      if (d > HEARING_RANGE) continue;
      if (this.hasLineOfSight(a.pos, e.pos)) continue;
      if (this.wallOnLine(a.pos, e.pos)) continue;
      if (!this.smokeOnLine(a.pos, e.pos)) continue;
      return e;
    }
    return null;
  }
  wallOnLine(p1, p2) {
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
      if (tMaxX < tMaxY) {
        tx += stepX;
        tMaxX += tDeltaX;
      } else {
        ty += stepY;
        tMaxY += tDeltaY;
      }
    }
    return false;
  }
  smokeOnLine(p1, p2) {
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
  fireBlind(a, target, weapon) {
    const cooldown = 1e3 / weapon.fireRate;
    if (this.t - a.lastShotAt < cooldown) return;
    a.lastShotAt = this.t;
    if (a.weapon !== "knife") a.ammo--;
    const HIT_CHANCE = 0.08;
    const hit = this.rng() < HIT_CHANCE;
    this.tickShots.push({
      from: { x: a.pos.x, y: a.pos.y },
      to: { x: target.pos.x, y: target.pos.y },
      side: a.side,
      hit,
      killerId: a.playerId
    });
    if (!hit) return;
    const dBlind = dist(a.pos, target.pos);
    const blindFalloff = Math.pow(weapon.rangeModifier, dBlind / WEAPON_FALLOFF_UNIT);
    let dmg = weapon.damage * blindFalloff * (0.6 + this.rng() * 0.3);
    if (target.armor > 0) {
      const before = dmg;
      dmg *= weapon.armorPen;
      target.armor = Math.max(0, target.armor - (before - dmg) * 0.5);
    }
    const applied = Math.min(target.hp, dmg);
    target.hp -= dmg;
    this.addDamage(a.playerId, applied);
    if (target.saving) {
      target.saving = false;
      target.dirty = true;
    }
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
  acquireTarget(a, reactionMs) {
    if (this.t < a.blindedUntil) {
      for (const id of Object.keys(a.spotted)) delete a.spotted[id];
      return null;
    }
    const visibleEnemies = [];
    const stillSeen = /* @__PURE__ */ new Set();
    for (const e of this.agents) {
      if (!e.alive || e.side === a.side) continue;
      const d = dist(a.pos, e.pos);
      if (d > VISION_RANGE) continue;
      if (!this.hasLineOfSight(a.pos, e.pos)) continue;
      visibleEnemies.push({ e, d });
      stillSeen.add(e.playerId);
      if (a.spotted[e.playerId] === void 0) {
        a.spotted[e.playerId] = this.t;
      }
    }
    for (const id of Object.keys(a.spotted)) {
      if (!stillSeen.has(id)) delete a.spotted[id];
    }
    let best = null;
    let bestD = Infinity;
    for (const { e, d } of visibleEnemies) {
      if (this.t - a.spotted[e.playerId] < reactionMs) continue;
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }
  hasLineOfSight(a, b) {
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
    const checkSmoke = (px, py) => {
      for (const sm of this.smokes) {
        const sdx = px - sm.pos.x, sdy = py - sm.pos.y;
        if (sdx * sdx + sdy * sdy >= sm.radius * sm.radius) continue;
        let inHole = false;
        for (const h of this.smokeHoles) {
          const hdx = px - h.pos.x, hdy = py - h.pos.y;
          if (hdx * hdx + hdy * hdy < h.radius * h.radius) {
            inHole = true;
            break;
          }
        }
        if (!inHole) return true;
      }
      return false;
    };
    let safety = (W + H) * 2;
    while (safety-- > 0) {
      if (tx < 0 || ty < 0 || tx >= W || ty >= H) return false;
      if (!(tx === Math.floor(a.x / ts) && ty === Math.floor(a.y / ts))) {
        if (this.map.walls[ty * W + tx]) return false;
      }
      const tAlong = Math.min(tMaxX, tMaxY);
      const px = a.x + dx * Math.min(1, Math.max(0, tAlong));
      const py = a.y + dy * Math.min(1, Math.max(0, tAlong));
      if (checkSmoke(px, py)) return false;
      if (tx === ex && ty === ey) return true;
      if (tMaxX < tMaxY) {
        tx += stepX;
        tMaxX += tDeltaX;
      } else {
        ty += stepY;
        tMaxY += tDeltaY;
      }
    }
    return true;
  }
  lastAliveOnSide(side) {
    return this.agents.filter((x) => x.side === side && x.alive).length === 1;
  }
  scoreDeficit(side) {
    if (side === "CT") return this.tSide.roundsWon - this.ct.roundsWon;
    return this.ct.roundsWon - this.tSide.roundsWon;
  }
  // ---- Bomb ----
  tickBomb() {
    if (this.bombPlanted) {
      const onSite = this.agents.find(
        (a) => a.alive && a.side === "CT" && dist(a.pos, this.bombPlantedAt) < this.map.tileSize * 1.2
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
    if (this.bombDropped && !this.bombCarrier) {
      const PICKUP_RANGE = this.map.tileSize * 0.9;
      let closest = null;
      let bestD = Infinity;
      for (const ag of this.agents) {
        if (!ag.alive || ag.side !== "T") continue;
        const d = dist(ag.pos, this.bombDropped);
        if (d < PICKUP_RANGE && d < bestD) {
          bestD = d;
          closest = ag;
        }
      }
      if (closest) {
        this.bombCarrier = closest.playerId;
        this.bombDropped = null;
        closest.dirty = true;
      }
    }
    if (!this.bombCarrier) return;
    const carrier = this.agents.find((a) => a.playerId === this.bombCarrier && a.alive);
    if (!carrier) return;
    const site = this.map.bombsites.find((s) => {
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
        for (const ag of this.agents) if (ag.alive) ag.dirty = true;
      }
    } else {
      this.planting = null;
      this.plantProgress = Math.max(0, this.plantProgress - TICK_MS);
    }
  }
  enemiesNearby(a, range) {
    return this.agents.some((e) => e.alive && e.side !== a.side && dist(e.pos, a.pos) < range);
  }
  checkEnd() {
    if (this.finished) return;
    const ctAlive = this.agents.some((a) => a.side === "CT" && a.alive);
    const tAlive = this.agents.some((a) => a.side === "T" && a.alive);
    if (!tAlive && !this.bombPlanted) return this.finish("t-elim", "CT");
    if (!ctAlive && !this.bombPlanted) return this.finish("ct-elim", "T");
    if (this.bombPlanted && !ctAlive) {
      this.push({ t: this.t, kind: "bomb-detonate" });
      return this.finish("bomb-detonated", "T");
    }
    if (this.t >= ROUND_TIME_MS && !this.bombPlanted) return this.finish("time-expired", "CT");
  }
  finish(outcome, winningSide) {
    this.finished = true;
    this.push({ t: this.t, kind: "round-end", winner: winningSide });
    this.result = { outcome, winningSide, durationMs: this.t, events: this.events };
    for (const ag of this.agents) this.bumpStat(ag.playerId, "roundsPlayed", 1);
  }
  teamOfPlayer(id) {
    if (this.ct.players.some((p) => p.id === id)) return this.ct;
    if (this.tSide.players.some((p) => p.id === id)) return this.tSide;
    return null;
  }
  bumpStat(playerId, key, amount) {
    const team = this.teamOfPlayer(playerId);
    if (!team) return;
    team.matchStats[playerId][key] += amount;
  }
  addDamage(playerId, amount) {
    const team = this.teamOfPlayer(playerId);
    if (!team) return;
    team.matchStats[playerId].damage += amount;
  }
};
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function worldCenterOfTile(t, map) {
  return { x: (t.x + 0.5) * map.tileSize, y: (t.y + 0.5) * map.tileSize };
}
function jitter(p, r, rng) {
  const a = rng() * Math.PI * 2;
  const d = rng() * r;
  return { x: p.x + Math.cos(a) * d, y: p.y + Math.sin(a) * d };
}

// scripts/instrument.ts
var MAP = JSON.parse(process.argv[2]);
function applyRifle(team) {
  const rifle = team.side === "CT" ? "m4" : "ak";
  for (const p of team.players) {
    const l = {
      weapon: rifle,
      utility: [],
      armor: true,
      helmet: true,
      keptWeapon: null,
      keptArmor: false,
      keptHelmet: false,
      keptUtility: []
    };
    team.loadouts[p.id] = l;
  }
}
var NEUTRALIZE = process.env.NEUTRALIZE === "1";
function runOne(seed) {
  setSeed(seed);
  const ct = makeTeam("ct", "CT", "CT");
  const t = makeTeam("t", "T", "T");
  if (NEUTRALIZE) {
    neutralizeTeamStats(ct, 60);
    neutralizeTeamStats(t, 60);
  }
  applyRifle(ct);
  applyRifle(t);
  const sim = new RoundSim(ct, t, MAP, seed);
  let safety = 1e5;
  while (!sim.finished && safety-- > 0) sim.tick();
  return sim.result?.winningSide ?? null;
}
function runTraced(seed) {
  setSeed(seed);
  const ct = makeTeam("ct", "CT", "CT");
  const t = makeTeam("t", "T", "T");
  if (NEUTRALIZE) {
    neutralizeTeamStats(ct, 60);
    neutralizeTeamStats(t, 60);
  }
  applyRifle(ct);
  applyRifle(t);
  const sim = new RoundSim(ct, t, MAP, seed);
  const nameById = /* @__PURE__ */ new Map();
  for (const team of [ct, t]) for (const p of team.players) nameById.set(p.id, `${team.side}:${p.name.split(" ")[0]}`);
  let safety = 1e5;
  let firstShotAt = -1;
  let firstKillAt = -1;
  while (!sim.finished && safety-- > 0) {
    const movingBefore = /* @__PURE__ */ new Map();
    for (const a of sim.agents) movingBefore.set(a.playerId, a.path.length > 0);
    sim.tick();
    for (const s of sim.tickShots) {
      if (firstShotAt < 0) firstShotAt = sim.t;
      const shooter = sim.agents.find((a) => a.playerId === s.killerId);
      const moving = movingBefore.get(s.killerId);
      const d = Math.hypot(s.from.x - s.to.x, s.from.y - s.to.y);
      console.log(
        `t=${String(sim.t).padStart(5)} ${nameById.get(s.killerId).padEnd(14)} pos=(${shooter.pos.x.toFixed(0)},${shooter.pos.y.toFixed(0)}) d=${d.toFixed(0)}px moving=${moving ? "Y" : "N"} hit=${s.hit ? "\u2713" : "\xB7"}`
      );
    }
    for (const e of sim.events) {
      if (e.kind === "kill" && firstKillAt < 0 && e.t > 0) {
        firstKillAt = e.t;
        console.log(`  \u2192 KILL at t=${e.t}: ${nameById.get(e.killer)} killed ${nameById.get(e.victim)} (${e.weapon}${e.headshot ? " HS" : ""})`);
      }
    }
    sim.events.length = 0;
  }
  const r = sim.result;
  console.log(`
Result: seed=${seed} winner=${r?.winningSide} outcome=${r?.outcome} dur=${(r?.durationMs ?? 0) / 1e3}s firstShot=${firstShotAt}ms firstKill=${firstKillAt}ms`);
}
var N = 1e3;
var ctWins = 0;
var tWins = 0;
var ctSeeds = [];
var tSeeds = [];
for (let s = 0; s < N; s++) {
  const w = runOne(s);
  if (w === "CT") {
    ctWins++;
    ctSeeds.push(s);
  } else if (w === "T") {
    tWins++;
    tSeeds.push(s);
  }
}
console.log(`Fresh teams over ${N} seeds: CT ${ctWins} (${(100 * ctWins / N).toFixed(1)}%) \xB7 T ${tWins} (${(100 * tWins / N).toFixed(1)}%)`);
function runPersistent(N2, baseSeed) {
  setSeed(baseSeed);
  const ct = makeTeam("ct", "CT", "CT");
  const t = makeTeam("t", "T", "T");
  if (NEUTRALIZE) {
    neutralizeTeamStats(ct, 60);
    neutralizeTeamStats(t, 60);
  }
  let cw = 0, tw = 0;
  for (let s = 0; s < N2; s++) {
    applyRifle(ct);
    applyRifle(t);
    for (const p of ct.players) {
      p.money = 4500;
      p.mood = 65;
      p.morale = 65;
    }
    for (const p of t.players) {
      p.money = 4500;
      p.mood = 65;
      p.morale = 65;
    }
    const sim = new RoundSim(ct, t, MAP, s + baseSeed * 1e6);
    let safety = 1e5;
    while (!sim.finished && safety-- > 0) sim.tick();
    if (sim.result?.winningSide === "CT") cw++;
    else if (sim.result?.winningSide === "T") tw++;
  }
  return { cw, tw };
}
console.log(`
Persistent teams (5 base seeds \xD7 ${N} rounds each):`);
for (let b = 0; b < 5; b++) {
  const { cw, tw } = runPersistent(N, b);
  console.log(`  base=${b}: CT ${cw} (${(100 * cw / N).toFixed(1)}%) \xB7 T ${tw} (${(100 * tw / N).toFixed(1)}%)`);
}
console.log();
console.log(`=== TRACE CT-win seed=${ctSeeds[0]} ===`);
runTraced(ctSeeds[0]);
if (tSeeds.length > 0) {
  console.log(`
=== TRACE T-win seed=${tSeeds[0]} ===`);
  runTraced(tSeeds[0]);
}
