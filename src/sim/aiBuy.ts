import type { Team, UtilityId, WeaponId } from "../domain/types.ts";
import { WEAPONS, defaultPistol } from "../domain/weapons.ts";

const VEST = 650;
const HELMET = 350;
const UPRICE: Record<UtilityId, number> = { smoke: 300, flash: 200, he: 300, molotov: 400 };

const isPistolRoundDefault: (n: number) => boolean = (n) => n === 1 || n === 13;

// Stat-weighted auto-buy for every player on the team. Mutates team.loadouts
// and player money. Extracted from game.ts so observe-mode matches (universe
// mode, balance sims) can reuse the same buy logic.
export function aiBuyFor(team: Team, roundNumber: number, isPistolRound = isPistolRoundDefault) {
  const rifle: WeaponId = team.side === "T" ? "ak" : "m4";
  const smg: WeaponId   = team.side === "T" ? "mac10" : "mp9";
  const W = (id: WeaponId) => WEAPONS[id];

  for (const p of team.players) {
    const existing = team.loadouts[p.id];
    const kept = existing.keptWeapon;
    const keptArmor = existing.keptArmor;
    const keptHelmet = existing.keptHelmet;
    const keptUtil = [...existing.keptUtility];
    const share = p.money;
    const wCost = (id: WeaponId) => id === kept ? 0 : W(id).cost;
    const uCost = (u: UtilityId) => keptUtil.includes(u) ? 0 : UPRICE[u];

    let weapon: WeaponId = kept ?? defaultPistol(team.side);
    let spent = 0;
    let armor = keptArmor;
    let helmet = keptHelmet;
    const util: UtilityId[] = [...keptUtil];
    const smokeW = Math.max(1, p.stats.smokeLineups);
    const flashW = Math.max(1, p.stats.flashTiming);
    const want: UtilityId = Math.random() * (smokeW + flashW) < smokeW ? "smoke" : "flash";

    if (isPistolRound(roundNumber)) {
      weapon = defaultPistol(team.side);
      helmet = false;
      const vestChance = 0.25 + (p.stats.composure + p.stats.discipline) / 400;
      const wantsVest = Math.random() < vestChance;
      if (wantsVest && share >= VEST) {
        armor = true;
        spent += VEST;
      } else if (!util.includes(want) && share - spent >= uCost(want)) {
        util.push(want);
        spent += uCost(want);
      }
    } else {
      const isRifle = (w: WeaponId) => W(w).slot === "rifle";
      const awpChance = Math.max(0, (p.stats.awpPref - 50) / 50);
      const wantsAwp = Math.random() < awpChance;
      if (wantsAwp && weapon !== "awp" && share >= wCost("awp")) weapon = "awp";
      else if (!isRifle(weapon) && weapon !== "awp" && share >= wCost(rifle)) weapon = rifle;
      else if (W(weapon).slot === "pistol" && share >= wCost(smg)) weapon = smg;
      if (W(weapon).slot === "pistol" && weapon !== "deagle" && share >= wCost("deagle")) weapon = "deagle";

      spent = wCost(weapon);
      if (!armor && W(weapon).slot !== "pistol" && share - spent >= VEST) { armor = true; spent += VEST; }
      if (armor && !helmet && W(weapon).slot !== "pistol" && share - spent >= HELMET) { helmet = true; spent += HELMET; }
      if (!util.includes(want) && share - spent >= uCost(want)) {
        util.push(want);
        spent += uCost(want);
      }
    }

    team.loadouts[p.id] = {
      weapon, utility: util, armor, helmet,
      keptWeapon: kept, keptArmor, keptHelmet, keptUtility: keptUtil,
    };
    p.money = Math.max(0, p.money - spent);
  }
}
