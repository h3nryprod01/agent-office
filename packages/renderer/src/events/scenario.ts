import { t } from "../i18n";
import type { AgentStatus, OfficeEvent, OfficeEventType } from "../../../protocol/src/events";

/** One scenario entry: emit `event` when playback reaches `atMs`. */
export interface TimedEvent {
  atMs: number;
  event: OfficeEvent;
}

const SESSION = "mock-session-1";
const PM = SESSION; // root agent: agentId === sessionId (protocol convention)

let seq = 0;
function ev(atMs: number, type: OfficeEventType, agentId: string, parentId: string | null, extra: Record<string, unknown> = {}): TimedEvent {
  seq += 1;
  return {
    atMs,
    event: {
      v: 0,
      id: `mock-${seq}`,
      type,
      timestamp: 0, // stamped with real clock at emit time by MockEventSource
      sessionId: SESSION,
      agentId,
      parentId,
      ...extra,
    } as OfficeEvent,
  };
}

const status = (atMs: number, id: string, parent: string | null, s: AgentStatus, detail: string | null = null) =>
  ev(atMs, "agent_status_changed", id, parent, { status: s, detail });
const toolStart = (atMs: number, id: string, parent: string | null, tool: string, detail: string) =>
  ev(atMs, "tool_call_started", id, parent, { tool, toolUseId: `tu-${atMs}-${id}`, detail });
const toolEnd = (atMs: number, id: string, parent: string | null, tool: string, ok: boolean, detail: string | null = null) =>
  ev(atMs, "tool_call_finished", id, parent, { tool, toolUseId: null, ok, detail });
const say = (atMs: number, id: string, parent: string | null, text: string) =>
  ev(atMs, "agent_message", id, parent, { text });

/**
 * Scripted ~70s session modeled on a real orchestration run:
 * a PM agent reads context, spawns 4 sub-agents; one gets blocked on a
 * permission prompt, one errors and recovers; everyone finishes.
 *
 * `extras` appends N background agents cycling through stations —
 * used to verify 60fps with 30+ characters (?stress=30).
 */
export function buildScenario(extras = 0): TimedEvent[] {
  const coder1 = "sub-coder-1";
  const coder2 = "sub-coder-2";
  const tester = "sub-tester";
  const reviewer = "sub-reviewer";
  const demoApp = "demo-app-root";

  const events: TimedEvent[] = [
    ev(0, "session_started", PM, null, { cwd: "/Users/you/Projects/acme-web", label: "acme-web" }),
    ev(200, "agent_spawned", PM, null, { name: "PM (orchestrator)", role: "planner", cwd: "/Users/you/Projects/acme-web" }),
    say(800, PM, null, t("demo.readContext")),
    toolStart(1_200, PM, null, "Read", "Read README.md"),
    toolEnd(3_200, PM, null, "Read", true),
    toolStart(3_500, PM, null, "Read", "Read .claude/memory/activeContext.md"),
    toolEnd(5_200, PM, null, "Read", true),
    say(5_800, PM, null, t("demo.split")),
    toolStart(6_500, PM, null, "Task", "Spawn sub-agents"),

    // sub-agents pop in at the meeting table, then walk to their desks
    ev(7_000, "agent_spawned", coder1, PM, { name: "Coder A", role: null }),
    ev(7_600, "agent_spawned", coder2, PM, { name: "Coder B", role: null, harness: "codex" }),
    ev(8_200, "agent_spawned", tester, PM, { name: "Tester", role: "tdd-guide" }),
    ev(8_800, "agent_spawned", reviewer, PM, { name: "Reviewer", role: "code-reviewer" }),
    toolEnd(9_200, PM, null, "Task", true),
    status(9_400, PM, null, "idle", "waiting for sub-agents"),

    // Coder A: read then write
    toolStart(9_800, coder1, PM, "Read", "Read src/tailer.js"),
    say(10_500, coder1, PM, t("demo.readOld")),
    toolEnd(13_000, coder1, PM, "Read", true),
    toolStart(13_400, coder1, PM, "Write", "Write src/feature.ts"),
    toolEnd(19_000, coder1, PM, "Write", true),

    // Coder B: bash test run → error → recover
    toolStart(10_400, coder2, PM, "Bash", "npm test"),
    say(11_200, coder2, PM, t("demo.runTests")),
    toolEnd(16_000, coder2, PM, "Bash", false, "3 tests failed"),
    say(16_400, coder2, PM, t("demo.testsRed")),
    status(18_500, coder2, PM, "working", "fixing failing tests"),
    toolStart(19_000, coder2, PM, "Edit", "Edit src/normalize.js"),
    toolEnd(23_500, coder2, PM, "Edit", true),
    toolStart(24_000, coder2, PM, "Bash", "npm test"),
    toolEnd(28_500, coder2, PM, "Bash", true, "all green"),
    say(29_000, coder2, PM, "Tests xanh ✅"),

    // Tester: blocked on permission
    toolStart(11_000, tester, PM, "Read", "Read test plan"),
    toolEnd(14_000, tester, PM, "Read", true),
    status(15_000, tester, PM, "waiting_permission", "Bash: rm -rf dist — needs approval"),
    say(15_400, tester, PM, t("demo.needApproval")),
    status(24_000, tester, PM, "running_command", "approved — running"),
    toolStart(24_200, tester, PM, "Bash", "rm -rf dist && npm run build"),
    toolEnd(30_000, tester, PM, "Bash", true),

    // Reviewer: reads a lot, comments
    toolStart(12_000, reviewer, PM, "Grep", "Grep TODO in src/"),
    toolEnd(14_500, reviewer, PM, "Grep", true),
    toolStart(15_500, reviewer, PM, "Read", "Read diff"),
    toolEnd(21_000, reviewer, PM, "Read", true),
    say(21_500, reviewer, PM, t("demo.cleanDiff")),
    status(22_000, reviewer, PM, "working", "writing review notes"),

    // wrap-up: each sub-agent reports & despawns
    say(31_000, coder1, PM, t("demo.myPartDone")),
    status(31_200, coder1, PM, "done"),
    ev(33_000, "agent_despawned", coder1, PM, { reason: "task complete" }),
    status(32_000, tester, PM, "done"),
    ev(34_500, "agent_despawned", tester, PM, { reason: "task complete" }),
    status(33_500, reviewer, PM, "done"),
    ev(36_000, "agent_despawned", reviewer, PM, { reason: "task complete" }),
    status(34_000, coder2, PM, "done"),
    ev(37_500, "agent_despawned", coder2, PM, { reason: "task complete" }),

    // ── second repo (Round 4 demo): its own office tab + a cross-office
    // alert while you're watching acme-web ──────────────────────────────
    ev(4_000, "agent_spawned", demoApp, null, { name: "demo-app session", role: null, cwd: "/Users/you/Projects/demo-app" }),
    toolStart(5_000, demoApp, null, "Bash", "npm run test:e2e"),
    say(6_000, demoApp, null, t("demo.e2e")),
    status(17_000, demoApp, null, "waiting_permission", "Bash: npx playwright install — needs approval"),
    status(26_000, demoApp, null, "running_command", "approved — running"),
    toolEnd(33_000, demoApp, null, "Bash", true, "e2e green"),
    status(35_000, demoApp, null, "done"),
    ev(45_000, "agent_despawned", demoApp, null, { reason: "task complete" }),

    say(38_500, PM, null, t("demo.report")),
    toolStart(39_000, PM, null, "Write", "Write docs/report.md"),
    toolEnd(43_000, PM, null, "Write", true),
    say(43_500, PM, null, "Done! 🎉"),
    status(44_000, PM, null, "done"),
    ev(46_000, "session_ended", PM, null, { reason: "stopped" }),
  ];

  return [...events, ...stressExtras(extras)].sort((a, b) => a.atMs - b.atMs);
}

/** Background characters for the 30-agent perf check. */
function stressExtras(count: number): TimedEvent[] {
  const out: TimedEvent[] = [];
  const tools = ["Read", "Bash", "Write", "Grep", "Edit"];
  for (let i = 0; i < count; i++) {
    const id = `stress-${i}`;
    out.push(ev(500 + i * 150, "agent_spawned", id, PM, { name: `Drone ${i + 1}`, role: null }));
    // keep them busy for the whole timeline
    for (let t = 2_000 + i * 300; t < 42_000; t += 4_000) {
      const tool = tools[(i + t / 4_000) % tools.length | 0];
      out.push(toolStart(t, id, PM, tool, `${tool} (background)`));
      out.push(toolEnd(t + 3_000, id, PM, tool, true));
    }
    out.push(ev(44_000 + i * 100, "agent_despawned", id, PM, { reason: "done" }));
  }
  return out;
}
