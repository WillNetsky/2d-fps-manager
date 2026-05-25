import type { Player } from "../domain/types.ts";

// Relationship bounds (mirrors the -100..100 scale documented on Player).
const MAX_REL = 100;
const MIN_REL = -100;

// How much playing a match together moves two teammates' bond. Winning
// together builds chemistry faster than losing together, but shared losses
// still count — adversity bonds people too.
export const WIN_BOND = 5;
export const LOSS_BOND = 2;

// Bond at or above this is treated as a real friendship by matchmaking — these
// players will try to group up rather than be split across teams.
export const FRIEND_THRESHOLD = 40;

function clampRel(v: number): number {
  return Math.max(MIN_REL, Math.min(MAX_REL, v));
}

function bond(a: Player, b: Player, amount: number) {
  a.relationships[b.id] = clampRel((a.relationships[b.id] ?? 0) + amount);
  b.relationships[a.id] = clampRel((b.relationships[a.id] ?? 0) + amount);
}

function bondTeam(byId: Map<string, Player>, ids: string[], amount: number) {
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = byId.get(ids[i]);
      const b = byId.get(ids[j]);
      if (a && b) bond(a, b, amount);
    }
  }
}

// Update teammate relationships in-place after a completed match. Winners bond
// harder than losers; opponents are left unchanged for now.
export function applyMatchChemistry(
  players: Player[],
  winnerIds: string[],
  loserIds: string[],
) {
  const byId = new Map(players.map(p => [p.id, p] as const));
  bondTeam(byId, winnerIds, WIN_BOND);
  bondTeam(byId, loserIds, LOSS_BOND);
}
