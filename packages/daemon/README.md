# @agent-office/daemon

Proof-of-concept data pipeline: tails real Claude Code session transcripts under
`~/.claude/projects/**/*.jsonl`, normalizes each new line into a small versioned
event schema, and broadcasts those events over a local WebSocket server so a
future renderer (e.g. `packages/web`) can animate agent activity in real time.

No mock data — this reads whatever transcript files already exist on your
machine and picks up new lines as Claude Code writes them.

## Run it

```bash
cd packages/daemon
npm install
npm start
```

You should see:

```
[daemon] WebSocket server listening on ws://127.0.0.1:8787
[daemon] tailing transcripts under /Users/you/.claude/projects
[event] session_start start (some-project) session started
[event] tool_call:Bash start (some-project) Bash: ls -la
...
```

On boot it reads every existing `.jsonl` file from byte 0, so you'll
immediately see a burst of historical events, then it settles into
near-real-time as files grow (poll interval: 1s).

### Try the test client

With the daemon running in one terminal:

```bash
node scripts/test-client.mjs            # connects to ws://127.0.0.1:8787, prints for 5s
node scripts/test-client.mjs ws://127.0.0.1:8787 15000   # custom url / duration
```

### Config (env vars, all optional)

| Var | Default | Purpose |
|---|---|---|
| `CLAUDE_PROJECTS_ROOT` | `~/.claude/projects` | Root dir to scan for `*.jsonl` |
| `DAEMON_WS_PORT` | `8787` | WebSocket port |
| `DAEMON_WS_HOST` | `127.0.0.1` | WebSocket bind host (localhost-only by default) |
| `SESSION_INACTIVITY_TIMEOUT_MS` | `300000` (5 min) | How long an agent can go with no new transcript line and no tool call in flight before a `session_end` event fires. See "Session end (inactivity timeout)" below. |

## How it works

```
~/.claude/projects/**/*.jsonl                (root sessions + sub-agent files)
        │  poll every 1s, read only newly-appended bytes (per-file offset)
        ▼
   TranscriptTailer  (src/tailer.js)
        │  emits {sessionId, subagent: {agentId, parentId-hint} | null, line: <parsed JSON>}
        ▼
  SessionNormalizer   (src/normalize.js)   — one instance per agentId
        │  emits zero or more NormalizedEvent (agentId/parentId resolved via AgentRegistry)
        ▼
 EventBroadcastServer (src/ws-server.js)          SessionEndMonitor (src/session-end-monitor.js)
        │  ws.send(JSON.stringify(event))          │  watches for inactivity, emits session_end
        ▼                                          ▼
   any WebSocket client on localhost      (also broadcast through the same ws-server)
```

**Why polling instead of `fs.watch`**: transcript files are appended-to
continuously by the Claude Code CLI. `fs.watch` is unreliable across
platforms for pure-append writes (no reliable change event on macOS for many
writers) and isn't recursive on Linux. A byte-offset poll is simpler,
portable, and at a 1s interval is fast enough for a character-animation use
case (nobody needs sub-100ms tool-call updates).

## Normalized event schema (v1)

Defined in `src/event-schema.js`. Designed around one question: **what does a
renderer need to animate a character?** Who's acting, what are they doing,
did it start/finish/fail, and what's a short line to put in a speech bubble.

```ts
{
  v: 1,                          // schema version
  id: string,                    // stable id, dedupable
  type: "session_start" | "session_end" | "speak" | "tool_call",
  sessionId: string,              // Claude Code session id (shared by a root agent and all its sub-agents)
  agentId: string,                // character id: sessionId for the root agent, real sub-agent id otherwise
  parentId: string | null,        // spawning agent's id; null for the root agent
  cwd: string | null,             // project dir -> which "desk"
  ts: number,                     // ms epoch
  agent: string,                  // display label, derived from cwd's basename
  tool: string | null,            // tool name, only for tool_call
  status: "start" | "ok" | "error" | null,
  detail: string,                 // <=140 char human-readable summary
  meta: object | null,            // escape hatch (e.g. toolUseId, reason)
}
```

`agentId`/`parentId` were added after the initial PoC (additive, non-breaking
per `packages/protocol/README.md`'s design principle) — see "Sub-agents
(agentId/parentId)" below for how they're derived.

Event types, mapped from raw transcript line shapes actually observed on
this machine:

- **`session_start`** — first `user`/`assistant` line seen for a session or
  sub-agent.
- **`speak`** — assistant `text` or `thinking` content blocks (character has
  something to "say"; `meta.kind` distinguishes the two).
- **`tool_call`** (`status: "start"`) — assistant `tool_use` block. Emitted
  immediately so a renderer can start a "walking to X" animation without
  waiting for the result.
- **`tool_call`** (`status: "ok" | "error"`) — the paired `tool_result` block
  (matched via `tool_use_id`), arriving on a later line. `is_error` maps to
  `"error"`.
- **`session_end`** (`status: "ok"`, `detail: "inactivity_timeout"`) — synthetic
  event from `SessionEndMonitor`, not a raw transcript line. See below.

Deliberately **not** surfaced as events: `queue-operation`, `last-prompt`,
`attachment`, `mode`, and `system` transcript lines. These are UI/hook
bookkeeping (input queue state, permission-mode changes, hook stdout), not
agent activity a viewer needs to see a character react to.

## Sub-agents (agentId/parentId)

Real transcripts on this machine contain two sub-agent file shapes, both
under `<project>/<sessionId>/subagents/` (see `docs/semantic-mapping.md`):

- `agent-<agentId>.jsonl` + sibling `agent-<agentId>.meta.json` — a direct
  sub-agent (spawned by an `Agent`-tool `tool_use` block). The meta file's
  `toolUseId` is the id of that spawning tool_use block, and `spawnDepth`
  (`1` = spawned by the root session, `2`+ = spawned by another sub-agent).
- `subagents/workflows/<runId>/agent-<agentId>.jsonl` — a workflow sub-agent
  (this user's devfleet/workflow tooling). Its meta.json has no `toolUseId`
  (workflow spawning doesn't go through a tool call at all) — its parent is
  derived structurally instead: `workflows/` is always a direct child of
  `<sessionId>/subagents/` on this machine, never nested under another
  agent's own file, so the root session is its parent.

`TranscriptTailer` (`src/tailer.js`) discovers both shapes alongside each
project's root `.jsonl` files, tagging each sub-agent line with
`{rootSessionId, agentId, toolUseId, spawnDepth}`. `AgentRegistry`
(`src/agent-registry.js`) is a shared per-root-session map of
`toolUseId -> agentId`, populated as every normalizer (root or sub-agent)
sees its own `tool_use` blocks; a sub-agent's `SessionNormalizer` resolves
its `parentId` by looking up its spawning `toolUseId` in that map (retried
lazily on each line, since a sub-agent's own transcript can start filling
before its parent's spawning line has been tailed). Root files are
processed before sub-agent files within each poll tick (and sub-agents are
processed shallowest-`spawnDepth`-first) specifically so this resolves on
the first pass rather than a later tick.

Convention (matches `packages/protocol/README.md`): root agent
`agentId === sessionId`, `parentId: null`. Sub-agent: `agentId` = the real
sub-agent id, `parentId` = the agent that spawned it (root sessionId, or
another sub-agent's `agentId` for depth-2+).

**Known gap**: if a sub-agent's spawning tool_use line genuinely hasn't been
written yet (rare — spawning always happens before the sub-agent's own
first line in practice), its earliest events may show `parentId: null`
until the parent's line is tailed on a later poll tick; this self-corrects
within one or two 1s ticks and does not affect steady-state operation.

## HTTP: GET /transcript (for Mission Control side panel)

Same host/port as the WebSocket (`EventBroadcastServer` now wraps its own
`http.Server` and passes it to `ws` via the `server` option, instead of
letting `ws` open its own). One route:

```
GET /transcript?sessionId=<id>&limit=20
-> [{ ts, role: "assistant" | "tool", text, tool? }, ...]
```

Reads from the same in-memory per-session ring buffers used for new-client
replay — no re-reading transcript files from disk. Each session gets its
own buffer (`perSessionLimit`, default 100), so a noisy session can no
longer crowd out a quiet one's history; total tracked sessions is capped
(`maxSessions`, default 50) with LRU eviction of the least-recently-updated
session. `sessionId` omitted returns the last `limit` events merged across
all sessions in `ts` order; `limit` defaults to 20.

## Session end (inactivity timeout)

Transcripts never contain an explicit "session closed" line — only a
build-side signal (process exit) would tell us that, and this PoC doesn't
hook into one. `SessionEndMonitor` (`src/session-end-monitor.js`) is a
coarse stand-in: it tracks, per
`agentId`, the timestamp of its last normalized event and emits a
`session_end` event (`detail: "inactivity_timeout"`) once **both**:

1. No new event for `SESSION_INACTIVITY_TIMEOUT_MS` (default **5 minutes**), and
2. The agent has no `tool_call` currently in flight (a `tool_call` "start"
   with no matching "ok"/"error" yet).

Condition (2) exists because measuring real tool-call durations on this
machine (~20k samples) showed 219 took over 5 minutes and 111 over 10
minutes to resolve (video renders, builds, long background commands) — a
timeout keyed only on "time since last line" would misfire mid-render.
Tracking in-flight tool calls separately means the timeout only measures
genuine idle time between turns, not "still working, just slow."

5 minutes was chosen as the default because: it's short enough that an
abandoned/finished session's character doesn't linger indefinitely, but
long enough to comfortably exceed normal "agent is thinking / user is
reading output before replying" gaps between turns (sampled gaps between
consecutive turn-producing lines were mostly well under a minute once
long-tool-call gaps are excluded by condition (2) above). Override via
`SESSION_INACTIVITY_TIMEOUT_MS` if a different tradeoff is wanted (e.g.
lower for snappier "idle" characters, higher if false despawns are
observed in practice).

## Files

- `src/event-schema.js` — the `NormalizedEvent` shape + factory.
- `src/normalize.js` — `SessionNormalizer`, raw JSONL line → events
  (one instance per `agentId`: root session or sub-agent).
- `src/tailer.js` — `TranscriptTailer`, polling file watcher with byte
  offsets; discovers root session files and both sub-agent file shapes.
- `src/agent-registry.js` — `AgentRegistry`, per-root-session
  `toolUseId -> agentId` map used to resolve sub-agent `parentId`.
- `src/session-end-monitor.js` — `SessionEndMonitor`, inactivity-timeout
  `session_end` emitter (see "Session end" above).
- `src/ws-server.js` — `EventBroadcastServer`, thin `ws` wrapper with a
  small replay buffer (last 200 events) for clients that connect mid-stream.
- `src/index.js` — wires everything together; the actual CLI entry point.
- `scripts/test-client.mjs` — manual verification client.

## Known limitations / open questions for the PM

- **`agent` label is just the cwd basename.** Good enough to distinguish
  projects, but multiple simultaneous sessions in the *same* repo (e.g. two
  worktrees) will render as the same "desk" unless the web client
  disambiguates by `sessionId`.
- **Replay buffer is in-memory, last 200 events, lost on daemon restart.**
  Fine for a PoC; not a durable event log.
- **No filtering by project** — the daemon tails every project under
  `~/.claude/projects`, including unrelated repos. Fine for personal use on
  one machine; would need a scope/allowlist for anything shared.
- **Real-time "waiting for permission" signal** — a designed-but-NOT-yet-
  registered `PreToolUse`/`PostToolUse` hook (`hooks/notify.mjs`,
  `src/hook-log-tailer.js`, `src/hook-signal-reconciler.js`) closes this gap.
  See `docs/pretooluse-hook-proposal.md` for the exact `settings.json`
  snippet, safety checklist, and test evidence — requires PM review and
  manual `settings.json` edit before it does anything.
