# Agent Office

[![CI](https://github.com/h3nryprod01/agent-office/actions/workflows/ci.yml/badge.svg)](https://github.com/h3nryprod01/agent-office/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-20%20%7C%2022-brightgreen.svg)](https://nodejs.org)

Your coding-agent sessions, rendered as a live isometric office.

Every character below is a **real agent session** running on this machine — walking to the bookshelf to read files, hammering the arcade machine to run commands, and raising a red ❗ when it needs you.

![Live demo — real Claude Code sessions as office characters](docs/media/demo.gif)

## Why

Terminal logs answer *"what happened?"*. Agent Office exists to answer a different question, **faster than the terminal**: *"where do I need to intervene?"*

Two principles drive every decision here:

- Real data + real-time is the soul of the product.
- Ugly graphics with true data **beat** pretty graphics with fake data.

## Quick start

Requires Node 20+.

```bash
git clone https://github.com/h3nryprod01/agent-office && cd agent-office
./scripts/start.sh
```

That installs dependencies, builds the renderer, installs the daemon as a login agent (it starts at login and restarts itself if it crashes), and opens **http://localhost:8787** — your currently running sessions appear as characters within seconds.

Re-run `./scripts/start.sh` whenever you like: it rebuilds and reuses the daemon that's already running. One process, one port, always the current build.

> Open it at `localhost`, not `127.0.0.1`. Browsers treat those as separate origins with separate permissions, and the microphone grant that voice input needs does not carry across.

No live sessions? Add `?mock=1` for a scripted scenario, and `?stress=30` for a perf test with 30 extra characters.

**Windows:** `powershell -ExecutionPolicy Bypass -File scripts\start.ps1` — the same thing. Parsed and dry-run clean on pwsh; the Scheduled Task and browser-open steps are Windows-only and unrun there. See [docs/install.md](docs/install.md).

**Linux:** `./scripts/install-ubuntu.sh` — systemd `--user` service, starts at boot.

**Prefer an icon to a terminal?** `./scripts/make-app.sh` builds a double-clickable *Agent Office.app* into `~/Applications`.

**Developing the renderer?** `npm --prefix packages/renderer run dev` serves it on **http://localhost:5199** with hot reload, talking to the same daemon.

Logs, troubleshooting, and uninstall: **[docs/install.md](docs/install.md)**.

## Architecture

```
~/.claude/projects/**/*.jsonl  ──┐
~/.codex/sessions/**           ──┤
~/.gemini/tmp/**               ──┼─►  packages/daemon (Node)
                                 │      normalizes three harnesses
Claude Code hook events ─────────┘      into one event stream
                                              │
                                              ▼
                                 WebSocket  ws://localhost:8787
                                 (+ HTTP for chat, costs, outputs, approvals)
                                              │
                                              ▼
                                 packages/renderer (three.js, isometric 3D)
```

The event protocol lives in `packages/protocol` (JSON schema). The daemon is the only writer and the renderer is a pure consumer, so a new harness is an adapter, not a rewrite.

## What works today

![Office overview — real sessions at their stations](docs/media/office-hero.png)

**Seeing what your agents are doing**

- Tails real transcripts from **Claude Code, Codex CLI, and Gemini CLI**, normalized into one event stream.
- Characters spawn per session and walk between stations — desk = editing, bookshelf = reading, arcade machine = running commands, meeting table = delegating — with live status badges and speech bubbles from the transcript.
- Sub-agents get their own characters, linked to their parent.
- Multiple repos become multiple office tabs; an org chart overlay shows who spawned whom.

**Acting on it**

- A **needs-attention queue** lists blocked, waiting, and errored agents, and pans the camera to them. OS notifications fire when one gets stuck.
- **Approve from the office**: a permission prompt raises ❗ on the character; approving in the UI unblocks the agent. Also works from Telegram.
- **Chat with a PM agent** per repo, which can delegate and answer permission prompts through the same gateway.
- **Cost dashboard** across all three harnesses, with an optional budget threshold that holds approvals rather than killing work.

**Running a set of agents as a team**

- `templates/` holds "company in a box" setups — a roster of agent roles plus goals — that you can list, inspect, apply, and save back.

## Status

A working tool, used daily by its author, still a personal project rather than a product. Known limits:

- **Localhost only, no authentication** — read [SECURITY.md](SECURITY.md) before exposing the port anywhere.
- Cost in USD is only complete for models with published pricing; others count tokens but not dollars rather than guessing.
- Animation pauses in hidden browser tabs (browsers stop `requestAnimationFrame`); state stays correct and characters catch up when the tab is visible.
- `waiting_permission` detection is instant with the optional hook pilot, and inferred from the transcript without it.
- Vietnamese TTS for PM replies needs a local `vieneu` virtualenv; without it the feature is simply off.

Test suite: 54 files, 552 tests (`npm test` in `packages/daemon`, `npx vitest run` in `packages/renderer`).

## Roadmap

1. **Aquarium** — passively visualize your own sessions. ✅
2. **Mission Control** — inspect a character, see who's blocked, jump to who needs you. ✅
3. **Open protocol** — one adapter per harness behind a shared schema. ✅ (Claude Code, Codex, Gemini)

Next: a public protocol document so third parties can add harnesses without reading the daemon's source.

## Repo structure

- `packages/daemon/` — data pipeline: transcript + hook tailers → event stream
- `packages/renderer/` — three.js isometric renderer and UI
- `packages/protocol/` — event protocol (JSON schema)
- `templates/` — "company in a box" agent rosters
- `docs/` — specs, semantic mapping, and a status note per feature recording what was built and why ([index](docs/README.md))
- `assets/` — art, with sources and licenses in [assets/CREDITS.md](assets/CREDITS.md)

## Contributing

Issues welcome, including "this didn't work on my machine". Replies are
best-effort — this is a spare-time project. Please open an issue before building
anything substantial. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE). Third-party art is CC0; see [assets/CREDITS.md](assets/CREDITS.md) for per-asset attribution.
