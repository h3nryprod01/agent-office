# PreToolUse/PostToolUse hook proposal — real-time "waiting for permission" signal

**Status: PROPOSAL ONLY. Nothing in this document has been applied to any
`settings.json` (global or project). No hook has been registered. This is
for PM review before enabling.**

Answers `docs/semantic-mapping.md` open question #1: transcript JSONL only
ever gets a line written after a turn completes, so it can't show the
"agent is currently blocked waiting for tool-use approval" moment — only
the denied/approved result, after the fact. A `PreToolUse` hook is the only
Claude Code channel that observes the pending-approval instant itself.

---

## 1. What was verified, and how

Claude Code's own hook documentation was not available as a local file on
this machine. Instead, the exact schema below was corroborated from **two
independently-sourced, currently-installed, real artifacts** on this
machine (not training-data recall):

1. **`~/.claude/settings.json`** (this user's own live global config) —
   already registers real hooks today:
   ```json
   "hooks": {
     "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 ~/.claude/hooks/save_session.py" }] }],
     "SessionStart": [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 ~/.claude/hooks/session_memory.py" }] }],
     "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": "python3 ~/.claude/hooks/recall_memory.py" }] }]
   }
   ```
   This confirms the exact `hooks.<EventName>[].{matcher, hooks[].{type,command}}`
   shape used on this installation.

2. **The `hookify` plugin** (`~/.claude/plugins/marketplaces/claude-plugins-official/plugins/hookify/`),
   an official, currently-enabled plugin that ships its own
   `PreToolUse`/`PostToolUse` hook executors and a `hooks/hooks.json`
   registering them:
   ```json
   "PreToolUse": [{ "hooks": [{ "type": "command", "command": "python3 \"${CLAUDE_PLUGIN_ROOT}/hooks/pretooluse.py\"", "timeout": 10 }] }]
   ```
   confirming: the **`timeout` field is in seconds**, and matcher-less
   registrations (no `matcher` key, or `"matcher": "*"`) fire for every
   tool.

   `hooks/pretooluse.py` (verbatim, this machine) shows the exact stdin/stdout contract:
   ```python
   input_data = json.load(sys.stdin)
   tool_name = input_data.get('tool_name', '')
   ...
   print(json.dumps(result), file=sys.stdout)
   ...
   finally:
       sys.exit(0)   # ALWAYS exit 0 - never block operations due to hook errors
   ```
   `core/rule_engine.py` shows the exact **block/allow output shape**:
   ```python
   # to deny:
   {"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny"}, "systemMessage": "..."}
   # to allow silently:
   {}
   ```
   and confirms `input_data` carries `hook_event_name`, `tool_name`,
   `tool_input`, and (for other event types) `transcript_path`, `reason`,
   `user_prompt`.

3. **This repo's own already-registered `SessionStart` hook**
   (`~/.claude/hooks/session_memory.py`, referenced from the same
   `settings.json` above) additionally confirms `payload.get("cwd")` and
   `CLAUDE_PROJECT_DIR` env var are real, live fields on this exact Claude
   Code version — and is itself the reference fail-open pattern this
   proposal's `notify.mjs` copies (`try/except` around the whole body,
   unconditional `sys.exit(0)`).

**Fields treated as confirmed for `PreToolUse`/`PostToolUse` stdin JSON:**
`hook_event_name`, `tool_name`, `tool_input`, `cwd`, `session_id` (standard
across all hook events per the `hookify` and `session_memory.py` evidence;
not directly grepped in a `PreToolUse` payload sample from Anthropic docs
since none were available locally — see the explicit caveat in section 4).

**Not directly observed on this machine, carried over from the corroborating
plugin code as "very likely but not independently re-verified against a
live Anthropic doc"**: `tool_use_id` naming (the hook script defensively
also checks `toolUseId` in case of casing differences), and whether
`PreToolUse` fires strictly *before* any permission-prompt UI renders
versus concurrently with it.

## 2. The settings.json snippet that WOULD need to be added

**NOT APPLIED. For PM review only.** This would go in `~/.claude/settings.json`
under the top-level `"hooks"` key, merged alongside the existing `Stop`,
`SessionStart`, `UserPromptSubmit` entries already there:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node /Users/you/Projects/your-repo/packages/daemon/hooks/notify.mjs pre",
            "timeout": 5
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node /Users/you/Projects/your-repo/packages/daemon/hooks/notify.mjs post",
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

- **Command path**: must be the absolute path shown above (spaces in
  `Acme Web` escaped, since this repo lives under a path with a space —
  test this exact escaping on the target shell before enabling; `command`
  strings in `settings.json` are passed to a shell, not exec'd directly, so
  unescaped spaces would split into extra argv entries).
- **`matcher: "*"`**: fires for every tool, on purpose — the whole point is
  a global "any tool, any project" signal. A narrower matcher (e.g. just
  `Bash`) would silently blind Agent Office to permission waits on
  `Edit`/`Write`/MCP tools, which matters just as much for "where do I need
  to intervene".
  - **Design node not yet decided by PM**: `hookify`'s own registration
    *omits* the `matcher` key entirely rather than using `"*"` — both were
    observed as valid in real registrations on this machine
    (`session_memory.py`'s registration uses `"matcher": ""` for
    non-tool events). Confirm which form the installed Claude Code version
    actually expects for `PreToolUse`/`PostToolUse` before applying;
    `"matcher": "*"` is this proposal's best guess, cross-referenced
    against `hookify`'s own `PreToolUse` registration which omits the key,
    implying `"*"`-equivalent default-all behavior when absent.
- **`timeout: 5`** (seconds): generous relative to actual expected latency
  (see budget below) but conservative relative to `hookify`'s own `10`.
  Lower is safer here since this hook does no I/O beyond one local file
  append — if it ever takes anywhere near 5s something is badly wrong
  (e.g. filesystem stall) and Claude Code should reasonably time it out
  rather than stall the user's tool call indefinitely.

## 3. Expected latency budget

Measured directly on this machine (see section 5 for exact commands):

| Stage | Measured | Notes |
|---|---|---|
| `node notify.mjs` cold process spawn → exit | ~40-45ms average (10-run loop, wall clock via `time`) | Dominated by Node.js interpreter startup, not script logic. This is the **real cost Claude Code pays per tool call** if this hook is registered — every single tool call across every project now pays one extra Node process spawn, twice (once for Pre, once for Post). |
| In-process work (JSON parse + one `appendFileSync`) | sub-millisecond | Not separately measurable at this scale; dwarfed by process spawn. |
| Daemon detects new hook-log line → emits signal | ~50–250ms (tailer poll interval, configurable) | This is the daemon-side latency budget, independent of the hook script itself. Set to 250ms default (see `hook-log-tailer.js`), tighter than the existing transcript tailer's 1s because shaving latency is this feature's entire purpose. |
| **End-to-end: tool call starts → Agent Office shows "waiting_permission"** | **~300ms worst case, dominated by daemon poll interval, not the hook** | If this is too slow for the product goal, lower `pollIntervalMs` in `HookLogTailer`, not the hook's own work — the hook is already at its floor. |

**Real cost to flag to PM**: this adds **two Node process spawns per tool
call, on every project, forever**, at ~40-45ms each = roughly **80-90ms of
added wall-clock latency per tool call machine-wide**, whether or not
Agent Office is even running. That is the actual price of "real-time" here
and is worth weighing against the PoC's value before enabling globally —
especially on a machine that also runs demo-app and other real work.

## 4. Safety checklist

- [x] **Fail-open verified** — see section 5, three separate error-injection
  tests (read-only log file, missing parent directory, unwritable parent
  directory), all exit 0.
- [x] **No network I/O** — `notify.mjs` imports only `node:fs`, `node:os`,
  `node:path`. No `fetch`, no socket, no child process spawn. Verified by
  reading the file's import list; there is nothing else to check.
- [x] **Execution time measured** — see section 3 and section 5 timing
  output. Dominant cost is Node startup, not script logic.
- [x] **What happens if the log file's directory doesn't exist yet** —
  `mkdirSync(..., { recursive: true })` wrapped in its own try/catch;
  verified via error-injection test 2 (section 5) that it self-heals when
  possible and fails silently (still exit 0) when it can't (test 3).
  In practice `~/.claude/` is guaranteed to exist (Claude Code itself lives
  there), so this is a defensive belt-and-suspenders case, not the expected
  path.
- [x] **What happens under concurrent writes from multiple simultaneous
  sessions** — `appendFileSync` on Linux/macOS is atomic for the write
  syscall itself for writes under the platform's atomic-append size (POSIX
  `O_APPEND` guarantees no interleaving *within* a single `write()` call);
  each hook invocation writes exactly one JSON line in one `appendFileSync`
  call, so concurrent sessions writing simultaneously will interleave
  whole lines, never partial/corrupt lines. The daemon-side tailer
  (`hook-log-tailer.js`) additionally wraps its `JSON.parse` per line in a
  try/catch that skips (not crashes on) any line that somehow still comes
  out malformed. **Not separately stress-tested with real concurrent
  processes** — see explicit gap below.
- [x] **Concurrent-write stress test — verified, not just reasoned about.**
  Ran 20 truly-parallel `node notify.mjs pre` processes (`for i in 1..20; do
  (echo '...' | node notify.mjs pre &); done; wait`) against a fresh log
  file. Result: exactly 20 lines, all 20 valid JSON, 0 malformed/interleaved
  lines. Confirms the POSIX `O_APPEND` atomicity reasoning above holds in
  practice on this machine's filesystem, not just in theory.
- [ ] **NOT verified**: real Claude Code `PreToolUse` stdin payload capture.
  Everything in section 1 is corroborated from a same-machine, currently-
  installed plugin's hook scripts and this repo's own already-registered
  hooks — not from directly observing a live `PreToolUse` invocation's
  stdin on this machine (that would require registering the hook first,
  which this task was told explicitly not to do). **Recommend**: after PM
  review, register only the `PreToolUse` hook in a **project-local**
  `.claude/settings.local.json` first (not global), trigger one real
  permission-gated tool call, inspect `~/.claude/agent-office-hook-events.jsonl`
  for the actual field names Claude Code sent, and diff against what
  `notify.mjs` expects — before promoting to the global config.

## 5. Test evidence

Ran directly (transcript quoted from this session, not paraphrased):

```
$ echo '{"session_id":"11111111-...","hook_event_name":"PreToolUse","tool_name":"Bash",
  "tool_input":{"command":"rm -rf /some/path","description":"test"},
  "cwd":"/Users/you/Projects/example-app",
  "transcript_path":"/Users/you/.claude/projects/fake/session.jsonl",
  "tool_use_id":"toolu_abc123"}' | node packages/daemon/hooks/notify.mjs pre
exit code: 0
$ tail -1 ~/.claude/agent-office-hook-events.jsonl
{"v":1,"hook":"PreToolUse","ts":1783134116776,"sessionId":"11111111-...",
 "cwd":"/Users/you/Projects/example-app","toolName":"Bash","toolUseId":"toolu_abc123"}
```

Timing (10-run loop, wall clock, includes Node cold start each time):
```
0.31s user 0.10s system 93% cpu 0.446 total   # ~44.6ms/run average
```

Edge cases, all exit 0:
- PostToolUse mode (`notify.mjs post`)
- malformed JSON on stdin (`not valid json {{{`)
- empty stdin
- missing CLI arg (defaults to `pre`)

Error-injection (fail-open), all exit 0:
1. Log file `chmod 444` (append denied) → exit 0, no line written, no crash.
2. Log directory doesn't exist at all → exit 0, self-heals (creates dir + would write, verified the created directory tree).
3. Parent directory `chmod 555` (mkdir itself denied) → exit 0, silently no-ops, no crash.

Concurrency (fail-open + integrity):
4. 20 truly-parallel `node notify.mjs pre` invocations against one fresh
   log file → exactly 20 lines written, all 20 valid JSON, 0 malformed or
   interleaved lines.

Reconciler unit tests (`hook-signal-reconciler.js`), 4/4 passed:
1. PreToolUse → PostToolUse: emits `waiting_permission` then `working`, in order.
2. PreToolUse → matching transcript `tool_call` event: silently clears pending state (no duplicate signal).
3. Duplicate PreToolUse for same session+tool without resolution: pending map does not leak (stays at size 1, not 2).
4. PostToolUse with no matching pending PreToolUse: emits nothing (no phantom signal).

End-to-end integration test (`HookLogTailer` + `HookSignalReconciler` wired
together, real file on disk, real poll loop): a simulated PreToolUse write
followed 200ms later by a simulated PostToolUse write produced exactly the
two expected signals in the expected order, picked up automatically by the
50ms-interval poller with no manual trigger.

All test scripts and their temp log files were deleted after the run; no
test artifacts remain in the repo or in `~/.claude/`.

## 6. What is intentionally NOT part of this proposal

- No change to any `settings.json`, anywhere.
- No change to `packages/renderer` (out of scope per task).
- No new npm dependency (uses only Node built-ins).
- No decision about whether `waiting_permission` should visually supersede
  the existing `tool_call:start` "Focusing" status in the renderer — that's
  a renderer-side design question for whoever picks up "wire this into
  `AgentSprite.ts`", not a daemon/hook concern.
