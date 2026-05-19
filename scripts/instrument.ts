// Instrumented rifle-mirror trace on the Empty_Room map.
//
// Builds two teams, forces M4+vest+helmet on CT and AK+vest+helmet on T,
// neutralizes player stats so weapon math is the only variable, and runs
// many seeds. Prints aggregate win rate, then re-plays a chosen seed
// tick-by-tick with shot-level detail.

import type { GameMap, Loadout, Team, WeaponId } from "../src/domain/types.ts";
import { makeTeam, neutralizeTeamStats, setSeed } from "../src/domain/factory.ts";
import { RoundSim } from "../src/sim/round.ts";

const MAP: GameMap = JSON.parse(process.argv[2]!);

function applyRifle(team: Team) {
  const rifle: WeaponId = team.side === "CT" ? "m4" : "ak";
  for (const p of team.players) {
    const l: Loadout = {
      weapon: rifle, utility: [], armor: true, helmet: true,
      keptWeapon: null, keptArmor: false, keptHelmet: false, keptUtility: [],
    };
    team.loadouts[p.id] = l;
  }
}

const NEUTRALIZE = process.env.NEUTRALIZE === "1";

function runOne(seed: number): "CT" | "T" | null {
  setSeed(seed);
  const ct = makeTeam("ct", "CT", "CT");
  const t = makeTeam("t", "T", "T");
  if (NEUTRALIZE) { neutralizeTeamStats(ct, 60); neutralizeTeamStats(t, 60); }
  applyRifle(ct); applyRifle(t);
  const sim = new RoundSim(ct, t, MAP, seed);
  let safety = 100000;
  while (!sim.finished && safety-- > 0) sim.tick();
  return sim.result?.winningSide ?? null;
}

function runTraced(seed: number) {
  setSeed(seed);
  const ct = makeTeam("ct", "CT", "CT");
  const t = makeTeam("t", "T", "T");
  if (NEUTRALIZE) { neutralizeTeamStats(ct, 60); neutralizeTeamStats(t, 60); }
  applyRifle(ct); applyRifle(t);
  const sim = new RoundSim(ct, t, MAP, seed);

  const nameById = new Map<string, string>();
  for (const team of [ct, t]) for (const p of team.players) nameById.set(p.id, `${team.side}:${p.name.split(" ")[0]}`);

  // Snapshot agent positions BEFORE tick to detect movement-at-shot.
  let safety = 100000;
  let firstShotAt = -1;
  let firstKillAt = -1;
  while (!sim.finished && safety-- > 0) {
    // Capture moving state of each agent BEFORE this tick.
    const movingBefore = new Map<string, boolean>();
    for (const a of sim.agents) movingBefore.set(a.playerId, a.path.length > 0);

    sim.tick();

    for (const s of sim.tickShots) {
      if (firstShotAt < 0) firstShotAt = sim.t;
      const shooter = sim.agents.find(a => a.playerId === s.killerId)!;
      const moving = movingBefore.get(s.killerId);
      const d = Math.hypot(s.from.x - s.to.x, s.from.y - s.to.y);
      console.log(
        `t=${String(sim.t).padStart(5)} ${nameById.get(s.killerId)!.padEnd(14)} ` +
        `pos=(${shooter.pos.x.toFixed(0)},${shooter.pos.y.toFixed(0)}) ` +
        `d=${d.toFixed(0)}px moving=${moving ? "Y" : "N"} ` +
        `hit=${s.hit ? "✓" : "·"}`
      );
    }
    for (const e of sim.events) {
      if (e.kind === "kill" && firstKillAt < 0 && e.t > 0) {
        firstKillAt = e.t;
        console.log(`  → KILL at t=${e.t}: ${nameById.get(e.killer)} killed ${nameById.get(e.victim)} (${e.weapon}${e.headshot ? " HS" : ""})`);
      }
    }
    sim.events.length = 0; // drain so we only see new
  }
  const r = sim.result;
  console.log(`\nResult: seed=${seed} winner=${r?.winningSide} outcome=${r?.outcome} dur=${(r?.durationMs ?? 0)/1000}s firstShot=${firstShotAt}ms firstKill=${firstKillAt}ms`);
}

// Mode A: fresh teams each seed (true variance over player rolls).
const N = 1000;
let ctWins = 0, tWins = 0;
const ctSeeds: number[] = [], tSeeds: number[] = [];
for (let s = 0; s < N; s++) {
  const w = runOne(s);
  if (w === "CT") { ctWins++; ctSeeds.push(s); }
  else if (w === "T") { tWins++; tSeeds.push(s); }
}
console.log(`Fresh teams over ${N} seeds: CT ${ctWins} (${(100*ctWins/N).toFixed(1)}%) · T ${tWins} (${(100*tWins/N).toFixed(1)}%)`);

// Mode B: build teams ONCE (one stat roll), play N rounds — same as balance worker.
function runPersistent(N: number, baseSeed: number) {
  setSeed(baseSeed);
  const ct = makeTeam("ct", "CT", "CT");
  const t = makeTeam("t", "T", "T");
  if (NEUTRALIZE) { neutralizeTeamStats(ct, 60); neutralizeTeamStats(t, 60); }
  let cw = 0, tw = 0;
  for (let s = 0; s < N; s++) {
    applyRifle(ct); applyRifle(t);
    for (const p of ct.players) { p.money = 4500; p.mood = 65; p.morale = 65; }
    for (const p of t.players) { p.money = 4500; p.mood = 65; p.morale = 65; }
    const sim = new RoundSim(ct, t, MAP, s + baseSeed * 1_000_000);
    let safety = 100000;
    while (!sim.finished && safety-- > 0) sim.tick();
    if (sim.result?.winningSide === "CT") cw++; else if (sim.result?.winningSide === "T") tw++;
  }
  return { cw, tw };
}
console.log(`\nPersistent teams (5 base seeds × ${N} rounds each):`);
for (let b = 0; b < 5; b++) {
  const { cw, tw } = runPersistent(N, b);
  console.log(`  base=${b}: CT ${cw} (${(100*cw/N).toFixed(1)}%) · T ${tw} (${(100*tw/N).toFixed(1)}%)`);
}
console.log();

// Trace one CT win and one T win for comparison.
console.log(`=== TRACE CT-win seed=${ctSeeds[0]} ===`);
runTraced(ctSeeds[0]);
if (tSeeds.length > 0) {
  console.log(`\n=== TRACE T-win seed=${tSeeds[0]} ===`);
  runTraced(tSeeds[0]);
}
