import type { RoundResult, Team } from "../domain/types.ts";

// Per-player CS-style round rewards.
const WIN_BONUS = 3250;
const LOSS_STREAK_BASE = 1400;
const LOSS_STREAK_BONUS = 500;
const MAX_LOSS_BONUS = 3400;
const KILL_REWARD = 300;
const PLAYER_MONEY_CAP = 16000;

export function applyRoundReward(
  ct: Team, t: Team, result: RoundResult, ctLossStreak: number, tLossStreak: number,
): { ctLossStreak: number; tLossStreak: number } {
  const winner = result.winningSide === "CT" ? ct : t;
  const loser = result.winningSide === "CT" ? t : ct;
  const loserBonus = Math.min(
    MAX_LOSS_BONUS,
    LOSS_STREAK_BASE + LOSS_STREAK_BONUS * (result.winningSide === "CT" ? tLossStreak : ctLossStreak),
  );
  for (const p of winner.players) p.money += WIN_BONUS;
  for (const p of loser.players)  p.money += loserBonus;

  // Kill rewards go to the killer directly.
  for (const e of result.events) {
    if (e.kind !== "kill") continue;
    const killer = ct.players.find(p => p.id === e.killer) ?? t.players.find(p => p.id === e.killer);
    if (killer) killer.money += KILL_REWARD;
  }

  // Cap money per player
  for (const team of [ct, t]) {
    for (const p of team.players) p.money = Math.min(p.money, PLAYER_MONEY_CAP);
  }

  return {
    ctLossStreak: result.winningSide === "CT" ? 0 : ctLossStreak + 1,
    tLossStreak: result.winningSide === "T" ? 0 : tLossStreak + 1,
  };
}
