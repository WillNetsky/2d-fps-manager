// Web Worker that simulates a batch of matches off the main thread. The
// coordinator (universeMode.ts) runs a pool of these and hands each one a slice
// of a day's matchups — every player plays one match per day, so the matches
// are independent and can run in parallel. Folding results into elo/chemistry/
// form happens back on the coordinator. The pure engine lives in universeSim.ts.

import { simulateMatchup, type MatchupOutcome } from "./universeSim.ts";
import type { GameMap, Player } from "../domain/types.ts";
import type { Matchup } from "./types.ts";

export type SimWorkerRequest =
  | { kind: "init"; maps: GameMap[] }
  | { kind: "simMatches"; players: Player[]; matchups: Matchup[] };

export type SimWorkerResponse =
  | { kind: "matchResults"; results: MatchupOutcome[] };

// Maps are sent once at init and reused for every batch — they carry large wall
// arrays, so we avoid re-cloning them across postMessage on every day.
let maps: GameMap[] = [];

const post = (msg: SimWorkerResponse) => (self as unknown as Worker).postMessage(msg);

self.onmessage = (e: MessageEvent<SimWorkerRequest>) => {
  const msg = e.data;
  if (msg.kind === "init") {
    maps = msg.maps;
    return;
  }
  // simMatches
  const byId = new Map(msg.players.map(p => [p.id, p] as const));
  const results = msg.matchups.map(m => simulateMatchup(m, byId, maps));
  post({ kind: "matchResults", results });
};
