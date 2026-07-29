import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSfx,
  type AudioContextLike,
  type GainLike,
  type OscillatorLike,
} from "../src/audio/sfx";
import type { OfficeEvent } from "../../protocol/src/events";

/** Minimal oscillator mock — the tests only count how many get created. */
class MockOsc implements OscillatorLike {
  type: OscillatorType = "sine";
  frequency = { setValueAtTime: (_v: number, _t: number) => {} };
  connect = (_node: unknown) => {};
  start = (_when?: number) => {};
  stop = (_when?: number) => {};
}

class MockGain implements GainLike {
  gain = {
    setValueAtTime: (_v: number, _t: number) => {},
    linearRampToValueAtTime: (_v: number, _t: number) => {},
  };
  connect = (_node: unknown) => {};
}

class MockContext implements AudioContextLike {
  currentTime = 0;
  destination = {};
  oscs: MockOsc[] = [];
  constructor(oscs: MockOsc[]) {
    this.oscs = oscs;
  }
  resume(): Promise<unknown> {
    return Promise.resolve();
  }
  createOscillator(): MockOsc {
    const o = new MockOsc();
    this.oscs.push(o);
    return o;
  }
  createGain(): MockGain {
    return new MockGain();
  }
}

function sfxHarness(opts: { startEnabled?: boolean } = {}) {
  const oscs: MockOsc[] = [];
  const ctx = new MockContext(oscs);
  let nowVal = 0;
  vi.stubGlobal("localStorage", {
    getItem: () => (opts.startEnabled ? "1" : null),
    setItem: () => {},
  });
  const sfx = createSfx({ makeContext: () => ctx, now: () => nowVal });
  return {
    sfx,
    oscs,
    advance: (ms: number) => {
      nowVal += ms;
    },
  };
}

/** Build a minimal OfficeEvent of one type + extra payload fields. */
function ev(
  type: "tool_call_started" | "agent_status_changed",
  extra: Record<string, unknown> = {},
): OfficeEvent {
  return {
    v: 0,
    id: "e",
    type,
    timestamp: 0,
    sessionId: "s",
    agentId: "a",
    parentId: null,
    ...extra,
  } as unknown as OfficeEvent;
}

describe("createSfx — ambient sound router (R10)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("default off (localStorage trống) → onEvent không tạo oscillator", () => {
    const { sfx, oscs } = sfxHarness();
    expect(sfx.enabled()).toBe(false);
    sfx.onEvent(ev("tool_call_started", { tool: "Bash" }));
    expect(oscs.length).toBe(0);
  });

  it("setEnabled(true) → tool_call_started tạo 1 clack; <350ms throttle, >350ms thêm", () => {
    const { sfx, oscs, advance } = sfxHarness();
    sfx.setEnabled(true);
    expect(sfx.enabled()).toBe(true);

    sfx.onEvent(ev("tool_call_started", { tool: "Bash" }));
    expect(oscs.length).toBe(1);

    sfx.onEvent(ev("tool_call_started", { tool: "Read" })); // same clock → <350ms
    expect(oscs.length).toBe(1); // throttled — no new oscillator

    advance(400); // past the 350ms gap
    sfx.onEvent(ev("tool_call_started", { tool: "Grep" }));
    expect(oscs.length).toBe(2);
  });

  it("status=done → ting (2 oscillator); error/blocked/waiting_permission → buzz (1)", () => {
    const done = sfxHarness();
    done.sfx.setEnabled(true);
    done.sfx.onEvent(ev("agent_status_changed", { status: "done", detail: null }));
    expect(done.oscs.length).toBe(2); // 2-note ting

    for (const status of ["error", "blocked", "waiting_permission"] as const) {
      const h = sfxHarness();
      h.sfx.setEnabled(true);
      h.sfx.onEvent(ev("agent_status_changed", { status, detail: null }));
      expect(h.oscs.length).toBe(1); // buzz
    }
  });
});
