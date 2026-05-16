import type { GameMap, Vec2 } from "../domain/types.ts";

// A chokepoint is a narrow open tile flanked by walls — the kind of spot
// you'd actually smoke / molly / push through. Detected purely from geometry.
export interface Choke {
  tile: Vec2;
  ctSide: Vec2 | null; // adjacent open tile closer to CT spawn
  tSide: Vec2 | null;  // adjacent open tile closer to T spawn
}

export interface MapAnalysis {
  chokes: Choke[];
  ctDist: number[]; // length = width*height; Infinity for unreachable
  tDist: number[];
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
  return { chokes, ctDist, tDist };
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
