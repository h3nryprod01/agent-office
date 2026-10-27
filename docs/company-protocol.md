# Company Protocol v1 — the contract between coordinator, agents, and the office

The shared protocol for running "a multi-agent company serving one solo dev".
Every skill (`/company:pm`, `company:report`, `/company:board`) and the office's
own UI read and write against this contract.

The founding principle doesn't move: **real data, in real time; everything must
answer "where do I need to intervene?" faster than the terminal would.**

## 1. Work items — the source of truth

- A tracker holds task state. One piece of work handed to one agent is **one
  issue**: the title is the work, the description carries the context, the file
  areas it may touch, and what "done" means. States are
  `Backlog → In Progress → Done / Blocked`.
- **The threshold for ceremony**: work under ~30 minutes that a single session
  finishes itself gets **no issue and no ritual**. Only work handed to another
  agent, or work with several steps, earns one.
- **When the tracker is offline**, write to the registry (§2) with a null issue
  id and append a line to an outbox file — one line per unsynced tracker
  operation (create / update / comment). Whichever session next finds the
  tracker alive replays the outbox and drops the synced lines. Replay is
  idempotent by design.

## 2. The work registry — the bridge into the office

A JSON file in the project's repo. The coordinator writes it when handing work
out; the agent updates it as links appear:

```json
{
  "version": 1,
  "items": [
    {
      "id": "wi-<short, unique>",
      "title": "Build the Mission Control MVP",
      "assignee": "mission-control",
      "sessionId": "<agent session id, if known>",
      "branch": "feat/mission-control",
      "parentItemId": "wi-<the item this one came from> | null",
      "sopStep": 3,
      "issueId": "PROJ-12 | null",
      "issueUrl": "https://... | null",
      "pr": "https://github.com/... | null",
      "note": "<external note ref> | null",
      "status": "in_progress | done | blocked",
      "updatedAt": "<ISO>"
    }
  ]
}
```

`assignee` is the roster member the work was handed to; `sopStep` is the 1-based
step of that member's SOP they are on (omit it for a member without an SOP).
`parentItemId` links the item to the one it came from, up to the project goal.

The daemon serves this over `GET /work-items`, re-read per request and never
cached. The side panel renders a "Work item" section with deep links out to the
issue, the note, and the PR.

Clicking a character opens everything about the work it is doing — that is the
registry's entire purpose.

## 3. The reporting protocol

Required in the prompt of every agent that gets spawned. When an agent finishes
or gets stuck, in this order:

1. **Update the work item.** Move the issue to Done or Blocked with a comment in
   exactly five parts, each at most two lines:
   - `Did:` what you did
   - `Verified:` how you verified it — test numbers, a real run, a screenshot
   - `Links:` PR / commit / files
   - `Blockers:` what is in the way, or "none"
   - `Next:` the suggested next step, or "none"

   Tracker offline → the same comment goes to the outbox and the registry.
2. **Message the coordinator** with those same five parts, if that session is
   still alive. If it isn't, skip it: the registry and the tracker are enough,
   because the PM is stateless and will read them back.
3. **Reusable knowledge, only when there is some.** An insight that applies
   beyond this repo becomes one external note, linked from the work item. Don't
   duplicate anything the repo's own docs already say.

The coordinator **does not take the report at face value** — it checks the PR,
the commits and the tests before closing anything.

## 4. A stateless PM

There is no long-lived PM session. Any session running `/company:pm` will:

1. **Read the state**: issues (or the registry when the tracker is down), the
   work registry, the repo's active-context note, `git log` and open PRs, and
   which sessions are currently running.
2. **Reconcile**: an issue marked Done but never merged? A PR open and
   unreviewed? An agent silent for too long?
3. **Act**: review and merge, or hand out new work — create the issue, add the
   registry entry, and spawn the agent with §3 and §5 injected into its prompt —
   then update the active-context note. When the agent is a roster member, the
   prompt is the persona + SOP prompt from §6, not a hand-written one.
4. **End the turn**, or loop. Dying costs nothing, because the whole brain lives
   in the tracker, the registry and the repo's memory.

## 5. Working discipline

Each of these was learned by getting it wrong first.

- Every agent works in **its own git worktree**, never checked out in the shared
  root. Always confirm `git branch --show-current` before committing.
- The coordinator **partitions file ownership** when handing work out and writes
  it in the issue. Needing to touch something outside your area is a thing you
  raise in the PR, not something you just do.
- Merge by squash through a PR. Docs and demo changes merge last. Delete the
  branch and the worktree afterwards — the worktree must be clean and its
  session stopped.
- A new decision gets appended to the repo's decision log with its date and,
  more importantly, its reason.

## 6. Personas and SOPs

A roster member may carry a `persona` (who they are) and an `sop` (how their
position works). Format and validation: [company-templates.md](company-templates.md).

When the PM hands work to such a member:

1. Call `POST /assign {project, member, title, brief, parentItemId}` on the
   daemon. It creates the project's work item (`assignee` = member,
   `sopStep` = 1, `parentItemId`) and returns `{item, prompt, problems}`.
2. Spawn the agent with exactly that `prompt`. It already carries the persona,
   the SOP (inputs, numbered steps, definition of done, hand-over targets,
   escalation triggers), the project goals, the task and the five-part report
   contract of §3.
3. The agent says which SOP step it is on in every progress message and in its
   report; the PM records it with `POST /items/update {patch: {sopStep}}` (and in
   the registry entry of §2).
4. The agent hands over to the targets its SOP names and escalates to a human on
   the SOP's triggers. A report that skips a line of the definition of done is
   not accepted at face value (§3).

A member without a persona or SOP is spawned the old way. If a SOP file is
missing or malformed, `/assign` still returns the persona prompt and lists the
problem — assigning work is never blocked by a documentation error.
