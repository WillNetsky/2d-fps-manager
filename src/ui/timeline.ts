import type { SimEvent, Side } from "../domain/types.ts";

export interface TimelineHandlers {
  onSeek(tickIdx: number): void;
  onPlayPauseToggle(): void;
}

export type SideOf = (playerId: string) => Side | null;

export class Timeline {
  el: HTMLElement;
  private bar: HTMLElement;
  private progressEl: HTMLElement;
  private handleEl: HTMLElement;
  private markersEl: HTMLElement;
  private playBtn: HTMLButtonElement;
  private timeLabel: HTMLElement;
  private titleEl: HTMLElement;

  private totalTicks = 0;
  private currentIdx = 0;
  private playing = false;
  private events: SimEvent[] = [];
  private tickMs = 50;
  private sideOf: SideOf = () => null;

  constructor(parent: HTMLElement, private handlers: TimelineHandlers) {
    this.el = document.createElement("div");
    this.el.className = "replay";

    const headerRow = document.createElement("div");
    headerRow.className = "replay-header";
    this.titleEl = document.createElement("span");
    this.titleEl.className = "replay-title";
    this.titleEl.textContent = "REPLAY · prev round";
    headerRow.appendChild(this.titleEl);
    this.el.appendChild(headerRow);

    const row = document.createElement("div");
    row.className = "replay-row";

    this.playBtn = document.createElement("button");
    this.playBtn.className = "replay-btn";
    this.playBtn.textContent = "▶";
    this.playBtn.onclick = () => this.handlers.onPlayPauseToggle();
    row.appendChild(this.playBtn);

    this.bar = document.createElement("div");
    this.bar.className = "replay-bar";
    this.progressEl = document.createElement("div");
    this.progressEl.className = "replay-progress";
    this.bar.appendChild(this.progressEl);
    this.markersEl = document.createElement("div");
    this.markersEl.className = "replay-markers";
    this.bar.appendChild(this.markersEl);
    this.handleEl = document.createElement("div");
    this.handleEl.className = "replay-handle";
    this.bar.appendChild(this.handleEl);
    row.appendChild(this.bar);

    this.timeLabel = document.createElement("span");
    this.timeLabel.className = "replay-time";
    this.timeLabel.textContent = "0:00";
    row.appendChild(this.timeLabel);

    this.el.appendChild(row);
    parent.appendChild(this.el);

    this.attachScrub();
  }

  private attachScrub() {
    let dragging = false;
    const seekFromEvent = (e: MouseEvent) => {
      const rect = this.bar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const idx = Math.floor(ratio * Math.max(0, this.totalTicks - 1));
      this.handlers.onSeek(idx);
    };
    this.bar.addEventListener("mousedown", (e) => {
      dragging = true; seekFromEvent(e);
    });
    window.addEventListener("mousemove", (e) => {
      if (dragging) seekFromEvent(e);
    });
    window.addEventListener("mouseup", () => { dragging = false; });
  }

  setReplay(totalTicks: number, events: SimEvent[], tickMs: number, title?: string, sideOf?: SideOf) {
    this.totalTicks = totalTicks;
    this.events = events;
    this.tickMs = tickMs;
    if (sideOf) this.sideOf = sideOf;
    if (title) this.titleEl.textContent = title;
    this.renderMarkers();
    this.setIndex(0);
  }

  setIndex(idx: number) {
    this.currentIdx = Math.max(0, Math.min(idx, this.totalTicks - 1));
    const ratio = this.totalTicks > 1 ? this.currentIdx / (this.totalTicks - 1) : 0;
    this.progressEl.style.width = `${ratio * 100}%`;
    this.handleEl.style.left = `${ratio * 100}%`;
    const seconds = Math.floor((this.currentIdx * this.tickMs) / 1000);
    this.timeLabel.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }

  setPlaying(playing: boolean) {
    this.playing = playing;
    this.playBtn.textContent = this.playing ? "❚❚" : "▶";
  }

  private renderMarkers() {
    this.markersEl.innerHTML = "";
    if (this.totalTicks <= 1) return;
    const totalMs = (this.totalTicks - 1) * this.tickMs;
    for (const e of this.events) {
      const ratio = totalMs > 0 ? e.t / totalMs : 0;
      const m = document.createElement("div");
      let extra = "";
      if (e.kind === "kill") {
        const side = this.sideOf(e.killer);
        if (side === "CT") extra = " kill-ct";
        else if (side === "T") extra = " kill-t";
      }
      m.className = `replay-marker ${e.kind}${extra}`;
      m.style.left = `${Math.min(100, Math.max(0, ratio * 100))}%`;
      m.title = this.eventLabel(e);
      this.markersEl.appendChild(m);
    }
  }

  private eventLabel(e: SimEvent): string {
    switch (e.kind) {
      case "kill": return `kill (${e.weapon})`;
      case "bomb-plant": return "bomb plant";
      case "bomb-defuse": return "bomb defuse";
      case "bomb-detonate": return "bomb detonate";
      case "round-start": return "round start";
      case "round-end": return `round end (${e.winner})`;
    }
  }
}
