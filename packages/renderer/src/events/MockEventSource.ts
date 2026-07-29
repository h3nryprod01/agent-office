import type { OfficeEvent } from "../../../protocol/src/events";
import { EventDispatcher, type EventSource } from "./EventSource";
import type { TimedEvent } from "./scenario";

/**
 * Plays a scripted scenario through the same EventSource interface the
 * real pipeline client uses. Owns a scaled simulation clock so the UI
 * can pause and change speed without touching consumers.
 */
export class MockEventSource implements EventSource {
  private dispatcher = new EventDispatcher();
  private timeline: TimedEvent[];
  private cursor = 0;
  private simTimeMs = 0;
  private speed = 1;
  private playing = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = 0;

  /** Fires whenever play state / speed / progress changes (for the UI). */
  onProgress: ((info: { simTimeMs: number; durationMs: number; playing: boolean; speed: number }) => void) | null =
    null;

  constructor(timeline: TimedEvent[]) {
    this.timeline = timeline;
  }

  get durationMs(): number {
    return this.timeline.length ? this.timeline[this.timeline.length - 1].atMs : 0;
  }

  subscribe(listener: (event: OfficeEvent) => void): () => void {
    return this.dispatcher.subscribe(listener);
  }

  start(): void {
    this.play();
  }

  stop(): void {
    this.pause();
  }

  play(): void {
    if (this.playing) return;
    this.playing = true;
    this.lastTick = performance.now();
    this.timer = setInterval(() => this.tick(), 50);
    this.notify();
  }

  pause(): void {
    this.playing = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.notify();
  }

  toggle(): void {
    this.playing ? this.pause() : this.play();
  }

  setSpeed(speed: number): void {
    this.speed = speed;
    this.notify();
  }

  get currentSpeed(): number {
    return this.speed;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Rewind to t=0. Consumers must also reset their state (see main.ts). */
  restart(): void {
    this.cursor = 0;
    this.simTimeMs = 0;
    this.lastTick = performance.now();
    this.notify();
  }

  private tick(): void {
    const now = performance.now();
    this.simTimeMs += (now - this.lastTick) * this.speed;
    this.lastTick = now;

    while (this.cursor < this.timeline.length && this.timeline[this.cursor].atMs <= this.simTimeMs) {
      const { event } = this.timeline[this.cursor];
      this.cursor += 1;
      // stamp with wall-clock time: consumers treat timestamps as real time
      this.dispatcher.emit({ ...event, timestamp: Date.now() });
    }
    if (this.cursor >= this.timeline.length) this.pause();
    this.notify();
  }

  private notify(): void {
    this.onProgress?.({
      simTimeMs: Math.min(this.simTimeMs, this.durationMs),
      durationMs: this.durationMs,
      playing: this.playing,
      speed: this.speed,
    });
  }
}
