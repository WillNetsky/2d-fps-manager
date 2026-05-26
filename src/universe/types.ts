import type { GameMap, Player } from "../domain/types.ts";
import { REGION_ORDER, type Region } from "../domain/countries.ts";

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
  // Friend-stacks (player-id groups of 2+ that queued together) present in this
  // lobby — one per team at most. Used to mark grouped players on the board.
  parties?: string[][];
  // Series length: 1 (or absent) = single match, 3 = Bo3, 5 = Bo5. A series is
  // the same two teams playing multiple games. For a series, the matchup's
  // top-level winnerSide / ctScore / tScore hold the SERIES result (games won,
  // e.g. 2-1) and the per-game detail lives in `games`; the top-level
  // seed / mapIndex / clutches / playerStats are unused (they live per game).
  bestOf?: 1 | 3 | 5;
  games?: GameResult[];
  // The pick/ban veto that chose this series' maps, in order. Recorded for the
  // box-score display; the resulting map order is reflected in `games`.
  veto?: VetoStep[];
  // For a Bo1: each participating player's morale at sim time, snapshotted so a
  // replay reproduces the exact match (the sim seeds in-match mood from morale,
  // which drifts day to day). Series store this per game instead.
  moods?: Record<string, number>;
}

// One step of a series map veto. `side` is which side of the matchup acted.
export interface VetoStep {
  side: "CT" | "T";
  action: "ban" | "pick" | "decider";
  mapIndex: number;
}

// One game within a series. Carries its own seed and map so it replays
// deterministically, exactly like a single Bo1 match does today.
export interface GameResult {
  seed: number;
  mapIndex: number;
  ctScore: number;                          // rounds won
  tScore: number;
  winnerSide: "CT" | "T";
  clutches: Clutch[];
  playerStats: Record<string, PlayerMatchStats>;
  // Each participating player's morale at sim time (see Matchup.moods).
  moods: Record<string, number>;
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
// Default players per region on the New Universe screen (the user can dial this
// up or down). Each region gets its own pool so every competitive scene can
// field many full lobbies a day. The sim runs off-thread and the roster/career
// tables are virtualized, so a full 1000/region (6k players) stays responsive.
export const PLAYERS_PER_REGION = 1000;
// Upper guard for the setup input — prevents runaway player generation from a typo.
export const MAX_PLAYERS_PER_REGION = 2000;
export const PLAYER_COUNT = PLAYERS_PER_REGION * REGION_ORDER.length;
export const TEAM_SIZE = 5;
