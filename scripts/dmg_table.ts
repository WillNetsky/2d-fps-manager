// One-tap reference: prints per-weapon damage at body/HS × armored/not.
import { WEAPONS } from "../src/domain/weapons.ts";

const labels = ["glock", "usp", "deagle", "mp9", "mac10", "m4", "ak", "awp"] as const;
console.log("weapon  body  bodyV  HS    HS+helmet  one-tap?");
for (const id of labels) {
  const w = WEAPONS[id];
  const body = w.damage;
  const bodyV = w.damage * w.armorPen;
  const hs = w.damage * w.headshotMultiplier;
  const hsH = hs * w.armorPen;
  const tap = hsH >= 100 ? "HS+helm" : hs >= 100 ? "HS only" : body >= 100 ? "body!" : "—";
  console.log(`${id.padEnd(7)} ${body.toFixed(0).padStart(4)}  ${bodyV.toFixed(1).padStart(5)}  ${hs.toFixed(0).padStart(4)}  ${hsH.toFixed(1).padStart(9)}  ${tap}`);
}
