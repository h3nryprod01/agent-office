/**
 * Ambient office sound (R10) — opt-in, default OFF, zero assets.
 *
 * createSfx() wires a tiny Web Audio synth onto the event stream: a clack on
 * each tool_call_started (throttled so a burst of agents = one clack), a
 * 2-note ting when an agent goes "done", a low buzz on error / blocked /
 * waiting_permission. setEnabled(true) is the user gesture that lazily creates
 * + resumes the AudioContext; until then onEvent is a no-op. Degrades
 * silently (supported=false) when Web Audio is unavailable.
 *
 * createSfx(deps) is the testable core: the AudioContext is injected so unit
 * tests drive it with a mock (see test/sfx.test.ts) — same shape as the
 * Audio injection in ui/voice.ts.
 */
import type { OfficeEvent } from "../../../protocol/src/events";

const SFX_KEY = "ao-sfx";

/** Slice of OscillatorNode the synth uses (mockable). */
export interface OscillatorLike {
  type: OscillatorType;
  frequency: { setValueAtTime(value: number, startTime: number): void };
  connect(node: unknown): void;
  start(when?: number): void;
  stop(when?: number): void;
}

/** Slice of GainNode the synth uses (mockable). */
export interface GainLike {
  gain: {
    setValueAtTime(value: number, startTime: number): void;
    linearRampToValueAtTime(value: number, endTime: number): void;
  };
  connect(node: unknown): void;
}

/** Slice of AudioContext the synth uses (mockable). */
export interface AudioContextLike {
  currentTime: number;
  resume(): Promise<unknown>;
  createOscillator(): OscillatorLike;
  createGain(): GainLike;
  /** Connect target — a real AudioDestinationNode at runtime. */
  destination: unknown;
}

export interface SfxDeps {
  /** Override the AudioContext factory (tests). Default: `new AudioContext()`. */
  makeContext?(): AudioContextLike;
  /** Override the clock used for clack throttling (tests). Default: performance.now(). */
  now?(): number;
}

export interface Sfx {
  enabled(): boolean;
  /** User gesture (button click) → lazily create + resume the AudioContext. */
  setEnabled(on: boolean): void;
  /** React to one protocol event; no-op while disabled. */
  onEvent(ev: OfficeEvent): void;
}

export function createSfx(deps: SfxDeps = {}): Sfx {
  // supported when the env can make sound: an injected factory (tests) OR the
  // real Web Audio API on window.
  const supported =
    !!deps.makeContext || (typeof window !== "undefined" && "AudioContext" in window);
  let enabled = supported && localStorage.getItem(SFX_KEY) === "1";
  let ctx: AudioContextLike | null = null;
  let master: GainLike | null = null;
  let lastClack = -Infinity; // global clack throttle across all agents

  const now = (): number =>
    deps.now?.() ?? (typeof performance !== "undefined" ? performance.now() : Date.now());

  const makeContext =
    deps.makeContext ?? (() => new AudioContext() as unknown as AudioContextLike);

  /** Master gain caps the whole mix at 0.08 — even a clack storm stays gentle. */
  const ensureMaster = (): GainLike | null => {
    if (!ctx) return null;
    if (!master) {
      master = ctx.createGain();
      master.gain.setValueAtTime(0.08, ctx.currentTime);
      master.connect(ctx.destination);
    }
    return master;
  };

  /** One oscillator blip with a 5ms attack + decay-to-0 envelope on its own gain. */
  const blip = (
    type: OscillatorType,
    freq: number,
    startMs: number,
    durMs: number,
    peak: number,
  ): void => {
    const out = ensureMaster();
    if (!ctx || !out) return;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    const t0 = ctx.currentTime + startMs / 1000;
    const t1 = t0 + durMs / 1000;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.005);
    g.gain.linearRampToValueAtTime(0, t1);
    osc.connect(g);
    g.connect(out);
    osc.start(t0);
    osc.stop(t1);
  };

  const clack = (): void => {
    const t = now();
    if (t - lastClack < 350) return; // many agents firing tools → one clack
    lastClack = t;
    blip("square", 180, 0, 40, 0.3);
  };
  const ting = (): void => {
    blip("sine", 880, 0, 60, 0.3);
    blip("sine", 1320, 60, 90, 0.3);
  };
  const buzz = (): void => {
    blip("sawtooth", 140, 0, 200, 0.3);
  };

  return {
    enabled: () => enabled,
    setEnabled(on: boolean) {
      enabled = supported && on;
      localStorage.setItem(SFX_KEY, enabled ? "1" : "0");
      if (!enabled) return;
      if (!ctx) ctx = makeContext();
      void ctx.resume(); // AudioContext starts suspended until a user gesture
    },
    onEvent(ev: OfficeEvent) {
      if (!enabled || !ctx) return;
      if (ev.type === "tool_call_started") {
        clack();
      } else if (ev.type === "agent_status_changed") {
        const s = ev.status;
        if (s === "done") ting();
        else if (s === "error" || s === "blocked" || s === "waiting_permission") buzz();
      }
    },
  };
}
