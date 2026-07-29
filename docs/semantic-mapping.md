# Semantic mapping — agent events → characters in the office

_Source data: real JSONL transcripts under `~/.claude/projects/**/*.jsonl`, read
directly on a working machine to get the field names right rather than guessing;
plus Claude Code's documented hook contract (`PreToolUse` / `PostToolUse` /
`Stop` / `SessionStart` / `Notification`) and the sub-agent definitions in
`~/.claude/agents/*.md`._

**The rule this document is written under:** every row below must point at a
field or event that actually exists. Where something is inferred rather than
observed, the row says so. Nothing is quietly invented.

---

## 1. The data shape, as confirmed

Read straight off a real transcript:

- Each line is one JSON object. `type` is one of `user`, `assistant`, `system`,
  `attachment`, `queue-operation`, `last-prompt`.
- An assistant message has `message.role = "assistant"` and `message.content` as
  an array of blocks: `{"type": "thinking"}`, `{"type": "text", "text"}`,
  `{"type": "tool_use", "id", "name", "input", "caller"}`.
- Tool names seen in real data: `Bash`, `Read`, `Write`, `Edit`, `Skill`,
  `ToolSearch`, `AskUserQuestion`, and any `mcp__<server>__<tool>`.
- Tool results arrive in the *next* `role: "user"` message as
  `{"type": "tool_result", "tool_use_id", "content", "is_error"?}`. There is also
  a parallel `toolUseResult` at the top level of the JSONL line — outside
  `message` — holding a pre-parsed version (exit code, success flag).
- **A denied permission** has a specific shape: `tool_result.is_error = true`
  with content like `Permission to use Bash with command <cmd> has been denied.`
  That is the state **after** the decision. The JSONL never records the *pending*
  moment, because a line is only written once the turn completes.

  This drives a design decision directly: **a real-time "blocked" signal — not a
  retrospective one — requires listening to the `PreToolUse` hook. Tailing the
  transcript cannot produce it.**
- Real system events observed: `type: "system"` with `subtype` in
  `turn_duration`, `away_summary`, `local_command`, `compact_boundary`,
  `api_error`, `stop_hook_summary`, `model_refusal_fallback`.
  - `stop_hook_summary` lists each hook that ran at Stop — `hookInfos:
    [{command, durationMs}]`, `hookErrors`, `preventedContinuation`. Direct
    evidence that `Stop` hooks exist and are observable from the transcript.
  - `compact_boundary` marks context compaction (`compactMetadata.trigger` is
    `"auto"` or `"manual"`).
- Every line carries `cwd` and `gitBranch` — the real basis for deriving a zone
  (one repo per office area) and the agent's context.
- **Sub-agents genuinely exist as separate files on disk**:
  `<project>/<sessionId>/subagents/workflows/<runId>/agent-<agentId>.jsonl`,
  alongside an `agent-<agentId>.meta.json` and a `journal.jsonl` recording the
  orchestration. The workflow file itself defines each child agent and its role
  as free-text prompt — there is no normalized `role` field.
- In the main transcript, a sub-agent line is marked by `isSidechain: true` plus
  `agentId` and `promptId`. Confirmed: thousands of such lines on a real machine.
- No `tool_use.name == "Task"` call appeared in the data available at the time,
  because that setup used workflows rather than the classic Task tool. Row 5
  below therefore rests on **the published contract** (`name: "Task"`, `input:
  {subagent_type, description, prompt}`) and is marked as inferred.
- Agent roles (`coder` / `tester` / `reviewer` / `PM`) have **no normalized
  field**. The only real source is the front-matter of `~/.claude/agents/*.md`
  when an agent is invoked by a matching name, or free text in a workflow script.

---

## 2. The mapping

| # | Event (real field) | What the character does | Zone | Status indicator |
|---|---|---|---|---|
| 1 | `tool_use.name = "Read"` | Sits and reads a document | Own desk | Pale blue dot, small 📄 |
| 2 | `tool_use.name = "Write"` | Types fast, fresh paper appears | Own desk | Green dot, ✏️ |
| 3 | `tool_use.name = "Edit"` | Types and strikes through existing paper — a different pose from Write, so editing reads differently from creating | Own desk | Green dot, 🖊️ |
| 4 | `tool_use.name = "Bash"` | Stands, walks to the terminal in the corner, types a command | Arcade machine / server corner | Amber dot, blinking `>_` while the command runs |
| 5 | `tool_use.name = "Task"` *(documented contract, not directly observed)* | Goes to the whiteboard, writes a brief, and a new character appears | Meeting room | Purple dot on the parent (waiting on a sub-agent); the child pops in |
| 6 | `WebFetch` / `WebSearch` | Leaves the desk and stands at the big window | Window / research zone | Deep blue dot, 🔍 |
| 7 | `tool_use.name` matching `mcp__*` | Walks to the mail counter (calling an outside system) | Mailroom, away from the desks | Light purple dot, 🔌, tooltip naming the MCP server from the `mcp__<server>__` prefix |
| 8 | `tool_use.name = "Skill"` (`input.skill`) | Goes to the filing cabinet, takes out a specific manual | Filing cabinet | Blue dot, 📘 with the skill name |
| 9 | `tool_use.name = "AskUserQuestion"` | Turns to face you, raises a hand, big question mark | In place | Orange dot, large ❓, with a slight shake to draw the eye |
| 10 | `tool_result.is_error = true` containing `"has been denied"` | Stops short, hand out, confused | In place | **Red dot + blinking ❗ — the highest priority. This is the state Mission Control exists to surface.** |
| 11 | `tool_result.is_error = true` (any other error) | Leans over the paper, scratches head | In place | Deep orange dot, ⚠️ |
| 12 | `PreToolUse` hook — permission requested, no decision yet. Observable **only** through the hook; never in the transcript, which is written after the turn ends | Knocks at a door marked "needs approval" | In place | **Solid red dot, ❗, blinking outline — the single most important state in the product** |
| 13 | `PostToolUse` hook | Nods, puts the object down | In place | Pale green dot for one frame, then the next state |
| 14 | `Stop` hook / `stop_hook_summary` | Stands, tidies the desk, sits back down | Own desk | Grey "available" dot. Non-empty `hookErrors` adds a small orange warning |
| 15 | `SessionStart` hook | Walks in through the office door and sits at an assigned desk | Door → own desk | Green dot, walk-in animation |
| 16 | `Notification` hook | Waves, or the desk lamp brightens | In place | Blinking amber dot, 🔔 |
| 17 | Waiting on you — the turn ended without a `tool_use`, or an `AskUserQuestion` is hanging | Sits still, facing out, arms folded | Own desk | Pale grey "available", optionally a 💬 bubble |
| 18 | Running — a `tool_use` with no matching `tool_result` yet | Whatever rows 1–8 say for that tool | The matching zone | Green "focusing" dot with a small spinner |
| 19 | `compact_boundary` | Blinks; a "memory" surfaces and fades | In place | Brief pale blue dot, 🧠, `preTokens` in the tooltip |
| 20 | `away_summary` | Leaves a paper note on the desk before disappearing | Desk → gone | Grey dot, 📝 summarising the content |
| 21 | `local_command` (a slash command you typed) | A bell rings outside; the character looks up | In place | Short amber outline flash |
| 22 | `api_error` | Freezes, red ✖️ overhead | In place | Red dot — nearly as urgent as permission-blocked |

---

## 3. Several agents at once

**Real basis:** `isSidechain: true` plus `agentId` in the main transcript, and
for multi-agent workflows a separate JSONL per agent under
`subagents/workflows/<runId>/`.

Display rules:

- A new `agentId` **pops in** in the middle of the office rather than walking
  through the door, so "spawned by another agent" reads differently from "a
  session you opened yourself".
- While a sub-agent is alive, a thin line connects it back to its parent's desk.
  That answers "who is waiting on whom" faster than a terminal can.
- When the sub-agent finishes, the character fades out and the line goes with it.
- Agents sharing a `cwd`/repo share a zone, named after the repo directory.
  Different `cwd` means a different zone — so "where do I need to intervene?"
  can be answered from position on the map alone, with no clicking.
- A real limit: the transcript has **no normalized `role` for sub-agents**. Do
  not paint a "Tester" or "PM" label that cannot be derived. Inventing data
  breaks the principle the whole product rests on.

## 4. Inferring a role — only with grounds

Roles are not a real field. Infer in this order, and make the UI **distinguish
inferred from certain** (a dimmer label, or a small `(?)`):

1. **Most certain:** if a Task or workflow invocation matches a file in
   `~/.claude/agents/<name>.md`, use that file's front-matter as the label —
   `code-reviewer` → "Reviewer", `tdd-guide` → "QA/Tester", `planner` →
   "PM/Planner". That is data on disk, not a guess.
2. **Middling:** with no matching agent file, infer from naming patterns in the
   spawn prompt or workflow script — a script with "Review" and "Verify" phases
   suggests "Reviewer" and "Verifier". Mark it as inferred.
3. **No grounds:** show a neutral "Agent" plus a shortened `agentId`. Do not
   invent a role.
4. `cwd` and `gitBranch` determine the **zone**, never the role.

## 5. Priority when several states are true at once

This is the product's core question, so priority decides the dot colour and can
suppress secondary icons:

1. **Blocked awaiting permission** — a hanging `PreToolUse`, or a "has been
   denied" result the agent is still retrying. Solid red, ❗, blinking outline.
   This is precisely why a real-time hook channel is required rather than just
   tailing the transcript: the transcript reveals this state only *after* the
   denial, never *while* it is pending.
2. Unrecoverable API or tool errors (`api_error`, repeating `is_error`) — red, ✖️.
3. A long-running command (Bash with no result past N seconds) — amber, shading
   toward orange past a configurable threshold.
4. Waiting on you — pale orange.
5. Working normally — green.
6. Idle / stopped / away — grey.

---

## Questions this document opened, and how they were settled

The four questions raised here at design time have since been answered by
building the thing:

1. **A real-time channel for "blocked awaiting permission."** Answered yes — the
   optional hook pilot shipped. Without it the office still infers the state
   from the transcript, a few seconds late; with it the ❗ appears while the
   prompt is actually hanging. The 2s grace window exists so a fast prompt does
   not flicker.
2. **Sub-agent roles.** Accepted as designed: most sub-agents show the neutral
   label. Better attribution needs workflow-script parsing and stayed on the
   backlog rather than being faked.
3. **The `Task` mapping** is still the documented contract rather than something
   verified against observed data. Treat row 5 as unverified.
4. **Zones and worktrees.** Settled: worktrees resolve back to their origin repo,
   so several agents on one project share a zone. Splitting them by raw `cwd`
   would have scattered one project across the map.
