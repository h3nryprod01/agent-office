#!/usr/bin/env node
// Agent Office — PermissionRequest gateway (spike R5②, wi-approve-spike).
//
// Registered as a PermissionRequest hook (matcher Bash|Edit|Write, timeout 30,
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
//   - never prints "allow" unless the daemon explicitly returned "allow"
//     (which requires a human click in the office);
//   - every error path is silence + exit 0 = the user's normal prompt;
//   - timeout layering: daemon TTL 25s < fetch abort 27s < hook timeout 30s,
//     so the terminal dialog is delayed at most ~27s when an office is open
//     but unattended, and ~50ms when no office is connected.

import { readFileSync } from "node:fs";

const PORT = process.env.AGENT_OFFICE_PORT ?? "8787";
const FETCH_TIMEOUT_MS = Number(process.env.APPROVE_GATEWAY_TIMEOUT_MS ?? 27_000);
const URL_BASE = `http://127.0.0.1:${PORT}`;

/** Truncate any long strings inside tool_input so the wire payload stays
 * small (Write content can be hundreds of KB — the office only needs a
 * preview, and the daemon truncates again on its side). */
function truncatedInput(toolInput) {
  if (!toolInput || typeof toolInput !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(toolInput)) {
    if (typeof value === "string") out[key] = value.slice(0, 500);
    else if (typeof value === "number" || typeof value === "boolean") out[key] = value;
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
    }),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) return;

  const result = await response.json();
  const decision = result?.decision;
  if (decision !== "allow" && decision !== "deny") return;

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: decision },
      },
    })
  );
}

main()
  .catch(() => {})
  .finally(() => process.exit(0));
