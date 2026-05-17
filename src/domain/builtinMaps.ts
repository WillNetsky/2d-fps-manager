import type { GameMap, Vec2 } from "./types.ts";

// 5 hand-built default maps. All are 33x21 @ 29px (odd pixel totals) and roughly
// mirror-symmetric so neither side gets a free travel advantage. CT spawn is at
// the north edge, T spawn at the south, with bombsites flanking the middle —
// each spawn reaches both sites in similar distance.

const W = 33;
const H = 21;
const TS = 29;

class B {
  walls: boolean[] = new Array(W * H).fill(true);
  carve(x1: number, y1: number, x2: number, y2: number) {
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        if (x >= 0 && y >= 0 && x < W && y < H) this.walls[y * W + x] = false;
      }
    }
  }
  fill(x1: number, y1: number, x2: number, y2: number) {
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
        if (x >= 0 && y >= 0 && x < W && y < H) this.walls[y * W + x] = true;
      }
    }
  }
  wall(x: number, y: number) { if (x >= 0 && y >= 0 && x < W && y < H) this.walls[y * W + x] = true; }
  done(
    name: string,
    ctSpawns: Vec2[],
    tSpawns: Vec2[],
    A: Vec2,
    Bs: Vec2,
    wallColor: string,
    floorColor: string,
  ): GameMap {
    return {
      name, width: W, height: H, tileSize: TS,
      walls: this.walls, ctSpawns, tSpawns,
      bombsites: [
        { id: "A", center: A, radius: 2.5 },
        { id: "B", center: Bs, radius: 2.5 },
      ],
      wallColor, floorColor,
    };
  }
}

// ── 1. Crossfire ──────────────────────────────────────────────────────────
// Open X corridor through the middle, with flanking outer routes. Sites in
// recessed alcoves east/west. Lots of long sightlines — favors AWPers.
function crossfire(): GameMap {
  const b = new B();
  // Outer ring of floor
  b.carve(1, 1, 31, 19);
  // Central X support pillars to break LOS
  b.fill(8, 4, 11, 7);
  b.fill(21, 4, 24, 7);
  b.fill(8, 13, 11, 16);
  b.fill(21, 13, 24, 16);
  // Center pillar cluster
  b.wall(15, 9); b.wall(17, 9);
  b.wall(15, 11); b.wall(17, 11);
  b.wall(16, 10);
  // Site alcoves carved into the inner pillar walls
  b.carve(2, 9, 4, 11);   // A pocket (west)
  b.carve(28, 9, 30, 11); // B pocket (east)
  return b.done(
    "Crossfire",
    [{x:14,y:1},{x:15,y:1},{x:16,y:1},{x:17,y:1},{x:18,y:1}],
    [{x:14,y:19},{x:15,y:19},{x:16,y:19},{x:17,y:19},{x:18,y:19}],
    {x:3,y:10}, {x:29,y:10},
    "#3a414f", "#1a1e27",
  );
}

// ── 2. Aqueduct ──────────────────────────────────────────────────────────
// A horizontal stone "canal" splits the map; three bridges (left, mid, right)
// cross it. Bombsites are tucked into raised platforms either side of mid.
// Warm sandstone palette.
function aqueduct(): GameMap {
  const b = new B();
  b.carve(1, 1, 31, 19);
  // Canal — a thick horizontal wall at y=10
  b.fill(0, 10, 32, 10);
  // Bridges
  b.carve(4, 10, 6, 10);
  b.carve(15, 10, 17, 10);
  b.carve(26, 10, 28, 10);
  // Bombsite platforms — slight nooks just off the bridges
  b.fill(11, 8, 13, 9);   // cover near A
  b.fill(19, 11, 21, 12); // cover near B
  // Some scattered cover
  b.wall(8, 4); b.wall(24, 4);
  b.wall(8, 16); b.wall(24, 16);
  b.wall(16, 4); b.wall(16, 16);
  return b.done(
    "Aqueduct",
    [{x:14,y:1},{x:15,y:1},{x:16,y:1},{x:17,y:1},{x:18,y:1}],
    [{x:14,y:19},{x:15,y:19},{x:16,y:19},{x:17,y:19},{x:18,y:19}],
    {x:6,y:6}, {x:26,y:14},
    "#7a5a3a", "#d6c39a",
  );
}

// ── 3. Bazaar ────────────────────────────────────────────────────────────
// Open central plaza dotted with market-stall single-tile cover. Two narrow
// alleys lead to walled-off bombsite rooms east and west. Terracotta theme.
function bazaar(): GameMap {
  const b = new B();
  b.carve(1, 1, 31, 19);
  // Walled bombsite rooms with single openings
  b.fill(0, 3, 4, 17);  // west wall block
  b.carve(1, 4, 3, 16); // A room interior
  b.carve(4, 9, 4, 11); // doorway into A
  b.fill(28, 3, 32, 17); // east wall block
  b.carve(29, 4, 31, 16); // B room interior
  b.carve(28, 9, 28, 11); // doorway into B
  // Market stall cover — a scattered, semi-random feel
  const stalls: [number, number][] = [
    [8,4],[12,5],[18,4],[22,5],
    [7,8],[10,10],[14,8],[19,10],[23,8],[26,10],
    [9,12],[13,14],[17,12],[21,14],[25,12],
    [10,16],[16,16],[22,16],
    [16,6],[16,14],
  ];
  for (const [x, y] of stalls) b.wall(x, y);
  return b.done(
    "Bazaar",
    [{x:14,y:1},{x:15,y:1},{x:16,y:1},{x:17,y:1},{x:18,y:1}],
    [{x:14,y:19},{x:15,y:19},{x:16,y:19},{x:17,y:19},{x:18,y:19}],
    {x:2,y:10}, {x:30,y:10},
    "#8a4530", "#e6c8a0",
  );
}

// ── 4. Vault ─────────────────────────────────────────────────────────────
// Two heavily fortified bombsite rooms. Three approaches each: a main wide
// corridor, a side door, and a narrow flank. CT side is naturally closer to
// the rooms; T must commit to one before peeking. Cold steel palette.
function vault(): GameMap {
  const b = new B();
  // Spawn halls (top and bottom)
  b.carve(1, 1, 31, 4);
  b.carve(1, 16, 31, 19);
  // Two bombsite vaults flanking middle
  b.carve(3, 7, 10, 13);   // A vault
  b.carve(22, 7, 29, 13);  // B vault
  // Vault entrances (broken walls)
  b.carve(6, 4, 7, 6);   // A from CT top
  b.carve(6, 14, 7, 16); // A from T bottom
  b.carve(10, 9, 11, 11); // A side flank toward mid
  b.carve(25, 4, 26, 6);   // B from CT top
  b.carve(25, 14, 26, 16); // B from T bottom
  b.carve(21, 9, 22, 11); // B side flank toward mid
  // Mid lane — a single column connecting top hall to bottom hall
  b.carve(15, 4, 17, 16);
  // Cover inside each vault
  b.wall(5, 9); b.wall(8, 11);
  b.wall(24, 9); b.wall(27, 11);
  return b.done(
    "Vault",
    [{x:14,y:2},{x:15,y:2},{x:16,y:2},{x:17,y:2},{x:18,y:2}],
    [{x:14,y:18},{x:15,y:18},{x:16,y:18},{x:17,y:18},{x:18,y:18}],
    {x:6,y:10}, {x:26,y:10},
    "#3d4a5a", "#202730",
  );
}

// ── 5. Greenhouse ────────────────────────────────────────────────────────
// A grid of pillar cover across an open floorplan. Sites are large open
// rooms in the corners — no choke to defend, but plenty of cover lines.
// Mossy green theme.
function greenhouse(): GameMap {
  const b = new B();
  b.carve(1, 1, 31, 19);
  // Regular pillar grid (4-tile spacing), avoiding spawn zones
  for (let y = 4; y <= 16; y += 3) {
    for (let x = 4; x <= 28; x += 4) {
      // Leave a column gap near the verticals
      if (x === 16) continue;
      b.wall(x, y);
    }
  }
  // Two larger cover blobs in the corners (visual interest, AWP angles)
  b.fill(2, 5, 3, 6);    // near A
  b.fill(29, 14, 30, 15); // near B
  // Diagonal feeder walls — break dead-straight cross sightlines
  b.wall(8, 7); b.wall(9, 8);
  b.wall(24, 12); b.wall(23, 13);
  return b.done(
    "Greenhouse",
    [{x:14,y:1},{x:15,y:1},{x:16,y:1},{x:17,y:1},{x:18,y:1}],
    [{x:14,y:19},{x:15,y:19},{x:16,y:19},{x:17,y:19},{x:18,y:19}],
    {x:3,y:4}, {x:29,y:16},
    "#3a5a3d", "#1e2a1f",
  );
}

export function builtinMaps(): GameMap[] {
  return [crossfire(), aqueduct(), bazaar(), vault(), greenhouse()];
}
