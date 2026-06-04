// Universe economy: playoff prize money and player market value. Pure helpers —
// no DOM, no storage. The day loop awards prizes when playoffs finish and
// recomputes player values once per completed day (see universeMode).

import type { Player } from "../domain/types.ts";
import {
  STARTING_ELO, WAGE_RATE, BASE_SPONSOR, SPONSOR_PER_RP, FOLD_THRESHOLD,
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

// Prize money owed to each team in one region's finished tournament.
export function regionPayouts(rp: RegionPlayoff): Map<string, number> {
  return placementPayouts(rp, PLAYOFF_PRIZES);
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

// ---- wages & budget --------------------------------------------------------

// A player's per-cycle wage, derived from their current market value (so it
// floats with skill/age/form — no stored contract for v1). Cheap/floor players
// cost almost nothing to keep.
export function wageOf(p: Player): number {
  return Math.round((p.value ?? 0) * WAGE_RATE);
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

// Run one cycle of finances over every active org: credit sponsorship, debit the
// wage bill. Mutates `balance` in place. Prize money is added separately (before
// this) so winnings are spendable. Call once per event cycle.
export function runFinancialCycle(teams: UniverseTeam[], players: Player[]): void {
  const byId = new Map(players.map(p => [p.id, p] as const));
  for (const t of teams) {
    if (t.disbandedDay || t.playerIds.length === 0) continue;
    t.balance = (t.balance ?? 0) + sponsorIncome(t) - wageBill(t, byId);
  }
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
