// Roster helpers — Active Roster vs bench, and who leads. Pure and dependency-
// light (types only) so the sim, the transfer market, and the UI can all share
// them. A team owns up to ROSTER_MAX players; `activeIds` is the five who play.

import type { Player } from "../domain/types.ts";
import { STARTING_ELO, TEAM_SIZE, type UniverseTeam } from "./types.ts";

// Re-pick a team's Active 5 as its best-by-Elo (the rest are bench) and keep its
// rosterKey in sync with that lineup. Call after any roster change (signing,
// release, bench move). Consumers tolerate a stale activeIds (they filter to
// current members), so this is a convenience rather than a hard invariant.
export function refreshActiveRoster(team: UniverseTeam, elos: Record<string, number>): void {
  const sorted = [...team.playerIds].sort(
    (a, b) => (elos[b] ?? STARTING_ELO) - (elos[a] ?? STARTING_ELO) || a.localeCompare(b));
  team.activeIds = sorted.slice(0, TEAM_SIZE);
  team.rosterKey = [...team.activeIds].sort().join(",");
}

// Rostered players outside the Active 5 (filtered to current members).
export function benchOf(team: UniverseTeam): string[] {
  const members = new Set(team.playerIds);
  const active = new Set((team.activeIds ?? team.playerIds.slice(0, TEAM_SIZE)).filter(id => members.has(id)));
  return team.playerIds.filter(id => !active.has(id));
}

// The five who actually play on a given day: the managed Active Roster filtered
// to who's available, topped up from the rest of the available roster by Elo if
// any active member is missing. Returns up to TEAM_SIZE ids.
export function activeLineup(team: UniverseTeam, available: string[], elos: Record<string, number>): string[] {
  const availSet = new Set(available);
  const managed = (team.activeIds ?? team.playerIds).filter(id => availSet.has(id));
  if (managed.length >= TEAM_SIZE) return managed.slice(0, TEAM_SIZE);
  const fill = available
    .filter(id => !managed.includes(id))
    .sort((a, b) => (elos[b] ?? STARTING_ELO) - (elos[a] ?? STARTING_ELO));
  return [...managed, ...fill].slice(0, TEAM_SIZE);
}

// The in-game leader: the active-roster player with the highest IGL rating.
export function iglOf(team: UniverseTeam, byId: Map<string, Player>): Player | undefined {
  const active = (team.activeIds ?? team.playerIds.slice(0, TEAM_SIZE));
  let best: Player | undefined;
  let bestIgl = -Infinity;
  for (const id of active) {
    const p = byId.get(id);
    if (p && (p.stats.igl ?? 0) > bestIgl) { bestIgl = p.stats.igl ?? 0; best = p; }
  }
  return best;
}
