// Shared rating math — pure, no deps beyond types — so both the UI (player
// pages, scoreboards) and derived views (news/storylines) rate consistently.

import type { CareerStats, PlayerMatchStats } from "./types.ts";

// HLTV 1.0 rating from per-match stats. Constants are the league averages used
// in the original formula. Returns 0 if the player did not play any rounds.
export function hltvRating1(s: PlayerMatchStats): number {
  const R = s.roundsPlayed;
  if (R <= 0) return 0;
  const kr = (s.kills / R) / 0.679;
  const sr = ((R - s.deaths) / R) / 0.317;
  const mkr = (s.k1 + 4 * s.k2 + 9 * s.k3 + 16 * s.k4 + 25 * s.k5) / R / 1.277;
  return (kr + 0.7 * sr + mkr) / 2.7;
}

// Rating over an accumulated CareerStats bucket (lifetime or a single year), or
// null if it holds no stat-bearing matches. Mirrors careerView's rating.
export function ratingOfCareer(c: CareerStats): number | null {
  if (c.matchesWithStats <= 0) return null;
  return hltvRating1({
    kills: c.kills, deaths: c.deaths, assists: c.assists, damage: c.damage,
    roundsPlayed: c.rounds, k1: c.k1, k2: c.k2, k3: c.k3, k4: c.k4, k5: c.k5,
  });
}
