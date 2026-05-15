import type { RoundResult, Team } from "../domain/types.ts";

// Simplified CS-style round rewards.
const WIN_BONUS = 3250;
const LOSS_STREAK_BASE = 1400;
const LOSS_STREAK_BONUS = 500;
const MAX_LOSS_BONUS = 3400;
const KILL_REWARD = 300; // pooled into team for simplicity

export function applyRoundReward(
  ct: Team, t: Team, result: RoundResult, ctLossStreak: number, tLossStreak: number,
): { ctLossStreak: number; tLossStreak: number } {
  const winner = result.winningSide === "CT" ? ct : t;
  const loser = result.winningSide === "CT" ? t : ct;
  winner.money += WIN_BONUS;
  loser.money += Math.min(MAX_LOSS_BONUS, LOSS_STREAK_BASE + LOSS_STREAK_BONUS *
    (result.winningSide === "CT" ? tLossStreak : ctLossStreak));

  // Kill rewards
  for (const e of result.events) {
    if (e.kind !== "kill") continue;
    const killerCt = ct.players.some(p => p.id === e.killer);
    (killerCt ? ct : t).money += KILL_REWARD;
  }

  // Cap money
  ct.money = Math.min(ct.money, 16000);
  t.money = Math.min(t.money, 16000);

  return {
    ctLossStreak: result.winningSide === "CT" ? 0 : ctLossStreak + 1,
    tLossStreak: result.winningSide === "T" ? 0 : tLossStreak + 1,
  };
}
