#!/usr/bin/env node
// Agent Office — SAMPLE PreToolUse hook: warn (never block) when another agent
// is already writing the file this one is about to edit.
//
// NOT installed automatically. To turn it on, see docs/radar.md — in short, add
// to .claude/settings.json (project) or ~/.claude/settings.json (user):
//   "hooks": { "PreToolUse": [ { "matcher": "Edit|Write|MultiEdit|NotebookEdit",
//     "hooks": [ { "type": "command", "command": "node /path/to/pre-edit-radar.mjs" } ] } ] }
//
// It asks the daemon's radar (GET /radar/touching) and, when somebody else —
// including an agent in another git worktree of this repo — touched the file
// within the radar window, it prints a warning for the agent (additionalContext)
// and for you (systemMessage). It NEVER sets a permission decision, always exits
// 0, and gives up after 1.5 s: if the office is down the edit just proceeds.

import { pathToFileURL } from "node:url";

const PORT = process.env.AGENT_OFFICE_PORT ?? "8787";
const TIMEOUT_MS = 1500;

/** @returns {Promise<object|null>} hook JSON output, or null for "say nothing" */
export async function buildWarning(input, fetchFn = fetch) {
  const toolInput = input?.tool_input ?? {};
  const file = toolInput.file_path ?? toolInput.notebook_path;
  if (typeof file !== "string" || !file) return null;
  let answer;
  try {
    const qs = new URLSearchParams({ path: file, cwd: input.cwd ?? process.cwd() });
    if (input.session_id) qs.set("exclude", input.session_id);
    const res = await fetchFn(`http://127.0.0.1:${PORT}/radar/touching?${qs}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) return null;
    answer = await res.json();
  } catch {
    return null; // office down or slow: stay out of the way
  }
  const others = [...(answer.touching ?? []), ...(answer.worktreeTwins ?? [])];
  if (others.length === 0) return null;
  // names come from folders the other agents control: flatten and cap before they reach this agent's context
  const clean = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").slice(0, 40);
  const who = others.map((t) => `${clean(t.name)} (${clean(t.harness ?? "agent")})`).join(", ");
  const twin = (answer.worktreeTwins ?? []).length > 0 ? " Some of them work in another worktree: expect a merge conflict." : "";
  const message = `Agent Office: ${who} recently wrote ${answer.path}.${twin} Consider coordinating before you edit it.`;
  return { systemMessage: message, hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: message } };
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  let raw = "";
  process.stdin.on("data", (c) => (raw += c));
  process.stdin.on("end", async () => {
    let input = null;
    try {
      input = JSON.parse(raw);
    } catch {
      // not JSON: nothing to check
    }
    const out = input ? await buildWarning(input) : null;
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(0);
  });
}
