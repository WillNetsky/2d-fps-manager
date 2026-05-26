// Web Worker that runs the headless universe simulation off the main thread, so
// fast-forwarding many days (or simming a full day of hundreds of matches) never
// freezes the UI. The pure engine lives in universeSim.ts; this file is just the
// message boundary. Spawned per request and terminated on completion by
// universeMode.ts (mirrors balanceWorker.ts).

import { simulateDays, simPendingDay, type SimState } from "./universeSim.ts";
import type { CompletedDay } from "./types.ts";

export type SimWorkerRequest =
  | { kind: "simDays"; state: SimState; nDays: number }
  | { kind: "simPendingDay"; state: SimState };

export type SimWorkerResponse =
  | { kind: "progress"; done: number; total: number }
  | { kind: "doneDays"; state: SimState; completedDays: CompletedDay[] }
  | { kind: "donePending"; state: SimState };

const post = (msg: SimWorkerResponse) => (self as unknown as Worker).postMessage(msg);

self.onmessage = (e: MessageEvent<SimWorkerRequest>) => {
  const msg = e.data;
  if (msg.kind === "simDays") {
    const { completedDays } = simulateDays(msg.state, msg.nDays, done => {
      post({ kind: "progress", done, total: msg.nDays });
    });
    post({ kind: "doneDays", state: msg.state, completedDays });
  } else if (msg.kind === "simPendingDay") {
    simPendingDay(msg.state);
    post({ kind: "donePending", state: msg.state });
  }
};
