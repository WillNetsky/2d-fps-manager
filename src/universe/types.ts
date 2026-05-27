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
  // Persistent named teams. A team crystallizes when a full 5-man friend-stack
  // forms (see crystallizeTeams) and then carries its identity, roster, elo, and
  // win/loss record across days — the foundation for standings and tournaments.
  // Absent on saves predating persistent teams; created lazily on the next sim.
  teams?: UniverseTeam[];
  // Current competitive season. Each season is a fixed window of days; team
  // season records accrue within it and reset at rollover. Absent on saves
  // predating seasons; initialized lazily (season 1 starting on the current day).
  season?: Season;
  // Bounded log of past season winners per region (most recent last). Powers the
  // champions history and, later, playoff seeding. Trimmed to CHAMPIONS_LOG_MAX.
  champions?: SeasonChampion[];
}

// A competitive season: a fixed-length window of days. Regular-season standings
// are the teams' season records (see UniverseTeam.season*); at day
// startDay+length the season rolls over — champions are recorded and counters
// reset. The unit Phase 3 playoffs will seed from.
export interface Season {
  number: number;                           // 1-based season index
  startDay: number;                         // day the season began (inclusive)
  length: number;                           // days per season
}

// One region's winner for one completed season — the top of that region's
// regular-season table at rollover.
export interface SeasonChampion {
  season: number;
  region: Region;
  teamId: string;
  teamName: string;
  wins: number;
  losses: number;
}

// A persistent, named team: a full 5-man friend-stack that has crystallized into
// a tracked org. Identity is stable across days via `id`; `rosterKey` (sorted
// player ids) is how a re-formed identical stack is matched back to its team.
export interface UniverseTeam {
  id: string;
  name: string;
  region: Region;
  playerIds: string[];                      // current 5-man roster
  rosterKey: string;                        // sorted playerIds joined — identity match
  elo: number;                              // team elo (avg of roster at last update)
  foundedDay: number;
  lastPlayedDay: number;
  // Lifetime team record (matches/series won, not individual rounds).
  wins: number;
  losses: number;
  roundsWon: number;
  roundsLost: number;
  // Current win/loss streak: positive = consecutive wins, negative = losses.
  streak: number;
  // Current-season record — same tallies as above but reset at each season
  // rollover. Drives the regular-season standings table. Absent on teams from
  // saves predating seasons; treated as 0 until they next play.
  seasonWins?: number;
  seasonLosses?: number;
  seasonRoundsWon?: number;
  seasonRoundsLost?: number;
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
  // Persistent-team ids for each side, set when that side fielded a full
  // crystallized 5-man (see UniverseTeam). Absent for pickup/scrim lobbies whose
  // sides aren't tracked orgs. A matchup with both set is a ranked team result.
  ctTeamId?: string;
  tTeamId?: string;
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

// Days per competitive season. A season is the regular-season window whose final
// standings (later) seed playoffs. 30 days ≈ a meaty but finite campaign.
export const SEASON_LENGTH = 30;
// Cap on the champions log so season history doesn't grow without bound.
export const CHAMPIONS_LOG_MAX = 120;

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
