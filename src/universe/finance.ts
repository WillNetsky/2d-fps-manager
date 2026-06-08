// Universe economy: playoff prize money and player market value. Pure helpers —
// no DOM, no storage. The day loop awards prizes when playoffs finish and
// recomputes player values once per completed day (see universeMode).

import type { Player } from "../domain/types.ts";
import { FRIEND_THRESHOLD } from "./chemistry.ts";
import { benchOf, refreshActiveRoster } from "./roster.ts";
import {
  STARTING_ELO, TEAM_SIZE, WAGE_RATE, BASE_SPONSOR, SPONSOR_PER_RP, FOLD_THRESHOLD,
  CONTRACT_LENGTH_DAYS, BENCH_MORALE_HIT, ORG_PRIZE_PLAYER_SHARE, EVENT_INTERVAL_DAYS,
  PRO_EARNINGS_THRESHOLD, UNPAID_MORALE_HIT, PRO_PATIENCE_CYCLES,
  type RegionPlayoff, type Universe, type UniverseTeam,
} from "./types.ts";

// ---- prize money -----------------------------------------------------------

// Flat payout per playoff finish, per region. A region's whole bracket is paid
// out from these; smaller fields simply have fewer tiers in play.
export const PLAYOFF_PRIZES = {
  champion: 250_000,
  runnerUp: 100_000,
  semifinal: 50_000,     // each losing semifinalist
  quarterfinal: 25_000,  // each team out in the quarterfinals
  bracket: 10_000,       // earlier bracket exit (round of 16+), each
  swiss: 5_000,          // eliminated in the Swiss stage, never reached bracket
} as const;

// A Major pays far more — the marquee international event. Same tier shape.
export const MAJOR_PRIZES = {
  champion: 1_000_000,
  runnerUp: 400_000,
  semifinal: 175_000,
  quarterfinal: 80_000,
  bracket: 35_000,
  swiss: 15_000,
} as const;

// Per-placement amounts (money or ranking points) — same tier shape so the same
// bracket-walk distributes either.
export interface PlacementTiers {
  champion: number;
  runnerUp: number;
  semifinal: number;
  quarterfinal: number;
  bracket: number;   // earlier bracket exit
  swiss: number;     // cut in the Swiss stage
}

// Amount owed to each team in one region's finished tournament, keyed by team id,
// for the given tier table. A team appears once, at its best (and only) finish.
// Call only after the region's bracket has fully resolved.
export function placementPayouts(rp: RegionPlayoff, tiers: PlacementTiers): Map<string, number> {
  const out = new Map<string, number>();
  if (rp.championTeamId) out.set(rp.championTeamId, tiers.champion);

  if (rp.bracket.length > 0) {
    const finalRound = Math.max(...rp.bracket.map(m => m.round));
    for (const m of rp.bracket) {
      if (!m.winnerTeamId) continue;
      const loser = m.aTeamId === m.winnerTeamId ? m.bTeamId : m.aTeamId;
      if (!loser || out.has(loser)) continue;
      const fromEnd = finalRound - m.round; // 0 = final, 1 = semis, 2 = QFs
      out.set(loser,
        fromEnd === 0 ? tiers.runnerUp
        : fromEnd === 1 ? tiers.semifinal
        : fromEnd === 2 ? tiers.quarterfinal
        : tiers.bracket);
    }
  }

  // Teams cut in the Swiss stage never reached the bracket.
  for (const e of rp.entrants) {
    if (e.status === "eliminated" && !out.has(e.teamId)) {
      out.set(e.teamId, tiers.swiss);
    }
  }
  return out;
}

// Prize money owed to each team in a finished bracket — Major-scaled if it's the
// international event, otherwise the regional circuit purse.
export function regionPayouts(rp: RegionPlayoff): Map<string, number> {
  return placementPayouts(rp, rp.intl ? MAJOR_PRIZES : PLAYOFF_PRIZES);
}

// Credit one team's prize winnings. `earnings` (the lifetime / pay-expectation
// metric) always banks the full amount. Where the cash lands differs by tier:
// a PRO org keeps it all in the club balance (it pays salaries from there);
// an amateur org keeps only a cut (1 - ORG_PRIZE_PLAYER_SHARE) and splits the
// rest across its active five into their personal wallets — how grassroots
// players bank the savings that later seed a founded org.
export function awardPrize(team: UniverseTeam, byId: Map<string, Player>, amt: number): void {
  team.earnings = (team.earnings ?? 0) + amt;
  if (team.tier === "pro") {
    team.balance = (team.balance ?? 0) + amt;
    return;
  }
  team.balance = (team.balance ?? 0) + Math.round(amt * (1 - ORG_PRIZE_PLAYER_SHARE));
  const active = team.activeIds ?? team.playerIds.slice(0, TEAM_SIZE);
  if (active.length === 0) { team.balance = (team.balance ?? 0) + Math.round(amt * ORG_PRIZE_PLAYER_SHARE); return; }
  const share = Math.round((amt * ORG_PRIZE_PLAYER_SHARE) / active.length);
  for (const id of active) {
    const p = byId.get(id);
    if (!p) continue;
    p.wallet = (p.wallet ?? 0) + share;
    p.careerEarnings = (p.careerEarnings ?? 0) + share;
  }
}

// ---- player market value ---------------------------------------------------

// Below this elo a player has essentially no market value; value scales off the
// margin above it.
const VALUE_ELO_FLOOR = 700;
const VALUE_PER_ELO = 250;

// Career-stage multiplier: peak value in the ascending early-20s prime, gentle
// decline through the late 20s and a steeper drop into the veteran years.
function ageFactor(age: number): number {
  if (age <= 19) return 1.05;
  if (age <= 24) return 1.15;
  if (age <= 27) return 1.0;
  if (age <= 30) return 0.8;
  if (age <= 33) return 0.55;
  return 0.35;
}

// Current form nudges value ±10%.
function formFactor(morale: number): number {
  return 0.9 + 0.2 * (Math.max(0, Math.min(100, morale)) / 100);
}

// A player's market value in dollars, from earned skill (elo), career stage
// (age), and current form (morale). Rounded to a clean $1k figure.
export function playerValue(p: Player, elo: number): number {
  const skill = Math.max(0, elo - VALUE_ELO_FLOOR);
  const v = skill * VALUE_PER_ELO * ageFactor(p.age) * formFactor(p.morale);
  return Math.round(v / 1000) * 1000;
}

// Refresh every player's stored value. Called once per completed sim day and on
// universe load, so value tracks elo/form/age drift.
export function recomputePlayerValues(u: Universe): void {
  for (const p of u.players) {
    p.value = playerValue(p, u.elos[p.id] ?? STARTING_ELO);
  }
}

// ---- wages, contracts & budget ---------------------------------------------

// The going rate to sign/renew a player: their market value scaled by WAGE_RATE.
export function marketWage(p: Player): number {
  return Math.round((p.value ?? 0) * WAGE_RATE);
}

// A player's actual per-cycle wage: their locked contract salary, or the market
// rate if they have no contract yet (new joiner before the next contract cycle).
export function wageOf(p: Player): number {
  return p.contract?.salary ?? marketWage(p);
}

// Sign (or renew) a player to a fresh contract at the current market rate, for a
// jittered term around CONTRACT_LENGTH_DAYS so expiries stagger across the scene.
export function signContract(p: Player, day: number, rng: () => number = Math.random): void {
  const term = Math.round(CONTRACT_LENGTH_DAYS * (0.75 + rng() * 0.5));
  p.contract = { salary: marketWage(p), until: day + term };
}

// Once an amateur org's lifetime earnings cross PRO_EARNINGS_THRESHOLD, its
// players expect to be paid. Each such org either:
//   - turns PRO, if it can comfortably cover a wage cycle (balance >= 2× the
//     projected wage bill): tier flips and the roster is put on contracts; OR
//   - stays amateur and bleeds — every active player loses morale, and an
//     unhappy, uncontracted player (the more ambitious, the likelier) walks to
//     free agency, mirroring runBenchCycle's exit roll.
// Run BEFORE runContractCycle so a freshly promoted org is treated as pro this
// cycle. Returns the ids that quit over pay.
export function runPayExpectationCycle(
  teams: UniverseTeam[], players: Player[], elos: Record<string, number>, day: number,
  rng: () => number = Math.random,
): string[] {
  const byId = new Map(players.map(p => [p.id, p] as const));
  const quit: string[] = [];
  for (const t of teams) {
    if (t.disbandedDay || t.playerIds.length === 0) continue;
    if (t.tier !== "org" || (t.earnings ?? 0) < PRO_EARNINGS_THRESHOLD) continue;

    const bill = wageBill(t, byId); // projected, off market wages (no contracts yet)
    if ((t.balance ?? 0) >= bill * 2) {
      t.tier = "pro";
      for (const id of t.playerIds) { const p = byId.get(id); if (p) signContract(p, day, rng); }
      (t.rosterHistory ??= []).push({ day, playerIds: [...t.playerIds], note: "Turned professional" });
      continue;
    }

    // Can't afford it — the squad stews, and the unhappiest may leave.
    let changed = false;
    const active = t.activeIds ?? t.playerIds.slice(0, TEAM_SIZE);
    for (const id of active) {
      const p = byId.get(id);
      if (!p) continue;
      p.morale = Math.max(0, Math.min(100, p.morale - UNPAID_MORALE_HIT));
    }
    for (const id of [...t.playerIds]) {
      if (t.playerIds.length <= 1) break;
      const p = byId.get(id);
      if (!p || p.contract) continue;
      const wantsOut = p.morale < 45;
      if (wantsOut && rng() < 0.2 + p.ambition / 200) {
        t.playerIds = t.playerIds.filter(x => x !== id);
        quit.push(id);
        changed = true;
        (t.rosterHistory ??= []).push({ day, playerIds: [...t.playerIds], note: `${p.handle} left — unpaid` });
      }
    }
    if (changed) { refreshActiveRoster(t, elos); t.rosterKey = [...(t.activeIds ?? t.playerIds)].sort().join(","); }
  }
  return quit;
}

// Reconcile contracts once per cycle:
//   - invariant: only players on an active org hold a contract (free agents /
//     folded players have theirs cleared);
//   - new joiners (e.g. an emergent crystallized lineup) get signed at market rate;
//   - expired deals are renewed at the new market rate, OR the player is let go to
//     free agency — a struggling org sheds its costliest expiring player, and an
//     aging player is sometimes not renewed (at most one release per org per cycle).
// Released players (returned) drop to the market, where the transfer window's
// backfill refills the short org. Run before the wage debit so a release relieves
// this cycle's bill.
export function runContractCycle(
  teams: UniverseTeam[], players: Player[], day: number, rng: () => number = Math.random,
): string[] {
  const byId = new Map(players.map(p => [p.id, p] as const));
  // Only players on an active PRO org hold a contract: amateur orgs don't pay,
  // so their players (and free agents / folded players) carry none.
  const onPaidOrg = new Set<string>();
  for (const t of teams) if (!t.disbandedDay && t.tier === "pro") for (const id of t.playerIds) onPaidOrg.add(id);
  for (const p of players) if (p.contract && !onPaidOrg.has(p.id)) delete p.contract;

  const freed: string[] = [];
  for (const t of teams) {
    if (t.disbandedDay || t.playerIds.length === 0 || t.tier !== "pro") continue;
    let released = 0;
    const expiring = t.playerIds
      .map(id => byId.get(id)).filter((p): p is Player => !!p)
      .filter(p => !p.contract || p.contract.until <= day)
      .sort((a, b) => (b.contract?.salary ?? 0) - (a.contract?.salary ?? 0));
    for (const p of expiring) {
      if (!p.contract) { signContract(p, day, rng); continue; } // new joiner
      const costCut = (t.balance ?? 0) < 0 && released < 1;
      const ageCut = p.age >= 31 && rng() < 0.35 && released < 1;
      if ((costCut || ageCut) && t.playerIds.length > 1) {
        t.playerIds = t.playerIds.filter(id => id !== p.id);
        delete p.contract;
        freed.push(p.id);
        released++;
        (t.rosterHistory ??= []).push({ day, playerIds: [...t.playerIds], note: `Released ${p.handle}` });
      } else {
        signContract(p, day, rng); // renew at current market rate
      }
    }
    if (released > 0) t.rosterKey = [...t.playerIds].sort().join(",");
  }
  return freed;
}

// An org's total per-cycle wage bill (sum of its roster's wages).
export function wageBill(team: UniverseTeam, byId: Map<string, Player>): number {
  let sum = 0;
  for (const id of team.playerIds) { const p = byId.get(id); if (p) sum += wageOf(p); }
  return sum;
}

// An org's per-cycle sponsorship income: a flat base plus a bonus scaled by
// ranking points, so results pay. (Prize money is awarded separately.)
export function sponsorIncome(team: UniverseTeam): number {
  return BASE_SPONSOR + Math.round((team.rankingPoints ?? 0) * SPONSOR_PER_RP);
}

// Run one cycle of finances over every active org: credit sponsorship, and —
// for PRO orgs only — debit the wage bill, paying each wage into the player's
// personal wallet (so salary actually reaches the player). Amateur orgs are
// player-run and pay no salaries; they just draw sponsorship. Mutates `balance`
// in place. Prize money is added separately (before this) so winnings are
// spendable. Call once per event cycle.
export function runFinancialCycle(teams: UniverseTeam[], players: Player[]): void {
  const byId = new Map(players.map(p => [p.id, p] as const));
  for (const t of teams) {
    if (t.disbandedDay || t.playerIds.length === 0) continue;
    t.balance = (t.balance ?? 0) + sponsorIncome(t);
    if (t.tier !== "pro") continue; // amateurs don't pay players
    for (const id of t.playerIds) {
      const p = byId.get(id);
      if (!p) continue;
      const wage = wageOf(p);
      t.balance = (t.balance ?? 0) - wage;
      p.wallet = (p.wallet ?? 0) + wage;
      p.careerEarnings = (p.careerEarnings ?? 0) + wage;
    }
  }
}

// Pro orgs are expected to win. Track each pro org's run of under-performance —
// sitting in the bottom third of active orgs by ranking points, or on a losing
// streak (streak <= -3). The counter resets the moment results recover; once it
// reaches PRO_PATIENCE_CYCLES the org folds (its backers pull out), freeing the
// roster to the market. Newly founded pros get a grace period to establish a
// ranking before the clock starts. Call after the transfer window / bench cycle,
// before the insolvency fold. Returns the orgs that folded on expectations.
const PRO_GRACE_DAYS = EVENT_INTERVAL_DAYS * 3; // settle-in window for a new pro org
export function runProDiscipline(teams: UniverseTeam[], day: number): UniverseTeam[] {
  const active = teams.filter(t => !t.disbandedDay && t.playerIds.length > 0);
  const ranked = [...active].map(t => t.rankingPoints ?? 0).sort((a, b) => a - b);
  const cutoff = ranked.length ? ranked[Math.floor(ranked.length / 3)] : 0; // bottom-third line
  const folded: UniverseTeam[] = [];
  for (const t of active) {
    if (t.tier !== "pro") continue;
    if (day - t.foundedDay < PRO_GRACE_DAYS) continue; // give new clubs time to rank up
    const underperforming = (t.rankingPoints ?? 0) <= cutoff || (t.streak ?? 0) <= -3;
    t.slumpCycles = underperforming ? (t.slumpCycles ?? 0) + 1 : 0;
    if ((t.slumpCycles ?? 0) >= PRO_PATIENCE_CYCLES) {
      t.disbandedDay = day;
      (t.rosterHistory ??= []).push({ day, playerIds: [], note: "Folded — failed expectations" });
      folded.push(t);
    }
  }
  return folded;
}

// Fold every active org whose balance has fallen below FOLD_THRESHOLD. Marks the
// org disbanded (freeing its players to the market, since disbanded orgs are
// excluded from active-roster lookups) with a distinct "insolvent" note for the
// news feed. Call AFTER the transfer window, so a sellable org can be bailed out
// by poach fees first. Returns the orgs that folded.
export function foldInsolventOrgs(teams: UniverseTeam[], day: number): UniverseTeam[] {
  const folded: UniverseTeam[] = [];
  for (const t of teams) {
    if (t.disbandedDay || t.playerIds.length === 0) continue;
    if ((t.balance ?? 0) >= FOLD_THRESHOLD) continue;
    t.disbandedDay = day;
    (t.rosterHistory ??= []).push({ day, playerIds: [], note: "Folded — insolvent" });
    folded.push(t);
  }
  return folded;
}

// ---- bench dynamics --------------------------------------------------------

// Benched players don't want to sit. Each cycle they lose morale; an unhappy,
// UNCONTRACTED bench player who isn't tied to the squad by friendship quits to
// free agency (the more ambitious, the likelier). Contracted bench players are
// locked in — they stew (and the market may sell them), but can't just walk.
// A player still friends with the starters, or content (low ambition), stays.
// Only ever removes bench players, so the active five is never disturbed.
// Returns the ids that quit.
export function runBenchCycle(
  teams: UniverseTeam[], players: Player[], elos: Record<string, number>, day: number,
  rng: () => number = Math.random,
): string[] {
  const byId = new Map(players.map(p => [p.id, p] as const));
  const quit: string[] = [];
  for (const t of teams) {
    if (t.disbandedDay) continue;
    const active = t.activeIds ?? t.playerIds.slice(0, TEAM_SIZE);
    let changed = false;
    for (const id of benchOf(t)) {
      const p = byId.get(id);
      if (!p) continue;
      p.morale = Math.max(0, Math.min(100, p.morale - BENCH_MORALE_HIT));
      const befriended = active.some(aid => (p.relationships[aid] ?? 0) >= FRIEND_THRESHOLD);
      const wantsOut = !p.contract && p.morale < 45 && !befriended;
      if (wantsOut && rng() < 0.3 + p.ambition / 200) {
        t.playerIds = t.playerIds.filter(x => x !== id);
        quit.push(id);
        changed = true;
        (t.rosterHistory ??= []).push({ day, playerIds: [...t.playerIds], note: `${p.handle} left the bench` });
      }
    }
    if (changed) refreshActiveRoster(t, elos);
  }
  return quit;
}

// ---- formatting ------------------------------------------------------------

// Compact dollar figure for tables/cards: $5K, $250K, $1.2M.
export function formatMoney(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `$${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`;
  }
  if (n >= 1_000) return `$${Math.round(n / 1000)}K`;
  return `$${Math.round(n)}`;
}
