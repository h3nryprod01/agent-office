#!/usr/bin/env node
// Agent Office — MCP permission server (the -p sibling of approve-gateway.mjs).
//
// The interactive PermissionRequest hook does NOT fire in `claude -p`, so the
// daemon-spawned PM (chat-session.js) can't route its permission prompts to the
// office that way. Claude Code's -p permission channel is instead a
// `--permission-prompt-tool`: an MCP tool Claude calls in place of the terminal
// dialog. This exposes exactly that tool (`approval_prompt`), routing each
// gated tool call to the office ✓/✗ via POST /approval-request (the same
// ApprovalBroker the interactive gateway uses).
//
// Fail-CLOSED: no office open / timeout / error → deny. Unlike the interactive
// hook's fail-open (which falls back to the terminal dialog), -p has no terminal
// to fall back to, so a silent allow would be the unsafe direction.
//
// Wire (chat-session.js): --permission-prompt-tool mcp__office__approval_prompt
//                         --mcp-config {"mcpServers":{"office":{command:node,args:[this]}}}

import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";

const PORT = process.env.AGENT_OFFICE_PORT ?? "8787";
const URL_BASE = `http://127.0.0.1:${PORT}`;

const TOOL = {
  name: "approval_prompt",
  description:
    "Ask for approval of a tool call through Agent Office. Claude Code calls this instead of showing a permission dialog when running with -p.",
  inputSchema: {
    type: "object",
    properties: {
      tool_name: { type: "string" },
      input: { type: "object" },
    },
    required: ["tool_name", "input"],
  },
};

/** POST to the daemon's ApprovalBroker; returns {decision: "allow"|"deny"|"none", message?}. */
async function askOffice(toolName, input, fetchFn = fetch) {
  try {
    const res = await fetchFn(`${URL_BASE}/approval-request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // lane L2: cwd (claude's cwd = the PM's repo) resolves the project policy; role "pm" lets a project override it.
      body: JSON.stringify({ tool: toolName, toolInput: input, cwd: process.cwd(), harness: "claude", role: "pm" }),
    });
    const body = await res.json();
    return { decision: body?.decision ?? "none", message: typeof body?.message === "string" ? body.message : undefined };
  } catch {
    return { decision: "none" };
  }
}

/**
 * Handle one JSON-RPC message. Returns the response object to write, or null
 * (notifications / no-id). `approve(toolName, input) => Promise<decision | {decision, message}>`
 * is injectable for tests.
 * @param {any} msg
 * @param {(toolName: string, input: object) => Promise<string>} [approve]
 * @returns {Promise<object|null>}
 */
export async function handleMessage(msg, approve = askOffice) {
  const { id, method, params } = msg ?? {};
  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "agent-office-approval", version: "1.0.0" },
      },
    };
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: [TOOL] } };
  }
  if (method === "tools/call") {
    const { name, arguments: args } = params ?? {};
    if (name !== "approval_prompt") {
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool: ${name}` } };
    }
    const answer = await approve(args?.tool_name, args?.input);
    const decision = typeof answer === "string" ? answer : answer?.decision;
    const policyMessage = typeof answer === "object" && typeof answer?.message === "string" ? answer.message : null;
    // Claude's permission-prompt-tool contract: the tool result text is a JSON
    // {behavior:"allow", updatedInput} or {behavior:"deny", message}.
    const payload =
      decision === "allow"
        ? { behavior: "allow", updatedInput: args?.input ?? {} }
        : { behavior: "deny", message: policyMessage ?? "Denied, or no office was open to approve it (Agent Office)." };
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } };
  }
  if (id == null) return null; // notification — no response
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
}

// stdio loop — runs only when executed directly (by Claude), not when imported
// by the test.
const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const response = await handleMessage(msg);
    if (response) process.stdout.write(JSON.stringify(response) + "\n");
  });
}
