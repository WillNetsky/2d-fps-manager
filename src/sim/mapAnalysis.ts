import type { GameMap, Vec2 } from "../domain/types.ts";

// A chokepoint is a narrow open tile flanked by walls — the kind of spot
// you'd actually smoke / molly / push through. Detected purely from geometry.
export interface Choke {
  tile: Vec2;
  ctSide: Vec2 | null; // adjacent open tile closer to CT spawn
  tSide: Vec2 | null;  // adjacent open tile closer to T spawn
}

// Named CT hold positions, derived from chokes + BFS distances. Each map gets:
//   - One `anchor` per site (the plate itself — last fallback).
//   - One `choke` per site (most-forward chokepoint between CT spawn and site).
//   - Optional `flank` per site (a second, geometrically distinct choke).
//   - One or two mid points (chokes that don't strongly belong to either site).
export type HoldRole = "anchor" | "choke" | "flank" | "mid-info" | "mid-aggro";
export interface HoldPoint {
  id: string;
  role: HoldRole;
  region: "A" | "B" | "mid";
  tile: Vec2;
}

export interface MapAnalysis {
  chokes: Choke[];
  ctDist: number[]; // length = width*height; Infinity for unreachable
  tDist: number[];
  holdPoints: { A: HoldPoint[]; B: HoldPoint[]; mid: HoldPoint[] };
}

const N4: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const N8: [number, number][] = [...N4, [1, 1], [-1, 1], [1, -1], [-1, -1]];

export function analyzeMap(map: GameMap): MapAnalysis {
  const W = map.width, H = map.height;
  const ctDist = bfs(map, map.ctSpawns);
  const tDist = bfs(map, map.tSpawns);
  const chokes: Choke[] = [];

  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const idx = y * W + x;
      if (map.walls[idx]) continue;
      // Must be reachable from both spawns to be a meaningful choke.
      if (!isFinite(ctDist[idx]) || !isFinite(tDist[idx])) continue;

      // 5+ walls in the 3x3 neighborhood = constrained passage.
      let wallCount = 0;
      for (const [dx, dy] of N8) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) wallCount++;
        else if (map.walls[ny * W + nx]) wallCount++;
      }
      if (wallCount < 5) continue;

      // Find the open 4-neighbors and pick which is "toward CT" vs "toward T".
      let ctSide: Vec2 | null = null, tSide: Vec2 | null = null;
      let ctSideD = Infinity, tSideD = Infinity;
      for (const [dx, dy] of N4) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        if (map.walls[ny * W + nx]) continue;
        const nIdx = ny * W + nx;
        if (ctDist[nIdx] < ctSideD) { ctSideD = ctDist[nIdx]; ctSide = { x: nx, y: ny }; }
        if (tDist[nIdx] < tSideD)   { tSideD  = tDist[nIdx];  tSide  = { x: nx, y: ny }; }
      }
      // Need at least one open neighbor.
      if (!ctSide && !tSide) continue;
      chokes.push({ tile: { x, y }, ctSide, tSide });
    }
  }
  const holdPoints = deriveHoldPoints(map, chokes, ctDist);
  return { chokes, ctDist, tDist, holdPoints };
}

// Classify each choke by which site it "belongs to" using BFS distance from
// each bombsite. A choke much closer to A than B is an A-region hold; one with
// similar distances to both is a mid hold.
function deriveHoldPoints(
  map: GameMap,
  chokes: Choke[],
  ctDist: number[],
): { A: HoldPoint[]; B: HoldPoint[]; mid: HoldPoint[] } {
  const W = map.width;
  const out: { A: HoldPoint[]; B: HoldPoint[]; mid: HoldPoint[] } = { A: [], B: [], mid: [] };
  const siteA = map.bombsites.find(s => s.id === "A");
  const siteB = map.bombsites.find(s => s.id === "B");

  // Anchor: bombsite center is the last-fallback hold.
  if (siteA) out.A.push({ id: "A-anchor", role: "anchor", region: "A", tile: siteA.center });
  if (siteB) out.B.push({ id: "B-anchor", role: "anchor", region: "B", tile: siteB.center });

  if (!siteA || !siteB) return out;

  const aDist = bfs(map, [siteA.center]);
  const bDist = bfs(map, [siteB.center]);

  type Tagged = { choke: Choke; aD: number; bD: number; ctD: number };
  const tagged: Tagged[] = [];
  for (const c of chokes) {
    const idx = c.tile.y * W + c.tile.x;
    const aD = aDist[idx], bD = bDist[idx], ctD = ctDist[idx];
    if (!isFinite(aD) || !isFinite(bD) || !isFinite(ctD)) continue;
    tagged.push({ choke: c, aD, bD, ctD });
  }

  // Per-site forward choke: choke that's clearly closer to this site than the
  // other, with the *largest* CT-distance (most-forward against T entry).
  const aRegion = tagged.filter(t => t.aD < t.bD * 0.7).sort((x, y) => y.ctD - x.ctD);
  const bRegion = tagged.filter(t => t.bD < t.aD * 0.7).sort((x, y) => y.ctD - x.ctD);

  const addRegion = (
    list: Tagged[],
    region: "A" | "B",
    bucket: HoldPoint[],
  ) => {
    if (list.length === 0) return;
    const primary = list[0];
    bucket.push({ id: `${region}-choke`, role: "choke", region, tile: primary.choke.tile });
    // Flank: next entry that's geometrically distinct (>3 tiles apart).
    for (let i = 1; i < list.length; i++) {
      const t = list[i];
      const dx = t.choke.tile.x - primary.choke.tile.x;
      const dy = t.choke.tile.y - primary.choke.tile.y;
      if (dx * dx + dy * dy > 9) {
        bucket.push({ id: `${region}-flank`, role: "flank", region, tile: t.choke.tile });
        break;
      }
    }
  };
  addRegion(aRegion, "A", out.A);
  addRegion(bRegion, "B", out.B);

  // Mid: chokes with comparable distance to both sites (within ~30%).
  const midRegion = tagged.filter(t => {
    const lo = Math.min(t.aD, t.bD), hi = Math.max(t.aD, t.bD);
    return hi > 0 && lo / hi >= 0.7;
  });
  if (midRegion.length > 0) {
    const cx = (map.width - 1) / 2, cy = (map.height - 1) / 2;
    const byCenter = midRegion.slice().sort((x, y) => {
      const dx1 = x.choke.tile.x - cx, dy1 = x.choke.tile.y - cy;
      const dx2 = y.choke.tile.x - cx, dy2 = y.choke.tile.y - cy;
      return dx1 * dx1 + dy1 * dy1 - (dx2 * dx2 + dy2 * dy2);
    });
    out.mid.push({ id: "mid-info", role: "mid-info", region: "mid", tile: byCenter[0].choke.tile });
    // Aggro mid: most-forward mid choke if it's geometrically distinct.
    const byForward = midRegion.slice().sort((x, y) => y.ctD - x.ctD);
    const top = byForward[0];
    if (top !== byCenter[0]) {
      const dx = top.choke.tile.x - byCenter[0].choke.tile.x;
      const dy = top.choke.tile.y - byCenter[0].choke.tile.y;
      if (dx * dx + dy * dy > 9) {
        out.mid.push({ id: "mid-aggro", role: "mid-aggro", region: "mid", tile: top.choke.tile });
      }
    }
  }
  return out;
}

function bfs(map: GameMap, sources: Vec2[]): number[] {
  const W = map.width, H = map.height;
  const dist = new Array<number>(W * H).fill(Infinity);
  const queue: Vec2[] = [];
  for (const s of sources) {
    if (s.x < 0 || s.y < 0 || s.x >= W || s.y >= H) continue;
    if (map.walls[s.y * W + s.x]) continue;
    if (dist[s.y * W + s.x] === Infinity) {
      dist[s.y * W + s.x] = 0;
      queue.push({ x: s.x, y: s.y });
    }
  }
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++];
    const d = dist[cur.y * W + cur.x];
    for (const [dx, dy] of N4) {
      const nx = cur.x + dx, ny = cur.y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (map.walls[ny * W + nx]) continue;
      const nIdx = ny * W + nx;
      if (dist[nIdx] > d + 1) {
        dist[nIdx] = d + 1;
        queue.push({ x: nx, y: ny });
      }
    }
  }
  return dist;
}
