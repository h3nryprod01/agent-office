import test from "node:test";
import assert from "node:assert/strict";
import { HermesSessionNormalizer } from "../src/hermes-normalize.js";
import { toolCalls } from "./hermes-fixture.js";

const SID = "20260101_000000_demo0001";
const session = { id: SID, source: "telegram", model: "demo-model", cwd: null, git_repo_root: null, started_at: 1767225600 };
const msg = (over) => ({ id: 1, role: "assistant", content: null, toolCalls: [], toolName: null, toolCallId: null, ts: 1767225601_000, ...over });

test("first message opens the character: session_start with harness hermes", () => {
  const n = new HermesSessionNormalizer(SID);
  const events = n.normalizeMessage(msg({ id: 1, role: "user", content: "hello" }), session);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.type, "session_start");
  assert.equal(e.harness, "hermes");
  assert.equal(e.sessionId, SID);
  assert.equal(e.agentId, SID);
  assert.equal(e.parentId, null);
  assert.equal(e.repo, "hermes"); // no cwd: Hermes gets its own office
  assert.equal(e.ts, 1767225600_000);
  assert.equal(e.meta.model, "demo-model");
  assert.equal(e.lane, null);
});

test("session_start is emitted once; user text is not character activity", () => {
  const n = new HermesSessionNormalizer(SID);
  n.normalizeMessage(msg({ id: 1, role: "user", content: "hi" }), session);
  assert.deepEqual(n.normalizeMessage(msg({ id: 2, role: "user", content: "again" }), session), []);
});

test("assistant text -> speak/text, truncated to one line", () => {
  const n = new HermesSessionNormalizer(SID);
  n.normalizeMessage(msg({ id: 1, role: "user", content: "hi" }), session);
  const [e] = n.normalizeMessage(msg({ id: 2, content: "line one\nline two" }), session);
  assert.equal(e.type, "speak");
  assert.equal(e.detail, "line one line two");
  assert.equal(e.meta.kind, "text");
});

test("assistant tool_calls -> tool_call start (one per call); tool result -> end with the same tool name", () => {
  const n = new HermesSessionNormalizer(SID);
  n.normalizeMessage(msg({ id: 1, role: "user", content: "hi" }), session);
  const calls = JSON.parse(toolCalls(["call_a", "read_file", { path: "/tmp/demo/notes.md" }], ["call_b", "terminal", { command: "ls" }]));
  const starts = n.normalizeMessage(msg({ id: 2, toolCalls: calls }), session);
  assert.deepEqual(starts.map((e) => [e.type, e.tool, e.status, e.id]), [
    ["tool_call", "read_file", "start", "call_a:start"],
    ["tool_call", "terminal", "start", "call_b:start"],
  ]);
  assert.match(starts[0].detail, /read_file: \/tmp\/demo\/notes\.md/);
  assert.match(starts[1].detail, /terminal: ls/);

  const [end] = n.normalizeMessage(
    msg({ id: 3, role: "tool", toolCallId: "call_a", toolName: "read_file", content: '{"content":"x","not_found":false}' }),
    session,
  );
  assert.deepEqual([end.type, end.tool, end.status, end.id], ["tool_call", "read_file", "ok", "call_a:end"]);
});

test("tool result that says success:false or carries an error is an error", () => {
  const n = new HermesSessionNormalizer(SID);
  n.normalizeMessage(msg({ id: 1, role: "user", content: "hi" }), session);
  const bad = n.normalizeMessage(msg({ id: 2, role: "tool", toolCallId: "c1", toolName: "browser", content: '{"success":false,"error":"boom"}' }), session);
  assert.equal(bad[0].status, "error");
  const plain = n.normalizeMessage(msg({ id: 3, role: "tool", toolCallId: "c2", toolName: "terminal", content: "exit 0" }), session);
  assert.equal(plain[0].status, "ok");
});

test("cwd (or git root) becomes the desk and repo; session_meta rows are ignored", () => {
  const n = new HermesSessionNormalizer(SID);
  const withCwd = { ...session, cwd: "/tmp/demo-app/.claude/worktrees/x" };
  assert.deepEqual(n.normalizeMessage(msg({ role: "session_meta" }), withCwd), []);
  const [start] = n.normalizeMessage(msg({ id: 2, role: "user", content: "hi" }), withCwd);
  assert.equal(start.repo, "demo-app");
  assert.equal(start.cwd, "/tmp/demo-app/.claude/worktrees/x");
});
