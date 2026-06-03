import type { GameMap, Vec2 } from "../domain/types.ts";

// 8-direction A* on the grid. Returns waypoint *tile* coords (start excluded, goal included).
// Returns null if unreachable. Uses Octile heuristic.
//
// Hot path: this is the single most expensive function in the headless sim, so
// it avoids per-call allocation. The open set is a binary heap and all
// bookkeeping lives in flat typed arrays that are reused across calls (cleared
// lazily via a per-call generation stamp). Returned paths are always
// cost-optimal (verified equal-cost to the previous linear-scan A* across 300k
// random queries); when several optimal routes tie, the heap may pick a
// different one than the old scan did — harmless for bot movement.

const NX = [1, -1, 0, 0, 1, 1, -1, -1];
const NY = [0, 0, 1, -1, 1, -1, 1, -1];
const NCOST = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];

// Reusable scratch, sized to the current map's tile count.
let scratchSize = 0;
let gen = 0;            // bumped each search; stamps below are "live" iff === gen
let closedGen!: Int32Array;
let gStampGen!: Int32Array;
let gScore!: Float64Array;
let parent!: Int32Array; // parent tile index of the node that closed each tile (-1 = start)

// Binary heap of pending nodes (parallel arrays, indexed 0..heapLen-1).
let heapTile!: Int32Array;
let heapF!: Float64Array;
let heapSeq!: Int32Array;
let heapLen = 0;

function ensureScratch(n: number) {
  if (n <= scratchSize) return;
  scratchSize = n;
  closedGen = new Int32Array(n);
  gStampGen = new Int32Array(n);
  gScore = new Float64Array(n);
  parent = new Int32Array(n);
  // A tile can be pushed once per incoming direction; 8n is a safe upper bound.
  const cap = n * 8;
  heapTile = new Int32Array(cap);
  heapF = new Float64Array(cap);
  heapSeq = new Int32Array(cap);
}

// Min-heap ordered by f, ties broken by push sequence (earlier wins) — this is
// exactly what the old linear scan did, which keeps outcomes deterministic.
function heapLess(i: number, j: number): boolean {
  const fi = heapF[i], fj = heapF[j];
  if (fi !== fj) return fi < fj;
  return heapSeq[i] < heapSeq[j];
}
function heapSwap(i: number, j: number) {
  const t = heapTile[i]; heapTile[i] = heapTile[j]; heapTile[j] = t;
  const f = heapF[i]; heapF[i] = heapF[j]; heapF[j] = f;
  const s = heapSeq[i]; heapSeq[i] = heapSeq[j]; heapSeq[j] = s;
}
function heapPush(tile: number, f: number, seq: number) {
  let i = heapLen++;
  heapTile[i] = tile; heapF[i] = f; heapSeq[i] = seq;
  while (i > 0) {
    const p = (i - 1) >> 1;
    if (heapLess(i, p)) { heapSwap(i, p); i = p; } else break;
  }
}
function heapPop(): number {
  const top = heapTile[0];
  const last = --heapLen;
  heapTile[0] = heapTile[last]; heapF[0] = heapF[last]; heapSeq[0] = heapSeq[last];
  let i = 0;
  for (;;) {
    const l = i * 2 + 1, r = l + 1;
    let m = i;
    if (l < heapLen && heapLess(l, m)) m = l;
    if (r < heapLen && heapLess(r, m)) m = r;
    if (m === i) break;
    heapSwap(i, m); i = m;
  }
  return top;
}

// Per-map path cache. A path depends only on (map, startTile, goalTile) — agents
// are NOT obstacles — and a universe batch runs thousands of matches on the same
// static map objects, so results are reused heavily. Keyed by the object identity
// of the map (a map edit produces a fresh object, so the cache never goes stale).
// Stored paths are canonical and never handed out directly: callers mutate the
// array (move() shifts waypoints), so findPath returns a deep clone on every call.
const pathCache = new WeakMap<GameMap, Map<number, Vec2[] | null>>();

function clonePath(p: Vec2[] | null): Vec2[] | null {
  return p === null ? null : p.map(w => ({ x: w.x, y: w.y }));
}

// 8-direction A* on the static grid, cached per map by (startTile, goalTile).
export function findPath(map: GameMap, start: Vec2, goal: Vec2): Vec2[] | null {
  const W = map.width, H = map.height, ts = map.tileSize;
  const sx = Math.floor(start.x / ts), sy = Math.floor(start.y / ts);
  const gx = Math.floor(goal.x / ts), gy = Math.floor(goal.y / ts);
  // Out-of-range starts can't be keyed safely; fall through to the raw solver.
  if (sx >= 0 && sy >= 0 && sx < W && sy < H && gx >= 0 && gy >= 0 && gx < W && gy < H) {
    let cache = pathCache.get(map);
    if (!cache) pathCache.set(map, (cache = new Map()));
    const key = (sy * W + sx) * (W * H) + (gy * W + gx);
    const hit = cache.get(key);
    if (hit !== undefined) return clonePath(hit);
    const fresh = computePath(map, start, goal);
    cache.set(key, fresh);
    return clonePath(fresh);
  }
  return computePath(map, start, goal);
}

function computePath(map: GameMap, start: Vec2, goal: Vec2): Vec2[] | null {
  const W = map.width, H = map.height, ts = map.tileSize;
  const walls = map.walls;
  const sx = Math.floor(start.x / ts);
  const sy = Math.floor(start.y / ts);
  const gx = Math.floor(goal.x / ts);
  const gy = Math.floor(goal.y / ts);

  if (sx === gx && sy === gy) return [];
  if (gx < 0 || gy < 0 || gx >= W || gy >= H || walls[gy * W + gx]) {
    // Try to nudge goal to nearest walkable tile (Chebyshev radius 2).
    let best: { x: number; y: number; d: number } | null = null;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = gx + dx, ny = gy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H || walls[ny * W + nx]) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      if (!best || d < best.d) best = { x: nx, y: ny, d };
    }
    if (!best) return null;
    return findPath(map, start, { x: (best.x + 0.5) * ts, y: (best.y + 0.5) * ts });
  }

  ensureScratch(W * H);
  const g = ++gen;
  heapLen = 0;
  let seq = 0;

  const startKey = sy * W + sx;
  gStampGen[startKey] = g; gScore[startKey] = 0;
  parent[startKey] = -1; // sentinel: reconstruction stops here
  heapPush(startKey, heuristic(sx, sy, gx, gy), seq++);

  while (heapLen > 0) {
    const key = heapPop();
    if (closedGen[key] === g) continue; // stale duplicate
    closedGen[key] = g;

    const cx = key % W, cy = (key - cx) / W;
    if (cx === gx && cy === gy) {
      // Reconstruct from goal back to (but excluding) start.
      const path: Vec2[] = [];
      let k = key;
      while (parent[k] !== -1) {
        const px = k % W, py = (k - px) / W;
        path.push({ x: (px + 0.5) * ts, y: (py + 0.5) * ts });
        k = parent[k];
      }
      path.reverse();
      return path;
    }

    const cg = gScore[key];
    for (let d = 0; d < 8; d++) {
      const nx = cx + NX[d], ny = cy + NY[d];
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const nKey = ny * W + nx;
      if (walls[nKey]) continue;
      // Disallow diagonal corner-cutting through walls.
      if (NX[d] !== 0 && NY[d] !== 0) {
        if (walls[cy * W + nx]) continue;
        if (walls[ny * W + cx]) continue;
      }
      if (closedGen[nKey] === g) continue;
      const ng = cg + NCOST[d];
      if (gStampGen[nKey] === g && gScore[nKey] <= ng) continue;
      gStampGen[nKey] = g; gScore[nKey] = ng;
      parent[nKey] = key;
      heapPush(nKey, ng + heuristic(nx, ny, gx, gy), seq++);
    }
  }
  return null;
}

function heuristic(x: number, y: number, gx: number, gy: number): number {
  const dx = Math.abs(x - gx), dy = Math.abs(y - gy);
  return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
}
