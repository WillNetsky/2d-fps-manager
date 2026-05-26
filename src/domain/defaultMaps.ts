import type { GameMap, Vec2 } from "./types.ts";

// A single hand-built default map, seeded into the saved-map store on first run
// (see seedDefaultMaps in the editor) and used as the ultimate fallback when no
// saved maps exist. It is not a privileged "built-in" — once seeded it's an
// ordinary editable/removable saved map.
//
// 33x21 @ 29px. The lesson from the old built-ins: spawning both teams in the
// same centre columns left them staring straight down the middle at each other.
// Here a full-width divider with OFFSET lanes breaks every spawn-to-spawn
// sightline, and both bombsites sit on the north (CT) half so CTs reach them
// faster than Ts — the CT-favoured travel the maps should have.

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

function junction(): GameMap {
  const b = new B();
  b.carve(1, 1, 31, 19); // open floor

  // Central divider: a full-width wall band with four OFFSET crossing lanes.
  // The centre columns (14-18) stay solid, so no spawn column has a straight
  // line to the opposing spawn.
  b.fill(1, 9, 31, 11);
  b.carve(2, 9, 5, 11);    // far-west lane
  b.carve(11, 9, 13, 11);  // mid-west lane
  b.carve(19, 9, 21, 11);  // mid-east lane
  b.carve(27, 9, 30, 11);  // far-east lane

  // North half = CT side; bombsites tucked into the corners with cover.
  // A site (west)
  b.wall(4, 3); b.wall(7, 6); b.fill(2, 7, 3, 7);
  // B site (east)
  b.wall(28, 3); b.wall(25, 6); b.fill(29, 7, 30, 7);
  // Mid cover just north of the divider so lane exits aren't a straight gauntlet.
  b.wall(11, 7); b.wall(21, 7); b.fill(15, 6, 17, 6);

  // South half = T side; cover for the approach up to the lanes.
  b.wall(8, 14); b.wall(24, 14); b.fill(15, 15, 17, 15);
  b.wall(11, 17); b.wall(21, 17);

  return b.done(
    "Junction",
    [{ x: 14, y: 2 }, { x: 15, y: 2 }, { x: 16, y: 2 }, { x: 17, y: 2 }, { x: 18, y: 2 }],
    [{ x: 14, y: 18 }, { x: 15, y: 18 }, { x: 16, y: 18 }, { x: 17, y: 18 }, { x: 18, y: 18 }],
    { x: 5, y: 5 }, { x: 27, y: 5 },
    "#454b56", "#16191f",
  );
}

// The default map(s). A single map today; an array so the seeder/fallbacks can
// stay map-count agnostic.
export function defaultMaps(): GameMap[] { return [junction()]; }
export function defaultMap(): GameMap { return junction(); }
