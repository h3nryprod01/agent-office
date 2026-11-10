# Privacy

This document says what Agent Office reads, writes and sends, checked against the source code of this repository (not against older documentation). It describes the software as shipped here; a fork or a different version may behave differently. It is not legal advice, and it does not describe what the services you connect to (Anthropic, OpenAI, Google, Telegram, Zalo) do with data once they receive it.

## In short

- Agent Office has no telemetry, no analytics, no crash reporting and no account.
- The daemon's own code calls out to exactly two hosts, `api.telegram.org` (changeable with `TELEGRAM_API_BASE`) and `openapi.zalo.me`, and only after you configure the matching bot or Official Account token.
- The web app loads no remote script, font, image or stylesheet.
- Everything else stays on your machine, unless you turn on LAN mode, in which case other devices you authorise can read it.
- If you turn on Telegram or Zalo, text that was written on your machine (command lines, file paths, agent output, the PM's answers) is sent to those services. Section 4 lists exactly what.

## 1. What it reads from your disk

- It tails the transcripts that Claude Code writes under `~/.claude/projects`, and, if present, `~/.claude-worker/projects` and any folder named in `AGENT_OFFICE_CLAUDE_ROOTS`.
- It tails Codex CLI sessions under `~/.codex/sessions`, Gemini CLI data under `~/.gemini/tmp`, and Hermes' SQLite store `~/.hermes/state.db`, which it opens read-only.
- It tails the hook log `~/.claude/agent-office-hook-events.jsonl`, which only exists if you installed the Agent Office hooks.
- From those transcripts it builds events (agent, repo, tool name, and the text of assistant messages, thinking blocks, tool calls and tool results, each cut to 2000 characters) and keeps the newest 500 events of each of up to 50 sessions in memory, to show in the office and to replay to a newly opened window.
- It re-reads the same transcript folders to total tokens and cost for the spend page.
- It reads `~/.claude/exec-usage.jsonl` and `~/.claude/exec-scorecard.jsonl` for the worker scorecard, if those files exist.
- It reads the team roster `~/.claude/company/roster.yaml` and the template folder `~/.claude/company`.
- It reads the work registry `.claude/memory/work-items.json` of the checkout it runs from.
- The documents page and the outputs page read files inside project folders you registered (and a short whitelist of media folders), and only serve them to the office UI.
- The tailers are read-only: they never modify the transcripts or the other agents' files.

## 2. What it writes

- Its data folder is `~/.agent-office`, or the folder in `AGENT_OFFICE_HOME`.
- `access.json` holds LAN mode state and access tokens as SHA-256 hashes, with file mode 600.
- `projects/<slug>/project.json` holds a project's name, template, folder, policy, chat bindings and members (display name, role, Telegram/Zalo user id).
- `projects/<slug>/items.json` holds the project's work items.
- `projects/<slug>/policy-audit.jsonl` logs each automatic approval decision with the tool name and a 200-character preview of the command in which common credential patterns are replaced by `***`.
- `projects/<slug>/docs-meta.json` and its version snapshots hold document status, comments and review history.
- `projects/<slug>/pm-session.json` holds the project PM's Claude session id, folder and time.
- `metrics/intervention/<day>.jsonl` holds one row per time an agent waited for a person: agent id, session id, kind, repo, project, harness and timestamps, but no message text.
- `telegram-offset.json` holds one number, the position in Telegram's update queue.
- `channels-state.json` holds which project each chat last chose with `/use`, and on which days the daily digest was sent.
- The default PM's session map is `.claude/memory/pm-session.json` inside the Agent Office checkout, not in the data folder.
- The Agent Office hook script (`notify.mjs`) appends one line per tool call to `~/.claude/agent-office-hook-events.jsonl`: session id, folder, tool name and tool-use id, and deliberately not the tool's input.
- `ao backup` writes a `.tar.gz` of the whole data folder to `~/agent-office-backups`.
- When you save a document or upload a file in the documents page, or create a project, it writes into that project folder.
- These files are plain JSON and are not encrypted by Agent Office; rely on your operating system's disk encryption and permissions.
- Pairing codes, pending approvals and rate-limit counters live in memory only and vanish when the daemon stops.
- The web app keeps interface preferences in the browser's `localStorage`: language, sound, presentation mode, collapsed chat dock, dismissed alert ids, the active documents project and the voice switch. In LAN mode, opening an access link sets an `HttpOnly` session cookie (`ao_session`, 30 days) that carries the access token; on a loopback-only setup it sets none.

## 3. What leaves your machine by default

- With no Telegram or Zalo token configured, the daemon makes no outbound network call of its own.
- The `claude` CLI that the daemon starts for the project PM talks to Anthropic with your own login. What you type to the PM, and the files the PM reads, go to Anthropic under your agreement with Anthropic.
- Pressing a probe button on the settings page runs the CLI's own status command (`claude auth status`, `codex login status`; what those contact is up to the CLI), or, for Gemini, sends a one-word prompt through your Gemini CLI.
- `ao update` and the installers run `git pull` and `npm ci`, which contact GitHub and the npm registry, only when you run them.
- Voice answers are produced by a local model through `POST /tts`; the repository code makes no network call for it, and the voice package you install may download model files, which this repository does not control.
- Voice input uses the browser's own speech recognition, whose handling of audio is decided by your browser vendor.
- In LAN mode the event stream, including those transcript excerpts, goes to every connected device that holds a token, a viewer token included.

## 4. If you turn on Telegram or Zalo

The Telegram channel starts when `TELEGRAM_BOT_TOKEN` is set. The one-way alert to your own chat needs `TELEGRAM_CHAT_ID` as well. The Zalo channel starts only when `ZALO_OA_TOKEN`, `ZALO_APP_ID` and `ZALO_OA_SECRET` are all set. These messages are sent unredacted: the credential masking in section 2 applies only to the audit file, not to what is sent to chat.

### Sent out

- Approval request: the project name, the tool name, and the first 300 characters of the command, file path or tool input that is waiting for a yes or no, plus the short id and two buttons.
- Approval requests go to the project's bound chat, or else to the DMs of its owners and managers, or else to your operator chat.
- Stuck-agent alert (Telegram only, to `TELEGRAM_CHAT_ID`): the agent name, the repo, "Waiting for approval" or "Error" or "Blocked", up to 2000 characters of the agent's last detail text, and a link to your office.
- The PM's answer, in full, to whoever asked, split into messages of at most 4096 characters.
- Command replies: `/status` (project name, template, item counts, and in a private chat the last 200 characters of the PM's reply), `/items` (open item titles), `/pending` (the first 120 characters of each approval), `/projects`, `/whoami`.
- The end-of-day digest at 18:00 local time by default to a project's bound room: project name, titles of up to 5 items finished today, counts, and a time-to-intervene line. `AO_DIGEST_TIME` changes the hour and `AO_DIGEST=0` switches it off.

### Received

- Each incoming message gives the daemon the text, the chat id, the sender's id and first name or username.
- A message from someone who is neither a member of the project nor your operator chat is dropped with no reply and nothing stored.
- A member's text is passed to that project's PM: it becomes a `claude -p` turn run in the project's folder, prefixed with the speaker's name, role and channel.
- The PM's tool use goes through the same approval gate as any other agent.
- Bot and Official Account tokens are removed from the environment of the PM process.
- Pairing stores the member's chat user id and display name in `project.json`.
- Zalo events must carry a valid `X-ZEvent-Signature` and be at most 5 minutes old; anything else is dropped.

For a bot you run for other people, publish a privacy policy: see [docs/telegram-bot-privacy-template.md](docs/telegram-bot-privacy-template.md).

## 5. Deleting your data

- Stop the daemon, then delete `~/.agent-office` (or your `AGENT_OFFICE_HOME`), `~/agent-office-backups`, and `~/.claude/agent-office-hook-events.jsonl`.
- Messages already sent to Telegram or Zalo stay with those services; delete them there.

## 6. Not verified

- Telegram and Zalo integrations have not been run against a live bot or Official Account in this repository; the lists above come from reading the code.
- This file reflects the code at the commit it was written against; check `git log PRIVACY.md` against later changes to `channel-router.js`, `notifier.js`, `telegram*.js` and `zalo*.js`.
