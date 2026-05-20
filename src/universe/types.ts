import type { GameMap, Player } from "../domain/types.ts";

export interface UniverseSummary {
  id: string;
  name: string;
  day: number;
  createdAt: number;
}

export interface Universe {
  id: string;
  name: string;
  createdAt: number;
  day: number;                              // current day index (1-based)
  players: Player[];                        // pool of players
  elos: Record<string, number>;             // playerId -> elo
  history: CompletedDay[];                  // all past days
  pendingDay: PendingDay | null;            // in-progress day (if any)
  // Rotation pool of map snapshots. Every match picks one (currently at
  // random); the index is stored on the matchup so replays land on the same
  // map deterministically. Always has length ≥ 1 while a universe is live.
  maps?: GameMap[];
  // Legacy single-map field — kept for back-compat with universes saved
  // before the rotation pool existed. On load it's migrated into maps[0].
  map?: GameMap;
}

export interface PendingDay {
  day: number;
  matchups: Matchup[];                      // each Matchup tracks its own status
}

export interface Matchup {
  id: string;
  ctPlayerIds: string[];                    // 5 player ids
  tPlayerIds: string[];                     // 5 player ids
  status: "pending" | "completed";
  ctScore?: number;
  tScore?: number;
  winnerSide?: "CT" | "T";
  clutches?: Clutch[];                      // clutches won during this match
  playerStats?: Record<string, PlayerMatchStats>;
  // Master RNG seed used to simulate the match. Lets us deterministically
  // replay the match (or jump to any round) without storing the event stream.
  seed?: number;
  // Absolute elo delta applied to each player at the end of this match.
  // Sign depends on side: winning side gains, losing side loses by the same
  // amount. Recorded so the post-match card can show original elo + ±delta.
  eloDelta?: number;
  // Index into Universe.maps for the map this matchup is played on. Defaults
  // to 0 for legacy matchups generated before the rotation pool existed.
  mapIndex?: number;
}

export interface Clutch {
  playerId: string;
  kills: number;                            // kills the player got while last alive
  // X in 1vX: enemies remaining at the moment they became the last survivor.
  // Optional for legacy saves predating opportunity tracking; fall back to
  // `kills` (which matches won-clutch math when they killed all enemies).
  enemiesAtStart?: number;
  // false = clutch opportunity that wasn't converted (player died/round lost).
  // Legacy saves only stored won clutches → treat undefined as true.
  won?: boolean;
  round?: number;                           // round number (1-based) the clutch happened in
}

export interface PlayerMatchStats {
  kills: number;
  deaths: number;
  assists: number;
  damage: number;
  roundsPlayed: number;
  // Rounds in which the player got exactly N kills (for HLTV 1.0 rating).
  k1: number; k2: number; k3: number; k4: number; k5: number;
}

export interface CompletedDay {
  day: number;
  matchups: Matchup[];                      // all status: "completed"
}

export const STARTING_ELO = 1000;
export const PLAYER_COUNT = 100;
export const TEAM_SIZE = 5;
export const MATCHUPS_PER_DAY = PLAYER_COUNT / (TEAM_SIZE * 2);
