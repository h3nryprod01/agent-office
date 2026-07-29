// Fixture lines are synthesized from real rollout records observed in
// ~/.codex/sessions/**/rollout-*.jsonl on this machine (codex-cli 0.142.x),
// with contents shortened/sanitized. Field names and nesting are verbatim.

import test from "node:test";
import assert from "node:assert/strict";
import { CodexSessionNormalizer } from "../src/codex-normalize.js";

const SID = "019f32a1-5afa-7b60-9a40-02a7ff1dc28e";
const TS = "2026-07-05T14:15:11.767Z";

function line(type, payload) {
  return { timestamp: TS, type, payload };
}

const sessionMeta = line("session_meta", {
  session_id: SID,
  cwd: "/Users/u/Projects/demo",
  originator: "Codex Desktop",
  cli_version: "0.142.3",
  thread_source: "user",
  source: "vscode",
});

test("session_meta emits session_start with harness codex", () => {
  const n = new CodexSessionNormalizer(SID);
  const events = n.normalizeLine(sessionMeta);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.type, "session_start");
  assert.equal(e.harness, "codex");
  assert.equal(e.sessionId, SID);
  assert.equal(e.agentId, SID);
  assert.equal(e.parentId, null);
  assert.equal(e.cwd, "/Users/u/Projects/demo");
  assert.equal(e.agent, "demo");
  assert.equal(e.v, 1);
});

test("subagent session_meta resolves parentId from parent_thread_id", () => {
  const n = new CodexSessionNormalizer(SID);
  const [e] = n.normalizeLine(
    line("session_meta", {
      session_id: SID,
      cwd: "/Users/u/Projects/demo",
      thread_source: "subagent",
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: "019eb2ca-1116-74a3-8c2c-a860aed98b2d",
            depth: 1,
            agent_nickname: "Lovelace",
          },
        },
      },
    })
  );
  assert.equal(e.parentId, "019eb2ca-1116-74a3-8c2c-a860aed98b2d");
  assert.equal(e.meta.agentNickname, "Lovelace");
  assert.equal(e.agent, "Lovelace"); // nickname beats the cwd-derived label
});

test("activity before session_meta emits a synthetic session_start first", () => {
  const n = new CodexSessionNormalizer(SID);
  const events = n.normalizeLine(
    line("response_item", {
      type: "function_call",
      name: "exec_command",
      arguments: '{"cmd":"ls"}',
      call_id: "call_orphan",
    })
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].type, "session_start");
  assert.equal(events[0].meta.inferred, true);
  assert.equal(events[1].type, "tool_call");
  // a later session_meta (resume) must not emit a second session_start
  assert.equal(n.normalizeLine(sessionMeta).length, 0);
});

test("function_call/function_call_output pair into start + ok tool_call events", () => {
  const n = new CodexSessionNormalizer(SID);
  n.normalizeLine(sessionMeta);

  const [start] = n.normalizeLine(
    line("response_item", {
      type: "function_call",
      name: "exec_command",
      arguments: '{"cmd":"ls -la","workdir":"/Users/u/Projects/demo"}',
      call_id: "call_abc123",
    })
  );
  assert.equal(start.type, "tool_call");
  assert.equal(start.tool, "exec_command");
  assert.equal(start.status, "start");
  assert.equal(start.id, "call_abc123:start");
  assert.match(start.detail, /ls -la/);
  assert.equal(start.harness, "codex");
  assert.equal(start.cwd, "/Users/u/Projects/demo");

  const [end] = n.normalizeLine(
    line("response_item", {
      type: "function_call_output",
      call_id: "call_abc123",
      output: "Chunk ID: 697a34\nWall time: 0.0 seconds\nProcess exited with code 0\nOutput:\ntotal 8",
    })
  );
  assert.equal(end.type, "tool_call");
  assert.equal(end.tool, "exec_command");
  assert.equal(end.status, "ok");
  assert.equal(end.id, "call_abc123:end");
});

test("non-zero exit code in output marks the tool_call as error", () => {
  const n = new CodexSessionNormalizer(SID);
  n.normalizeLine(
    line("response_item", {
      type: "function_call",
      name: "exec_command",
      arguments: '{"cmd":"pdftotext x.pdf"}',
      call_id: "call_err",
    })
  );
  const [end] = n.normalizeLine(
    line("response_item", {
      type: "function_call_output",
      call_id: "call_err",
      output: "Chunk ID: 587f24\nProcess exited with code 1\nOutput:\npdftotext not found",
    })
  );
  assert.equal(end.status, "error");
});

test("custom_tool_call (apply_patch) pairs with block-array output", () => {
  const n = new CodexSessionNormalizer(SID);
  n.normalizeLine(sessionMeta);
  const [start] = n.normalizeLine(
    line("response_item", {
      type: "custom_tool_call",
      name: "apply_patch",
      input: "*** Begin Patch\n*** Update File: /Users/u/Projects/demo/a.js\n*** End Patch",
      call_id: "call_patch",
    })
  );
  assert.equal(start.tool, "apply_patch");
  assert.equal(start.status, "start");

  const [end] = n.normalizeLine(
    line("response_item", {
      type: "custom_tool_call_output",
      call_id: "call_patch",
      output: [{ type: "input_text", text: "Exit code: 0\nSuccess. Updated a.js" }],
    })
  );
  assert.equal(end.tool, "apply_patch");
  assert.equal(end.status, "ok");
  assert.match(end.detail, /Success/);
});

test("agent_message becomes a speak event with a stable per-file id", () => {
  const n = new CodexSessionNormalizer(SID);
  n.normalizeLine(sessionMeta);
  const [e1] = n.normalizeLine(
    line("event_msg", { type: "agent_message", message: "Mình sẽ dùng skill plugin-creator." })
  );
  const [e2] = n.normalizeLine(line("event_msg", { type: "agent_message", message: "Xong." }));
  assert.equal(e1.type, "speak");
  assert.equal(e1.harness, "codex");
  assert.match(e1.detail, /plugin-creator/);
  assert.notEqual(e1.id, e2.id);
});

test("web_search_call emits a single completed tool_call", () => {
  const n = new CodexSessionNormalizer(SID);
  n.normalizeLine(sessionMeta);
  const [e] = n.normalizeLine(
    line("response_item", {
      type: "web_search_call",
      id: "ws_123",
      status: "completed",
      action: { type: "search", query: "Zernio MCP API" },
    })
  );
  assert.equal(e.type, "tool_call");
  assert.equal(e.tool, "web_search");
  assert.equal(e.status, "ok");
  assert.equal(e.detail, "Zernio MCP API");
});

test("turn_context updates cwd for subsequent events", () => {
  const n = new CodexSessionNormalizer(SID);
  n.normalizeLine(sessionMeta);
  assert.equal(n.normalizeLine(line("turn_context", { cwd: "/Users/u/Projects/other" })).length, 0);
  const [e] = n.normalizeLine(
    line("event_msg", { type: "agent_message", message: "moved" })
  );
  assert.equal(e.cwd, "/Users/u/Projects/other");
  assert.equal(e.agent, "other");
});

test("bookkeeping lines emit nothing", () => {
  const n = new CodexSessionNormalizer(SID);
  for (const raw of [
    line("event_msg", { type: "token_count", info: {} }),
    line("event_msg", { type: "task_started", turn_id: "t1" }),
    line("event_msg", { type: "task_complete", turn_id: "t1" }),
    line("response_item", { type: "reasoning", encrypted_content: "..." }),
    line("response_item", { type: "message", role: "developer", content: [] }),
    line("compacted", {}),
    { not: "a rollout line" },
  ]) {
    assert.equal(n.normalizeLine(raw).length, 0, JSON.stringify(raw).slice(0, 60));
  }
});
