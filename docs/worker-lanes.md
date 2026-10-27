# Worker lanes — seeing the whole multi-vendor team

A *worker lane* is Claude Code driven by another vendor's model (DeepSeek, MiMo, GLM, Kimi...) through an isolated
config directory (for example `~/.claude-worker`). Its transcripts have the Claude Code format, but live in a
different root, so the daemon has to be told to look there.

## Roots

| Source | Root | `harness` |
|---|---|---|
| main Claude Code | `CLAUDE_PROJECTS_ROOT` or `~/.claude/projects` | `claude-code` |
| worker config dir | `<EXEC_CONFIG_DIR or ~/.claude-worker>/projects`, tailed automatically when it exists | `claude-worker` |
| anything else | `AGENT_OFFICE_CLAUDE_ROOTS` (`:`-separated, `;` on Windows). Entries are worker roots; write `claude=<path>` for a plain Claude root | `claude-worker` / `claude-code` |

Roots are de-duplicated. The daemon logs which ones it tails at start-up.

## Lane

`lane` is the vendor, derived from the model id in the transcript (`deepseek-*` → `deepseek`, `mimo-*` → `mimo`,
`glm-*` → `glm`, `k3[1m]` / `kimi-*` → `kimi`, `qwen-*` → `qwen`; any other id such as `openai/gpt-oss-20b` becomes a
readable slug, `gpt-oss`). It is known only after the first assistant reply, so the opening `session_start` carries
`lane: null` and every later event carries the lane; the renderer fills it in from the first event that has one.
Claude models keep `lane: null`. A known non-Anthropic model (e.g. MiMo) run from the *main* Claude config dir also gets its lane — the harness stays `claude-code` — so it shows in the lane table and badge; unknown ids get a slug lane only in a worker root. A worker root that appears after the daemon started is picked up on restart.

Events gain two additive fields, nothing is removed: `harness` (`claude-worker`, `hermes` are new values) and `lane`.
In the renderer `AgentModel.lane` exists next to `AgentModel.harness`; `ui/vendor.ts` turns the pair into a label and
colour (`vendorOf`) — the office drawing can reuse it.

## Prices

Spend prices come from `usage-pricing.js`; the worker rows were copied from the owner's own price table
(`exec_prices.py`, read 2026-10-19), not guessed:

| Model | cache-miss in | cache-hit in | out (USD / M tokens) |
|---|---|---|---|
| DeepSeek flash — peak | 0.30 | 0.006 | 1.20 |
| DeepSeek flash — off-peak | 0.15 | 0.003 | 0.60 |
| DeepSeek pro — peak / off-peak | 1.32 / 0.66 | 0.044 / 0.022 | 3.96 / 1.98 |
| MiMo pro | 0.435 | 0.0036 | 0.87 |
| MiMo flash | 0.14 | 0.0028 | 0.28 |

- DeepSeek peak = Mon–Fri 01–04 and 06–10 UTC. Chinese public holidays are not modelled, so a holiday weekday is
  priced as peak (an upper bound); so is a call with no timestamp.
- Cache writes are billed as fresh input (no 1.25× surcharge as on Anthropic).
- **Kimi is a flat-fee plan: no per-token price, tokens only.** Unknown vendors likewise (their model is listed
  under "no price" in `/costs`).
- Cross-check on the author's real data (30 days): the transcript estimate for DeepSeek was about 2% above the exact
  cost the worker runs logged; MiMo's was about 14% below (the transcripts cover more or fewer runs than the log, so
  treat "Transcript $" as an estimate and "Logged $" as the exact figure for headless runs).

## Scorecard

`GET /scorecard?days=N` (default 30, 0 = all time) reads two append-only logs from `AGENT_OFFICE_EXEC_DIR`
(default `~/.claude`):

- `exec-usage.jsonl` — one row per headless worker run (`lane`, `turns`, `seconds`, `miss`/`hit`/`out` tokens,
  `cost_usd` exact, `is_error`, `timeout`);
- `exec-scorecard.jsonl` — one row per independent review of a worker's output (`executor`, `critical`, `high`,
  `rework`).

Per lane it returns jobs, errors, timeouts, exact logged cost, review count, **passed review** (no critical, no
high, no rework) and pass rate (`null` — shown as "—" — when there is no review, never 0%). It returns aggregates only:
repo names, task text and findings never leave the module. Reviews whose executor is not a worker lane (for example
`main`) are counted as `unattributedReviews`.

The Spend page joins this with `/costs` → `byLane` (tokens and estimated cost from transcripts) in a "Worker lanes"
table.
