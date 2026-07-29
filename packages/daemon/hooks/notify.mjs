#!/usr/bin/env node
// Agent Office — PreToolUse / PostToolUse notify hook (PROPOSAL, not yet registered).
//
// Purpose: give the Agent Office daemon a real-time "waiting for permission"
// signal that transcript-tailing cannot provide (transcript JSONL only ever
// records a line AFTER a turn completes — the "pending approval" moment is
// invisible to a tailer). This script is invoked directly by Claude Code's
// hook runner (not by this repo's code) once registered in settings.json.
//
// Contract with Claude Code (verified against the hookify plugin's own
// PreToolUse/PostToolUse hook scripts, which are live-registered on this
// machine in ~/.claude/settings.json and ~/.claude/hooks/hooks.json — see
// docs/pretooluse-hook-proposal.md for the exact citations):
//   - stdin: one JSON object, no trailing input after that.
//     Confirmed-present fields (observed in installed hookify hook + this
//     repo's own session_memory.py SessionStart hook): hook_event_name,
//     tool_name, tool_input, session_id, cwd, transcript_path.
//   - stdout: hook runner reads JSON from stdout for optional structured
//     control (e.g. {"hookSpecificOutput": {"permissionDecision": "deny"}}).
//     This hook NEVER wants to influence the decision, so on the happy path
//     it prints nothing (silence == allow, confirmed by hookify's own hooks
//     returning "{}" for the no-op case).
//   - exit code: hook runner treats non-zero exit / thrown error as hook
//     failure. Empirically every reference hook (hookify's own, and this
//     user's session_memory.py) wraps its body in try/catch and always
//     exits 0 regardless of internal error — "fail open" is the estabilshed
//     convention on this machine, not just this proposal's invention.
//
// Non-negotiable properties for THIS script (per task spec):
//   1. Extremely fast: one synchronous-ish JSON.stringify + one appendFile.
//      No network calls, no spawning processes, no reading other files.
//   2. Fail-open: any thrown error anywhere is swallowed; the script always
//      exits 0. A broken/misconfigured hook must never block or slow down
//      the user's real tool calls across ALL their projects.
//   3. Side-effect-free otherwise: the ONLY effect is one appended line to
//      a fixed local log file. No stdout output on the happy path (keeps
//      Claude Code's hook-output parsing path untouched / a no-op).
//
// Usage (as registered in settings.json — see docs/pretooluse-hook-proposal.md):
//   node /abs/path/to/notify.mjs pre   <- PreToolUse
//   node /abs/path/to/notify.mjs post  <- PostToolUse
//
// The mode is a CLI arg (not re-derived from hook_event_name) so the two
// registrations in settings.json are unambiguous even if Claude Code ever
// omits hook_event_name from stdin.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Fixed, project-agnostic log path. Deliberately NOT under this repo (the
// hook fires from any project on the machine, including unrelated ones like
// demo-app) and NOT under a path that could plausibly not exist on a given
// machine setup other than ~/.claude itself, which Claude Code guarantees.
const LOG_PATH = path.join(os.homedir(), ".claude", "agent-office-hook-events.jsonl");

function main() {
  const mode = process.argv[2] === "post" ? "post" : "pre"; // default pre, never throws on bad arg

  try {
    let raw = "";
    try {
      raw = readStdinSync();
    } catch {
      raw = "";
    }

    let payload = {};
    try {
      payload = raw ? JSON.parse(raw) : {};
    } catch {
      payload = {}; // malformed stdin must not crash the hook
    }

    const line = {
      v: 1,
      hook: mode === "pre" ? "PreToolUse" : "PostToolUse",
      ts: Date.now(),
      sessionId: payload.session_id ?? null,
      cwd: payload.cwd ?? null,
      toolName: payload.tool_name ?? null,
      // Keep tool_input out entirely: it can contain arbitrarily large or
      // sensitive content (file contents, command strings with secrets).
      // The daemon/renderer only needs "who is waiting on what tool", not
      // the tool's full argument payload.
      toolUseId: payload.tool_use_id ?? payload.toolUseId ?? null,
    };

    try {
      mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    } catch {
      // Directory creation failing (permissions, disk full, race) must not
      // block the tool call — swallow and fall through to the append
      // attempt, which will also fail safely below.
    }

    try {
      appendFileSync(LOG_PATH, JSON.stringify(line) + "\n");
    } catch {
      // Fail open: logging failure (disk full, permission denied, path
      // gone) is never a reason to block or slow the user's actual tool
      // call.
    }
  } catch {
    // Absolute last-resort catch-all. No matter what goes wrong above,
    // fall through to the guaranteed exit(0) below.
  }

  process.exit(0);
}

// Minimal synchronous stdin reader. Avoids pulling in any async plumbing —
// Claude Code hook stdin for a single tool call is always small (a few KB
// at most: tool name + tool input JSON), so a blocking read is fine and
// keeps this script dependency-free and trivially fast.
function readStdinSync() {
  try {
    // fd 0 == stdin. Works for a pipe (how Claude Code invokes hooks) since
    // the hook process's stdin is not a TTY in that context.
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

main();
