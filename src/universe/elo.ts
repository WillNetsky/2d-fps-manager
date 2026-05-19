import { STARTING_ELO } from "./types.ts";

const K = 32;
const SCALE = 400;

export function expectedScore(a: number, b: number): number {
  return 1 / (1 + 10 ** ((b - a) / SCALE));
}

export function teamElo(playerIds: string[], elos: Record<string, number>): number {
  if (playerIds.length === 0) return STARTING_ELO;
  let sum = 0;
  for (const id of playerIds) sum += elos[id] ?? STARTING_ELO;
  return sum / playerIds.length;
}

// Apply elo deltas in-place: each player on the winning side gains, each on the
// losing side loses, scaled by the team rating gap.
export function applyMatchElo(
  winnerIds: string[],
  loserIds: string[],
  elos: Record<string, number>,
): void {
  const wT = teamElo(winnerIds, elos);
  const lT = teamElo(loserIds, elos);
  const wExp = expectedScore(wT, lT);
  const wDelta = K * (1 - wExp);
  const lDelta = K * (0 - (1 - wExp));
  for (const id of winnerIds) elos[id] = (elos[id] ?? STARTING_ELO) + wDelta;
  for (const id of loserIds)  elos[id] = (elos[id] ?? STARTING_ELO) + lDelta;
}
