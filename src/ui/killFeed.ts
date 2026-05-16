import type { KillCause, Side } from "../domain/types.ts";

interface Entry {
  el: HTMLElement;
  bornAt: number;
}

const ENTRY_TTL_MS = 5000;
const MAX_ENTRIES = 6;

export class KillFeed {
  el: HTMLElement;
  private entries: Entry[] = [];
  private rafHandle = 0;

  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "kill-feed";
    parent.appendChild(this.el);
    this.tick();
  }

  push(killer: { name: string; side: Side }, victim: { name: string; side: Side }, weapon: KillCause, headshot: boolean) {
    const row = document.createElement("div");
    row.className = "kf-row";
    const kName = document.createElement("span");
    kName.className = killer.side === "CT" ? "kf-ct" : "kf-t";
    kName.textContent = killer.name;
    const w = document.createElement("span");
    w.className = "kf-weapon";
    w.textContent = ` ${weaponIcon(weapon)}${headshot ? "🎯" : ""} `;
    const vName = document.createElement("span");
    vName.className = victim.side === "CT" ? "kf-ct" : "kf-t";
    vName.textContent = victim.name;
    row.append(kName, w, vName);
    this.el.prepend(row);
    this.entries.unshift({ el: row, bornAt: performance.now() });
    // Drop overflow oldest
    while (this.entries.length > MAX_ENTRIES) {
      const dropped = this.entries.pop();
      dropped?.el.remove();
    }
  }

  clear() {
    for (const e of this.entries) e.el.remove();
    this.entries = [];
  }

  private tick = () => {
    const now = performance.now();
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const e = this.entries[i];
      const age = now - e.bornAt;
      if (age >= ENTRY_TTL_MS) {
        e.el.remove();
        this.entries.splice(i, 1);
      } else if (age > ENTRY_TTL_MS - 500) {
        e.el.style.opacity = String(1 - (age - (ENTRY_TTL_MS - 500)) / 500);
      }
    }
    this.rafHandle = requestAnimationFrame(this.tick);
  };

  dispose() {
    cancelAnimationFrame(this.rafHandle);
    this.clear();
  }
}

function weaponIcon(w: KillCause): string {
  switch (w) {
    case "knife":    return "🔪";
    case "pistol":   return "[P]";
    case "smg":      return "[smg]";
    case "rifle":    return "[rifle]";
    case "awp":      return "[AWP]";
    case "molotov":  return "🔥";
    case "he":       return "💥";
  }
}
