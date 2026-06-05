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
  // Parallel lifetime aggregate counting ONLY tournament (playoff) matches, so
  // the career screen can filter to event games. Folded alongside `careers` at
  // sim time. Absent on saves predating it; backfilled from the retained history
  // window on load (older events outside the window can't be reconstructed) and
  // complete from there forward.
  eventCareers?: Record<string, CareerStats>;
  // Recent transfers (most recent last), bounded to TRANSFERS_LOG_MAX. Populated
  // by the post-event transfer window; drives the Market screen's activity list.
  transfers?: TransferRecord[];
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
  // Recurring full-5 friend cliques accruing commitment toward org status. A
  // stack is promoted out of this list into `teams` once it clears the gate.
  // Absent on saves predating the stack→org phase; created lazily.
  stacks?: ProvisionalStack[];
  // The tournament currently running, if any (reuses the bracket engine that used
  // to drive end-of-season playoffs). Null/absent between events. Seeded by world
  // ranking, runs concurrently with the daily ladder, and pays out prize money +
  // ranking points when it finishes.
  playoffs?: PlayoffState | null;
  // Tournament-circuit scheduler: counts down to the next event and tracks the
  // calendar so the world ages between events. Absent on saves predating the
  // circuit; created lazily.
  circuit?: Circuit;
  // Log of past tournament winners (most recent last), bounded to TITLES_LOG_MAX.
  // The trophy record that replaced per-season champions.
  titles?: TournamentTitle[];
  // Per-year per-player career aggregates: calendar year -> playerId -> totals.
  // Parallels `careers` (lifetime) but bucketed by year (a pure function of the
  // day, so it backfills cleanly from history) for the player page's year-by-year
  // breakdown. Trimmed to YEAR_STATS_KEEP most-recent years to stay bounded.
  yearStats?: Record<number, Record<string, CareerStats>>;
}

// Tournament-circuit scheduler. A tournament starts when `daysUntilNext` reaches
// zero (and none is running), then `EVENT_INTERVAL_DAYS` is set again on finish.
// Player aging/retirement runs once per calendar year, deferred until no event is
// in progress so a bracket's rosters never change mid-tournament.
export interface Circuit {
  nextEventId: number;        // monotonic id for naming events
  daysUntilNext: number;      // days until the next tournament starts
  lastLifecycleYear: number;  // last calendar year the world aged through
  nextMajorId?: number;       // monotonic id for naming Majors (absent → 1)
}

// The standout player of a finished tournament — captured at finish time (when
// the bracket's match stats are still in the retained history).
export interface TitleMvp {
  playerId: string;
  handle: string;
  country?: string;
  teamId?: string;            // the org they played for in the event
  teamName?: string;
  rating: number;             // aggregate HLTV 1.0 across the event
  kills: number;
  deaths: number;
  adr: number;
}

// One completed tournament's headline result — the trophy-cabinet record.
export interface TournamentTitle {
  eventId: number;
  name: string;               // e.g. "EU Circuit #3" or "Major #2"
  intl?: boolean;             // a Major (international): the marquee title
  region: Region;
  mvp?: TitleMvp;             // standout player (absent on saves predating MVPs)
  day: number;                // day the final concluded
  championTeamId: string;
  championName: string;
  runnerUpTeamId?: string;
  runnerUpName?: string;
  prize: number;              // champion's prize money (display only)
}

// One transfer executed in a market window: a player signing for an org, either
// poached from another org (fromTeamId set, fee paid) or picked up as a free
// agent (no fromTeamId, fee 0). Logged for the Market screen's activity list.
export interface TransferRecord {
  day: number;
  playerId: string;
  playerHandle: string;
  fromTeamId?: string;
  fromTeamName?: string;
  toTeamId: string;
  toTeamName: string;
  fee: number;
}

// One running tournament across every region that fielded a bracket. Each region
// runs its own bracket; a tournament "day" plays one round from every region
// still going. The same engine that used to drive end-of-season playoffs.
export interface PlayoffState {
  season: number;                           // the event id this tournament is
  day: number;                              // 1-based tournament day index
  regions: RegionPlayoff[];
  major?: boolean;                          // a Major: one international bracket
}

export type PlayoffStage = "swiss" | "bracket" | "done";

// One region's playoff run: an optional Swiss group stage that whittles entrants
// down to the bracket cut, then a single-elimination bracket to the title.
export interface RegionPlayoff {
  region: Region;             // for a Major this is just a nominal carrier (see intl)
  intl?: boolean;             // the international Major bracket — labelled "Major", not a region
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

// Links a playoff matchup back to its place in the tournament so results advance
// the right region/stage/round/slot.
export interface PlayoffMatchTag {
  stage: PlayoffStage;                      // "swiss" | "bracket"
  round: number;                            // round within that stage (1-based)
  slot: number;                             // pairing/match index within the round
}

// How serious a tracked team is, climbing the competitive ladder:
//  - "stack": a recurring full-5 friend clique that hasn't earned org status yet
//             (tracked only as a ProvisionalStack, never as a UniverseTeam).
//  - "org":   crystallized, named, counts in standings; the level UniverseTeam
//             records start at today.
//  - "pro":   an org that pays its players (reserved for a later milestone).
export type TeamTier = "stack" | "org" | "pro";

// One lineup the org fielded, recorded when the roster changes. The first entry
// is the founding five; later entries capture signings/releases. Lets an org's
// identity outlive any particular roster.
export interface RosterHistoryEntry {
  day: number;
  playerIds: string[];
  note: string;                             // e.g. "Founded", "Signed …", "Released …"
}

// A recurring full-5 friend clique that is accruing the commitment needed to
// become an org, but hasn't promoted yet (see GAMES_TO_ORG / driven-core gate in
// universeSim). Plays as a pickup lobby until it crystallizes. Keyed by the same
// sorted-roster `rosterKey` an org uses, so the two phases line up.
export interface ProvisionalStack {
  rosterKey: string;                        // sorted player ids
  region: Region;
  playerIds: string[];                      // last-seen roster order
  gamesTogether: number;                    // days this exact five has stacked
  firstSeenDay: number;
  lastSeenDay: number;
}

// A non-player staff member who runs a team. Minimal for now (identity only) —
// groundwork for a fuller coach role and academy teams later.
export interface Manager {
  name: string;
  country?: string;   // ISO-3166 alpha-2
  since: number;      // day they took charge
}

// A persistent, named team: an org that owns a roster. A player belongs to at
// most one team. Identity is stable across days via `id`. The roster holds up to
// ROSTER_MAX players; `activeIds` is the five that actually play (the rest are
// bench). `rosterKey` (sorted ACTIVE ids) still matches a re-formed lineup back.
export interface UniverseTeam {
  id: string;
  name: string;
  region: Region;
  // The founding player who runs the club. A team that crystallized from a
  // grassroots 5-stack is player-led: this is that founder (the de facto captain
  // at founding). Leadership falls to the current captain if the founder leaves.
  founderId?: string;
  // Hired front-office staff (see Manager). NOT auto-generated for grassroots
  // teams — they're player-run; reserved for established orgs / future hiring.
  manager?: Manager;
  // Country of origin — the founding captain's nationality (ISO-3166 alpha-2).
  // Fixed at crystallization; survives roster changes. Absent on saves predating
  // org nationality; backfilled from the current captain on load.
  country?: string;
  playerIds: string[];                      // full roster (active + bench), up to ROSTER_MAX
  // The five players who actually play (a subset of playerIds, AI-managed). The
  // rest of the roster are bench. Absent on saves predating benches — backfilled
  // to the best five on load.
  activeIds?: string[];
  rosterKey: string;                        // sorted ACTIVE ids joined — identity match
  // Competitive tier. Absent on saves predating tiers; treated as "org" (every
  // tracked team used to be a crystallized org).
  tier?: TeamTier;
  // Lineups over time, oldest first. Absent on pre-tier saves; backfilled with a
  // single "Founded" entry on load.
  rosterHistory?: RosterHistoryEntry[];
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
  // Spendable cash. Income (prize money + sponsorship) flows in, wages and
  // transfer fees flow out, each event cycle. Distinct from `earnings` (a
  // lifetime stat). An org whose balance falls below FOLD_THRESHOLD goes under.
  // Absent on saves predating wages; seeded from `earnings` on load.
  balance?: number;
  // Lifetime tournament prize money won, in dollars. Accrues when each event
  // finishes (see finance.regionPayouts). Absent on saves predating the economy;
  // treated as 0 until the team next cashes.
  earnings?: number;
  // World-ranking points. Awarded by tournament placement and decayed by
  // RANKING_DECAY at each new event, so the ranking reflects recent form. Absent
  // on saves predating the circuit; treated as 0. The basis for the ranking table.
  rankingPoints?: number;
  // Day the org disbanded: set once its clique has fully decayed (no two members
  // still bonded) AND it has sat idle past DISBAND_IDLE_DAYS. A disbanded org is
  // frozen — excluded from invitees, rankings, and "current team" lookups — but
  // kept for history/links (titles, past results). Absent while active.
  disbandedDay?: number;
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

// ---- Tournament circuit ----------------------------------------------------
// Days in a calendar year. The world ages once per year (aging/retirement/youth)
// and the player page buckets stats by year. ~4 events per year at the default
// interval.
export const YEAR_LENGTH = 56;
// Days between tournaments (the scheduler's reset value after each event).
export const EVENT_INTERVAL_DAYS = 14;
// Teams invited to a regional tournament, by world ranking. 8 → a clean
// single-elimination bracket through the existing engine (no Swiss stage).
export const INVITE_FIELD = 8;
// Ranking points decay applied to every team when a new event starts, so the
// world ranking reflects recent results and inactive teams fade.
export const RANKING_DECAY = 0.8;
// Cap on the trophy log so circuit history doesn't grow without bound.
export const TITLES_LOG_MAX = 200;
export const TRANSFERS_LOG_MAX = 200;

// ---- Economy (wages / budget). All amounts are per event cycle (~14 days), the
// cadence at which finances tick (see finance.runFinancialCycle). Tunable; the
// intent is that lean or winning orgs sustain while expensive-but-losing rosters
// bleed and eventually fold, with the transfer market bailing out sellable orgs.
export const STARTING_BALANCE = 250_000;  // seed cash a new org crystallizes with
export const WAGE_RATE = 0.05;            // per-cycle wage = this × player market value
export const BASE_SPONSOR = 30_000;       // flat sponsorship every active org draws
export const SPONSOR_PER_RP = 50;         // extra sponsorship per ranking point (results pay)
export const FOLD_THRESHOLD = -200_000;   // balance below this → the org folds (insolvent)
export const CONTRACT_LENGTH_DAYS = 112;  // base contract term (~2 seasons); jittered per signing
// How many most-recent years of per-player breakdown to retain in
// `Universe.yearStats`. Older years drop from the per-year view (their games are
// still counted in lifetime `careers`), keeping core storage bounded.
export const YEAR_STATS_KEEP = 12;

// Playoff sizing. A region with >= SWISS_FIELD ranked teams runs a Swiss stage
// (SWISS_TARGET wins to advance / losses to drop) that cuts to BRACKET_FIELD,
// then a single-elimination bracket. Smaller fields skip Swiss and seed a
// power-of-two bracket directly (see startPlayoffs).
export const SWISS_FIELD = 16;
export const SWISS_TARGET = 3;
export const BRACKET_FIELD = 8;

// Majors: the marquee international event. Every MAJOR_EVERY-th event slot is a
// Major instead of the regional circuits — one cross-region bracket of the
// world's best MAJOR_FIELD teams by ranking. Less frequent, bigger stakes.
export const MAJOR_EVERY = 4;    // ~1 Major per in-game year (YEAR/EVENT cadence)
export const MAJOR_FIELD = 16;   // top teams worldwide invited (Swiss → bracket)

// Stack→org promotion gate. A recurring full-5 clique becomes a named org once
// it has stacked together at least GAMES_TO_ORG times AND carries a driven core
// of at least DRIVEN_CORE_SIZE players whose ambition clears DRIVEN_AMBITION.
// Low-ambition "for fun" cliques never clear the bar — they just keep stacking.
export const GAMES_TO_ORG = 3;
export const DRIVEN_AMBITION = 70;
export const DRIVEN_CORE_SIZE = 2;

// A friendship clique that stalls one short of a full five (4 players) with at
// least one driven member will recruit the nearest-Elo solo as its fifth and
// seed a bond, so the completed five re-forms and can pursue org status. The
// seeded bond clears FRIEND_THRESHOLD with margin so it survives a day's decay.
export const RECRUIT_BOND = 55;

// Tournament free-agent grouping: when seeding an event, the strongest players
// not on an org may band into a fresh contender — but only if their roster Elo
// would out-seed an already-qualified team by this margin (so we add genuine
// title threats, not field padding). Seeded with bonds so the team can persist.
export const FA_CONTENDER_MARGIN = 25;

// Org dissolution: an org disbands once it has sat idle this many days AND no two
// of its current members are still bonded (the clique has fully decayed).
export const DISBAND_IDLE_DAYS = 84; // ~1.5 seasons without a game

export const STARTING_ELO = 1000;
// Default players per region on the New Universe screen (the user can dial this
// up or down). Each region gets its own pool so every competitive scene can
// field many full lobbies a day. The sim runs off-thread and the roster/career
// tables are virtualized, so a full 1000/region (6k players) stays responsive.
export const PLAYERS_PER_REGION = 1000;
// Upper guard for the setup input — prevents runaway player generation from a typo.
export const MAX_PLAYERS_PER_REGION = 2000;
export const PLAYER_COUNT = PLAYERS_PER_REGION * REGION_ORDER.length;
export const TEAM_SIZE = 5;            // players on the Active Roster (who play a match)
export const ROSTER_MAX = 12;         // full roster cap (active + bench); academy comes later
// A benched player loses this much morale per cycle (they want to play). Drives
// the bench dynamics: seek a transfer, quit if uncontracted, or stay if content.
export const BENCH_MORALE_HIT = 6;
