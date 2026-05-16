import type { PlayerStats } from "./types.ts";

// 5-cell summary used by player cards. Average of the underlying fine-grained ratings.
export function statSummary(s: PlayerStats) {
  const avg = (...keys: Array<keyof PlayerStats>) =>
    Math.round(keys.reduce((sum, k) => sum + s[k], 0) / keys.length);
  return {
    aim: avg("accuracy", "crosshairPlacement", "sprayControl", "tapping", "flickAim", "counterStrafe"),
    reflexes: avg("reflexes", "handSpeed"),
    gameSense: avg("mapAwareness", "positioning", "gameSense", "timing", "adaptability"),
    nerve: avg("composure", "discipline", "recovery"),
    utility: avg("utility", "smokeLineups", "flashTiming", "molotovUse"),
  };
}
