import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileRadar } from "../src/radar.js";

const TTL = 10 * 60 * 1000;
const T0 = 1_700_000_000_000;

function setup(overrides = {}) {
  const clock = { now: T0 };
  const emitted = [];
  const notified = [];
  const radar = new FileRadar({
    ttlMs: TTL,
    now: () => clock.now,
    emit: (e) => emitted.push(e),
    notify: (n) => notified.push(n),
    checkout: () => null,
    checkoutDir: () => null,
    ...overrides,
  });
  return { radar, clock, emitted, notified, alerts: () => emitted.filter((e) => e.type === "collision_alert") };
}

let seq = 0;
function edit(agent, file, extra = {}) {
  return {
    v: 1,
    id: `e${++seq}`,
    type: "tool_call",
    sessionId: agent.sessionId ?? agent.agentId,
    agentId: agent.agentId,
    parentId: agent.parentId ?? null,
    cwd: agent.cwd ?? "/w/demo-app",
    repo: agent.repo ?? "demo-app",
    harness: agent.harness ?? "claude-code",
    ts: extra.ts ?? T0,
    agent: agent.name ?? agent.agentId,
    tool: "Edit",
    status: "start",
    detail: `Edit: ${file}`,
    meta: { toolUseId: `tu${seq}`, paths: [file] },
    ...extra,
  };
}

const A = { agentId: "sess-a", name: "alpha" };
const B = { agentId: "sess-b", name: "beta" };

test("two unrelated sessions editing one file → exactly one collision alert + one notification", () => {
  const { radar, alerts, notified } = setup();
  radar.onEvent(edit(A, "/w/demo-app/src/x.ts"));
  assert.equal(alerts().length, 0);
  radar.onEvent(edit(B, "/w/demo-app/src/x.ts"));
  radar.onEvent(edit(A, "/w/demo-app/src/x.ts")); // ping-pong must not re-alert
  radar.onEvent(edit(B, "/w/demo-app/src/x.ts"));
  assert.equal(alerts().length, 1);
  const a = alerts()[0];
  assert.equal(a.meta.kind, "file");
  assert.equal(a.meta.severity, "hard");
  assert.equal(a.meta.path, "/w/demo-app/src/x.ts");
  assert.deepEqual(a.meta.agents.map((x) => x.agentId).sort(), ["sess-a", "sess-b"]);
  assert.equal(a.agentId, "sess-b"); // anchored on whoever touched second
  assert.equal(notified.length, 1);
});

test("parent and child (sub-agent of the same session) never collide", () => {
  const { radar, alerts } = setup();
  const root = { agentId: "root", sessionId: "root" };
  const child = { agentId: "child", sessionId: "root", parentId: "root" };
  const grandchild = { agentId: "gc", sessionId: "root", parentId: "child" };
  radar.onEvent(edit(root, "/w/demo-app/a.ts"));
  radar.onEvent(edit(child, "/w/demo-app/a.ts"));
  radar.onEvent(edit(grandchild, "/w/demo-app/a.ts"));
  assert.equal(alerts().length, 0);
});

test("codex-style child thread (own sessionId, parentId = parent thread) is the same tree", () => {
  const { radar, alerts } = setup();
  radar.onEvent(edit({ agentId: "thread-1", harness: "codex" }, "/w/demo-app/a.ts"));
  radar.onEvent(edit({ agentId: "thread-2", parentId: "thread-1", harness: "codex" }, "/w/demo-app/a.ts"));
  assert.equal(alerts().length, 0);
});

test("a sub-agent collides with an UNRELATED session", () => {
  const { radar, alerts } = setup();
  radar.onEvent(edit({ agentId: "r1", sessionId: "r1" }, "/w/demo-app/a.ts"));
  radar.onEvent(edit({ agentId: "kid", sessionId: "r2", parentId: "r2" }, "/w/demo-app/a.ts"));
  assert.equal(alerts().length, 1);
});

test("different files do not collide; read-only / finished / pathless events are ignored", () => {
  const { radar, alerts } = setup();
  radar.onEvent(edit(A, "/w/demo-app/a.ts"));
  radar.onEvent(edit(B, "/w/demo-app/b.ts"));
  radar.onEvent(edit(B, "/w/demo-app/a.ts", { status: "ok", id: "end-1" })); // result line, not an intent
  radar.onEvent(edit(B, "/w/demo-app/a.ts", { tool: "Read", meta: { toolUseId: "r" } }));
  assert.equal(alerts().length, 0);
});

test("touches expire: the same file hours apart is no collision, and a stale replay is ignored", () => {
  const { radar, clock, alerts } = setup();
  radar.onEvent(edit(A, "/w/demo-app/a.ts", { ts: T0 }));
  clock.now = T0 + TTL + 1;
  radar.onEvent(edit(B, "/w/demo-app/a.ts", { ts: clock.now }));
  assert.equal(alerts().length, 0);
  // boot-time replay of an old transcript line
  radar.onEvent(edit({ agentId: "old" }, "/w/demo-app/a.ts", { ts: T0 }));
  assert.equal(alerts().length, 0);
});

test("alert resolves once one side has gone quiet for the TTL, and can fire again later", () => {
  const { radar, clock, emitted, alerts } = setup();
  radar.onEvent(edit(A, "/w/demo-app/a.ts"));
  radar.onEvent(edit(B, "/w/demo-app/a.ts"));
  assert.equal(radar.list().alerts.length, 1);
  clock.now = T0 + TTL + 1;
  radar.onEvent(edit(B, "/w/demo-app/other.ts", { ts: clock.now })); // B alive, A silent
  radar.sweep();
  assert.equal(radar.list().alerts.length, 0);
  assert.equal(emitted.filter((e) => e.type === "collision_resolved").length, 1);
  assert.equal(emitted.at(-1).meta.alertId, alerts()[0].meta.alertId);
  // A comes back to the same file → a fresh collision
  radar.onEvent(edit(A, "/w/demo-app/a.ts", { ts: clock.now }));
  radar.onEvent(edit(B, "/w/demo-app/a.ts", { ts: clock.now }));
  assert.equal(alerts().length, 2);
});

function gitTree() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ao-radar-")));
  const main = path.join(base, "acme-web");
  const wt = path.join(base, "acme-web-wt");
  fs.mkdirSync(path.join(main, ".git", "worktrees", "wt"), { recursive: true });
  fs.mkdirSync(wt, { recursive: true });
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(main, ".git", "worktrees", "wt")}\n`);
  const other = path.join(base, "other-repo");
  fs.mkdirSync(path.join(other, ".git"), { recursive: true });
  return { main, wt, other };
}

test("same repo, different worktrees, same relative path → one SOFT alert, no desktop notification", async () => {
  const { checkoutOf, checkoutOfDir } = await import("../src/checkout.js");
  const { main, wt } = gitTree();
  const { radar, alerts, notified } = setup({ checkout: checkoutOf, checkoutDir: checkoutOfDir });
  radar.onEvent(edit({ ...A, cwd: main }, path.join(main, "src", "x.ts")));
  radar.onEvent(edit({ ...B, cwd: wt }, path.join(wt, "src", "x.ts")));
  radar.onEvent(edit({ ...B, cwd: wt }, path.join(wt, "src", "x.ts")));
  assert.equal(alerts().length, 1);
  assert.equal(alerts()[0].meta.kind, "worktree");
  assert.equal(alerts()[0].meta.severity, "soft");
  assert.equal(alerts()[0].meta.relPath, path.join("src", "x.ts"));
  assert.equal(notified.length, 0);
});

test("worktrees of DIFFERENT repos, or different relative paths, raise nothing", async () => {
  const { checkoutOf, checkoutOfDir } = await import("../src/checkout.js");
  const { main, wt, other } = gitTree();
  const { radar, alerts } = setup({ checkout: checkoutOf, checkoutDir: checkoutOfDir });
  radar.onEvent(edit({ ...A, cwd: main }, path.join(main, "src", "x.ts")));
  radar.onEvent(edit({ ...B, cwd: other }, path.join(other, "src", "x.ts")));
  radar.onEvent(edit({ agentId: "c" , cwd: wt }, path.join(wt, "src", "y.ts")));
  assert.equal(alerts().length, 0);
});

test("two claude-worker sessions on one repo → a worker alert; one worker alone, or on another repo, is fine", async () => {
  const { checkoutOf, checkoutOfDir } = await import("../src/checkout.js");
  const { main, wt, other } = gitTree();
  const { radar, alerts, notified } = setup({ checkout: checkoutOf, checkoutDir: checkoutOfDir });
  const w = (id, cwd) => ({ agentId: id, harness: "claude-worker", cwd });
  radar.onEvent(edit(w("w1", main), path.join(main, "a.ts")));
  radar.onEvent(edit(w("w3", other), path.join(other, "a.ts")));
  assert.equal(alerts().length, 0);
  radar.onEvent(edit(w("w2", wt), path.join(wt, "z.ts"))); // other worktree of the same repo
  assert.equal(alerts().length, 1);
  assert.equal(alerts()[0].meta.kind, "worker");
  assert.equal(notified.length, 1);
  radar.onEvent(edit(w("w2", wt), path.join(wt, "z2.ts")));
  assert.equal(alerts().length, 1);
});

test("a worker next to a normal claude session on one repo is NOT a worker alert", async () => {
  const { checkoutOf, checkoutOfDir } = await import("../src/checkout.js");
  const { main } = gitTree();
  const { radar, alerts } = setup({ checkout: checkoutOf, checkoutDir: checkoutOfDir });
  radar.onEvent(edit({ agentId: "w1", harness: "claude-worker", cwd: main }, path.join(main, "a.ts")));
  radar.onEvent(edit({ agentId: "me", harness: "claude-code", cwd: main }, path.join(main, "b.ts")));
  assert.equal(alerts().length, 0);
});

test("a worker and its own sub-agents are one tree (no worker alert)", async () => {
  const { checkoutOf, checkoutOfDir } = await import("../src/checkout.js");
  const { main } = gitTree();
  const { radar, alerts } = setup({ checkout: checkoutOf, checkoutDir: checkoutOfDir });
  radar.onEvent(edit({ agentId: "w1", harness: "claude-worker", cwd: main }, path.join(main, "a.ts")));
  radar.onEvent(edit({ agentId: "w1-kid", sessionId: "w1", parentId: "w1", harness: "claude-worker", cwd: main }, path.join(main, "b.ts")));
  assert.equal(alerts().length, 0);
});

test("whoIsTouching: lists live touchers (hard) and other-worktree twins (soft), can exclude the asker", async () => {
  const { checkoutOf, checkoutOfDir } = await import("../src/checkout.js");
  const { main, wt } = gitTree();
  const { radar, clock } = setup({ checkout: checkoutOf, checkoutDir: checkoutOfDir });
  radar.onEvent(edit({ ...A, cwd: main }, path.join(main, "src", "x.ts")));
  radar.onEvent(edit({ ...B, cwd: wt }, path.join(wt, "src", "x.ts")));
  clock.now = T0 + 5000;

  const hard = radar.whoIsTouching(path.join(main, "src", "x.ts"));
  assert.deepEqual(hard.touching.map((t) => t.agentId), ["sess-a"]);
  assert.equal(hard.touching[0].ageMs, 5000);
  assert.deepEqual(hard.worktreeTwins.map((t) => t.agentId), ["sess-b"]);

  const excl = radar.whoIsTouching(path.join(main, "src", "x.ts"), { excludeSessionId: "sess-a" });
  assert.deepEqual(excl.touching, []);

  clock.now = T0 + TTL + 1;
  assert.deepEqual(radar.whoIsTouching(path.join(main, "src", "x.ts")).touching, []);
});

test("agentCwd resolves by agentId or sessionId", () => {
  const { radar } = setup();
  radar.onEvent(edit({ agentId: "kid", sessionId: "root", parentId: "root", cwd: "/w/p" }, "/w/p/a.ts"));
  assert.equal(radar.agentCwd("kid"), "/w/p");
  assert.equal(radar.agentCwd("root"), "/w/p"); // falls back to any agent of that session
  assert.equal(radar.agentCwd("nope"), null);
});

test("a third agent on the same file updates the open alert instead of raising another", () => {
  const { radar, alerts, notified } = setup();
  radar.onEvent(edit(A, "/w/demo-app/src/x.ts"));
  radar.onEvent(edit(B, "/w/demo-app/src/x.ts"));
  radar.onEvent(edit({ agentId: "thread-9", harness: "codex", name: "gamma" }, "/w/demo-app/src/x.ts"));
  radar.onEvent(edit({ agentId: "thread-9", harness: "codex", name: "gamma" }, "/w/demo-app/src/x.ts"));
  const all = alerts();
  assert.equal(all.length, 2); // the original + one revision
  assert.equal(all[0].meta.alertId, all[1].meta.alertId);
  assert.notEqual(all[0].id, all[1].id);
  assert.deepEqual(all[1].meta.agents.map((a) => a.agentId).sort(), ["sess-a", "sess-b", "thread-9"]);
  assert.equal(all[1].agentId, "thread-9");
  assert.equal(radar.list().alerts.length, 1);
  assert.equal(notified.length, 1);
});

test("the alert survives while two trees remain, and closes when only one is left", () => {
  const { radar, clock } = setup();
  radar.onEvent(edit(A, "/w/demo-app/x.ts", { ts: T0 }));
  radar.onEvent(edit(B, "/w/demo-app/x.ts", { ts: T0 + 400_000 }));
  radar.onEvent(edit({ agentId: "c" }, "/w/demo-app/x.ts", { ts: T0 + 500_000 }));
  clock.now = T0 + TTL + 1; // A is stale, B and C still live
  radar.sweep();
  assert.equal(radar.list().alerts.length, 1);
  clock.now = T0 + 400_000 + TTL + 1; // B stale too
  radar.sweep();
  assert.equal(radar.list().alerts.length, 0);
});

test("sessions that share a folder label are told apart by a short id in the alert text", () => {
  const { radar, alerts } = setup();
  radar.onEvent(edit({ agentId: "1111aaaa", name: "demo-app" }, "/w/demo-app/x.ts"));
  radar.onEvent(edit({ agentId: "2222bbbb", name: "demo-app" }, "/w/demo-app/x.ts"));
  assert.match(alerts()[0].detail, /demo-app#1111 and demo-app#2222 are editing x\.ts/);
});

test("a finished session hands its files over: the next agent on them is not a collision", () => {
  const { radar, alerts } = setup();
  radar.onEvent(edit(A, "/w/demo-app/a.ts"));
  radar.onEvent({ ...edit(A, "/w/demo-app/a.ts"), type: "session_end", status: "ok", meta: null, id: "end-a" });
  radar.onEvent(edit(B, "/w/demo-app/a.ts", { ts: T0 + 60_000 }));
  assert.equal(alerts().length, 0);
});

test("a session_end closes an open alert", () => {
  const { radar, emitted } = setup();
  radar.onEvent(edit(A, "/w/demo-app/a.ts"));
  radar.onEvent(edit(B, "/w/demo-app/a.ts"));
  radar.onEvent({ ...edit(A, "/w/demo-app/a.ts"), type: "session_end", status: "ok", meta: null, id: "end-a" });
  assert.equal(radar.list().alerts.length, 0);
  assert.equal(emitted.filter((e) => e.type === "collision_resolved").length, 1);
});

test("agentCwd still answers for a session that has been quiet far longer than the TTL", () => {
  const { radar, clock } = setup();
  radar.onEvent(edit({ agentId: "quiet", cwd: "/w/quiet" }, "/w/quiet/a.ts"));
  clock.now = T0 + TTL * 20;
  radar.sweep();
  assert.equal(radar.agentCwd("quiet"), "/w/quiet");
});

test("a collision found while replaying old history is shown but does not notify again", () => {
  const { radar, clock, alerts, notified } = setup();
  clock.now = T0 + 5 * 60_000; // daemon restarted 5 min after the edits
  radar.onEvent(edit(A, "/w/demo-app/a.ts", { ts: T0 }));
  radar.onEvent(edit(B, "/w/demo-app/a.ts", { ts: T0 + 1000 }));
  assert.equal(alerts().length, 1);
  assert.equal(notified.length, 0);
});

test("an event with a bad timestamp cannot pin an agent as live forever", () => {
  const { radar, alerts } = setup();
  radar.onEvent(edit(A, "/w/demo-app/a.ts", { ts: NaN }));
  radar.onEvent(edit(B, "/w/demo-app/a.ts"));
  assert.equal(alerts().length, 0);
});
