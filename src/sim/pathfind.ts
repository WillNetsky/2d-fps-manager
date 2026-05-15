import type { GameMap, Vec2 } from "../domain/types.ts";

// 8-direction A* on the grid. Returns waypoint *tile* coords (start excluded, goal included).
// Returns null if unreachable. Uses Octile heuristic.

interface Node {
  x: number; y: number;
  g: number; f: number;
  parent: Node | null;
}

const NEIGHBORS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

export function findPath(map: GameMap, start: Vec2, goal: Vec2): Vec2[] | null {
  const sx = Math.floor(start.x / map.tileSize);
  const sy = Math.floor(start.y / map.tileSize);
  const gx = Math.floor(goal.x / map.tileSize);
  const gy = Math.floor(goal.y / map.tileSize);

  if (sx === gx && sy === gy) return [];
  if (!inBounds(map, gx, gy) || map.walls[gy * map.width + gx]) {
    // Try to nudge goal to nearest walkable tile (Chebyshev radius 2).
    let best: { x: number; y: number; d: number } | null = null;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
      const nx = gx + dx, ny = gy + dy;
      if (!inBounds(map, nx, ny) || map.walls[ny * map.width + nx]) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      if (!best || d < best.d) best = { x: nx, y: ny, d };
    }
    if (!best) return null;
    return findPath(map, start, { x: (best.x + 0.5) * map.tileSize, y: (best.y + 0.5) * map.tileSize });
  }

  const open: Node[] = [];
  const startNode: Node = { x: sx, y: sy, g: 0, f: heuristic(sx, sy, gx, gy), parent: null };
  open.push(startNode);
  const closed = new Set<number>();
  const bestG = new Map<number, number>();
  bestG.set(sy * map.width + sx, 0);

  while (open.length) {
    // Pop lowest f (linear; small grid so fine).
    let bestIdx = 0;
    for (let i = 1; i < open.length; i++) if (open[i].f < open[bestIdx].f) bestIdx = i;
    const cur = open.splice(bestIdx, 1)[0];
    const key = cur.y * map.width + cur.x;
    if (closed.has(key)) continue;
    closed.add(key);

    if (cur.x === gx && cur.y === gy) {
      // Reconstruct
      const path: Vec2[] = [];
      let n: Node | null = cur;
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
      // Disallow diagonal corner-cutting through walls.
      if (dx !== 0 && dy !== 0) {
        if (map.walls[cur.y * map.width + nx]) continue;
        if (map.walls[ny * map.width + cur.x]) continue;
      }
      const nKey = ny * map.width + nx;
      if (closed.has(nKey)) continue;
      const g = cur.g + cost;
      const prev = bestG.get(nKey);
      if (prev !== undefined && prev <= g) continue;
      bestG.set(nKey, g);
      open.push({ x: nx, y: ny, g, f: g + heuristic(nx, ny, gx, gy), parent: cur });
    }
  }
  return null;
}

function inBounds(map: GameMap, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < map.width && y < map.height;
}

function heuristic(x: number, y: number, gx: number, gy: number): number {
  const dx = Math.abs(x - gx), dy = Math.abs(y - gy);
  return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy);
}
