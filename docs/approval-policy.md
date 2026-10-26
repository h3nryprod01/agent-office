# Approval modes and data rules (lane L2)

Per project, stored in `~/.agent-office/projects/<slug>/project.json` under `policy`.
A project without `policy` behaves exactly as before: every permission request waits for a person.

```json
"policy": {
  "approval": {
    "mode": "ask",
    "roles": { "pm": "auto" },
    "tools": { "WebFetch": "deny" }
  },
  "allowedHarnesses": ["claude"],
  "allowedLanes": ["glm"]
}
```

## Modes

| mode | what happens to a permission request |
|---|---|
| `ask` (default) | waits for a person in the office (or the terminal dialog if no office is open) |
| `auto` | allowed automatically, **except** the danger list below, which still asks |
| `read-only` | `Read`/`Glob`/`Grep`/`LS`/`NotebookRead` allowed; everything that writes or runs (Bash, Write, Edit, MCP tools, unknown tools) is refused with a message the agent sees |
| `deny` | everything is refused |

Precedence: `tools[<tool>]` > `roles[<role>]` > `mode`. A per-tool `auto` is still subject to the danger list.
Over budget (`overBudget`), `auto` falls back to `ask`; `read-only`/`deny` stay as they are.

The role of a request is whatever the launcher puts in `AGENT_OFFICE_ROLE` (hook) — the PM chat's MCP permission tool always sends `pm`.
The hook also forwards `AGENT_OFFICE_HARNESS` (default `claude`) and `AGENT_OFFICE_LANE`.

### Always-ask list in `auto` (`policy-danger.js`)

`recursive-delete` (`rm -r`, `find -delete`, `git clean -f`), `force-push` (`--force`, `-f`, `+ref`, `--mirror`, `--delete`),
`destructive-git` (`reset --hard`, `branch -D`, `filter-branch`), `secret-read` (`.env*`, keys, `~/.ssh`, `~/.aws`, keychain, `printenv`),
`download-exec` (`curl | sh`, `sh <(curl …)`, fetch-then-run), `outside-cwd-write` (any write/redirect/Write/Edit target outside the project directory, symlinks resolved),
`sensitive-config-write` (`.git/`, `.claude/settings*`, `.claude/hooks`, shell rc files, LaunchAgents), `privileged` (`sudo`, `chmod -R`),
`destructive-infra` (`DROP TABLE`, `terraform destroy`, `kubectl delete`, `docker prune`, …), `publish` (`npm publish`, `gh release create`, …),
`self-control` (a command or WebFetch aimed at the daemon's own `/policy`, `/approval*`, `/chat`… routes),
`uninspectable` (input too long for the hook to forward, or a Bash call with no readable command).
Shells hidden behind `sh -c`, `eval`, `env`, `timeout`, `xargs` and MCP shell tools (`command`/`cmd` argument) are unwrapped and scanned too.
This is a tripwire for accidents and injected one-liners, not a sandbox. Use `read-only`/`deny` when you need a guarantee.

### Known limits (by design — a denylist is a tripwire)

- Write-then-run: an agent can `Write` a script inside the project (allowed) and run it (allowed); the script can do anything the
  danger list would have asked about. Use `read-only`/`deny` where that matters.
- Reading a path outside the project (`cp /etc/hosts .`, `tar … /usr/share/x`) is flagged like a write; `cd ..` is judged against the
  project root, not the session's own subdirectory. Both cost one click.
- The hook only sees what Claude Code would have asked about: tools already allowed in Claude Code's own settings, and tools not
  matched by the hook's `matcher` (`Bash|Edit|Write` in the pilot config), never reach the policy. `read-only`/`deny` therefore
  restrict *prompted* calls; they are not a sandbox.
- Until L1's `roleOf(req)` replaces `loopbackRole`, any local process (an agent included) counts as `owner` over loopback. The
  `self-control` rule blocks the obvious `curl localhost…/policy`, not a script that does it.

## Audit

Every automatic decision (allow/deny) and every ask that was forced back by the danger list or the budget is appended to
`projects/<slug>/policy-audit.jsonl` (trimmed at 512 KB): time, project, session, agent label, harness, lane, role, tool,
redacted preview, mode + where it came from, decision, reasons. `GET /policy/audit[?project=][&limit=]`, shown in Settings.

## Data rules

`allowedHarnesses` / `allowedLanes`: a session whose harness (or reported lane) is not listed raises one `policy_alert` event
(intervention queue) and an OS notification. Reading the transcript is never blocked. Empty/absent = no rule.

## API

`GET /policy`, `GET /policy?project=<slug>`, `POST /policy {project, policy}`, `GET /policy/audit`.
Writes need `manager` (tighten: ask/read-only/deny) or `owner` (anything that newly sets `auto`, or touches the data rules).
Until L1's `roleOf(req)` is wired in (`createPolicyHttpHandler({ roleOf })` in `index.js`), only a direct loopback connection counts as `owner`; everything else gets 403.

## The hook output format was verified with a real run

Claude Code 2.1.308, 2026-10-27, `claude -p` with a `PermissionRequest` hook (matcher `Bash|Edit|Write`):

- the hook fires in `-p` mode too (an older note here said it did not);
- hook prints `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}` → the Bash call ran;
- hook prints the same with `"behavior":"deny","message":"…"` → the call was blocked and the model quoted the message back;
- the captured stdin payloads (paths replaced) and the verified outputs are in `packages/daemon/test/fixtures/permission-request-*.json`.
