import type { Side, Weapon, WeaponId, Utility, UtilityId } from "./types.ts";

// Stats derived from CS2 items_game.txt (cycletime, damage, range_modifier,
// armor_ratio → armorPen, headshot multiplier). Costs match CS2 buy menu.
// `range` is the max effective shooting distance in world pixels (not a CS2
// concept — used to gate target acquisition); damage falloff is applied
// multiplicatively via `rangeModifier ^ (distance / WEAPON_FALLOFF_UNIT)`.
//
// World scale: agents render as a ~14 px diameter circle, intended to
// represent a CS player hitbox (~64 CS units across). That fixes the scale
// at 1 px ≈ 64/14 ≈ 4.57 CS units, so 1 tile (29 px) ≈ 3.4 m, putting our
// 32×20 default map at roughly real-Dust2 dimensions. The falloff unit is
// derived from that ratio so CS damage curves transfer 1:1.
export const PIXELS_PER_CS_UNIT = 14 / 64;
// CS uses 500 units in the falloff formula; convert to our pixel space.
export const WEAPON_FALLOFF_UNIT = 500 * PIXELS_PER_CS_UNIT;

export const WEAPONS: Record<WeaponId, Weapon> = {
  knife:  { id: "knife",  name: "Knife",  slot: "knife",  cost: 0,
            damage: 55,  fireRate: 2,    accuracy: 0.9,  range: 32,
            magSize: 0,  reserveAmmo: 0, reloadMs: 0,
            rangeModifier: 1.0, armorPen: 0.85, headshotMultiplier: 3 },
  // Glock-18 — T default. Big mag, low damage, weak armor pen, loose at range.
  glock:  { id: "glock",  name: "Glock",  slot: "pistol", faction: "T", cost: 0,
            damage: 30,  fireRate: 6.67, accuracy: 0.70, range: 320,
            magSize: 20, reserveAmmo: 120, reloadMs: 2200,
            rangeModifier: 0.75, armorPen: 0.475, headshotMultiplier: 4 },
  // USP-S — CT default. Smaller mag but tighter, harder-hitting first shot.
  usp:    { id: "usp",    name: "USP-S",  slot: "pistol", faction: "CT", cost: 0,
            damage: 35,  fireRate: 5.88, accuracy: 0.78, range: 360,
            magSize: 12, reserveAmmo: 24, reloadMs: 2200,
            rangeModifier: 0.91, armorPen: 0.507, headshotMultiplier: 4 },
  // Desert Eagle — one-tap potential, slow ROF, expensive.
  deagle: { id: "deagle", name: "Deagle", slot: "pistol", cost: 700,
            damage: 63,  fireRate: 2.5,  accuracy: 0.78, range: 420,
            magSize: 7,  reserveAmmo: 35, reloadMs: 1900,
            rangeModifier: 0.81, armorPen: 0.93, headshotMultiplier: 4 },
  // MP9 (CT SMG) — high fire rate, tight spray.
  mp9:    { id: "mp9",    name: "MP9",    slot: "smg", faction: "CT", cost: 1250,
            damage: 26,  fireRate: 14.7, accuracy: 0.72, range: 360,
            magSize: 30, reserveAmmo: 120, reloadMs: 2100,
            rangeModifier: 0.75, armorPen: 0.60, headshotMultiplier: 4 },
  // MAC-10 (T SMG) — punchier rounds, looser spray, cheaper.
  mac10:  { id: "mac10",  name: "Mac10",  slot: "smg", faction: "T",  cost: 1050,
            damage: 29,  fireRate: 13.3, accuracy: 0.66, range: 340,
            magSize: 30, reserveAmmo: 100, reloadMs: 2350,
            rangeModifier: 0.65, armorPen: 0.65, headshotMultiplier: 4 },
  // M4A4 (CT rifle) — slightly less damage than AK but more accurate.
  m4:     { id: "m4",     name: "M4",     slot: "rifle", faction: "CT", cost: 3100,
            damage: 33,  fireRate: 10,   accuracy: 0.86, range: 540,
            magSize: 30, reserveAmmo: 90, reloadMs: 3100,
            rangeModifier: 0.97, armorPen: 0.70, headshotMultiplier: 4 },
  // AK-47 (T rifle) — one-shot HS vs helmet, harder spray.
  ak:     { id: "ak",     name: "AK",     slot: "rifle", faction: "T",  cost: 2700,
            damage: 36,  fireRate: 10,   accuracy: 0.80, range: 540,
            magSize: 30, reserveAmmo: 90, reloadMs: 2900,
            rangeModifier: 0.98, armorPen: 0.775, headshotMultiplier: 4 },
  // AWP — one-shot body or HS to any target.
  awp:    { id: "awp",    name: "AWP",    slot: "awp",   cost: 4750,
            damage: 115, fireRate: 1.46, accuracy: 0.95, range: 640,
            magSize: 10, reserveAmmo: 30, reloadMs: 3700,
            rangeModifier: 0.99, armorPen: 0.975, headshotMultiplier: 4 },
};

// Side's free default pistol — what they spawn with on pistol rounds / after death.
export function defaultPistol(side: Side): WeaponId {
  return side === "CT" ? "usp" : "glock";
}

export const UTILITIES: Record<UtilityId, Utility> = {
  smoke: { id: "smoke", name: "Smoke", cost: 300 },
  flash: { id: "flash", name: "Flash", cost: 200 },
  he: { id: "he", name: "HE", cost: 300 },
  molotov: { id: "molotov", name: "Molotov", cost: 400 },
};

export const VEST_COST = 650;
export const HELMET_UPGRADE_COST = 350;

// Base headshot chance per weapon (modulated by aim stat at shoot time).
export const HEADSHOT_BASE: Record<WeaponId, number> = {
  knife: 0,
  glock: 0.10,
  usp: 0.12,
  deagle: 0.22,
  mp9: 0.12,
  mac10: 0.11,
  m4: 0.18,
  ak: 0.20,
  awp: 0.30,
};

