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
  // Active end-of-season playoffs, present only while season.phase === "playoffs".
  // Cleared back to null/undefined when the playoffs finish and the next regular
  // season begins.
  playoffs?: PlayoffState | null;
}

// Which part of the season calendar we're in. Regular season builds standings;
// playoffs are the dedicated knockout days that crown the champion.
export type SeasonPhase = "regular" | "playoffs";

// End-of-season playoffs across every region that qualified. Each region runs its
// own bracket; a playoff "day" plays one round from every region still going.
export interface PlayoffState {
  season: number;                           // the season these playoffs decide
  day: number;                              // 1-based playoff day index
  regions: RegionPlayoff[];
}

export type PlayoffStage = "swiss" | "bracket" | "done";

// One region's playoff run: an optional Swiss group stage that whittles entrants
// down to the bracket cut, then a single-elimination bracket to the title.
export interface RegionPlayoff {
  region: Region;
  stage: PlayoffStage;
  entrants: PlayoffEntrant[];               // seed order (seed 1 first)
  swissRound: number;                       // 1-based Swiss round (next to play)
  swissTarget: number;                      // wins to advance / losses to drop (e.g. 3)
  bracket: BracketMatch[];                  // single-elim matches (all rounds, filled in)
  bracketRound: number;                     // 1-based current bracket round
  championTeamId?: string;
  skippedSwiss?: boolean;                   // true when too few teams for a Swiss stage
}

// A team in a region's playoff, with its live Swiss record.
export interface PlayoffEntrant {
  teamId: string;
  seed: number;                             // 1..N from final regular-season standing
  wins: number;                             // Swiss wins
  losses: number;                           // Swiss losses
  status: "active" | "advanced" | "eliminated";
  oppIds: string[];                         // Swiss opponents faced (rematch avoidance)
}

// One single-elimination match. Team ids fill in as prior rounds resolve; the
// winner advances to (round+1, floor(slot/2)).
export interface BracketMatch {
  round: number;                            // 1 = first knockout round
  slot: number;                             // position within the round (0-based)
  aTeamId?: string;
  bTeamId?: string;
  winnerTeamId?: string;
  // The matchup id (within the playoff day) that decided this match, for replay.
  matchupId?: string;
}

// A competitive season: a fixed-length window of days. Regular-season standings
// are the teams' season records (see UniverseTeam.season*); at day
// startDay+length the season rolls over — champions are recorded and counters
// reset. The unit Phase 3 playoffs will seed from.
export interface Season {
  number: number;                           // 1-based season index
  startDay: number;                         // day the regular season began (inclusive)
  length: number;                           // regular-season days per season
  phase?: SeasonPhase;                      // "regular" (default) | "playoffs"
}

// One region's winner for one completed season. With playoffs, the champion is
// the team that won the region's knockout bracket; the regular-season leader is
// recorded separately as the #1 seed / regular-season title holder.
export interface SeasonChampion {
  season: number;
  region: Region;
  teamId: string;
  teamName: string;
  wins: number;                             // record shown next to the title
  losses: number;
  // Regular-season leader (top seed) when playoffs decided the title and it
  // differs from the playoff champion. Display only.
  regularSeasonLeaderId?: string;
  regularSeasonLeaderName?: string;
}

// Links a playoff matchup back to its place in the tournament so results advance
// the right region/stage/round/slot.
export interface PlayoffMatchTag {
  stage: PlayoffStage;                      // "swiss" | "bracket"
  round: number;                            // round within that stage (1-based)
  slot: number;                             // pairing/match index within the round
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
  // Set when this matchup is a playoff game, so its result maps back to the
  // tournament. `region` (above) identifies which region's playoff.
  playoff?: PlayoffMatchTag;
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

// Playoff sizing. A region with >= SWISS_FIELD ranked teams runs a Swiss stage
// (SWISS_TARGET wins to advance / losses to drop) that cuts to BRACKET_FIELD,
// then a single-elimination bracket. Smaller fields skip Swiss and seed a
// power-of-two bracket directly (see startPlayoffs).
export const SWISS_FIELD = 16;
export const SWISS_TARGET = 3;
export const BRACKET_FIELD = 8;

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
