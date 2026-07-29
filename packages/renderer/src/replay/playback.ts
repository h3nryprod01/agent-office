import type { OfficeEvent } from "../../../protocol/src/events";
import { INITIAL_STATE, type OfficeState } from "../sim/model";
import { reduce } from "../sim/reducer";

/**
 * Rebuilds OfficeState at an arbitrary time T from a recorded event list —
 * pure event sourcing over the existing reducer. Forward seeks are
 * incremental (only the delta is fed); backward seeks rebuild from t=0.
 *
 * ponytail: full rebuild on backward scrub — O(n) over ≤50k cheap reducer
 * calls (tens of ms worst case). Add periodic state checkpoints if scrubbing
 * a huge session ever feels sluggish.
 */
export class ReplayCursor {
  private state: OfficeState = INITIAL_STATE;
  private index = 0; // next event to feed
  private lastT = -Infinity;

  /** `events` must be sorted by timestamp (recorder/parse guarantee this). */
  constructor(private readonly events: readonly OfficeEvent[]) {}

  get startMs(): number {
    return this.events.length ? this.events[0].timestamp : 0;
  }

  get endMs(): number {
    return this.events.length ? this.events[this.events.length - 1].timestamp : 0;
  }

  get count(): number {
    return this.events.length;
  }

  /** State after applying every event with timestamp <= tMs. */
  stateAt(tMs: number): OfficeState {
    if (tMs < this.lastT) {
      this.state = INITIAL_STATE;
      this.index = 0;
    }
    while (this.index < this.events.length && this.events[this.index].timestamp <= tMs) {
      this.state = reduce(this.state, this.events[this.index]);
      this.index += 1;
    }
    this.lastT = tMs;
    return this.state;
  }
}
