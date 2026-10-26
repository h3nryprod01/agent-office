import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  InterventionMetrics,
  createProjectResolver,
  localDay,
  stats,
  createMetricsHttpHandler,
} from "../src/intervention-metrics.js";

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0); // midday UTC: the same calendar day in every timezone
const S = 1000;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ao-metrics-"));
}

function make(overrides = {}) {
  const clock = { now: T0 + 3600 * S };
  const m = new InterventionMetrics({
    dir: tmpDir(),
    now: () => clock.now,
    projectOf: (cwd) => (cwd?.startsWith("/w/acme-web") ? "acme-web" : null),
    flushMs: 0,
    ...overrides,
  });
  return { m, clock };
}

let n = 0;
function ev(agentId, type, ts, fields = {}) {
  return {
    v: 1,
    id: `e${++n}`,
    type,
    sessionId: fields.sessionId ?? agentId,
    agentId,
    parentId: null,
    cwd: fields.cwd ?? "/w/acme-web",
    repo: fields.repo ?? "acme-web",
    harness: "claude-code",
    ts,
    agent: agentId,
    tool: fields.tool ?? null,
    status: fields.status ?? null,
    detail: fields.detail ?? "",
    meta: fields.meta ?? null,
  };
}
const hook = (id, ts, state) => ev(id, "hook_signal", ts, { tool: "Bash", meta: { state } });
const toolStart = (id, ts) => ev(id, "tool_call", ts, { tool: "Read", status: "start" });
const toolErr = (id, ts, detail = "boom") => ev(id, "tool_call", ts, { tool: "Bash", status: "error", detail });

test("stats: median averages the middle pair, p90 is nearest-rank", () => {
  assert.deepEqual(stats([]), { count: 0, medianMs: 0, p90Ms: 0, totalMs: 0 });
  assert.deepEqual(stats([4000, 1000, 3000, 2000, 10000]), { count: 5, medianMs: 3000, p90Ms: 10000, totalMs: 20000 });
  assert.deepEqual(stats([1000, 2000, 3000, 4000]), { count: 4, medianMs: 2500, p90Ms: 4000, totalMs: 10000 });
  const ten = Array.from({ length: 10 }, (_, i) => (i + 1) * 1000);
  assert.equal(stats(ten).p90Ms, 9000);
});

test("permission wait: from the hook signal until the hook says the agent proceeds", () => {
  const { m } = make();
  m.onEvent(hook("s1", T0, "waiting_permission"));
  m.onEvent(hook("s1", T0 + 42 * S, "working"));
  const eps = m.episodes();
  assert.equal(eps.length, 1);
  assert.deepEqual(
    { kind: eps[0].kind, durationMs: eps[0].durationMs, resolution: eps[0].resolution, project: eps[0].project },
    { kind: "waiting_permission", durationMs: 42 * S, resolution: "resumed", project: "acme-web" },
  );
});

test("error: from the failing tool_call until the agent does anything else; denial is 'blocked'", () => {
  const { m } = make();
  m.onEvent(toolErr("s1", T0));
  m.onEvent(toolStart("s1", T0 + 5 * S));
  m.onEvent(toolErr("s2", T0, "The user doesn't want to proceed. Permission to use Edit has been denied."));
  m.onEvent(ev("s2", "speak", T0 + 90 * S, { status: "ok", detail: "ok, trying another way" }));
  const byAgent = Object.fromEntries(m.episodes().map((e) => [e.agentId, e]));
  assert.equal(byAgent.s1.kind, "error");
  assert.equal(byAgent.s1.durationMs, 5 * S);
  assert.equal(byAgent.s2.kind, "blocked");
  assert.equal(byAgent.s2.durationMs, 90 * S);
});

test("approval answered in the office closes the episode with the decision; a hook wait that started earlier keeps its start", () => {
  const { m } = make();
  m.onEvent(hook("s1", T0, "waiting_permission"));
  m.onEvent(ev("s1", "approval_pending", T0 + 1 * S, { tool: "Bash", status: "start", meta: { approvalId: "a1" } }));
  // expired = nobody decided; the terminal dialog is still waiting, so nothing closes
  m.onEvent(ev("s1", "approval_resolved", T0 + 26 * S, { status: "ok", meta: { approvalId: "a1", decision: "none", source: "expired" } }));
  assert.equal(m.episodes().length, 0);
  m.onEvent(ev("s1", "approval_resolved", T0 + 30 * S, { status: "ok", meta: { approvalId: "a2", decision: "allow", source: "office" } }));
  const [e] = m.episodes();
  assert.equal(e.durationMs, 30 * S);
  assert.equal(e.resolution, "approved");
});

test("a second trigger of the same or lower rank while an episode is open does not start another", () => {
  const { m } = make();
  m.onEvent(hook("s1", T0, "waiting_permission"));
  m.onEvent(hook("s1", T0 + 2 * S, "waiting_permission"));
  m.onEvent(ev("s1", "approval_pending", T0 + 3 * S, { status: "start", meta: { approvalId: "x" } }));
  m.onEvent(toolStart("s1", T0 + 10 * S));
  assert.equal(m.episodes().length, 1);
  assert.deepEqual([m.episodes()[0].kind, m.episodes()[0].durationMs], ["waiting_permission", 10 * S]);
});

test("declining a prompt in the terminal (a tool error) ends the wait as 'denied', even if the session then times out", () => {
  const { m } = make();
  m.onEvent(hook("s1", T0, "waiting_permission"));
  m.onEvent(toolErr("s1", T0 + 10 * S, "The user doesn't want to proceed with this tool use."));
  m.onEvent(ev("s1", "session_end", T0 + 310 * S, { status: "ok", meta: { reason: "inactivity_timeout" } }));
  m.onEvent(ev("s1", "speak", T0 + 12 * 3600 * S, { status: "ok" }));
  assert.deepEqual(m.episodes().map((e) => [e.kind, e.durationMs, e.resolution]), [["waiting_permission", 10 * S, "denied"]]);
});

test("events with a non-numeric timestamp are ignored (no NaN episodes, no NaN-NaN-NaN.jsonl)", () => {
  const dir = tmpDir();
  const { m } = make({ dir });
  m.onEvent(toolErr("s1", NaN));
  m.onEvent(toolStart("s1", T0));
  m.onEvent(toolErr("s2", T0));
  m.onEvent(toolStart("s2", undefined));
  assert.equal(m.episodes().length, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("an unreadable day file does not stop the metrics from loading", () => {
  const dir = tmpDir();
  fs.mkdirSync(path.join(dir, `${localDay(T0)}.jsonl`)); // a folder where a file should be
  assert.doesNotThrow(() => make({ dir }));
});

test("a permission wait that follows an error closes the error and is recorded on its own", () => {
  const { m } = make();
  m.onEvent(toolErr("s1", T0));
  m.onEvent(hook("s1", T0 + 2 * S, "waiting_permission"));
  m.onEvent(hook("s1", T0 + 40 * S, "working"));
  const byKind = Object.fromEntries(m.episodes().map((e) => [e.kind, e.durationMs]));
  assert.deepEqual(byKind, { error: 2 * S, waiting_permission: 38 * S });
});

test("the 5-minute inactivity session_end does not erase a permission wait (it writes no transcript line)", () => {
  const { m } = make();
  m.onEvent(hook("s1", T0, "waiting_permission"));
  m.onEvent(ev("s1", "session_end", T0 + 300 * S, { status: "ok", meta: { reason: "inactivity_timeout" } }));
  m.onEvent(hook("s1", T0 + 720 * S, "working"));
  assert.equal(m.episodes()[0].durationMs, 720 * S);
  // ...but a stuck ERROR on a session that timed out is dropped: nobody was provably waited on
  m.onEvent(toolErr("s2", T0));
  m.onEvent(ev("s2", "session_end", T0 + 300 * S, { status: "ok", meta: { reason: "inactivity_timeout" } }));
  m.onEvent(toolStart("s2", T0 + 9000 * S));
  assert.equal(m.episodes().length, 1);
});

test("day window steps by calendar day across a DST change", () => {
  const prev = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const { m, clock } = make();
    clock.now = new Date(2026, 2, 9, 0, 30).getTime(); // DST began on 8 March: 8 Mar is only 23 h long
    assert.deepEqual(m.summary({ days: 3 }).byDay.map((d) => d.date), ["2026-03-07", "2026-03-08", "2026-03-09"]);
  } finally {
    if (prev === undefined) delete process.env.TZ;
    else process.env.TZ = prev;
  }
});

test("a torn last line does not swallow the next episode; day files past retention are deleted", () => {
  const dir = tmpDir();
  const old = path.join(dir, "2020-01-01.jsonl");
  fs.writeFileSync(old, "{}\n");
  const { m } = make({ dir });
  assert.equal(fs.existsSync(old), false);
  const day = path.join(dir, `${localDay(T0 + 100 * S)}.jsonl`);
  fs.writeFileSync(day, '{"id":"torn'); // crash mid-write
  m.onEvent(toolErr("s1", T0 + 100 * S));
  m.onEvent(toolStart("s1", T0 + 105 * S));
  const lines = fs.readFileSync(day, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]).durationMs, 5 * S);
  assert.equal(make({ dir }).m.episodes().length, 1); // reload skips the torn line, keeps ours
});

test("session_end while stuck, and out-of-order replay, record nothing", () => {
  const { m } = make();
  m.onEvent(toolErr("s1", T0));
  m.onEvent(ev("s1", "session_end", T0 + 300 * S, { status: "ok" }));
  m.onEvent(toolErr("s2", T0 + 100 * S));
  m.onEvent(toolStart("s2", T0 + 50 * S)); // older than the start → cannot be the resolution
  assert.equal(m.episodes().length, 0);
});

test("unrelated events from other agents do not close an episode", () => {
  const { m } = make();
  m.onEvent(toolErr("s1", T0));
  m.onEvent(toolStart("s2", T0 + 3 * S));
  assert.equal(m.episodes().length, 0);
});

function seed(m) {
  const mk = (agent, start, secs, cwd, kind = "hook") => {
    const where = { cwd, repo: cwd.split("/")[2] };
    if (kind === "hook") {
      m.onEvent({ ...hook(agent, start, "waiting_permission"), ...where });
      m.onEvent({ ...hook(agent, start + secs * S, "working"), ...where });
    } else {
      m.onEvent({ ...toolErr(agent, start), ...where });
      m.onEvent({ ...toolStart(agent, start + secs * S), ...where });
    }
  };
  mk("a", T0, 10, "/w/acme-web/x");
  mk("b", T0 + 100 * S, 20, "/w/acme-web/x");
  mk("c", T0 + 200 * S, 30, "/w/acme-web/x");
  mk("d", T0 + 300 * S, 600, "/w/loose-repo", "err");
  // previous day
  mk("e", T0 - 24 * 3600 * S, 60, "/w/acme-web/x");
}

test("summary: total, by kind, by project, by day — all from the same episodes", () => {
  const { m } = make();
  seed(m);
  const s = m.summary({ days: 7 });
  assert.deepEqual(s.total, { count: 5, medianMs: 30 * S, p90Ms: 600 * S, totalMs: 720 * S });
  assert.equal(s.byKind.waiting_permission.count, 4);
  assert.equal(s.byKind.error.count, 1);
  assert.equal(s.byProject["acme-web"].count, 4);
  assert.equal(s.byProject["acme-web"].medianMs, 25 * S);
  assert.equal(s.byProject["loose-repo"].count, 1); // a cwd no project claims groups by repo name
  const today = s.byDay.find((d) => d.date === localDay(T0 + 400 * S));
  assert.equal(today.count, 4);
  assert.equal(s.byDay.length, 7);
  assert.equal(s.byDay.at(-1).date, localDay(m.now()));
});

test("summary filters: project (slug or repo), kind, days, single date", () => {
  const { m } = make();
  seed(m);
  assert.equal(m.summary({ days: 7, project: "acme-web" }).total.count, 4);
  assert.equal(m.summary({ days: 7, kind: "error" }).total.count, 1);
  assert.equal(m.summary({ days: 1 }).total.count, 4); // yesterday's episode drops out
  assert.equal(m.summary({ date: localDay(T0 - 24 * 3600 * S) }).total.count, 1);
  assert.equal(m.summary({ days: 7, project: "nobody" }).total.count, 0);
});

test("persisted per day; a restarted daemon replaying the same history does not double count", () => {
  const dir = tmpDir();
  const a = make({ dir }).m;
  seed(a);
  a.flush();
  const files = fs.readdirSync(dir).sort();
  assert.equal(files.length, 2);
  assert.match(files[0], /^\d{4}-\d{2}-\d{2}\.jsonl$/);

  const { m: b } = make({ dir });
  assert.equal(b.summary({ days: 7 }).total.count, 5); // loaded from disk
  seed(b); // transcript replay at boot
  b.flush();
  assert.equal(b.summary({ days: 7 }).total.count, 5);
  const lines = files.flatMap((f) => fs.readFileSync(path.join(dir, f), "utf8").trim().split("\n"));
  assert.equal(lines.length, 5);
});

test("history older than the retention window is ignored", () => {
  const { m, clock } = make({ retentionDays: 30 });
  clock.now = T0 + 60 * 24 * 3600 * S;
  m.onEvent(hook("s1", T0, "waiting_permission"));
  m.onEvent(hook("s1", T0 + 5 * S, "working"));
  assert.equal(m.episodes().length, 0);
});

test("project resolver: project cwd (incl. worktrees under it) → slug, else null", () => {
  const home = tmpDir();
  fs.mkdirSync(path.join(home, "projects", "acme-web"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "projects", "acme-web", "project.json"),
    JSON.stringify({ version: 1, slug: "acme-web", cwd: "/w/acme-web" }),
  );
  fs.mkdirSync(path.join(home, "projects", "broken"), { recursive: true });
  fs.writeFileSync(path.join(home, "projects", "broken", "project.json"), "{nope");
  const projectOf = createProjectResolver({ projectsDir: path.join(home, "projects") });
  assert.equal(projectOf("/w/acme-web"), "acme-web");
  assert.equal(projectOf("/w/acme-web/.claude/worktrees/l4"), "acme-web");
  assert.equal(projectOf("/w/acme-web-other"), null);
  assert.equal(projectOf(null), null);
  assert.equal(createProjectResolver({ projectsDir: path.join(home, "missing") })("/w/acme-web"), null);
});

test("GET /metrics/intervention returns the summary; bad params fall back to defaults", async () => {
  const { m } = make();
  seed(m);
  const handler = createMetricsHttpHandler(m);
  const call = (qs) =>
    new Promise((resolve) => {
      const res = {
        writeHead(status) { this.status = status; },
        end(body) { resolve({ status: this.status, body: JSON.parse(body) }); },
      };
      const handled = handler({ method: "GET" }, res, new URL(`http://x/metrics/intervention${qs}`));
      assert.equal(handled, true);
    });
  const ok = await call("?days=7&project=acme-web");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.total.count, 4);
  assert.equal((await call("?days=banana")).body.window.days, 7);
  assert.equal((await call("?days=9999")).body.window.days, 90);
  assert.equal(handler({ method: "GET" }, {}, new URL("http://x/other")), false);
});

test("sibling tool_results of one transcript line (same timestamp) are not a 0 ms intervention", () => {
  const { m } = make();
  m.onEvent(toolErr("s1", T0));
  m.onEvent(ev("s1", "tool_call", T0, { tool: "Read", status: "ok" }));
  assert.equal(m.episodes().length, 0);
  m.onEvent(toolStart("s1", T0 + 4 * S));
  assert.equal(m.episodes()[0].durationMs, 4 * S);
});
