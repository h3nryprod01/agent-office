import type { OfficeEvent } from "../../../protocol/src/events";
import { EventDispatcher, type EventSource } from "./EventSource";
import { createDaemonV1Adapter } from "./daemonV1Adapter";

/**
 * ws:// base derived from the page origin, so the office works both directly
 * (localhost:8787) and through an SSH tunnel on any local port — page and
 * WebSocket share one origin. Falls back to the daemon default off-browser
 * (tests, mock).
 */
export function wsBase(): string {
  if (typeof location !== "undefined" && location.host) {
    return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  }
  return "ws://127.0.0.1:8787";
}

/**
 * Real-pipeline client. Connects to the daemon's WebSocket
 * (packages/daemon, default ws://127.0.0.1:8787) and forwards each
 * JSON message through `adapt`, which turns one raw frame into zero or
 * more protocol events (default: the daemon-v1 → draft-v0 adapter).
 * Once the pipeline emits draft v0 natively, pass an identity adapter.
 *
 * Auto-reconnects with backoff: the daemon restarting (or not being up
 * yet) must never leave the office silently frozen at 0 events.
 */
export class WebSocketEventSource implements EventSource {
  private dispatcher = new EventDispatcher();
  private ws: WebSocket | null = null;
  private stopped = false;
  private retryMs = 1000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  /** UI hook: called with true when connected, false when disconnected. */
  onStatus: ((connected: boolean) => void) | null = null;

  constructor(
    private url: string = wsBase(),
    private adapt: (raw: unknown) => OfficeEvent[] = createDaemonV1Adapter(),
    /** Raw-frame tap for UI-layer state the v0 protocol doesn't model
     * (spike R5②: approval_pending/approval_resolved). Called for every
     * frame, before adapt(); a throwing listener never breaks the pipeline. */
    private onRaw?: (raw: unknown) => void,
  ) {}

  subscribe(listener: (event: OfficeEvent) => void): () => void {
    return this.dispatcher.subscribe(listener);
  }

  start(): void {
    if (this.ws || this.stopped) return;
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.retryMs = 1000;
      this.onStatus?.(true);
    };
    this.ws.onmessage = (msg) => {
      try {
        const parsed = JSON.parse(String(msg.data));
        try {
          this.onRaw?.(parsed);
        } catch {
          // a broken raw-tap listener must not take down the main pipeline
        }
        for (const event of this.adapt(parsed)) this.dispatcher.emit(event);
      } catch {
        // non-JSON frame — ignore, the daemon owns its own logging
      }
    };
    this.ws.onclose = () => {
      this.ws = null;
      this.onStatus?.(false);
      if (this.stopped) return;
      this.retryTimer = setTimeout(() => this.start(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 15_000);
    };
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.ws?.close();
    this.ws = null;
  }
}
