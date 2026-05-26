import type { Player } from "../domain/types.ts";

// Persistent "form" lives on Player.morale (0..100). It carries between matches
// and is seeded into each match's in-the-moment mood (see buildTeam), so a
// player on a heater shoots better and a tilted one shoots worse. How a player
// reacts to a result is personality-driven:
//   - recovery + composure decide how fast they snap back toward baseline
//     between games (high → shakes off losses, resets for the next game).
//   - tilts-easy / low composure make losses hit harder AND stick: they stay
//     low until they actually win, which resets them.
//   - low ambition ("fun") players barely register wins or losses and sit at a
//     cheerful, high baseline — having fun no matter what.

const MIN = 0, MAX = 100;
const WIN_SWING = 14;    // base morale lift from a win (before personality)
const LOSS_SWING = 16;   // base morale hit from a loss
const PERF_SWING = 10;   // lift/sting from carrying vs. throwing
const TILT_MULT = 1.6;   // how much harder a tilter takes a loss
const NOISE = 3;         // ± random jitter

function clamp(v: number): number { return Math.max(MIN, Math.min(MAX, v)); }

// Emotional resting point. Easy-going (low-ambition) players sit high and happy;
// intense competitors live nearer the middle and ride the result swings.
export function baselineMorale(p: Player): number {
  return 58 + (1 - (p.ambition ?? 50) / 100) * 17; // ~58 (ambitious) .. 75 (fun)
}

type Stat = {
  kills: number; deaths: number; assists: number;
  damage: number; roundsPlayed: number;
};
function impactOf(s: Stat): number {
  const r = Math.max(1, s.roundsPlayed);
  return (s.kills + 0.4 * s.assists - 0.8 * s.deaths) / r; // ~ -0.8..+1.5
}

function isTilter(p: Player): boolean {
  return p.traits.includes("tilts-easy") || p.stats.composure < 40;
}

export interface MatchFormInput {
  winnerIds: string[];
  loserIds: string[];
  stats?: Record<string, Stat>;
  rng?: () => number;
}

// Update persistent form for everyone who played, in-place. Call once per match.
export function applyMatchForm(players: Player[], input: MatchFormInput, index?: Map<string, Player>) {
  const { winnerIds, loserIds, stats, rng = Math.random } = input;
  // Caller may pass a prebuilt id→player index to avoid rebuilding per match.
  const byId = index ?? new Map(players.map(p => [p.id, p] as const));

  const process = (ids: string[], won: boolean) => {
    for (const id of ids) {
      const p = byId.get(id);
      if (!p) continue;
      const amb = (p.ambition ?? 50) / 100;
      const composureW = p.stats.composure / 100;
      const recoveryW = p.stats.recovery / 100;
      const tilter = isTilter(p);
      const B = baselineMorale(p);
      const cur = typeof p.morale === "number" ? p.morale : B;

      // 1) Result swing — fun players barely register W/L, ambitious ride it.
      let swing = (won ? WIN_SWING : -LOSS_SWING) * (0.25 + 0.75 * amb);
      // Carrying lifts, throwing stings — felt regardless of personality.
      if (stats && stats[id]) {
        swing += PERF_SWING * Math.max(-1, Math.min(1.2, impactOf(stats[id])));
      }
      // Tilters take losses harder.
      if (!won && tilter) swing *= TILT_MULT;
      swing += (rng() * 2 - 1) * NOISE;

      // 2) Pull back toward baseline — recovery + composure set the reset speed
      //    (shake it off / reset for next game). Tilters barely climb back up
      //    from a low spot until they win, so a loss leaves them stuck low.
      let pull = (B - cur) * (0.12 + (recoveryW * 0.6 + composureW * 0.4) * 0.5);
      if (tilter && cur < B && !won) pull *= 0.2;

      p.morale = clamp(cur + swing + pull);
    }
  };

  process(winnerIds, true);
  process(loserIds, false);
}
