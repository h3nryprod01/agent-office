# Hermes Adapter — Hermes Agent `state.db` → event schema v1

Hermes Agent (Nous Research) is the fifth source the daemon tails, after Claude Code, Codex, Gemini and
Claude-format worker roots. Its agents show up with `harness: "hermes"`.

_Source of truth: the structure of a real `~/.hermes` on the author's machine (table and column names, row shapes,
counts). No message content was copied anywhere; the fixtures in `packages/daemon/test/hermes-fixture.js` are
invented._

## 1. Where Hermes keeps sessions

| Store | Verdict |
|---|---|
| `~/.hermes/state.db` (SQLite, WAL mode) — tables `sessions` and `messages` | **The live store.** Every session since the current version, including the Telegram gateway ones. |
| `~/.hermes/sessions/*.jsonl` | Legacy. Three files, last written months before the db's newest session. The current version no longer writes them. |
| `~/.hermes/sessions/session_*.json`, `request_dump_*.json` | Per-session snapshots / API request dumps. Large, contain full prompts; not read. |
| `~/.hermes/logs/agent.log` | Plain log lines, no structure worth tailing. |

So Hermes **can** be tailed, but not like a transcript: the data is rows in a SQLite database, not a file that grows.

### Shape (columns the adapter uses)

- `sessions`: `id` (text, e.g. `20260101_000000_demo0001`), `source` (`cli` | `telegram` | `oneshot` ...), `model`,
  `cwd` and `git_repo_root` (often NULL for gateway sessions), `started_at` (epoch **seconds**, float),
  token counters (`input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens`),
  `estimated_cost_usd` / `actual_cost_usd` / `cost_status` (`included` for subscription-billed models).
- `messages`: `id` (autoincrement), `session_id`, `role` (`user` | `assistant` | `tool` | `session_meta`), `content`,
  `tool_calls` (JSON array, OpenAI shape `[{id, function:{name, arguments:<JSON string>}}]`), `tool_name`,
  `tool_call_id`, `timestamp` (epoch seconds, float).
- Token counters are disjoint: `cache_read_tokens` exceeds `input_tokens` in real rows, so `input` excludes the
  cached part (same convention as the Claude parser).

## 2. How the daemon reads it

`hermes-tailer.js` polls (2 s) and keeps one cursor, the highest `messages.id` already handled.

- Read-only, **one fresh connection per tick**, closed right after: a long-lived read connection would pin a WAL
  snapshot and stall Hermes' own checkpoints.
- Only the columns above are selected — never `system_prompt`, `model_config`, `origin_json`.
- First sight: remember the current max id, replay only messages from the last 5 minutes (same cutoff as the other
  tailers; `HERMES_BACKFILL_MAX_AGE_MS` overrides).
- **Needs `node:sqlite` (Node >= 22.13, where it no longer needs a flag).** On an older Node the tailer emits `unavailable` once, the daemon logs one
  line, and everything else carries on. This keeps the daemon's single dependency (`ws`).
- A missing db is not an error (Hermes not installed). A schema this code does not know reports one error, not one
  per tick.
- Location: `~/.hermes/state.db`; `HERMES_HOME` moves the directory, `HERMES_DB_PATH` names the file.

## 3. Mapping to events

| Hermes row | Event v1 | Notes |
|---|---|---|
| first row of a session | `session_start` | `agentId` = `sessionId` = Hermes session id; `ts` = `sessions.started_at`; `meta.model`, `meta.source` |
| `assistant` with text | `speak` (`meta.kind: "text"`) | one line, truncated to 140 chars |
| `assistant` with `tool_calls` | one `tool_call` `start` per call | id = `<call id>:start`; `detail` = `name: <command/path/url/query>` |
| `tool` | `tool_call` `ok` / `error` | id = `<call id>:end`; `error` when the JSON result has `success:false` or an `error` key |
| `user`, `session_meta` | nothing | the human's prompt is not character activity (same policy as the other adapters) |

- `cwd` = `sessions.cwd`, else `git_repo_root`. With neither (gateway sessions), the agent lands in its own
  **`hermes` office** (`repo: "hermes"`, label `hermes`) instead of the catch-all `other`.
- `parentId` is always `null`: `parent_session_id` exists but links compression/continuation chains, not a team tree,
  so every Hermes character is a root agent.
- No "waiting for approval" signal exists in the db, so Hermes agents never show the approval state.

## 4. Spend

`parseHermesDb` (usage-parsers.js) reads one bucket per session from the `sessions` row, located at the session's
last activity hour (`last_activity_at`, else `ended_at`, else the session's newest message). Cost is what Hermes recorded (`actual_cost_usd`, else `estimated_cost_usd`; `included`
subscription sessions record 0) — it is **not** re-priced from our table. Because Hermes' live data sits in the WAL,
the db file's mtime/size does not change on writes, so the cost index re-reads it on every scan instead of trusting its
file cache (one SELECT over a few rows).

Limit: a session that spans several hours is attributed entirely to its last hour.

## 5. Not done

- Hermes' `kanban.db` / `cron/executions.db` / `worker_executions` table (delegated runs) are not read: they would
  give a real parent→child tree, but the schema is unstable across Hermes versions and nothing here needs it yet.
- No `session_end` from `sessions.ended_at`: the daemon's inactivity timeout covers it like for every other harness.
