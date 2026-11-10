/**
 * First run: with no agent session running the office is empty, which looks
 * broken. After a short grace period (the daemon backlog arrives right after
 * connect) offer a scripted sample. Sample data is ALWAYS labelled as such and
 * gives way the moment a real session appears.
 *
 * The sample is the same mock scenario `?mock=1` plays; its events are reduced
 * into the shared state and recognised afterwards by their session id.
 */
import type { OfficeEvent } from "../../../protocol/src/events";
import { MockEventSource } from "../events/MockEventSource";
import { buildScenario } from "../events/scenario";
import { t } from "../i18n";
import { INITIAL_STATE, type OfficeState } from "../sim/model";
import { reduce } from "../sim/reducer";

/** Session id every scenario event carries (events/scenario.ts). */
export const DEMO_SESSION = "mock-session-1";
const GRACE_MS = 4000;
const LOOP_PAUSE_MS = 4000;

export const realAgentCount = (s: OfficeState): number =>
  [...s.agents.values()].filter((a) => a.sessionId !== DEMO_SESSION).length;

/** State with every sample agent removed (INITIAL_STATE when nothing real is left). */
export function withoutDemo(s: OfficeState): OfficeState {
  const kept = [...s.agents].filter(([, a]) => a.sessionId !== DEMO_SESSION);
  return kept.length === 0 ? INITIAL_STATE : { ...s, agents: new Map(kept) };
}

export const offerVisible = (p: { real: number; demoOn: boolean; dismissed: boolean; elapsedMs: number; graceMs: number }): boolean =>
  p.real === 0 && !p.demoOn && !p.dismissed && p.elapsedMs >= p.graceMs;

export interface DemoSource {
  subscribe(l: (e: OfficeEvent) => void): () => void;
  start(): void;
  stop(): void;
  restart(): void;
  play(): void;
  onProgress: ((i: { simTimeMs: number; durationMs: number; playing: boolean }) => void) | null;
}

export interface FirstRunOptions {
  getState: () => OfficeState;
  setState: (s: OfficeState) => void;
  /** Called when the sample leaves, so a tab that only the sample had does not stay selected. */
  resetTab: () => void;
  now?: () => number;
  makeSource?: () => DemoSource;
  /** Tests drive tick() by hand. */
  autoTick?: boolean;
}

export interface FirstRunHandle {
  tick(): void;
  startDemo(): void;
  stopDemo(): void;
  destroy(): void;
}

export function mountFirstRun(opts: FirstRunOptions): FirstRunHandle {
  const now = opts.now ?? Date.now;
  const t0 = now();
  const el = document.createElement("div");
  el.className = "first-run";
  el.setAttribute("role", "status");
  el.hidden = true;
  document.body.appendChild(el);

  let source: DemoSource | null = null;
  let unsub: (() => void) | null = null;
  let dismissed = false;
  let loopTimer: ReturnType<typeof setTimeout> | null = null;

  const button = (act: string, label: string, onClick: () => void): HTMLButtonElement => {
    const b = document.createElement("button");
    b.dataset.act = act;
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  };
  const paint = (mode: "offer" | "demo" | "none"): void => {
    if (el.dataset.mode === mode) return;
    el.dataset.mode = mode;
    el.hidden = mode === "none";
    el.replaceChildren();
    if (mode === "none") return;
    const title = document.createElement("strong");
    title.textContent = t(mode === "offer" ? "firstRun.title" : "firstRun.demoLabel");
    const body = document.createElement("span");
    body.textContent = t(mode === "offer" ? "firstRun.body" : "firstRun.demoNote");
    el.append(title, body);
    if (mode === "offer") {
      el.append(button("see", t("firstRun.see"), startDemo), button("no", t("firstRun.no"), () => { dismissed = true; tick(); }));
    } else {
      el.append(button("exit", t("firstRun.exit"), stopDemo));
    }
  };

  function startDemo(): void {
    if (source) return;
    source = opts.makeSource ? opts.makeSource() : new MockEventSource(buildScenario(0));
    unsub = source.subscribe((e) => opts.setState(reduce(opts.getState(), e)));
    source.onProgress = (i) => {
      if (i.playing || i.simTimeMs < i.durationMs || loopTimer) return;
      loopTimer = setTimeout(() => {
        loopTimer = null;
        if (!source) return;
        opts.setState(withoutDemo(opts.getState()));
        source.restart();
        source.play();
      }, LOOP_PAUSE_MS);
    };
    source.start();
    tick();
  }

  function stopDemo(): void {
    if (!source) return;
    if (loopTimer) clearTimeout(loopTimer);
    loopTimer = null;
    source.onProgress = null;
    unsub?.();
    source.stop();
    source = null;
    unsub = null;
    dismissed = true; // leaving the sample is an answer; do not offer it again
    opts.setState(withoutDemo(opts.getState()));
    opts.resetTab();
    tick();
  }

  function tick(): void {
    const real = realAgentCount(opts.getState());
    if (source && real > 0) return stopDemo(); // a real session wins
    if (source) return paint("demo");
    paint(offerVisible({ real, demoOn: false, dismissed, elapsedMs: now() - t0, graceMs: GRACE_MS }) ? "offer" : "none");
  }

  const timer = opts.autoTick === false ? null : setInterval(tick, 1000);
  return {
    tick,
    startDemo,
    stopDemo,
    destroy: () => {
      if (timer) clearInterval(timer);
      if (source) stopDemo();
      el.remove();
    },
  };
}
