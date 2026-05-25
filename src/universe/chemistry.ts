import type { Player } from "../domain/types.ts";

// Relationship bounds (mirrors the -100..100 scale documented on Player).
const MAX_REL = 100;
const MIN_REL = -100;

// Bond at or above this is treated as a real friendship by matchmaking — these
// players try to group up rather than be split across teams.
export const FRIEND_THRESHOLD = 40;

// --- Tuning ---------------------------------------------------------------
// Relationships are now DIRECTIONAL (a→b can differ from b→a) and personality-
// driven. A player's `ambition` (0..100) decides what moves their bonds:
//  - low ambition ("fun"): bonds just from playing together, win or lose, and
//    barely cares about results or who carried → forms stable friend groups.
//  - high ambition: small baseline, big swings on wins/losses and on whether a
//    teammate over/under-performed → volatile, results-driven bonds.
const WIN_BONUS = 3.0;       // ambitious players enjoy winning together
const LOSS_PENALTY = 3.0;    // ambitious players sour on losses
const PERF_WEIGHT = 5.0;     // pull toward teammates who out-performed (per ambition)
const RIVALRY_WEIGHT = 2.5;  // opponent rivalry / respect magnitude
const NOISE = 2.5;           // ± random jitter on every pairwise change
const DAILY_DECAY = 0.04;    // bonds regress 4%/day toward 0 (need upkeep)
const FORGET_BELOW = 0.5;    // bonds weaker than this are dropped entirely

function clampRel(v: number): number {
  return Math.max(MIN_REL, Math.min(MAX_REL, v));
}

type Stat = {
  kills: number; deaths: number; assists: number;
  damage: number; roundsPlayed: number;
};

// Per-round impact, used to compare teammates against each other. Positive =
// carried, negative = dragged. Roughly -0.8..+1.5 per round.
function impactOf(s: Stat): number {
  const r = Math.max(1, s.roundsPlayed);
  return (s.kills + 0.4 * s.assists - 0.8 * s.deaths) / r;
}

export interface MatchChemistryInput {
  winnerIds: string[];
  loserIds: string[];
  // Per-player match stats (for performance-driven bonding). Optional — without
  // it, bonds still move on result + base + noise, just not on performance.
  stats?: Record<string, Stat>;
  rng?: () => number;
}

// Update relationships in-place after a completed match. Teammates bond (or
// fray) based on result, each other's performance, and personality; opponents
// pick up small rivalries or mutual respect. Everything carries random jitter,
// and the swings are gated by each viewer's ambition.
export function applyMatchChemistry(players: Player[], input: MatchChemistryInput) {
  const { winnerIds, loserIds, stats, rng = Math.random } = input;
  const byId = new Map(players.map(p => [p.id, p] as const));
  const noise = () => (rng() * 2 - 1) * NOISE;

  // Move a's directional feeling toward b.
  const adjust = (aId: string, bId: string, amount: number) => {
    const a = byId.get(aId);
    if (!a) return;
    a.relationships[bId] = clampRel((a.relationships[bId] ?? 0) + amount);
  };

  // Each player's impact relative to the rest of their team this match.
  const teamRelativeImpact = (ids: string[]): Map<string, number> => {
    const out = new Map<string, number>();
    if (!stats) return out;
    const vals = ids.map(id => (stats[id] ? impactOf(stats[id]) : null));
    const present = vals.filter((v): v is number => v !== null);
    if (present.length === 0) return out;
    const avg = present.reduce((s, v) => s + v, 0) / present.length;
    ids.forEach((id, i) => { if (vals[i] !== null) out.set(id, vals[i]! - avg); });
    return out;
  };

  const processTeam = (ids: string[], won: boolean) => {
    const rel = teamRelativeImpact(ids);
    for (const aId of ids) {
      const a = byId.get(aId);
      if (!a) continue;
      const amb = a.ambition / 100;        // 0 = fun, 1 = ambitious
      for (const bId of ids) {
        if (aId === bId) continue;
        // Fun players bond from simply playing together; ambitious players
        // start near zero and let results do the talking.
        let delta = 0.8 + 2.2 * (1 - amb);
        if (won) delta += WIN_BONUS * amb;
        else     delta -= LOSS_PENALTY * amb;
        // Reward/punish teammates by how they performed — weighted by ambition.
        const bImpact = rel.get(bId);
        if (bImpact !== undefined) delta += PERF_WEIGHT * bImpact * amb;
        delta += noise();
        adjust(aId, bId, delta);
      }
    }
  };

  processTeam(winnerIds, true);
  processTeam(loserIds, false);

  // Opponents: rivalries and the occasional mutual respect. Small and very
  // noisy. Losers tend to resent the team that beat them (more so if ambitious);
  // a respect roll can flip it positive instead.
  for (const wId of winnerIds) {
    for (const lId of loserIds) {
      if (!byId.has(wId) || !byId.has(lId)) continue;
      const lAmb = byId.get(lId)!.ambition / 100;
      const loserRespects = rng() < 0.25;
      adjust(lId, wId,
        (loserRespects ? 1 : -1) * RIVALRY_WEIGHT * (0.4 + 0.6 * lAmb) + noise() * 0.5);
      const winnerRespects = rng() < 0.5;
      adjust(wId, lId,
        (winnerRespects ? 1 : -1) * RIVALRY_WEIGHT * 0.5 + noise() * 0.5);
    }
  }
}

// Daily regression: every bond drifts toward 0 (with a little jitter) so
// friendships and rivalries fade without upkeep. Weak bonds are forgotten
// entirely. This keeps the whole pool from locking into permanent perfect
// cliques — only relationships that keep getting reinforced survive.
export function decayRelationships(players: Player[], rng: () => number = Math.random) {
  for (const p of players) {
    for (const id of Object.keys(p.relationships)) {
      const next = p.relationships[id] * (1 - DAILY_DECAY) + (rng() * 2 - 1) * 0.5;
      if (Math.abs(next) < FORGET_BELOW) delete p.relationships[id];
      else p.relationships[id] = clampRel(next);
    }
  }
}
