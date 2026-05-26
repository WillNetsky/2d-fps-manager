import type { GameMap, Vec2 } from "./types.ts";

// A single hand-built default map, seeded into the saved-map store on first run
// (see seedDefaultMaps in the editor) and used as the ultimate fallback when no
// saved maps exist. It is not a privileged "built-in" — once seeded it's an
// ordinary editable/removable saved map.
//
// 33x21 @ 29px. Built in the style of the player-edited maps: an OPEN floor
// with scattered pillar cover (not a choke), both bombsites pulled to the north
// (CT) half for CT-favoured travel, and a small central island that blocks the
// straight spawn-to-spawn sightline while leaving the flanks open to rotate
// around. The old built-ins left both spawns staring down the middle at each
// other — this keeps the spawns in place but kills that peek.

const W = 33;
const H = 21;
const TS = 29;

class B {
  walls: boolean[] = new Array(W * H).fill(true);
  carve(x1: number, y1: number, x2: number, y2: number) {
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++)
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++)
        if (x >= 0 && y >= 0 && x < W && y < H) this.walls[y * W + x] = false;
  }
  fill(x1: number, y1: number, x2: number, y2: number) {
    for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++)
      for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++)
        if (x >= 0 && y >= 0 && x < W && y < H) this.walls[y * W + x] = true;
  }
  wall(x: number, y: number) { if (x >= 0 && y >= 0 && x < W && y < H) this.walls[y * W + x] = true; }
  done(name: string, ctSpawns: Vec2[], tSpawns: Vec2[], A: Vec2, Bs: Vec2, wallColor: string, floorColor: string): GameMap {
    return {
      name, width: W, height: H, tileSize: TS, walls: this.walls, ctSpawns, tSpawns,
      bombsites: [{ id: "A", center: A, radius: 2.5 }, { id: "B", center: Bs, radius: 2.5 }],
      wallColor, floorColor,
    };
  }
}

function crossover(): GameMap {
  const b = new B();
  b.carve(1, 1, 31, 19); // open floor

  // Central island — a small hollow box that blocks the straight spawn-to-spawn
  // line (centre columns 14-18 are covered at y9-11) but leaves both flanks open
  // to rotate around. A nook is carved in its middle for cover variety.
  b.fill(13, 9, 19, 11);
  b.carve(15, 10, 17, 10);
  // Pillars flanking the island — mid-fight angles.
  b.wall(9, 10); b.wall(23, 10);
  b.wall(11, 8); b.wall(21, 8); b.wall(11, 12); b.wall(21, 12);

  // North half = CT side; bombsites with surrounding cover.
  b.wall(7, 6); b.fill(3, 4, 4, 4); b.wall(9, 4);   // A (west, ~5,5)
  b.wall(25, 6); b.fill(28, 4, 29, 4); b.wall(23, 4); // B (east, ~27,5)
  b.wall(16, 4);                                      // centre cover below CT spawn
  b.wall(13, 6); b.wall(19, 6);                       // site-approach angles

  // South half = T side; cover for the push up to the island and flanks.
  b.wall(7, 14); b.wall(25, 14);
  b.wall(11, 16); b.wall(16, 16); b.wall(21, 16);
  b.wall(5, 16); b.wall(27, 16);

  return b.done(
    "Crossover",
    [{ x: 14, y: 2 }, { x: 15, y: 2 }, { x: 16, y: 2 }, { x: 17, y: 2 }, { x: 18, y: 2 }],
    [{ x: 14, y: 18 }, { x: 15, y: 18 }, { x: 16, y: 18 }, { x: 17, y: 18 }, { x: 18, y: 18 }],
    { x: 5, y: 5 }, { x: 27, y: 5 },
    "#3f4654", "#1b1f27",
  );
}

// The default map(s). A single map today; an array so the seeder/fallbacks can
// stay map-count agnostic.
export function defaultMaps(): GameMap[] { return [crossover()]; }
export function defaultMap(): GameMap { return crossover(); }
