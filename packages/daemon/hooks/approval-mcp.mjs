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

// lane L4: lets an agent ask "is anyone else writing this file?" before it edits.
const WHO_IS_TOUCHING = {
  name: "who_is_touching",
  description:
    "Before editing a file, ask Agent Office which OTHER agents have recently written it (last ~10 minutes), including agents working on the same file in a different git worktree. Returns a short plain-text answer; it never blocks anything.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "File path, absolute or relative to the current directory" },
      session_id: { type: "string", description: "Your own session id, if you know it, so you are left out of the answer" },
    },
    required: ["path"],
  },
};

/** POST to the daemon's ApprovalBroker; returns "allow" | "deny" | "none". */
async function askOffice(toolName, input, fetchFn = fetch) {
  try {
    const res = await fetchFn(`${URL_BASE}/approval-request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: toolName, toolInput: input }),
    });
    const body = await res.json();
    return body?.decision ?? "none";
  } catch {
    return "none";
  }
}

/** GET the radar's view of one path; returns the parsed answer or null when the office is unreachable. */
async function askRadar(path, sessionId, fetchFn = fetch) {
  try {
    const qs = new URLSearchParams({ path, cwd: process.cwd() });
    if (sessionId) qs.set("exclude", sessionId);
    const res = await fetchFn(`${URL_BASE}/radar/touching?${qs}`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

/** An agent's name derives from a folder it controls and is shown to OTHER agents: flatten and cap it. */
export const cleanName = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 40);
const ago = (ms) => (ms < 90_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}min`);

/** Plain-text answer for the agent. Exported for the test. */
export function describeTouching(answer, askerKnown = true) {
  if (!answer) return "Agent Office is not reachable, so I cannot tell who else is touching this file.";
  const line = (t) => `- ${cleanName(t.name)} (${t.harness ?? "unknown"}, repo ${t.repo ?? "?"}) via ${t.tool ?? "a write"}, ${ago(t.ageMs)} ago`;
  const out = [];
  if (answer.touching.length) {
    out.push(`${answer.touching.length} other agent(s) wrote ${answer.path} recently:`, ...answer.touching.map(line));
  }
  if (answer.worktreeTwins.length) {
    out.push(
      "The same file (same repo-relative path) was written in another worktree — expect a merge conflict:",
      ...answer.worktreeTwins.map((t) => `${line(t)} in ${t.cwd ?? "another worktree"}`),
    );
  }
  const youNote = askerKnown ? "" : "\n(Without a session_id this list may include you.)";
  return out.length
    ? `${out.join("\n")}\nConsider waiting, or coordinate before editing.${youNote}`
    : `Nobody else is writing ${answer.path} right now.`;
}

/**
 * Handle one JSON-RPC message. Returns the response object to write, or null
 * (notifications / no-id). `approve(toolName, input) => Promise<decision>` is
 * injectable for tests.
 * @param {any} msg
 * @param {(toolName: string, input: object) => Promise<string>} [approve]
 * @param {(path: string, sessionId?: string) => Promise<object|null>} [touching] lane L4: radar lookup
 * @returns {Promise<object|null>}
 */
export async function handleMessage(msg, approve = askOffice, touching = askRadar) {
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
    return { jsonrpc: "2.0", id, result: { tools: [TOOL, WHO_IS_TOUCHING] } };
  }
  if (method === "tools/call") {
    const { name, arguments: args } = params ?? {};
    if (name === "who_is_touching") {
      if (typeof args?.path !== "string" || !args.path) {
        return { jsonrpc: "2.0", id, error: { code: -32602, message: "path (string) is required" } };
      }
      const text = describeTouching(await touching(args.path, args.session_id), Boolean(args.session_id));
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } };
    }
    if (name !== "approval_prompt") {
      return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool: ${name}` } };
    }
    const decision = await approve(args?.tool_name, args?.input);
    // Claude's permission-prompt-tool contract: the tool result text is a JSON
    // {behavior:"allow", updatedInput} or {behavior:"deny", message}.
    const payload =
      decision === "allow"
        ? { behavior: "allow", updatedInput: args?.input ?? {} }
        : { behavior: "deny", message: "Denied, or no office was open to approve it (Agent Office)." };
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
