// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INITIAL_STATE, type AgentModel, type OfficeState } from "../src/sim/model";
import { DEMO_SESSION, mountFirstRun, offerVisible, realAgentCount, withoutDemo, type DemoSource } from "../src/ui/firstRun";
import type { OfficeEvent } from "../../protocol/src/events";

const agent = (id: string, sessionId: string): AgentModel => ({ agentId: id, sessionId } as unknown as AgentModel);
const stateOf = (...a: AgentModel[]): OfficeState => ({ ...INITIAL_STATE, agents: new Map(a.map((x) => [x.agentId, x])) });

describe("pure helpers", () => {
  it("counts only agents that are not part of the sample", () => {
    expect(realAgentCount(INITIAL_STATE)).toBe(0);
    expect(realAgentCount(stateOf(agent("a", DEMO_SESSION), agent("b", "real-1")))).toBe(1);
  });

  it("withoutDemo drops sample agents and keeps real ones", () => {
    const s = withoutDemo(stateOf(agent("a", DEMO_SESSION), agent("b", "real-1")));
    expect([...s.agents.keys()]).toEqual(["b"]);
    expect(withoutDemo(stateOf(agent("a", DEMO_SESSION)))).toBe(INITIAL_STATE);
  });

  it("offers the sample only after the grace period, with nothing real, once", () => {
    const base = { real: 0, demoOn: false, dismissed: false, elapsedMs: 5000, graceMs: 4000 };
    expect(offerVisible(base)).toBe(true);
    expect(offerVisible({ ...base, elapsedMs: 1000 })).toBe(false);
    expect(offerVisible({ ...base, real: 1 })).toBe(false);
    expect(offerVisible({ ...base, demoOn: true })).toBe(false);
    expect(offerVisible({ ...base, dismissed: true })).toBe(false);
  });
});

function fakeSource() {
  let listener: ((e: OfficeEvent) => void) | null = null;
  const src = {
    started: 0,
    stopped: 0,
    subscribe(l: (e: OfficeEvent) => void) { listener = l; return () => { listener = null; }; },
    start() { src.started++; },
    stop() { src.stopped++; },
    restart() {},
    play() {},
    onProgress: null as DemoSource["onProgress"],
    emit(e: OfficeEvent) { listener?.(e); },
  };
  return src;
}

describe("mountFirstRun", () => {
  let state: OfficeState;
  let clock: number;
  let src: ReturnType<typeof fakeSource>;
  let resets: number;
  const mount = () =>
    mountFirstRun({
      getState: () => state,
      setState: (s) => { state = s; },
      resetTab: () => { resets++; },
      now: () => clock,
      makeSource: () => src,
      autoTick: false,
    });
  const el = () => document.querySelector<HTMLElement>(".first-run")!;
  const spawn = (sessionId: string): OfficeEvent =>
    ({ v: 0, id: "e", type: "agent_spawned", timestamp: 0, sessionId, agentId: "x-" + sessionId, parentId: null, name: "n", role: "coder" } as unknown as OfficeEvent);

  beforeEach(() => {
    document.body.innerHTML = "";
    state = INITIAL_STATE;
    clock = 0;
    src = fakeSource();
    resets = 0;
  });
  afterEach(() => { document.body.innerHTML = ""; });

  it("stays hidden during the grace period (the daemon backlog is still arriving)", () => {
    const h = mount();
    h.tick();
    expect(el().hidden).toBe(true);
  });

  it("offers a sample when nothing real shows up, and starts it on click", () => {
    const h = mount();
    clock = 6000;
    h.tick();
    expect(el().hidden).toBe(false);
    expect(el().querySelector("button[data-act=see]")).not.toBeNull();
    el().querySelector<HTMLButtonElement>("button[data-act=see]")!.click();
    expect(src.started).toBe(1);
  });

  it("always labels sample data while it plays", () => {
    const h = mount();
    clock = 6000;
    h.startDemo();
    h.tick();
    expect(el().hidden).toBe(false);
    expect(el().dataset.mode).toBe("demo");
    expect(el().textContent).toMatch(/sample/i);
    expect(el().querySelector("button[data-act=exit]")).not.toBeNull();
  });

  it("sample events land in the shared state", () => {
    const h = mount();
    h.startDemo();
    src.emit(spawn(DEMO_SESSION));
    expect(realAgentCount(state)).toBe(0);
    expect(state.agents.size).toBe(1);
    h.destroy();
  });

  it("yields to a real session: sample stops, sample agents vanish, tab resets, label gone", () => {
    const h = mount();
    h.startDemo();
    src.emit(spawn(DEMO_SESSION));
    src.emit(spawn("real-1"));
    h.tick();
    expect(src.stopped).toBe(1);
    expect([...state.agents.values()].every((a) => a.sessionId === "real-1")).toBe(true);
    expect(resets).toBe(1);
    expect(el().hidden).toBe(true);
  });

  it("Exit sample stops it and does not offer again", () => {
    const h = mount();
    clock = 6000;
    h.startDemo();
    src.emit(spawn(DEMO_SESSION));
    h.stopDemo();
    expect(state.agents.size).toBe(0);
    h.tick();
    expect(el().hidden).toBe(true);
  });

  it("'Not now' dismisses the offer", () => {
    const h = mount();
    clock = 6000;
    h.tick();
    el().querySelector<HTMLButtonElement>("button[data-act=no]")!.click();
    h.tick();
    expect(el().hidden).toBe(true);
  });
});

describe("sample data never leaves the page", () => {
  it("the notifier is fed state without sample agents", async () => {
    const { interventionQueue } = await import("../src/sim/selectors");
    const demo = { agentId: "d", sessionId: DEMO_SESSION, status: "waiting_permission", despawnedAt: null, statusSince: 0 } as unknown as AgentModel;
    const s = stateOf(demo);
    expect(interventionQueue(s)).toHaveLength(1); // would raise an OS toast
    expect(interventionQueue(withoutDemo(s))).toHaveLength(0);
  });

  it("main.ts hands the notifier withoutDemo(...) and nothing else", async () => {
    const src = (await import("../src/main.ts?raw")).default as string;
    expect(src).toMatch(/notifier\.sync\(withoutDemo\(current\(\)\)\)/);
    expect(src).not.toMatch(/notifier\.sync\(current\(\)\)/);
  });
});
