import type { OfficeEvent } from "../../../protocol/src/events";

/** Ring-buffer cap — ~50k events is hours of a busy session, few MB of JSON. */
export const RECORDER_CAP = 50_000;

const EXPORT_FORMAT = "agent-office-replay";

/** On-disk shape of an exported session (download / drag-drop import). */
export interface ReplayFile {
  format: typeof EXPORT_FORMAT;
  version: 1;
  exportedAt: number;
  events: OfficeEvent[];
}

/**
 * Records every event flowing into the renderer (live WS or mock) so the
 * session can be replayed. Append-only ring buffer: oldest events fall off
 * once the cap is reached. Pure data — no DOM, no Pixi.
 */
export class EventRecorder {
  private buf: OfficeEvent[] = [];

  constructor(private readonly cap: number = RECORDER_CAP) {}

  record(event: OfficeEvent): void {
    this.buf.push(event);
    // ponytail: amortized trim — let it overflow 25% then cut back, so we
    // don't pay an O(n) slice on every event once the buffer is full
    if (this.buf.length > this.cap * 1.25) this.buf = this.buf.slice(-this.cap);
  }

  /** Copy of everything recorded (oldest first, at most `cap` events). */
  snapshot(): OfficeEvent[] {
    if (this.buf.length > this.cap) this.buf = this.buf.slice(-this.cap);
    return this.buf.slice();
  }

  get size(): number {
    return Math.min(this.buf.length, this.cap);
  }

  /** Timestamp of the oldest / newest recorded event (0 when empty). */
  get startMs(): number {
    return this.buf[0]?.timestamp ?? 0;
  }

  get endMs(): number {
    return this.buf[this.buf.length - 1]?.timestamp ?? 0;
  }

  toJSON(): string {
    const file: ReplayFile = {
      format: EXPORT_FORMAT,
      version: 1,
      exportedAt: Date.now(),
      events: this.snapshot(),
    };
    return JSON.stringify(file);
  }
}

/**
 * Parse an exported replay file back into an event list. Throws an Error
 * with a short human-readable message on anything that isn't ours.
 * Malformed entries are dropped; events are re-sorted by timestamp so a
 * hand-edited or merged file still replays deterministically.
 */
export function parseReplayFile(text: string): OfficeEvent[] {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("File không phải JSON hợp lệ");
  }
  const file = data as Partial<ReplayFile>;
  if (file?.format !== EXPORT_FORMAT || !Array.isArray(file.events)) {
    throw new Error("Không phải file replay Agent Office");
  }
  const events = (file.events as unknown[]).filter((e): e is OfficeEvent => {
    const ev = e as Partial<OfficeEvent> | null;
    return (
      !!ev &&
      typeof ev.type === "string" &&
      typeof ev.timestamp === "number" &&
      typeof ev.agentId === "string"
    );
  });
  return events.slice().sort((a, b) => a.timestamp - b.timestamp);
}
