import type { GameMap, Player } from "../domain/types.ts";
import type { Region } from "../domain/countries.ts";

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
  // Recent completed days, kept for replay + the per-player game log. Bounded
  // to the last HISTORY_DAYS so storage doesn't grow without limit; older days
  // are folded into `careers` before being dropped.
  history: CompletedDay[];
  pendingDay: PendingDay | null;            // in-progress day (if any)
  // Running per-player career totals (playerId -> aggregate). The source of
  // truth for lifetime stats — every completed matchup is folded in exactly
  // once, so career figures survive history trimming. Absent on pre-aggregate
  // saves; rebuilt from history on load.
  careers?: Record<string, CareerStats>;
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
  // Competitive region this lobby was drawn from (e.g. "EU"). Optional for
  // legacy matchups generated before region-based matchmaking existed.
  region?: Region;
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

// Lifetime per-player totals, accumulated one completed matchup at a time.
// Mirrors what the old full-history scan produced, so display code reads the
// same numbers without replaying every match ever played.
export interface CareerStats {
  played: number;
  wins: number;
  losses: number;
  roundsWon: number;
  roundsLost: number;
  matchesWithStats: number;                 // matches that carried playerStats
  kills: number;
  deaths: number;
  assists: number;
  damage: number;
  rounds: number;
  k1: number; k2: number; k3: number; k4: number; k5: number;
  // Clutch tallies bucketed by 1vX; index i corresponds to 1v(i+1).
  clutchWins: number[];                     // length 5
  clutchAttempts: number[];                 // length 5
}

export const STARTING_ELO = 1000;
// A larger pool so each competitive region can field several full lobbies a
// day. Matchmaking partitions by region, so most of these are EU/CIS players.
export const PLAYER_COUNT = 400;
export const TEAM_SIZE = 5;
