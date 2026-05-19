// Run the balance matrix using the actual balance worker logic.
import type { GameMap } from "../src/domain/types.ts";
import { ALL_PRESETS, PRESET_LABELS, simulateCell } from "../src/balance/balanceWorker.ts";

const MAP: GameMap = JSON.parse(process.argv[2]!);
const ROUNDS = Number(process.argv[3] ?? 5000);

console.log(`Matrix on "${MAP.name}", ${ROUNDS} rounds/cell, neutralize=true, resetEachRound=false\n`);
const pad = (s: string, n: number) => s.padEnd(n);
console.log(`${pad("CT", 18)} ${pad("T", 18)} ${pad("CT win %", 9)} ${pad("Plant %", 9)} avg dur (s)`);

for (const ct of ALL_PRESETS) {
  for (const t of ALL_PRESETS) {
    const stats = simulateCell({
      map: MAP, rounds: ROUNDS, neutralize: true, resetEachRound: false,
      ctLoadout: ct, tLoadout: t, onProgress: () => {},
    });
    const ctPct = (100 * stats.ctWins / stats.rounds).toFixed(1);
    const plantPct = (100 * stats.plants / stats.rounds).toFixed(1);
    const dur = (stats.totalDurationMs / stats.rounds / 1000).toFixed(1);
    console.log(`${pad(PRESET_LABELS[ct], 18)} ${pad(PRESET_LABELS[t], 18)} ${pad(ctPct + "%", 9)} ${pad(plantPct + "%", 9)} ${dur}`);
  }
}
