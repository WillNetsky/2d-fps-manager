// src/domain/weapons.ts
var WEAPONS = {
  knife: {
    id: "knife",
    name: "Knife",
    slot: "knife",
    cost: 0,
    damage: 55,
    fireRate: 2,
    accuracy: 0.9,
    range: 32,
    magSize: 0,
    reserveAmmo: 0,
    reloadMs: 0,
    rangeModifier: 1,
    armorPen: 0.85,
    headshotMultiplier: 3
  },
  // Glock-18 — T default. Big mag, low damage, weak armor pen, loose at range.
  glock: {
    id: "glock",
    name: "Glock",
    slot: "pistol",
    faction: "T",
    cost: 0,
    damage: 30,
    fireRate: 6.67,
    accuracy: 0.7,
    range: 320,
    magSize: 20,
    reserveAmmo: 120,
    reloadMs: 2200,
    rangeModifier: 0.75,
    armorPen: 0.475,
    headshotMultiplier: 4
  },
  // USP-S — CT default. Smaller mag but tighter, harder-hitting first shot.
  usp: {
    id: "usp",
    name: "USP-S",
    slot: "pistol",
    faction: "CT",
    cost: 0,
    damage: 35,
    fireRate: 5.88,
    accuracy: 0.78,
    range: 360,
    magSize: 12,
    reserveAmmo: 24,
    reloadMs: 2200,
    rangeModifier: 0.91,
    armorPen: 0.507,
    headshotMultiplier: 4
  },
  // Desert Eagle — one-tap potential, slow ROF, expensive.
  deagle: {
    id: "deagle",
    name: "Deagle",
    slot: "pistol",
    cost: 700,
    damage: 63,
    fireRate: 2.5,
    accuracy: 0.78,
    range: 420,
    magSize: 7,
    reserveAmmo: 35,
    reloadMs: 1900,
    rangeModifier: 0.81,
    armorPen: 0.93,
    headshotMultiplier: 4
  },
  // MP9 (CT SMG) — high fire rate, tight spray.
  mp9: {
    id: "mp9",
    name: "MP9",
    slot: "smg",
    faction: "CT",
    cost: 1250,
    damage: 26,
    fireRate: 14.7,
    accuracy: 0.72,
    range: 360,
    magSize: 30,
    reserveAmmo: 120,
    reloadMs: 2100,
    rangeModifier: 0.75,
    armorPen: 0.6,
    headshotMultiplier: 4
  },
  // MAC-10 (T SMG) — punchier rounds, looser spray, cheaper.
  mac10: {
    id: "mac10",
    name: "Mac10",
    slot: "smg",
    faction: "T",
    cost: 1050,
    damage: 29,
    fireRate: 13.3,
    accuracy: 0.66,
    range: 340,
    magSize: 30,
    reserveAmmo: 100,
    reloadMs: 2350,
    rangeModifier: 0.65,
    armorPen: 0.65,
    headshotMultiplier: 4
  },
  // M4A4 (CT rifle) — slightly less damage than AK but more accurate.
  m4: {
    id: "m4",
    name: "M4",
    slot: "rifle",
    faction: "CT",
    cost: 3100,
    damage: 33,
    fireRate: 10,
    accuracy: 0.86,
    range: 540,
    magSize: 30,
    reserveAmmo: 90,
    reloadMs: 3100,
    rangeModifier: 0.97,
    armorPen: 0.7,
    headshotMultiplier: 4
  },
  // AK-47 (T rifle) — one-shot HS vs helmet, harder spray.
  ak: {
    id: "ak",
    name: "AK",
    slot: "rifle",
    faction: "T",
    cost: 2700,
    damage: 36,
    fireRate: 10,
    accuracy: 0.8,
    range: 540,
    magSize: 30,
    reserveAmmo: 90,
    reloadMs: 2900,
    rangeModifier: 0.98,
    armorPen: 0.775,
    headshotMultiplier: 4
  },
  // AWP — one-shot body or HS to any target.
  awp: {
    id: "awp",
    name: "AWP",
    slot: "awp",
    cost: 4750,
    damage: 115,
    fireRate: 1.46,
    accuracy: 0.95,
    range: 640,
    magSize: 10,
    reserveAmmo: 30,
    reloadMs: 3700,
    rangeModifier: 0.99,
    armorPen: 0.975,
    headshotMultiplier: 4
  }
};

// scripts/dmg_table.ts
var labels = ["glock", "usp", "deagle", "mp9", "mac10", "m4", "ak", "awp"];
console.log("weapon  body  bodyV  HS    HS+helmet  one-tap?");
for (const id of labels) {
  const w = WEAPONS[id];
  const body = w.damage;
  const bodyV = w.damage * w.armorPen;
  const hs = w.damage * w.headshotMultiplier;
  const hsH = hs * w.armorPen;
  const tap = hsH >= 100 ? "HS+helm" : hs >= 100 ? "HS only" : body >= 100 ? "body!" : "\u2014";
  console.log(`${id.padEnd(7)} ${body.toFixed(0).padStart(4)}  ${bodyV.toFixed(1).padStart(5)}  ${hs.toFixed(0).padStart(4)}  ${hsH.toFixed(1).padStart(9)}  ${tap}`);
}
