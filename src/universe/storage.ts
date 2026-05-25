import type { Universe, UniverseSummary } from "./types.ts";

const INDEX_KEY = "2d-fps-universes";
const SLOT_PREFIX = "2d-fps-universe-";

function loadIndex(): UniverseSummary[] {
  const raw = localStorage.getItem(INDEX_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveIndex(idx: UniverseSummary[]) {
  localStorage.setItem(INDEX_KEY, JSON.stringify(idx));
}

export function listUniverses(): UniverseSummary[] {
  return loadIndex().sort((a, b) => b.createdAt - a.createdAt);
}

export function loadUniverse(id: string): Universe | null {
  const raw = localStorage.getItem(SLOT_PREFIX + id);
  if (!raw) return null;
  try { return JSON.parse(raw) as Universe; } catch { return null; }
}

function isQuotaError(e: unknown): boolean {
  return e instanceof DOMException &&
    (e.name === "QuotaExceededError" || e.name === "NS_ERROR_DOM_QUOTA_REACHED");
}

// Persist a universe. `history` grows by ~one full day of matchups per sim'd
// day, so a long-running universe can exceed the localStorage quota (~5 MB).
// Rather than throwing — which used to leave the sim overlay stuck on screen
// and freeze the app — we shed the oldest days of history and retry. Recent
// days are kept; only deep career history degrades, and only under pressure.
// Returns the number of history days dropped (0 on a clean save).
export function saveUniverse(u: Universe): number {
  let dropped = 0;
  for (;;) {
    try {
      localStorage.setItem(SLOT_PREFIX + u.id, JSON.stringify(u));
      const idx = loadIndex().filter(s => s.id !== u.id);
      idx.push({ id: u.id, name: u.name, day: u.day, createdAt: u.createdAt });
      saveIndex(idx);
      return dropped;
    } catch (e) {
      if (isQuotaError(e) && u.history.length > 0) {
        u.history.shift(); // drop the oldest day and try again
        dropped++;
        continue;
      }
      throw e;
    }
  }
}

export function deleteUniverse(id: string): void {
  localStorage.removeItem(SLOT_PREFIX + id);
  saveIndex(loadIndex().filter(s => s.id !== id));
}

export function newUniverseId(): string {
  return `u${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
