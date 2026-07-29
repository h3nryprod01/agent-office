import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMessage } from "../hooks/approval-mcp.mjs";

test("initialize → protocolVersion + tools capability", async () => {
  const r = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize" });
  assert.equal(r.id, 1);
  assert.ok(r.result.protocolVersion);
  assert.ok(r.result.capabilities.tools);
});

test("tools/list → exposes approval_prompt", async () => {
  const r = await handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(r.result.tools[0].name, "approval_prompt");
});

test("tools/call: office allows → behavior allow + passes input through", async () => {
  const r = await handleMessage(
    {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "approval_prompt", arguments: { tool_name: "Write", input: { file_path: "x" } } },
    },
    async () => "allow",
  );
  const payload = JSON.parse(r.result.content[0].text);
  assert.equal(payload.behavior, "allow");
  assert.deepEqual(payload.updatedInput, { file_path: "x" });
});

test("tools/call: office denies → behavior deny", async () => {
  const r = await handleMessage(
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "approval_prompt", arguments: { tool_name: "Bash", input: {} } } },
    async () => "deny",
  );
  assert.equal(JSON.parse(r.result.content[0].text).behavior, "deny");
});

test("tools/call: 'none' (no office / timeout) → deny (FAIL-CLOSED, no terminal fallback in -p)", async () => {
  const r = await handleMessage(
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "approval_prompt", arguments: { tool_name: "Bash", input: {} } } },
    async () => "none",
  );
  assert.equal(JSON.parse(r.result.content[0].text).behavior, "deny");
});

test("tools/call: unknown tool → JSON-RPC error", async () => {
  const r = await handleMessage(
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "other", arguments: {} } },
    async () => "allow",
  );
  assert.ok(r.error);
});

test("notification (no id) → no response", async () => {
  const r = await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(r, null);
});
