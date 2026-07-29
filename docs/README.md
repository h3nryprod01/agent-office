# Documentation

Two kinds of document live here.

**Reference** describes how the system works now. Start here.

**Status notes** are a record per feature: what was built, what broke, and why
a particular approach was chosen over the obvious one. They are written at the
end of a piece of work, not maintained afterwards, so they are accurate about
the day they describe and may lag the code. They are kept because the reasoning
is often more useful than the outcome — several of them exist mainly to record
a trap worth not falling into twice.

The reference documents are in English. **The status notes are in Vietnamese**,
in the language they were written in as the work happened. Translating them
after the fact would have meant rewriting a record, so they were left alone.

## Start here

| Document | What it covers |
|---|---|
| [SPECS.md](SPECS.md) | The system in one place — architecture, event schema, components |
| [install.md](install.md) | Install, run, troubleshoot, uninstall, per platform |
| [semantic-mapping.md](semantic-mapping.md) | How an agent event becomes a character walking to a station |
| [company-protocol.md](company-protocol.md) | The contract between coordinator, agents, and the office |

## Reference

| Document | What it covers |
|---|---|
| [codex-adapter.md](codex-adapter.md) | Codex CLI rollout files → event schema v1 |
| [gemini-adapter.md](gemini-adapter.md) | Gemini CLI chat sessions → event schema v1 |
| [company-templates.md](company-templates.md) | "Company in a box" — roster + goals, applied to a machine |
| [art-direction.md](art-direction.md) | Visual rules the art follows |
| [windows-port.md](windows-port.md) | What the Windows port does and does not cover |
| [pretooluse-hook-proposal.md](pretooluse-hook-proposal.md) | Hook design for instant "waiting for permission" |

## How each piece was built

**The data pipeline**

- [codex-adapter-status.md](codex-adapter-status.md) · [harness3-status.md](harness3-status.md) — adding the second and third harness
- [daemon-leak-status.md](daemon-leak-status.md) — a leak, found and closed
- [cost-dashboard-status.md](cost-dashboard-status.md) · [cost-multiharness-status.md](cost-multiharness-status.md) — spend across three CLIs, and the double-counting trap in Codex's own token events

**The office**

- [renderer-status.md](renderer-status.md) · [mission-control-status.md](mission-control-status.md) — the renderer, and making it interactive
- [art-status.md](art-status.md) · [art-round2-status.md](art-round2-status.md) · [anim-round3-status.md](anim-round3-status.md) · [makeover-status.md](makeover-status.md) — three passes over the art
- [office-life-status.md](office-life-status.md) · [ceo-avatar-status.md](ceo-avatar-status.md) — making a mostly-idle office feel alive
- [multi-office-status.md](multi-office-status.md) · [orgchart-status.md](orgchart-status.md) — many repos, and who spawned whom
- [replay-status.md](replay-status.md) — scrubbing back through a session

**Acting on what you see**

- [approve-spike-status.md](approve-spike-status.md) — answering a permission prompt from the office
- [notify-status.md](notify-status.md) · [notify-click-fix-status.md](notify-click-fix-status.md) — OS notifications, and the click that opened the wrong thing
- [pm-chat-status.md](pm-chat-status.md) · [pm-per-repo-status.md](pm-per-repo-status.md) · [pm-ux-status.md](pm-ux-status.md) — a PM agent per repo
- [voice-status.md](voice-status.md) · [voice-vi-status.md](voice-vi-status.md) — talking to the PM, and why the system Vietnamese voice had to go
- [deeplinks-status.md](deeplinks-status.md) — linking straight to a work item

**Running agents as a team**

- [company-skills-status.md](company-skills-status.md) · [company-hire-status.md](company-hire-status.md) — roles, roster, and vetting a skill before installing it
- [templates-panel-status.md](templates-panel-status.md) · [template-realestate-status.md](template-realestate-status.md) — templates in the UI, and a real one
- [hiring-hall-status.md](hiring-hall-status.md) — filling a gap in the roster
- [standup-status.md](standup-status.md) — a 9am standup written to Obsidian

**Other**

- [demo-status.md](demo-status.md) · [promo-video-status.md](promo-video-status.md) — the demo and the promo video
- [brainstorm-2026-07-17.md](brainstorm-2026-07-17.md) — a direction-setting session
