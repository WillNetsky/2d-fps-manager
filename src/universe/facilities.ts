// Org facilities — the money sink that develops players. Pure helpers (no DOM,
// no storage), mirroring finance.ts. An org spends its surplus on three leveled
// facilities; each accelerates a slice of its roster's seasonal stat development
// (and Sports Science also softens veteran decline and nudges morale). Facilities
// cost a rising one-off to upgrade plus per-cycle upkeep, so they track success
// rather than running away — a struggling org can't sustain a big setup.
//
// The Universe is AI-simulated, so investment is an AI behavior (runFacilityCycle);
// the levels are surfaced read-only on the team page.

import type { Player } from "../domain/types.ts";
import type { UniverseTeam } from "./types.ts";

export type FacilityKey = "training" | "analysts" | "sportsScience";
export const FACILITY_MAX = 5;

// Which stat groups each facility develops (names match the category arrays in
// lifecycle.ts). Used by the AI, the development bonus, and the UI.
export interface FacilityMeta {
  key: FacilityKey;
  label: string;
  blurb: string;
}
export const FACILITIES: FacilityMeta[] = [
  { key: "training",      label: "Training Center", blurb: "Aim & mechanics development" },
  { key: "analysts",      label: "Analysts",        blurb: "Game sense, utility & teamplay development" },
  { key: "sportsScience", label: "Sports Science",  blurb: "Mental development, slows veteran decline, lifts morale" },
];

// ---- tuning ----------------------------------------------------------------

const BASE_FACILITY_COST = 150_000;   // upgrade cost scale (rises with level)
const UPKEEP_PER_LEVEL = 8_000;       // per-cycle upkeep, per facility level
const DEV_PER_LEVEL = 0.25;           // seasonal stat-delta bonus per level
const DECLINE_REDUCE_PER_LEVEL = 0.08; // Sports Science softens negative deltas
const MORALE_PER_LEVEL = 1;           // Sports Science morale bump per cycle, per level
const COMFORT_BUFFER = 300_000;       // cash an org keeps before investing
const PRO_BUFFER_FACTOR = 0.5;        // pros tolerate a smaller buffer (build faster)

// ---- reads -----------------------------------------------------------------

export function facilityLevel(team: UniverseTeam, key: FacilityKey): number {
  return team.facilities?.[key] ?? 0;
}

// Cost to go from `level` to `level + 1` — a rising one-off.
export function upgradeCost(level: number): number {
  return Math.round(BASE_FACILITY_COST * Math.pow(level + 1, 1.6) / 1000) * 1000;
}

// An org's total per-cycle facility upkeep (all facilities, scaled by level).
export function facilityUpkeep(team: UniverseTeam): number {
  let lvls = 0;
  for (const f of FACILITIES) lvls += facilityLevel(team, f.key);
  return lvls * UPKEEP_PER_LEVEL;
}

// ---- development bonus -----------------------------------------------------

// Per-category seasonal development bonus an org's facilities grant its roster,
// plus a multiplier applied to NEGATIVE (decline) deltas. Consumed by
// advancePlayerCareers (lifecycle.ts). Category names match its stat arrays.
export interface DevBonus {
  physical: number;
  aim: number;
  cognitive: number;
  mental: number;
  utility: number;
  team: number;
  declineMult: number; // <= 1; smaller = decline softened more
}

export function developmentBonus(team: UniverseTeam): DevBonus {
  const tr = facilityLevel(team, "training");
  const an = facilityLevel(team, "analysts");
  const ss = facilityLevel(team, "sportsScience");
  return {
    physical: tr * DEV_PER_LEVEL,
    aim: tr * DEV_PER_LEVEL,
    cognitive: an * DEV_PER_LEVEL,
    utility: an * DEV_PER_LEVEL,
    team: an * DEV_PER_LEVEL,
    mental: ss * DEV_PER_LEVEL,
    declineMult: Math.max(0, 1 - ss * DECLINE_REDUCE_PER_LEVEL),
  };
}

// ---- AI investment cycle ---------------------------------------------------

// Once per event cycle: each active org invests surplus into its lowest-level
// affordable facility (balanced build-out) while keeping a comfort buffer in the
// bank — pros tolerate a smaller buffer, so they build faster. Then Sports
// Science lifts the active roster's morale a touch. Mutates team.facilities,
// team.balance, and player morale in place.
export function runFacilityCycle(teams: UniverseTeam[], players: Player[], day: number): void {
  void day; // reserved for future facility history/news; keeps the call signature stable
  const byId = new Map(players.map(p => [p.id, p] as const));
  for (const t of teams) {
    if (t.disbandedDay || t.playerIds.length === 0) continue;

    // Invest: cheapest improving upgrade we can afford above the buffer.
    const buffer = t.tier === "pro" ? COMFORT_BUFFER * PRO_BUFFER_FACTOR : COMFORT_BUFFER;
    const upgradable = FACILITIES
      .map(f => ({ key: f.key, level: facilityLevel(t, f.key) }))
      .filter(f => f.level < FACILITY_MAX)
      .sort((a, b) => a.level - b.level);
    for (const f of upgradable) {
      const cost = upgradeCost(f.level);
      if ((t.balance ?? 0) - cost < buffer) continue;
      t.balance = (t.balance ?? 0) - cost;
      (t.facilities ??= {})[f.key] = f.level + 1;
      break; // one upgrade per cycle
    }

    // Sports Science welfare: a small morale lift for the active roster.
    const ss = facilityLevel(t, "sportsScience");
    if (ss > 0) {
      const active = t.activeIds ?? t.playerIds.slice(0, 5);
      for (const id of active) {
        const p = byId.get(id);
        if (p) p.morale = Math.max(0, Math.min(100, p.morale + ss * MORALE_PER_LEVEL));
      }
    }
  }
}
