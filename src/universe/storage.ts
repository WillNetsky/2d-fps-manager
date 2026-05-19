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

export function saveUniverse(u: Universe): void {
  localStorage.setItem(SLOT_PREFIX + u.id, JSON.stringify(u));
  const idx = loadIndex().filter(s => s.id !== u.id);
  idx.push({ id: u.id, name: u.name, day: u.day, createdAt: u.createdAt });
  saveIndex(idx);
}

export function deleteUniverse(id: string): void {
  localStorage.removeItem(SLOT_PREFIX + id);
  saveIndex(loadIndex().filter(s => s.id !== id));
}

export function newUniverseId(): string {
  return `u${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
