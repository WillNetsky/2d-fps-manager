import type { Weapon, WeaponId, Utility, UtilityId } from "./types.ts";

export const WEAPONS: Record<WeaponId, Weapon> = {
  knife:  { id: "knife",  name: "Knife",  slot: "knife",  cost: 0,    damage: 50,  fireRate: 2,  accuracy: 0.9,  range: 32,
            magSize: 0,  reserveAmmo: 0,  reloadMs: 0 },
  pistol: { id: "pistol", name: "Pistol", slot: "pistol", cost: 0,    damage: 22,  fireRate: 4,  accuracy: 0.72, range: 320,
            magSize: 15, reserveAmmo: 60, reloadMs: 1500 },
  // Deagle: high-damage pistol, slow ROF, expensive. One-tap potential.
  deagle: { id: "deagle", name: "Deagle", slot: "pistol", cost: 700,  damage: 55,  fireRate: 2.5, accuracy: 0.78, range: 420,
            magSize: 7,  reserveAmmo: 35, reloadMs: 1900 },
  // CT SMG — slightly tighter spray, smaller mag.
  mp9:    { id: "mp9",    name: "MP9",    slot: "smg", faction: "CT", cost: 1250, damage: 24,  fireRate: 12, accuracy: 0.72, range: 360,
            magSize: 30, reserveAmmo: 90, reloadMs: 2300 },
  // T SMG — heavier rounds, more recoil, cheaper.
  mac10:  { id: "mac10",  name: "Mac10",  slot: "smg", faction: "T",  cost: 1050, damage: 27,  fireRate: 11, accuracy: 0.66, range: 340,
            magSize: 30, reserveAmmo: 90, reloadMs: 2500 },
  // CT rifle — accurate, expensive.
  m4:     { id: "m4",     name: "M4",     slot: "rifle", faction: "CT", cost: 3100, damage: 30,  fireRate: 8.5, accuracy: 0.86, range: 540,
            magSize: 30, reserveAmmo: 90, reloadMs: 3100 },
  // T rifle — hits harder, less accurate, cheaper.
  ak:     { id: "ak",     name: "AK",     slot: "rifle", faction: "T",  cost: 2700, damage: 36,  fireRate: 7.5, accuracy: 0.80, range: 520,
            magSize: 30, reserveAmmo: 90, reloadMs: 2900 },
  awp:    { id: "awp",    name: "AWP",    slot: "awp",   cost: 4750, damage: 115, fireRate: 1,  accuracy: 0.95, range: 640,
            magSize: 5,  reserveAmmo: 20, reloadMs: 3700 },
};

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
  pistol: 0.10,
  deagle: 0.22,
  mp9: 0.12,
  mac10: 0.11,
  m4: 0.18,
  ak: 0.20,
  awp: 0.30,
};

export const HEADSHOT_MULTIPLIER = 4;
export const HELMET_HS_REDUCTION = 0.5;
