import type { Universe, UniverseSummary, CompletedDay } from "./types.ts";
import {
  idbAvailable, idbGet, idbGetAll, idbPut, idbPutMany, idbDelete,
  STORE_META, STORE_CORE, STORE_DAYS,
} from "./idb.ts";

// How many of the most recent completed days are loaded into memory. The full
// archive lives in IndexedDB (the `days` store); only this window is held in
// `Universe.history` for the game log / replay UI. Career aggregates survive
// trimming, so lifetime stats are unaffected by the window size.
export const HISTORY_WINDOW = 60;

// A universe is persisted as three kinds of record so we never re-serialize the
// whole world on every save:
//   meta — small summary, powers the load menu
//   core — everything except history (players, elos, careers, maps, pendingDay)
//   days — one record per completed day, written once and never rewritten
// `core` is rewritten on every save but is bounded (players + the in-progress
// day), so it stays small even with thousands of players.
type UniverseCore = Omit<Universe, "history">;
interface DayRecord { universeId: string; day: number; matchups: CompletedDay["matchups"]; }

// All day records for a universe: compound keys [id, day] sort lexicographically,
// so bounding the second component across the full day range selects them all.
const dayRange = (id: string) => IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]);

// ---- localStorage fallback (private-mode browsers without IndexedDB) -------

const LS_INDEX = "2d-fps-universes";
const LS_SLOT = "2d-fps-universe-";

function lsList(): UniverseSummary[] {
  const raw = localStorage.getItem(LS_INDEX);
  if (!raw) return [];
  try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
}
function lsSave(u: Universe): void {
  // Degraded mode: store the whole universe as one blob, shedding the oldest
  // history under quota pressure (same behaviour the app had before IDB).
  for (;;) {
    try {
      localStorage.setItem(LS_SLOT + u.id, JSON.stringify(u));
      const idx = lsList().filter(s => s.id !== u.id);
      idx.push({ id: u.id, name: u.name, day: u.day, createdAt: u.createdAt });
      localStorage.setItem(LS_INDEX, JSON.stringify(idx));
      return;
    } catch (e) {
      const quota = e instanceof DOMException &&
        (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED");
      if (quota && u.history.length > 0) { u.history.shift(); continue; }
      throw e;
    }
  }
}

// ---- public async API ------------------------------------------------------

export async function listUniverses(): Promise<UniverseSummary[]> {
  if (!idbAvailable()) return lsList().sort((a, b) => b.createdAt - a.createdAt);
  const metas = await idbGetAll<UniverseSummary>(STORE_META);
  return metas.sort((a, b) => b.createdAt - a.createdAt);
}

export async function loadUniverse(id: string): Promise<Universe | null> {
  if (!idbAvailable()) {
    const raw = localStorage.getItem(LS_SLOT + id);
    if (!raw) return null;
    try { return JSON.parse(raw) as Universe; } catch { return null; }
  }
  const core = await idbGet<UniverseCore>(STORE_CORE, id);
  if (!core) return null;
  const days = await idbGetAll<DayRecord>(STORE_DAYS, dayRange(id));
  days.sort((a, b) => a.day - b.day);
  const recent = days.slice(-HISTORY_WINDOW);
  const history: CompletedDay[] = recent.map(d => ({ day: d.day, matchups: d.matchups }));
  return { ...core, history } as Universe;
}

// Persist the live working set (everything except completed-day history). Cheap
// and bounded; safe to call on every match completion. Completed days are
// written separately via appendDays when a day rolls over.
export async function saveUniverse(u: Universe): Promise<void> {
  if (!idbAvailable()) { lsSave(u); return; }
  const { history: _drop, ...core } = u;
  const meta: UniverseSummary = { id: u.id, name: u.name, day: u.day, createdAt: u.createdAt };
  await idbPut(STORE_CORE, core);
  await idbPut(STORE_META, meta);
}

// Append completed days to the archive. Each is written once, in a single
// transaction, and never rewritten — this is what stops history from bloating
// every save. No-op under the localStorage fallback (days ride inside the blob).
export async function appendDays(universeId: string, days: CompletedDay[]): Promise<void> {
  if (!idbAvailable() || days.length === 0) return;
  const records: DayRecord[] = days.map(d => ({ universeId, day: d.day, matchups: d.matchups }));
  await idbPutMany(STORE_DAYS, records);
}

export async function deleteUniverse(id: string): Promise<void> {
  if (!idbAvailable()) {
    localStorage.removeItem(LS_SLOT + id);
    localStorage.setItem(LS_INDEX, JSON.stringify(lsList().filter(s => s.id !== id)));
    return;
  }
  await idbDelete(STORE_CORE, id);
  await idbDelete(STORE_META, id);
  await idbDelete(STORE_DAYS, dayRange(id));
}

export function newUniverseId(): string {
  return `u${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
