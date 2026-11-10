# Adapters: what was actually checked

Agent Office reads each agent's own transcript files. This page says, per agent, **which version was checked, when,
and how**. A cell says "not verified" when it was not; nothing here is inferred from marketing pages or older notes.

Checked on **2026-11-10**, on one macOS machine, read-only. Re-check yours any time:

```
node scripts/ao.mjs doctor
```

`doctor` takes the newest transcript each adapter can see, runs its last ~300 lines through the real normalizer and
prints `[ok]` (events came out), `[warn]` (the file is there but yields nothing, or the tailer cannot read it) or nothing
(no transcripts for that agent on this machine). It never starts an agent CLI and writes nothing.
The version it prints is the one **recorded inside the transcript**, i.e. the version that wrote the file.

| Agent | Version checked | Status | How it was checked |
|---|---|---|---|
| Claude Code | CLI 2.1.318 installed; newest transcript written by 2.1.321 | Verified | `doctor`: the newest transcript parses into `session_start`, `tool_call` and `speak` events. Transcript line types the adapter does not use (`attachment`, `api-request`, `bridge-session`, ...) are skipped on purpose. |
| Claude Code, worker lane (a non-Anthropic model behind a separate config dir) | transcript written by 2.1.318, 4 days old | Verified | Same check on the worker root. |
| Codex CLI | CLI 0.142.5 installed | **Not verified** | No rollout on this machine was written by the CLI (see the next row), so the CLI's own format was only checked against the repo's fixture from an earlier 0.142.x. |
| Codex desktop app | transcripts from 0.130.0-alpha.5 up to 0.162.0-alpha.17.2 (newest 2026-10-26); the app itself was not found in `/Applications` or `~/Applications` on the day of the check | **Partly works** | It does write `~/.codex/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`-style records, and tool calls parse. Two gaps found: (1) the assistant's text is an `item_completed` `AgentMessage` record, not the `agent_message` the adapter expected, so characters never "spoke". Fixed in this release. (2) All 288 rollout files on this machine are `.jsonl.zst` (compressed), and the tailer only matches plain `.jsonl`. Whether the app writes plain files while a session is live and compresses them afterwards was **not** verified (no desktop session ran during the check), so sessions that exist only as `.zst` are invisible to the office. Not fixed yet. |
| Gemini CLI | 0.29.5 installed | **Not verified on a live session** | No Gemini transcripts exist on this machine (`~/.gemini/tmp` was empty), so `doctor` prints no line. The parser is tested against a session recorded with 0.29.5 (`packages/daemon/test/fixtures/gemini-session.json`). |
| Antigravity CLI (`agy`, Google's replacement for free and consumer Gemini CLI use) | not installed | **No adapter** | The repo has no adapter for it and its transcript format was not examined. |
| Hermes Agent | v0.22.5 installed | Verified | `doctor`: the last 200 rows of `~/.hermes/state.db` (opened read-only) parse into `session_start`, `speak` and `tool_call` events. The newest message was 16 days old. |

## Is Gemini CLI still supported?

Checked against Google's own pages on 2026-11-10:

- The `google-gemini/gemini-cli` README (<https://github.com/google-gemini/gemini-cli>) now says Gemini CLI is for
  organizations with Gemini Code Assist Standard / Enterprise (and Code Assist for GitHub); free individual access and
  Google AI Pro / Ultra moved to Antigravity CLI (`agy`) on June 18, 2026.
- Google's announcement (<https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/>,
  dated May 19, 2026) states the same dates, and that enterprise access via a Code Assist Standard or Enterprise licence
  "remains unchanged".

So Gemini CLI still exists and is maintained for enterprise users, but a person on a free or consumer plan can no longer
use it, and the replacement (`agy`) is not covered by Agent Office.

## What the README may say

Claude Code, and Hermes, are verified. Codex is partly working (see above). Gemini CLI is parser-tested only. `agy`
is not supported. Wording like "works across Claude Code, Codex and Gemini" is not supported by this table.
