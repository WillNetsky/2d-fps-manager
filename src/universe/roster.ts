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

// Snapshot of who's on the roster and in the active 5, taken BEFORE a membership
// change so syncActiveRoster can tell genuine bench/promote moves apart from the
// signing/departure that triggered them.
export interface RosterSnapshot { members: Set<string>; active: Set<string>; }
export function rosterSnapshot(team: UniverseTeam): RosterSnapshot {
  return {
    members: new Set(team.playerIds),
    active: new Set(team.activeIds ?? team.playerIds.slice(0, TEAM_SIZE)),
  };
}

// Re-pick the active 5 (see refreshActiveRoster) and report who moved between the
// bench and the active roster — counting only players who were ALREADY on the
// roster before the change, so a brand-new signing isn't reported as a promotion
// and a departed player isn't reported as benched. Pass the pre-change snapshot.
export function syncActiveRoster(
  team: UniverseTeam, elos: Record<string, number>, before: RosterSnapshot,
): { benched: string[]; promoted: string[] } {
  refreshActiveRoster(team, elos);
  const nowActive = new Set(team.activeIds ?? []);
  const members = new Set(team.playerIds);
  const benched = [...before.active].filter(id => members.has(id) && !nowActive.has(id));
  const promoted = [...nowActive].filter(id => before.members.has(id) && !before.active.has(id));
  return { benched, promoted };
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
