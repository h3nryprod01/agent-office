#!/usr/bin/env node
// Agent Office — PermissionRequest gateway (spike R5②, wi-approve-spike).
//
// Registered as a PermissionRequest hook (matcher Bash|Edit|Write, timeout 120,
// project-local pilot in .claude/settings.local.json). Fires ONLY when Claude
// Code is about to show a permission dialog — auto-allowed tool calls never
// invoke it, so normal tool traffic pays zero overhead by construction.
// (Verified live on v2.1.202, 2026-07-07: payload fields, allow/deny control,
// and timeout→dialog fail-open — see docs/approve-spike-status.md.)
//
// Flow:  stdin PermissionRequest payload
//        → POST http://127.0.0.1:8787/approval-request  (long-poll ≤27s;
//          daemon answers immediately with "none" when no office is open,
//          otherwise when the user clicks ✓/✗ or its own 25s TTL fires)
//        → decision "allow"/"deny": print the PermissionRequest decision JSON
//        → ANY other outcome (none/timeout/daemon down/garbage): print
//          NOTHING and exit 0 → Claude Code shows its normal dialog.
//
// Safety invariants (per task spec, non-negotiable):
//   - never prints "allow" unless the daemon explicitly returned "allow" — a human
//     click in the office, OR (lane L2) the project's own `auto`/`read-only` policy,
//     which the daemon applies only after its danger list found nothing to ask about;
//   - every error path is silence + exit 0 = the user's normal prompt;
//   - timeout layering: daemon TTL 115s < fetch abort 118s < hook timeout 120s,
//     so the terminal dialog is delayed at most ~27s when an office is open
//     but unattended, and ~50ms when no office is connected.

import { readFileSync } from "node:fs";

const PORT = process.env.AGENT_OFFICE_PORT ?? process.env.DAEMON_WS_PORT ?? "8787";
const FETCH_TIMEOUT_MS = Number(process.env.APPROVE_GATEWAY_TIMEOUT_MS ?? 118_000);
const URL_BASE = `http://127.0.0.1:${PORT}`;

// lane L2: the daemon's policy engine classifies the command and the path, so
// those keys travel in full (up to INSPECT_MAX); bulky bodies (Write content,
// Edit old/new strings) stay at the 500-char preview size.
const INSPECT_KEYS = new Set(["command", "file_path", "notebook_path", "path", "pattern"]);
const INSPECT_MAX = 8000;
const PREVIEW_MAX = 500;

/** Truncate long strings so the wire payload stays small. A string that did not
 * fit in INSPECT_MAX sets `_truncated`: the daemon cannot judge what it cannot
 * see, so it treats such a call as dangerous instead of waving it through. */
function truncatedInput(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(toolInput)) {
    const max = INSPECT_KEYS.has(key) ? INSPECT_MAX : PREVIEW_MAX;
    if (typeof value === "string") {
      out[key] = value.slice(0, max);
      if (INSPECT_KEYS.has(key) && value.length > max) out._truncated = true;
    } else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
    // nested objects/arrays dropped: preview only needs the primitives
  }
  return out;
}

async function main() {
  let payload = {};
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return; // no parseable input → nothing to gate → normal dialog
  }
  if (!payload || typeof payload.tool_name !== "string") return;

  const response = await fetch(`${URL_BASE}/approval-request`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: payload.session_id ?? null,
      tool: payload.tool_name,
      toolInput: truncatedInput(payload.tool_input),
      cwd: payload.cwd ?? null,
      permissionMode: payload.permission_mode ?? null,
      // lane L2: who is asking. The launcher of a non-default harness/lane (worker wrapper) sets these;
      // an ordinary Claude Code session sends none and counts as harness "claude".
      harness: process.env.AGENT_OFFICE_HARNESS ?? "claude",
      lane: process.env.AGENT_OFFICE_LANE ?? undefined,
      role: process.env.AGENT_OFFICE_ROLE ?? undefined,
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return;

  const result = await response.json();
  const decision = result?.decision;
  if (decision !== "allow" && decision !== "deny") return;

  // `message` (deny only, policy-made): the model sees it as the reason the call was refused —
  // verified with a real `claude -p` run, see test/fixtures/permission-request-decisions.json.
  const message = decision === "deny" && typeof result.message === "string" ? result.message.slice(0, 500) : undefined;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: decision, ...(message ? { message } : {}) },
      },
    })
  );
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
