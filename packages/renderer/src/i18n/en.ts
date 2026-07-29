/**
 * English UI strings — the default.
 *
 * The Vietnamese original avoids jargon on purpose: an agent is "waiting for
 * you to approve", not in state `waiting_permission`. The English keeps that
 * choice rather than falling back to the enum names.
 */
export const en = {
  // ── navigation ───────────────────────────────────────────────────────────
  "nav.office": "Office",
  "nav.board": "Board",
  "nav.log": "Activity",
  "nav.costs": "Spend",
  "nav.settings": "Settings",

  // ── agent status ─────────────────────────────────────────────────────────
  "status.working": "Working",
  "status.reading": "Reading files",
  "status.running_command": "Running a command",
  "status.waiting_permission": "Waiting for you",
  "status.blocked": "Blocked",
  "status.error": "Hit an error",
  "status.idle": "Idle",
  "status.done": "Done",

  // ── stations in the office ───────────────────────────────────────────────
  "station.pmDesk": "PM / CEO desk",
  "station.cabinet": "Filing cabinet",
  "station.bookshelf": "Bookshelf (reading files)",
  "station.arcade": "Arcade machine (running commands)",
  "station.meeting": "Meeting table (delegating)",

  // ── office controls ──────────────────────────────────────────────────────
  "office.center": "⌖ Center",
  "office.centerTitle": "Bring the office back to the middle of the view",
  "office.lightsOn": "☀️ Lights on",
  "office.lightsOff": "🌙 Lights off",
  "office.lightsOnTitle": "Turn the office lights on",
  "office.lightsOffTitle": "Lights off — only screens and neon",
  "office.toDesks": "🏢 Back to desks",
  "office.huddle": "👥 Huddle",
  "office.toDesksTitle": "Send everyone back to their desk",
  "office.huddleTitle": "Call the team to the meeting table",
  "office.soundTitle": "Toggle ambient sound (clack / ting / buzz)",
  "office.connecting": "live: connecting to {url}…",
  "office.offline": "⚠ daemon offline — reconnecting…",
  "office.openFailed": "⚠ Could not open: {error}",

  // ── wall boards ──────────────────────────────────────────────────────────
  "wall.daemonOffline": "daemon offline",
  "wall.queued": "Queued",
  "wall.inProgress": "In progress",
  "wall.productivity": "THROUGHPUT",
  "wall.last24h": "last 24 hours",
  "wall.empty": "— empty —",

  // ── no WebGL ─────────────────────────────────────────────────────────────
  "webgl.title": "3D graphics are unavailable",
  "webgl.body": "This machine cannot use WebGL, so the 3D office does not render.",
  "webgl.stillWorks":
    "Everything else still works: <b>Board</b>, <b>Activity</b>, <b>Spend</b>, <b>Settings</b> — use the sidebar on the left.",
  "webgl.hint":
    "Usually an old graphics card or driver, or a remote desktop / virtual machine without hardware acceleration.",

  // ── side panel ───────────────────────────────────────────────────────────
  "panel.copied": "copied",
  "panel.copyManually": "copy the line above by hand",
  "panel.agentGone": "This agent is gone",
  "panel.resumeInClaude": "Resume in Claude",
  "panel.resumeCopyTitle": "Copy the command that resumes this PM session",
  "panel.status": "Status",
  "panel.detail": "Detail",
  "panel.doing": "Doing",
  "panel.cwd": "Working directory",
  "panel.session": "Session",
  "panel.reportsTo": "Reports to",
  "panel.topLevel": " · top level",
  "panel.close": "Close",
  "panel.noActivity": "Nothing yet.",
  "panel.transcriptLiveOnly": "Transcripts need live mode (?ws=1).",
  "panel.loading": "Loading…",
  "panel.noMessages": "No messages in the buffer yet.",
  "panel.showMore": "Show more ({n})",

  // ── PM chat ──────────────────────────────────────────────────────────────
  "chat.youPrefix": "you › ",
  "chat.toggleTitle": "Show or hide the chat box",
  "chat.stopTitle":
    "Stop the PM turn that is running. This stops ONLY this PM chat — your other Claude sessions have to be stopped in their own app.",
  "chat.placeholder": "Message the PM… (Enter to send)",
  "chat.placeholderRepo": "Message the PM · {repo}… (Enter to send)",
  "chat.ttsTitle": "Read the PM's replies aloud — click to toggle",
  "chat.resumeTitle":
    "Continue this PM session in Claude Code — copies the 'claude --resume' command for the open repo",
  "chat.hint":
    "This talks to the PM for the repo in the open tab (the All tab uses the default repo). To approve a tool for a session that is waiting on permission, do it in that session's own Claude Code app.",
  "chat.sendFailed": "Send failed (HTTP {status})",
  "chat.noDaemon": "Cannot reach the daemon ({url}) — is it running?",
  "chat.stopFailed": "Cannot reach the daemon to stop the turn.",
  "chat.noSession": "No PM session for this repo yet — send the PM a message first.",
  "chat.copiedCmd": "copied 🔗 {cmd}",
  "chat.copyManually": "copy this command by hand: {cmd}",
  "chat.daemonUnreachable": "Cannot reach the daemon ({url}).",

  // ── activity log ─────────────────────────────────────────────────────────
  "activity.runningTests": "Running tests",
  "activity.git": "Version control (git)",
  "activity.deleteFile": "Deleting files",
  "activity.moveFile": "Copying or moving files",
  "activity.build": "Building",
  "activity.shell": "Running a shell command",
  "activity.readingNamed": "Reading: {name}",
  "activity.reading": "Reading and looking things up",
  "activity.editingNamed": "Editing: {name}",
  "activity.editing": "Writing and editing",
  "activity.web": "Searching the web",
  "activity.working": "Working",
  "activity.liveOnly": "The activity log needs live mode.",
  "activity.empty": "Nothing has happened yet.",
  "activity.business": "Business",
  "activity.technical": "Technical",

  // ── board ────────────────────────────────────────────────────────────────
  "kanban.ideas": "Ideas",
  "kanban.queued": "Queued",
  "kanban.inProgress": "In progress",
  "kanban.review": "In review",
  "kanban.liveOnly": "The board needs live mode.",
  "kanban.more": "… {n} more",
  "kanban.inputPlaceholder": "+ jot down an idea…",
  "kanban.myIdeas": "My ideas",
  "kanban.agentWork": "Agent work",
  "kanban.noIdeas": "No ideas yet",
  "kanban.noIdeasHint":
    "Type your first idea below and press Enter — the PM picks work up from here.",
  "kanban.agentNoWork": "No agent work yet",
  "kanban.agentNoWorkHint":
    'Go to the "My ideas" tab, write one down, then hand it to the PM.',
  "kanban.askPm": 'Please take on this idea: "{title}"',

  // ── spend ────────────────────────────────────────────────────────────────
  "costs.overBudget":
    "⚠ Over budget: {spent} of {budget}. Requests that need approval will wait for you to approve going over.",
  "costs.byDay": "By day",
  "costs.liveOnly": "Spend needs live mode.",
  "costs.chipWithTotal": "{warn}Spend · {total}",
  "costs.chip": "Spend",

  // ── settings ─────────────────────────────────────────────────────────────
  "settings.title": "Settings",
  "settings.connection": "Connection",
  "settings.agentSources": "Agent sources",
  "settings.about": "About",
  "settings.mockMode": "● Demo mode (mock) — not connected to a daemon",
  "settings.connected": "● Connected",
  "settings.disconnected": "● Disconnected — is the daemon ({url}) running?",
  "settings.installed": "Installed",
  "settings.notInstalled": "Not installed",
  "settings.loggedIn": "Signed in",
  "settings.notLoggedIn": "Not signed in",
  "settings.notChecked": "Not checked",
  "settings.check": "Check",
  "settings.checking": "Checking…",
  "settings.checkFailed": "Failed — try again",
  "settings.sourcesLiveOnly": "Agent sources only show in live mode (needs the daemon).",
  "settings.sourcesHint":
    'The agent CLIs this office can see. "Check" confirms you are signed in.',
  "settings.aboutText":
    "Agent Office — a visual office for a one-person company run on AI agents, with a company-in-a-box setup per kind of work.",
  "settings.language": "Language",
  "settings.languageHint": "Changing the language reloads the page.",

  // ── company templates ────────────────────────────────────────────────────
  "templates.button": "🏢 Company in a box",
  "templates.note": "Each template is a packaged multi-agent company — departments plus goals. <b>Applying overwrites the real roster</b> on this machine; the old one is always backed up first.",
  "templates.loading": "Loading…",
  "templates.hasGoals": "has goals.md",
  "templates.noGoals": "no goals.md",
  "templates.meta": "{depts} departments · {members} people · {goals}",
  "templates.missingSkills":
    "⚠ Missing {n} skill(s): {list} — run the company-hire skill to add them (a safety scan is required).",
  "templates.confirmOverwrite": "⚠ Click again to OVERWRITE the roster",
  "templates.apply": "Apply",
  "templates.applyWarning":
    'Applying "{name}" overwrites {path}. Your current roster is backed up first → {path}.<timestamp>.bak',
  "templates.backedUp": "✅ Previous roster backed up → {path}",
  "templates.createdFresh": "✅ Roster created (there was no previous one to back up).",
  "templates.allSkillsPresent": "✅ Every skill this template needs is already installed.",
  "templates.close": "Close",
  "templates.empty": "No templates in templates/ yet.",
  "templates.applied": 'Applied "{name}"',
  "templates.goalsHeading": "Goals (goals.md) — handed to company-pm",
  "templates.noDaemon": "Cannot reach the daemon ({url}).",
  "templates.applying": 'Applying "{name}"…',
  "templates.applyFailed": "⚠ Apply failed: {error}",

  // ── hiring hall ──────────────────────────────────────────────────────────
  "hiring.prompt":
    "Use the company-hire skill to hire {gap}. Report the scan verdict and the result back in chat.",
  "hiring.noRoster":
    "No roster yet — hire your first person with the form below, or run the company-roster skill to bootstrap one.",
  "hiring.budgetCap": "cap ${amount}/day",
  "hiring.emptyDept": "empty",
  "hiring.rosterUpdated": "Roster updated: {when} · {total} people",
  "hiring.close": "Close",
  "hiring.gapPlaceholder": "Describe the gap — e.g. need a thumbnail designer for media",
  "hiring.liveOnly": "The roster needs live mode (and the daemon at {url}).",
  "hiring.unreadable": "Could not read the roster — is the daemon running?",
  "hiring.inProgress":
    "⏳ The PM is hiring… (company-hire: find candidates → scan → install). Details in the chat box.",
  "hiring.noDaemon": "⚠ Cannot reach the daemon ({url}) — is it running?",
  "hiring.joined": "🎉 {names} joined the roster.",
  "hiring.turnDone":
    "✅ The PM finished — see the result in the chat box. Anyone hired shows up in the roster on their own.",
  "hiring.turnFailed": "The PM turn failed",

  // ── timeline / replay ────────────────────────────────────────────────────
  "timeline.backToLive": "Back to live",
  "timeline.exportTitle": "Export this session as JSON",
  "timeline.importTitle": "Import a replay JSON file (or drop one on the page)",
  "timeline.noEvents": "No events to replay yet",
  "timeline.nothingToExport": "No events to export yet",
  "timeline.exported": "Exported {n} events",
  "timeline.noRecording": "This browser cannot record video",
  "timeline.timelapseSaved": "Timelapse downloaded",
  "timeline.recording": "Recording — set replay to 60× for a timelapse",
  "timeline.emptyFile": "That replay file is empty",
  "timeline.loaded": "Loaded {n} events — drag the timeline or press ▶",
  "timeline.unreadableFile": "Could not read that file",
  "timeline.notJson": "That file is not valid JSON",
  "timeline.notReplayFile": "Not an Agent Office replay file",

  // ── voice ────────────────────────────────────────────────────────────────
  "voice.tableSummary": "table, {rows} rows",
  "voice.ttsGlitch": "🗣️ The voice failed on that sentence — try again or reload the page.",
  "voice.micBlocked": "The microphone is blocked — allow it for this page and try again.",
  "voice.networkError":
    "Speech recognition hit a network error — Chrome's Web Speech calls Google's servers; check your VPN or firewall.",
  "voice.error": "Speech recognition error: {code}",
  "voice.unsupported": "This browser has no Web Speech API — try Chrome or Edge",
  "voice.micTitle": "Click to talk (or hold Space when not typing) — release to send, Esc to cancel",
  "voice.ttsUnsupported": "This browser has no speechSynthesis",
  "voice.ttsOn": "Reading the PM's replies aloud — click to turn off",
  "voice.ttsOff": "Click to have the PM read replies aloud (off by default)",

  // ── filing cabinet ───────────────────────────────────────────────────────
  "outputs.empty": "Nothing in docs/media/ yet.",
  "outputs.title": "Filing cabinet",
  "outputs.close": "Close",
  "outputs.liveOnly": "The filing cabinet needs live mode (?ws=1).",
  "outputs.loading": "Loading…",
  "outputs.noDaemon": "Cannot reach the daemon.",

  // ── work items ───────────────────────────────────────────────────────────
  "work.because": "because →",
  "work.whyLabel": "Why",
  "work.liveOnly": "Work items need live mode (?ws=1).",
  "work.loading": "Loading…",
  "work.none": "No work item for this agent.",

  // ── building view ────────────────────────────────────────────────────────
  "building.button": "🏢 Building",
  "building.title": "Building",
  "building.close": "Close",
  "building.empty": "No department is active right now.",
  "building.hasBlocked": "has a blocked agent",

  // ── org chart ────────────────────────────────────────────────────────────
  "org.button": "Org chart",
  "org.close": "Close",
  "org.empty": "No agents are running.",

  // ── registry board ───────────────────────────────────────────────────────
  "board.toggle": "Board · {doing} doing · {blocked} blocked · {done} done",
  "board.empty": "Registry is empty.",

  // ── robot kit ────────────────────────────────────────────────────────────
  "robot.color.fire": "Fire",
  "robot.color.green": "Green",
  "robot.color.magenta": "Magenta",
  "robot.color.purple": "Purple",
  "robot.color.pink": "Pink",
  "robot.color.mint": "Mint",
  "robot.color.white": "White",
  "robot.color.sand": "Sand",
  "robot.body.boxy": "Boxy",
  "robot.body.boxyDesc": "voxel, friendly",
  "robot.body.capsule": "Capsule",
  "robot.body.capsuleDesc": "rounded and soft, with a visor",
  "robot.body.hover": "Hover",
  "robot.body.hoverDesc": "no legs — floats",
  "robot.body.heavy": "Heavy",
  "robot.body.heavyDesc": "large, industrial, shoulder plates",
  "robot.body.slim": "Slim",
  "robot.body.slimDesc": "tall, slender, elegant",
  "robot.body.retro": "Retro",
  "robot.body.retroDesc": "1950s tin robot",
  "robot.body.eye": "Eye",
  "robot.body.eyeDesc": "a single flying eye — minimal",
  "robot.body.quad": "Quadruped",
  "robot.body.quadDesc": "mechanical animal — low, crawling",
  "robot.body.screen": "Screen head",
  "robot.body.screenDesc": "the head is a screen",
  "robot.body.cube": "Cube",
  "robot.body.cubeDesc": "floating block with detached arms",
  "robot.shellLight": "light shell",
  "robot.shellDark": "dark shell",
  "robot.walkStop": "⏸ Stop walking",
  "robot.walkStart": "🚶 See it walk",

  // ── demo scenario (?mock=1) ──────────────────────────────────────────────
  "demo.readContext": "Reading the project context first…",
  "demo.split": "OK — splitting this across 4 agents.",
  "demo.readOld": "Let me look at the existing code…",
  "demo.runTests": "Running the test suite…",
  "demo.testsRed": "Tests are red — fixing 😅",
  "demo.needApproval": "I need you to approve this command!",
  "demo.cleanDiff": "Diff is clean, one small nit.",
  "demo.myPartDone": "My part is done!",
  "demo.e2e": "Running e2e against demo-app…",
  "demo.report": "Collecting the results and writing it up.",

  // ── added in the English pass ──────────────────────────────────────────
  "outputs.open": "Open",
  "outputs.reveal": "Show in folder",
  "org.title": "Org chart",
  "costs.loading": "Loading…",
  "queue.title": "❗ Needs you",
  "hiring.title": "🪪 Hiring",
  "hiring.note": "Roster members are skills/agents INSTALLED on this machine (from ~/.claude/company/roster.yaml) — not the session characters currently running in the office.",
  "hiring.loading": "Loading…",
  "hiring.newHire": "Hire someone",
  "hiring.askPm": "Ask the PM to hire",
  "hiring.flow": "The PM runs the company-hire skill: find GitHub candidates → a safety scan is required (skillspector) → install → write the roster. Follow along in the chat box; new hires walk in through the door and greet the office.",
  "panel.recentActivity": "Recent activity",
  "chat.typing": "PM is typing…",
  "chat.stop": "⏹ stop",
  "chat.send": "Send",
  "wall.scrumBoard": "WORK BOARD",
  "chat.note": "\u24d8 this chat cannot approve permissions \u2014 do that in the agent's own app \u00b7 each message is one real Claude turn",
};
