import { test } from "node:test";
import assert from "node:assert/strict";
import { HookSignalReconciler } from "../src/hook-signal-reconciler.js";

const GRACE_MS = 30; // tiny grace window so tests run fast

function pre(overrides = {}) {
  return {
    v: 1,
    hook: "PreToolUse",
    ts: 1000,
    sessionId: "sess-1",
    cwd: "/repo",
    toolName: "Bash",
    toolUseId: "tu-1",
    ...overrides,
  };
}

function post(overrides = {}) {
  return pre({ hook: "PostToolUse", ts: 1100, ...overrides });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("fast Pre→Post pair emits nothing (auto-allowed tool must not flash red)", async () => {
  const r = new HookSignalReconciler({ graceMs: GRACE_MS });
  const out = [];
  r.onHookLine(pre(), (s) => out.push(s));
  r.onHookLine(post(), (s) => out.push(s));
  await sleep(GRACE_MS * 2);
  assert.deepEqual(out, []);
});

test("unconfirmed Pre emits waiting_permission after the grace window", async () => {
  const r = new HookSignalReconciler({ graceMs: GRACE_MS });
  const out = [];
  r.onHookLine(pre(), (s) => out.push(s));
  assert.deepEqual(out, []); // nothing yet — still inside the grace window
  await sleep(GRACE_MS * 2);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], {
    state: "waiting_permission",
    sessionId: "sess-1",
    cwd: "/repo",
    tool: "Bash",
    ts: 1000,
    toolUseId: "tu-1",
  });
});

test("Post after an emitted wait emits the working downgrade", async () => {
  const r = new HookSignalReconciler({ graceMs: GRACE_MS });
  const out = [];
  r.onHookLine(pre(), (s) => out.push(s));
  await sleep(GRACE_MS * 2);
  r.onHookLine(post({ ts: 2000 }), (s) => out.push(s));
  assert.equal(out.length, 2);
  assert.equal(out[1].state, "working");
  assert.equal(out[1].ts, 2000);
});

test("transcript tool_call event confirms too (PostToolUse missing)", async () => {
  const r = new HookSignalReconciler({ graceMs: GRACE_MS });
  const out = [];
  r.onHookLine(pre(), (s) => out.push(s));
  r.onNormalizedEvent({ type: "tool_call", sessionId: "sess-1", tool: "Bash", ts: 1050 });
  await sleep(GRACE_MS * 2);
  assert.deepEqual(out, []);
});

test("transcript confirmation after an emitted wait downgrades as well", async () => {
  const r = new HookSignalReconciler({ graceMs: GRACE_MS });
  const out = [];
  r.onHookLine(pre(), (s) => out.push(s));
  await sleep(GRACE_MS * 2);
  r.onNormalizedEvent({ type: "tool_call", sessionId: "sess-1", tool: "Bash", ts: 3000 });
  assert.equal(out.length, 2);
  assert.equal(out[1].state, "working");
});

test("lines without sessionId or toolName are ignored", async () => {
  const r = new HookSignalReconciler({ graceMs: GRACE_MS });
  const out = [];
  r.onHookLine(pre({ sessionId: null }), (s) => out.push(s));
  r.onHookLine(pre({ toolName: undefined }), (s) => out.push(s));
  r.onHookLine(null, (s) => out.push(s));
  await sleep(GRACE_MS * 2);
  assert.deepEqual(out, []);
});

test("a second Pre for the same session+tool restarts the wait (parallel calls collapse)", async () => {
  const r = new HookSignalReconciler({ graceMs: GRACE_MS });
  const out = [];
  r.onHookLine(pre({ toolUseId: "tu-a" }), (s) => out.push(s));
  await sleep(GRACE_MS / 2);
  r.onHookLine(pre({ toolUseId: "tu-b", ts: 1500 }), (s) => out.push(s));
  await sleep(GRACE_MS * 2);
  assert.equal(out.length, 1);
  assert.equal(out[0].toolUseId, "tu-b");
});
