# Presentation mode

A switch that makes the office safe to screen-share, record or screenshot: project names, paths, branches, agent names
and everything people typed or agents said are replaced **before any view sees them**.

## Turning it on

- The **🎭 Present** button in the controls bar (the page reloads — nothing drawn before the switch can linger), or
- `?present=1` on the URL (`?present=0` forces it off). Either way the choice is saved in `localStorage`. That storage belongs to one origin: a link opened on a *different* origin
  (the daemon's notification link defaults to `localhost:5199`, the app is served on `127.0.0.1:8787`) starts unmasked.
  Present from the origin your notifications point at, or turn notifications off (below).

While it is on, a green **PRESENTATION MODE — names are masked** badge sits top-right.

## What it does

`fetch` and `WebSocket` are wrapped at boot (`packages/renderer/src/presentation/install.ts`), so every response and every
socket frame goes through `mask()` (`mask.ts`) on the way in. No view, store or reducer knows the mode exists — a new view
that fetches from the daemon is covered without changes.

| Data | Becomes |
|---|---|
| `repo`, `project`, `slug`, repo-keyed maps (`repos: {…}`) | `project-1`, `project-2`, … (stable for the session) |
| `cwd`, `path`, `file`, … | `~/dir-1/project-2/src/file-3.ts` — home prefix dropped, common segments (`src`, `docs`, `.claude`, `README.md`…) kept, extension kept |
| `branch` | `branch-1` (`main`/`master`/`develop` kept) |
| agent / person names | `agent-1`, … |
| free text (chat, tool details, titles, errors, markdown) | each word → `▒▒▒`, same length, paths inside it aliased |
| tokens, keys, secret-shaped values | `••••` |
| ids, enums, timestamps, numbers (`status`, `tool`, `sessionId`, `ts`, …) | untouched |

The policy is **deny by default**: a string field the masker does not recognise as structural is blurred. Adding a new
structural field that must survive masking means adding its key to `SAFE_KEY` in `mask.ts`.

Requests going back to the daemon (same origin only) have aliases turned into the real values (`/items?project=project-1`, JSON bodies),
so the app keeps working. Two exceptions: `POST /open` (open a file/folder on the host) is refused, and `/tts` is **not** unmasked —
that text is spoken aloud. Responses that are not binary (JSON, ndjson, text, html, no content type) are all masked; only
audio/video/image/font/octet-stream pass through.

Replay files loaded from disk or `?replay=` are masked on the way in; the app's **export** button in this mode writes an
already-masked replay.

## What it does not do

- **It is renderer-only.** The daemon still raises its own macOS notifications with real agent/repo names and tool details
  (and sends Telegram/Zalo messages if configured). Before sharing a screen run the daemon with `AGENT_OFFICE_NOTIFY=0`
  and leave the chat notifiers unset.
- Don't *operate* the office while presenting: titles are blurred, so "assign to PM" sends the blurred title, and approval cards show a
  blurred preview (approving still approves the real call).
- A few vendor/tool words are deliberately left readable (`PUBLIC_WORDS` in `mask.ts`: Read, Bash, Claude, Codex, Hermes, DeepSeek…).
  A word that has also been seen as a project name is aliased instead (a repo called `Hermes` becomes `project-N` in chat too). `mcp__<server>__<tool>` becomes `mcp__server-1__tool-1`.
- Known gap: a single-word value under a structural key (`role`, `source`, `status`, `…Id`) is kept as is — e.g. a roster `role: "closer"`.
  Multi-word values there are blurred.
- Real names that happen to look like aliases (a repo literally called `project-1`) are treated as already masked.

- It masks data, not pixels: a screenshot of a *non*-masked page is still unmasked. Use the switch **before** opening anything.
- The "resume in Claude" command copied from the side panel contains the masked path and will not run.
- Anything you type yourself (a chat message) is shown as typed until the reply arrives.
- The browser tab title and i18n strings are static text; they carry no project data.
- It is a screen-sharing aid, not a security boundary: the real data is still sent to the browser (visible in dev tools).

## Tests

- `test/presentationMask.test.ts`, `presentationInstall.test.ts`, `presentationReplay.test.ts` — the masker, the fetch/WebSocket wrappers, replay import.
- `test/presentationSweep.test.ts` — **positive test**: boots the real `main.ts` against a fake daemon full of invented sensitive names,
  switches the mask on, clicks through every view and overlay, and fails if any of those names appears in any rendered text or
  text-bearing attribute. `presentationSweepControl.test.ts` runs the same fixture with the switch off and demands the names *are*
  visible, so the sweep cannot pass vacuously.

## Recording a timelapse (`?clean=1` and `?replay=`)

`?clean=1` hides the panels and draws a small HUD (day clock, agents, working). `?replay=<url>&speed=<N>&play=1[&from=0..1&to=0..1]`
loads a replay file and plays it. Together with `?present=1` that is how the launch timelapse is recorded: a day of transcripts is
normalised by the daemon's own tailer into a replay file, then played in a real browser and captured.
