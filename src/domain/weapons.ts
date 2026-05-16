import type { Weapon, WeaponId, Utility, UtilityId } from "./types.ts";

export const WEAPONS: Record<WeaponId, Weapon> = {
  knife: { id: "knife", name: "Knife", cost: 0, damage: 50, fireRate: 2, accuracy: 0.9, range: 32 },
  pistol: { id: "pistol", name: "Pistol", cost: 0, damage: 22, fireRate: 4, accuracy: 0.72, range: 320 },
  smg: { id: "smg", name: "SMG", cost: 1250, damage: 26, fireRate: 10, accuracy: 0.7, range: 360 },
  rifle: { id: "rifle", name: "Rifle", cost: 2700, damage: 32, fireRate: 8, accuracy: 0.82, range: 520 },
  awp: { id: "awp", name: "AWP", cost: 4750, damage: 115, fireRate: 1, accuracy: 0.95, range: 640 },
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
  smg: 0.12,
  rifle: 0.18,
  awp: 0.30,
};

export const HEADSHOT_MULTIPLIER = 4;
export const HELMET_HS_REDUCTION = 0.5;
