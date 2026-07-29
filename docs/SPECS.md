# Agent Office — system overview

The whole system in one page. Individual features have their own status note in
this directory; this is the map they hang off.

## What it is

A local web app that turns the **real coding-agent sessions running on your
machine** into characters in an isometric 3D office. Nothing here is simulated:
every character, status and movement comes from live data.

**The question it answers faster than a terminal: "where do I need to
intervene?"**

## Architecture

```
DATA SOURCES (read-only, non-invasive)
  ~/.claude/projects/**/*.jsonl             Claude Code transcripts (root + sub-agents + workflows)
  ~/.codex/sessions/**/rollout-*.jsonl      Codex CLI
  ~/.gemini/tmp/**                          Gemini CLI
  ~/.claude/agent-office-hook-events.jsonl  PreToolUse/PostToolUse hooks (optional)
        │ tail + normalize: dedupe, resolve parentId,
        │ derive the repo from cwd (worktrees resolve to their origin repo)
        ▼
DAEMON — packages/daemon (plain Node; the only dependency is `ws`)
  • a login service: launchd on macOS, systemd --user on Linux, a Scheduled Task
    on Windows. Restarts itself if it dies; 768 MB heap cap.
  • WebSocket on 127.0.0.1:8787 — event schema v1 (additive only), a ring buffer
    per session (100 events, LRU evicting past 50 sessions), session_end after
    5 minutes of inactivity.
  • HTTP on the same port: GET /transcript · /work-items · /costs · /outputs ·
    /roster · /templates · /harnesses — POST /chat · /open · /templates/apply ·
    /tts · /approval-request · /approval-response
        ▼
PROTOCOL — packages/protocol (the JSON schema both sides agree on)
        ▼
RENDERER — packages/renderer (Vite + TypeScript + three.js; DOM panels, no chart library)
  • live by default; ?mock=1 runs a scripted scenario with no daemon
  • auto-reconnect with backoff, and an explicit offline label
  • 60 fps with 30+ characters is a hard constraint (?stress=30 checks it)
```

The daemon is the only writer and the renderer is a pure consumer. Adding a
fourth harness is an adapter, not a rewrite.

## What it does

**The office** — isometric 3D. Skins vary by role and harness, so a full room
reads as varied rather than cloned. Characters walk between stations, and which
station means what is the core mapping: desk = editing, bookshelf = reading
files, arcade machine = running commands, meeting table = delegating to
sub-agents. See [semantic-mapping.md](semantic-mapping.md).

**Many repos** — one office tab per repo, derived from cwd, with worktrees
resolved back to their origin repo. Each tab carries a live count and an alert
dot, and the intervention queue reaches **across** offices: clicking an alert
switches tab and pans the camera to the character.

**Mission Control** — click a character for a side panel: status, current tool,
a timeline, the real transcript via `GET /transcript`, and the work item with
deep links out. A "needs you" queue ranks blocked, waiting and errored agents by
urgency. With the optional hooks installed, `waiting_permission` is detected in
real time (with a 2s grace window so a fast prompt doesn't flicker).

**Acting from the office**
- **Chat with a PM agent, per repo.** Each message is one real `claude -p
  --resume` turn; the PM spawns lazily in the tab's own repo and reads work
  items, git and the tracker to answer. Its character sits at the CEO desk.
- **Voice** — Web Speech into the chat box, and replies read back aloud.
- **Approve permissions from the office** — a permission-prompt gateway puts
  ✓/✗ on the queue. It fails open to "ask" and never auto-approves.
- **A CEO avatar** — you. Agents waiting on approval walk over and queue at your
  desk.
- **OS notifications** when an agent has been stuck for more than 30 seconds,
  deduplicated per stuck period, off with `AGENT_OFFICE_NOTIFY=0`.

**Watching and accounting**
- **Replay and time-lapse** — events are recorded in the browser, with a 1×–60×
  scrubber and JSON export/import.
- **Spend** — parses `message.usage` out of the transcripts across all three
  harnesses. The traps that mattered: Claude writes up to 9 copies of a
  response, so entries dedupe by `message.id`; cached reads bill at 0.1× input;
  Codex replays an identical `token_count` when only its rate limits changed, so
  events that don't advance the total are dropped. **A model with no published
  price counts tokens and reports no dollars rather than inventing a number.**
- **A wall board** showing real work-item counts and throughput.

## Running a set of agents as a team

Beyond watching one agent, the office models a small multi-agent company —
see [company-protocol.md](company-protocol.md).

- **Work items** live in a registry the office reads, with an outbox so an
  offline tracker replays idempotently later.
- **A stateless PM**: the state is in the tracker, the registry and the repo's
  own memory, so any session can act as PM.
- **A five-part report** (Did / Verified / Links / Blockers / Next) is required
  from any agent handed a work item; anything under 30 minutes skips the
  ceremony.
- **Templates** — a company in a box: a roster of roles plus goals, which you
  can list, inspect, apply and save back. See
  [company-templates.md](company-templates.md).

Working discipline that turned out to matter: a separate worktree per agent,
partitioned file ownership when work is handed out, squash-merge through a PR,
and a coordinator that verifies against reality before closing an item.

## Operating it

- The daemon runs as a login service and revives itself (verified with `kill -9`),
  and shuts down cleanly with a 2s force-exit backstop.
- Renderer development: `npm --prefix packages/renderer run dev` on port 5199.
  Don't start the daemon through npm — the service owns 8787.
- Tests on main: daemon 241, renderer 319, `tsc` clean. CI runs all of it on
  Node 20 and 22.

## Where the reasoning lives

Each feature has a `*-status.md` in this directory recording what was built,
what broke, and why the obvious approach was wrong. Those are dated notes, not
maintained documentation — see [README.md](README.md) for the index.
