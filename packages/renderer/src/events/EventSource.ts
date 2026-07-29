import type { OfficeEvent } from "../../../protocol/src/events";

/**
 * The renderer's only dependency on "where events come from".
 * MockEventSource (scripted demo) and WebSocketEventSource (real daemon)
 * both implement this, so swapping in the real pipeline is a one-line
 * change in main.ts.
 */
export interface EventSource {
  /** Register a listener. Returns an unsubscribe function. */
  subscribe(listener: (event: OfficeEvent) => void): () => void;
  /** Begin producing events (connect / start playback). */
  start(): void;
  /** Stop producing events (disconnect / pause playback). */
  stop(): void;
}

/** Tiny shared emitter so both sources dispatch identically. */
export class EventDispatcher {
  private listeners = new Set<(event: OfficeEvent) => void>();

  subscribe(listener: (event: OfficeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: OfficeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
