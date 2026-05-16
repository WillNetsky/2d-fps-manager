import type { GameMap, SimEvent } from "../domain/types.ts";
import type { RoundSnapshot } from "./round.ts";
import type { SimView } from "../render/renderer.ts";

export interface RecordedRound {
  map: GameMap;
  snapshots: RoundSnapshot[];
  events: SimEvent[];
  tickMs: number;
}

// Holds the last round's data and controls playback.
export class ReplayPlayer {
  private recorded: RecordedRound | null = null;
  private index = 0;
  private playing = false;
  private intervalHandle: number | null = null;
  private onFrame: ((view: SimView, idx: number) => void) | null = null;
  private endHoldUntil = 0;
  private static END_HOLD_MS = 1500;

  load(recorded: RecordedRound) {
    this.stop();
    this.recorded = recorded;
    this.index = 0;
    this.endHoldUntil = 0;
  }

  setOnFrame(fn: (view: SimView, idx: number) => void) {
    this.onFrame = fn;
  }

  play() {
    if (!this.recorded || this.playing) return;
    this.playing = true;
    this.intervalHandle = window.setInterval(() => this.step(), this.recorded.tickMs);
  }

  pause() {
    this.playing = false;
    if (this.intervalHandle !== null) clearInterval(this.intervalHandle);
    this.intervalHandle = null;
  }

  stop() {
    this.pause();
    this.index = 0;
  }

  isPlaying() { return this.playing; }

  togglePlay() {
    if (this.playing) this.pause();
    else this.play();
  }

  seek(idx: number) {
    if (!this.recorded) return;
    this.index = Math.max(0, Math.min(idx, this.recorded.snapshots.length - 1));
    this.endHoldUntil = 0;
    this.emit();
  }

  totalTicks() {
    return this.recorded?.snapshots.length ?? 0;
  }

  currentIndex() { return this.index; }

  private step() {
    if (!this.recorded) return;
    // Holding at the last frame before looping.
    if (this.endHoldUntil > 0) {
      if (performance.now() >= this.endHoldUntil) {
        this.endHoldUntil = 0;
        this.index = 0;
        this.emit();
      }
      return;
    }
    this.index++;
    if (this.index >= this.recorded.snapshots.length) {
      this.index = this.recorded.snapshots.length - 1;
      this.endHoldUntil = performance.now() + ReplayPlayer.END_HOLD_MS;
    }
    this.emit();
  }

  private emit() {
    if (!this.recorded || !this.onFrame) return;
    const snap = this.recorded.snapshots[this.index];
    const view: SimView = {
      t: snap.t,
      map: this.recorded.map,
      agents: snap.agents,
      smokes: snap.smokes,
      flashes: snap.flashes,
      tickFlashes: snap.tickFlashes,
      molotovs: snap.molotovs,
      hes: snap.hes,
      tickHEs: snap.tickHEs,
      smokeHoles: snap.smokeHoles,
      grenadeFlights: snap.grenadeFlights,
      drops: snap.drops,
      bombPlanted: snap.bombPlanted,
      bombPlantedAt: snap.bombPlantedAt,
      bombCarrier: snap.bombCarrier,
      bombDropped: snap.bombDropped,
      bombDefuseProgress: snap.bombDefuseProgress,
      defuseTimeMs: snap.defuseTimeMs,
      bombPlantedTime: snap.bombPlantedTime,
      tickShots: snap.tickShots,
    };
    this.onFrame(view, this.index);
  }
}
