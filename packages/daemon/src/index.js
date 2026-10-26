#!/usr/bin/env node
// Entry point: tail ~/.claude/projects/**/*.jsonl (root sessions and their
// sub-agent files), ~/.codex/sessions/**/rollout-*.jsonl (Codex CLI) and
// ~/.gemini/tmp/**/chats/session-*.json (Gemini CLI), normalize each new
// record, and broadcast normalized events over a local WebSocket server.

import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TranscriptTailer } from "./tailer.js";
import { HookLogTailer } from "./hook-log-tailer.js";
import { HookSignalReconciler } from "./hook-signal-reconciler.js";
import { SessionNormalizer } from "./normalize.js";
import { CodexTailer } from "./codex-tailer.js";
import { CodexSessionNormalizer } from "./codex-normalize.js";
import { GeminiTailer } from "./gemini-tailer.js";
import { GeminiSessionNormalizer } from "./gemini-normalize.js";
import { AgentRegistry } from "./agent-registry.js";
import { SessionEndMonitor } from "./session-end-monitor.js";
import { makeEvent, getRepoRoot } from "./event-schema.js";
import { EventBroadcastServer } from "./ws-server.js";
import { ChatSessionManager, createChatHttpHandler } from "./chat-session.js";
import { attachNotifier } from "./notifier.js";
import { ApprovalBroker, createApprovalHttpHandler } from "./approvals.js";
import { UsageCostIndex, createCostsHttpHandler } from "./usage-costs.js";
import { OutputsIndex, createOutputsHttpHandler } from "./outputs.js";
import { DEFAULT_ROSTER_PATH, RosterWatcher, createRosterHttpHandler } from "./roster.js";
import { DEFAULT_TEMPLATES_DIR, createTemplatesHttpHandler } from "./templates.js";
import { createProjectsHttpHandler } from "./projects.js";
import { VieNeuTts, createTtsHttpHandler } from "./tts.js";
import { createHarnessHttpHandler } from "./harness-probe.js";
import { createStaticHttpHandler } from "./static-serve.js";
import { createOriginGuard } from "./origin-guard.js";
// lane L1: LAN access control (token auth for non-loopback requests)
import { AccessStore, createAccessGuard, combineGuards, resolveBindHost, watchRevocations } from "./access.js";
// lane L3: multi-vendor team — worker roots, Hermes, scorecard
import { resolveClaudeRoots } from "./worker-lanes.js";
import { HermesTailer } from "./hermes-tailer.js";
import { HermesSessionNormalizer } from "./hermes-normalize.js";
import { createScorecardHttpHandler } from "./scorecard.js";
// lane L2: per-project approval modes + data rules
import { PolicyStore } from "./policy-store.js";
import { PolicyEngine } from "./policy-engine.js";
import { createPolicyHttpHandler } from "./policy-http.js";
import { attachPolicyWatch } from "./policy-watch.js";
import { DEFAULT_PROJECTS_DIR } from "./projects.js";
// lane L4: collision radar, time-to-intervene metrics, open-the-session actions
import { attachRadar, createRadarHttpHandler } from "./radar.js";
import { attachInterventionMetrics, createMetricsHttpHandler } from "./intervention-metrics.js";
import { createSessionOpenHandler } from "./session-open.js";
import { createAssignmentsHttpHandler } from "./assignments.js"; // lane L6
import { createMultiPm } from "./multi-pm.js"; // lane L5

const PROJECTS_ROOT =
  process.env.CLAUDE_PROJECTS_ROOT ?? path.join(os.homedir(), ".claude", "projects");
const CODEX_SESSIONS_ROOT =
  process.env.CODEX_SESSIONS_ROOT ?? path.join(os.homedir(), ".codex", "sessions");
const GEMINI_TMP_ROOT = process.env.GEMINI_TMP_ROOT ?? path.join(os.homedir(), ".gemini", "tmp");
// lane L3: Claude-format roots (main + ~/.claude-worker + AGENT_OFFICE_CLAUDE_ROOTS) and Hermes' SQLite store
const CLAUDE_ROOTS = resolveClaudeRoots();
const HERMES_DB_PATH =
  process.env.HERMES_DB_PATH ?? path.join(process.env.HERMES_HOME ?? path.join(os.homedir(), ".hermes"), "state.db");
const WS_PORT = Number(process.env.DAEMON_WS_PORT ?? 8787);
// lane L1: ~/.agent-office/access.json decides the default bind (127.0.0.1 unless LAN mode is on)
const accessStore = new AccessStore();
const WS_HOST = resolveBindHost(accessStore);
const SESSION_INACTIVITY_TIMEOUT_MS = Number(
  process.env.SESSION_INACTIVITY_TIMEOUT_MS ?? 5 * 60 * 1000
);

async function main() {
  // per-event stdout logging filled a 9GB launchd log — opt-in only
  const logEvent = process.env.AGENT_OFFICE_VERBOSE === "1" ? console.log : () => {};
  // PM chat: POST /chat → spawn a real `claude -p --resume` turn, reply
  // streams back over the same WS as additive "chat_message" events.
  // Round 5: one PM per repo — `repo` in the POST body picks whose PM; the
  // cwd for non-default repos comes from getRepoRoot (populated by the
  // transcript tailers' deriveRepo walks).
  const repoRoot =
    process.env.AGENT_OFFICE_REPO ??
    fileURLToPath(new URL("../../..", import.meta.url));
  const chatManager = new ChatSessionManager({
    stateFile: path.join(repoRoot, ".claude", "memory", "pm-session.json"),
    cwd: repoRoot,
    resolveRepoRoot: getRepoRoot,
    broadcast: (event) => server.broadcast(event),
    ...(process.env.CHAT_TIMEOUT_MS ? { timeoutMs: Number(process.env.CHAT_TIMEOUT_MS) } : {}),
    // test/dev knob: point at a stub binary instead of the real CLI
    ...(process.env.CHAT_CLAUDE_BIN ? { claudeBin: process.env.CHAT_CLAUDE_BIN } : {}),
  });

  // Approve gateway (spike R5②): pending permission approvals answered from
  // the office. In-memory only — restart = every pending falls back to "ask".
  const approvalBroker = new ApprovalBroker({
    broadcast: (event) => server.broadcast(event),
    hasClients: () => server.clientCount > 0 || multiPm.hasApprovers(), // lane L5: a phone-only owner counts as watching
    makeEvent,
    isOverBudget: () => usageIndex.overBudgetNow(),
    ...(process.env.APPROVAL_TTL_MS ? { ttlMs: Number(process.env.APPROVAL_TTL_MS) } : {}),
  });
  const chatHttp = createChatHttpHandler(chatManager);
  const approvalHttp = createApprovalHttpHandler(approvalBroker);
  // Cost dashboard (wi-cost-dashboard, wi-cost-multiharness): lazy usage
  // aggregation over the same three session trees the tailers watch — parsed
  // per request, never in RAM.
  const budgetUsd = Number(process.env.AGENT_OFFICE_BUDGET_USD) || null;
  const usageIndex = new UsageCostIndex({
    projectsRoot: PROJECTS_ROOT,
    claudeRoots: CLAUDE_ROOTS, // lane L3
    hermesDbPath: HERMES_DB_PATH, // lane L3
    codexSessionsRoot: CODEX_SESSIONS_ROOT,
    geminiTmpRoot: GEMINI_TMP_ROOT,
    budgetUsd,
  });
  const costsHttp = createCostsHttpHandler(usageIndex);
  const scorecardHttp = createScorecardHttpHandler(); // lane L3
  // Filing cabinet (wi-office-life): needs server.workItemsPath, which only
  // exists once `server` is constructed — same lazy-reference trick as
  // approvalBroker's hasClients above (assigned before any request can land).
  let outputsHttp;
  let radarHttp, metricsHttp, sessionOpenHttp; // lane L4: built once the broadcast server exists
  // Hiring Hall (wi-hiring-hall): company roster read from
  // ~/.claude/company/roster.yaml; file changes broadcast as the ADDITIVE
  // event type "roster_updated" (renderer diffs members → walk-in greeting).
  const rosterPath = process.env.COMPANY_ROSTER_PATH ?? DEFAULT_ROSTER_PATH;
  const rosterHttp = createRosterHttpHandler({ rosterPath });
  // Company in a box: browse templates/ and apply one
  // onto ~/.claude/company/roster.yaml (timestamped backup first).
  const templatesHttp = createTemplatesHttpHandler();
  // ~/.agent-office/projects/<slug>/ — the daemon is the only writer of an item.
  const projectsHttp = createProjectsHttpHandler();
  // lane L6: persona + SOP — /roster-members, /sop, /assign. SOP files sit next to the company roster.
  const assignmentsHttp = createAssignmentsHttpHandler({ companyDir: path.dirname(rosterPath) });
  // lane L5: one PM per project, members + pairing codes, Telegram/Zalo channels, the
  // end-of-day digest (multi-pm.js). Owns /pms /pm/* /overview /members /pairing /channels and
  // the Zalo webhook. `server` is assigned below — every callback here runs after it exists.
  // TODO(coordinator, lane L1): pass `roleOf: (req) => ...` once the platform lane's access
  // control lands; until then every caller counts as owner, as before roles existed.
  const multiPm = createMultiPm({
    chatManager,
    approvalBroker,
    broadcast: (event) => server.broadcast(event),
    // pm_status is live-only: never into the replay buffer (it would evict real sessions)
    broadcastLive: (event) => {
      const payload = JSON.stringify(event);
      for (const client of server.wss?.clients ?? []) if (client.readyState === client.OPEN) client.send(payload);
    },
    // lane L4's radar, when present; a 404 simply drops the line from the digest
    metricsUrl: (slug) => `http://127.0.0.1:${WS_PORT}/metrics/intervention?project=${encodeURIComponent(slug)}`,
    ...(process.env.CHAT_CLAUDE_BIN ? { claudeBin: process.env.CHAT_CLAUDE_BIN } : {}),
  });
  // R13-INFRA: harness install/login probe for the onboarding wizard, and a
  // static handler serving the renderer build (1 process, 1 port).
  const harnessHttp = createHarnessHttpHandler();
  const staticHttp = createStaticHttpHandler();
  // Voice: POST /tts → a WAV from the local model. A missing venv returns 503
  // and blocks nothing — the renderer simply doesn't speak.
  const vieneuTts = new VieNeuTts();
  const ttsHttp = createTtsHttpHandler(vieneuTts);

  // lane L2: per-project approval modes (project.json -> policy.approval) and data rules
  // (policy.allowedHarnesses/allowedLanes). The engine answers permission requests in the
  // approval broker; the HTTP handler serves the Settings panel; attachPolicyWatch warns
  // when a forbidden harness shows up. AGENT_OFFICE_PROJECTS_DIR points the store at a
  // scratch dir for tests.
  const policyStore = new PolicyStore({ projectsDir: process.env.AGENT_OFFICE_PROJECTS_DIR || DEFAULT_PROJECTS_DIR });
  approvalBroker.policy = new PolicyEngine({ store: policyStore, isOverBudget: () => usageIndex.overBudgetNow() });
  // L1 JOIN POINT: pass `roleOf` from access.js here; the default trusts only direct loopback callers.
  const policyHttp = createPolicyHttpHandler({ store: policyStore });

  const server = new EventBroadcastServer({
    port: WS_PORT,
    host: WS_HOST,
    // the side panel's transcript "Show more" grows its
    // request up to limit=500 — bump the ring buffer to match, or higher
    // tiers would just re-return the same 100 events.
    perSessionLimit: 500,
    ...(process.env.WORK_ITEMS_PATH ? { workItemsPath: process.env.WORK_ITEMS_PATH } : {}),
    extraHttp: (req, res, url) =>
      chatHttp(req, res, url) ||
      multiPm.http(req, res, url) || // lane L5 (also serves POST /zalo/webhook)
      approvalHttp(req, res, url) ||
      costsHttp(req, res, url) ||
      scorecardHttp(req, res, url) || // lane L3
      outputsHttp(req, res, url) ||
      rosterHttp(req, res, url) ||
      templatesHttp(req, res, url) ||
      projectsHttp(req, res, url) ||
      policyHttp(req, res, url) || // lane L2
      assignmentsHttp(req, res, url) || // lane L6
      harnessHttp(req, res, url) ||
      ttsHttp(req, res, url) ||
      radarHttp(req, res, url) || // lane L4
      metricsHttp(req, res, url) || // lane L4
      sessionOpenHttp(req, res, url) || // lane L4
      staticHttp(req, res, url), // static-serve LAST: catch-all GET, must not shadow an API route
    // reject cross-origin requests before any route runs (CSRF: a remote page
    // must not trip /harnesses?probe= or POST /templates/apply). Same-origin app
    // works; AGENT_OFFICE_DEV=1 additionally allows the Vite dev origin.
    // lane L1: origin check first, then the token gate (loopback passes it untouched)
    originGuard: combineGuards(createOriginGuard(), createAccessGuard({ store: accessStore })),
  });
  const outputsIndex = new OutputsIndex({ repoRoot, workItemsPath: server.workItemsPath });
  outputsHttp = createOutputsHttpHandler(outputsIndex);
  await server.start();

  const rosterWatcher = new RosterWatcher({
    rosterPath,
    onRoster: (roster) => {
      server.broadcast(
        makeEvent({
          id: `roster:${Date.now()}`,
          type: "roster_updated",
          sessionId: "company-roster",
          agentId: "company-roster",
          status: "ok",
          detail: "roster.yaml changed",
          meta: { roster },
        })
      );
      logEvent("[event] roster_updated");
    },
  });
  rosterWatcher.start();
  // lane L4: attached BEFORE the notifier on purpose — radar alerts go straight to the
  // base broadcast, so the notifier never reads one as "this agent is alive again".
  const radar = attachRadar(server);
  const interventionMetrics = attachInterventionMetrics(server);
  radarHttp = createRadarHttpHandler(radar);
  metricsHttp = createMetricsHttpHandler(interventionMetrics);
  sessionOpenHttp = createSessionOpenHandler({ resolveCwd: (id) => radar.agentCwd(id) });
  attachNotifier(server); // macOS notification khi agent kẹt >30s (AGENT_OFFICE_NOTIFY=0 để tắt)
  attachPolicyWatch(server, { store: policyStore }); // lane L2: warn when a forbidden harness/lane runs in a project
  // lane L5: Telegram is now a multi-project, multi-member channel (telegram-channel.js): a
  // silent no-op without TELEGRAM_BOT_TOKEN; TELEGRAM_CHAT_ID stays the operator's own chat.
  // attach() pushes approvals to people's chats; start() begins polling + the daily digest.
  multiPm.attach(server);
  multiPm.start();
  console.log(`[daemon] approve gateway: POST http://${WS_HOST}:${WS_PORT}/approval-request|/approval-response`);
  console.log(`[daemon] PM chat endpoint: POST http://${WS_HOST}:${WS_PORT}/chat (repo: ${repoRoot})`);
  console.log(
    `[daemon] project PMs: GET /pms, /overview · POST /pm/send (telegram: ${multiPm.channels.telegram.enabled ? "on" : "off"}, zalo: ${multiPm.channels.zalo.enabled ? "on" : "off"})`
  );
  console.log(`[daemon] cost dashboard: GET http://${WS_HOST}:${WS_PORT}/costs?window=24h|7d|30d`);
  console.log(`[daemon] outputs (tủ hồ sơ): GET http://${WS_HOST}:${WS_PORT}/outputs, POST /open`);
  console.log(`[daemon] collision radar: GET http://${WS_HOST}:${WS_PORT}/radar, /radar/touching?path=; metrics: GET /metrics/intervention`);
  console.log(`[daemon] hiring hall roster: GET http://${WS_HOST}:${WS_PORT}/roster (${rosterPath})`);
  console.log(
    `[daemon] company templates: GET http://${WS_HOST}:${WS_PORT}/templates, POST /templates/apply (${DEFAULT_TEMPLATES_DIR})`
  );
  console.log(
    `[daemon] VieNeu TTS: POST http://${WS_HOST}:${WS_PORT}/tts (python: ${vieneuTts.pythonBin}, available: ${vieneuTts.available()})`
  );
  console.log(`[daemon] WebSocket server listening on ws://${WS_HOST}:${WS_PORT}`);
  console.log(`[daemon] serving work registry from ${server.workItemsPath}`);
  console.log(`[daemon] tailing transcripts under ${CLAUDE_ROOTS.map((r) => `${r.root} (${r.harness})`).join(", ")}`);
  console.log(`[daemon] session inactivity timeout: ${SESSION_INACTIVITY_TIMEOUT_MS}ms`);
  // lane L1: say plainly whether the door is open to the network
  if (!["127.0.0.1", "localhost", "::1"].includes(WS_HOST)) {
    console.log(
      `[daemon] LAN access ON (${WS_HOST}): non-loopback requests need a token — ${accessStore.list().length} issued (node scripts/ao.mjs token list)`
    );
  }

  /** @type {Map<string, SessionNormalizer>} keyed by agentId (sessionId for root agents) */
  const normalizers = new Map();
  const registry = new AgentRegistry();

  const endMonitor = new SessionEndMonitor({
    timeoutMs: SESSION_INACTIVITY_TIMEOUT_MS,
    onTimeout: ({ sessionId, agentId, parentId, cwd, harness }) => {
      // Prune per-agent state that would otherwise be retained forever
      // (wi-daemon-leak): the normalizer for this agent, and — when the
      // ROOT session ends — its whole tool_use->agent registry map. A
      // session that resumes later just gets a fresh normalizer (which
      // re-emits session_start on its first new line).
      normalizers.delete(agentId);
      codexNormalizers.delete(agentId);
      // Safe to evict: the Gemini normalizer holds no emission bookkeeping
      // (GeminiTailer owns the offsets), so a resumed session re-emits only
      // its idempotent session_start, never replayed history.
      geminiNormalizers.delete(agentId);
      hermesNormalizers.delete(agentId); // lane L3: same property — the tailer owns the cursor
      if (agentId === sessionId) registry.clearSession(sessionId);
      const event = makeEvent({
        id: `${agentId}:session_end`,
        type: "session_end",
        sessionId,
        agentId,
        parentId,
        cwd,
        harness,
        status: "ok",
        detail: "inactivity_timeout",
        meta: { reason: "inactivity_timeout" },
      });
      server.broadcast(event);
      logEvent(`[event] session_end (${event.agent}) inactivity_timeout`);
    },
  });
  endMonitor.start();

  // Real-time "waiting for approval" channel (Mission Control): tail the
  // hook event log written by hooks/notify.mjs (PreToolUse/PostToolUse) and
  // reconcile against transcript-derived events. Emits the ADDITIVE v1
  // event type "hook_signal" — existing v1 event types are untouched.
  const reconciler = new HookSignalReconciler();
  const hookTailer = new HookLogTailer({ startAtEnd: true });
  hookTailer.on("line", ({ line }) => {
    reconciler.onHookLine(line, (signal) => {
      const event = makeEvent({
        id: `hook:${signal.sessionId}:${signal.toolUseId ?? signal.tool}:${signal.ts}:${signal.state}`,
        type: "hook_signal",
        sessionId: signal.sessionId,
        // Hooks only know the root session — sub-agent tool calls report
        // under the root character. Good enough: the human intervenes at
        // the session level anyway.
        agentId: signal.sessionId,
        cwd: signal.cwd,
        ts: signal.ts,
        tool: signal.tool,
        status: signal.state === "waiting_permission" ? "start" : "ok",
        detail:
          signal.state === "waiting_permission"
            ? `waiting for approval: ${signal.tool}`
            : `${signal.tool} resumed`,
        meta: { state: signal.state, toolUseId: signal.toolUseId, source: "hook" },
      });
      server.broadcast(event);
      logEvent(`[event] hook_signal:${signal.state} ${signal.tool} (${event.agent})`);
    });
  });
  hookTailer.on("error", ({ error }) => {
    console.error("[hook-tailer] error:", error.message);
  });
  hookTailer.start();
  console.log(`[daemon] tailing hook log at ${hookTailer.logPath}`);

  const tailer = new TranscriptTailer({ roots: CLAUDE_ROOTS }); // lane L3

  tailer.on("line", ({ sessionId, subagent, harness, line }) => {
    const agentId = subagent?.agentId ?? sessionId;
    let normalizer = normalizers.get(agentId);
    if (!normalizer) {
      normalizer = subagent
        ? new SessionNormalizer(sessionId, {
            agentId: subagent.agentId,
            registry,
            harness, // lane L3
            spawnToolUseId: subagent.toolUseId,
            // Workflow sub-agents (subagents/workflows/<runId>/agent-<id>.jsonl)
            // have no toolUseId in their meta.json — there is no tool_use block
            // to point at, because devfleet/workflow spawning doesn't go
            // through a `Task`/`Agent` tool call. The only real signal for
            // their parent is directory structure: on this machine `workflows/`
            // always sits directly under `<sessionId>/subagents/`, never
            // nested under another agent's own file (verified against every
            // workflow subagent under ~/.claude/projects) — so the root
            // session is structurally their parent, not a guess.
            parentId: subagent.toolUseId ? null : sessionId,
          })
        : new SessionNormalizer(sessionId, { agentId: sessionId, parentId: null, registry, harness });
      normalizers.set(agentId, normalizer);
    }

    const events = normalizer.normalizeLine(line);
    for (const event of events) {
      server.broadcast(event);
      endMonitor.touch(event);
      reconciler.onNormalizedEvent(event);
      logEvent(
        `[event] ${event.type}${event.tool ? `:${event.tool}` : ""} ${event.status ?? ""} (${event.agent}${event.parentId ? ` <- ${event.parentId}` : ""}) ${event.detail}`
      );
    }
  });

  tailer.on("error", ({ filePath, error }) => {
    console.error(`[tailer] error reading ${filePath}:`, error.message);
  });

  tailer.start();

  // Second source: OpenAI Codex CLI rollout files. Same broadcast pipeline,
  // separate tailer/normalizer pair (rollout format shares nothing with the
  // Claude Code transcript format — see docs/codex-adapter.md).
  console.log(`[daemon] tailing codex rollouts under ${CODEX_SESSIONS_ROOT}`);
  /** @type {Map<string, CodexSessionNormalizer>} keyed by Codex thread id */
  const codexNormalizers = new Map();
  const codexTailer = new CodexTailer({
    sessionsRoot: CODEX_SESSIONS_ROOT,
    ...(process.env.CODEX_BACKFILL_MAX_AGE_MS
      ? { backfillMaxAgeMs: Number(process.env.CODEX_BACKFILL_MAX_AGE_MS) }
      : {}),
  });

  codexTailer.on("line", ({ sessionId, line }) => {
    let normalizer = codexNormalizers.get(sessionId);
    if (!normalizer) {
      normalizer = new CodexSessionNormalizer(sessionId);
      codexNormalizers.set(sessionId, normalizer);
    }
    for (const event of normalizer.normalizeLine(line)) {
      server.broadcast(event);
      endMonitor.touch(event);
      logEvent(
        `[event] ${event.type}${event.tool ? `:${event.tool}` : ""} ${event.status ?? ""} (codex:${event.agent}${event.parentId ? ` <- ${event.parentId}` : ""}) ${event.detail}`
      );
    }
  });

  codexTailer.on("error", ({ filePath, error }) => {
    console.error(`[codex-tailer] error reading ${filePath}:`, error.message);
  });

  codexTailer.start();

  // Third source: Gemini CLI chat sessions. Unlike the two JSONL sources this
  // one is a whole JSON document rewritten in place per message — the tailer
  // re-parses it and reports what's new (see docs/gemini-adapter.md).
  console.log(`[daemon] tailing gemini chats under ${GEMINI_TMP_ROOT}`);
  /** @type {Map<string, GeminiSessionNormalizer>} keyed by Gemini session id */
  const geminiNormalizers = new Map();
  const geminiTailer = new GeminiTailer({
    tmpRoot: GEMINI_TMP_ROOT,
    ...(process.env.GEMINI_BACKFILL_MAX_AGE_MS
      ? { backfillMaxAgeMs: Number(process.env.GEMINI_BACKFILL_MAX_AGE_MS) }
      : {}),
  });

  geminiTailer.on("message", ({ sessionId, cwd, message, toolCallOffset }) => {
    let normalizer = geminiNormalizers.get(sessionId);
    if (!normalizer) {
      normalizer = new GeminiSessionNormalizer(sessionId);
      geminiNormalizers.set(sessionId, normalizer);
    }
    for (const event of normalizer.normalizeMessage(message, { cwd, toolCallOffset })) {
      server.broadcast(event);
      endMonitor.touch(event);
      logEvent(
        `[event] ${event.type}${event.tool ? `:${event.tool}` : ""} ${event.status ?? ""} (gemini:${event.agent}) ${event.detail}`
      );
    }
  });

  geminiTailer.on("error", ({ filePath, error }) => {
    console.error(`[gemini-tailer] error reading ${filePath}:`, error.message);
  });

  geminiTailer.start();

  // lane L1: a revoked token also closes the sockets it already opened
  watchRevocations({ store: accessStore, wss: server.wss });
  // lane L3: Hermes Agent — sessions live in ~/.hermes/state.db (SQLite), see docs/hermes-adapter.md
  console.log(`[daemon] tailing hermes sessions in ${HERMES_DB_PATH}`);
  /** @type {Map<string, HermesSessionNormalizer>} keyed by Hermes session id */
  const hermesNormalizers = new Map();
  const hermesTailer = new HermesTailer({
    dbPath: HERMES_DB_PATH,
    ...(process.env.HERMES_BACKFILL_MAX_AGE_MS
      ? { backfillMaxAgeMs: Number(process.env.HERMES_BACKFILL_MAX_AGE_MS) }
      : {}),
  });
  hermesTailer.on("message", ({ sessionId, session, message }) => {
    let normalizer = hermesNormalizers.get(sessionId);
    if (!normalizer) {
      normalizer = new HermesSessionNormalizer(sessionId);
      hermesNormalizers.set(sessionId, normalizer);
    }
    for (const event of normalizer.normalizeMessage(message, session)) {
      server.broadcast(event);
      endMonitor.touch(event);
      logEvent(`[event] ${event.type}${event.tool ? `:${event.tool}` : ""} ${event.status ?? ""} (hermes:${event.agent}) ${event.detail}`);
    }
  });
  hermesTailer.on("error", ({ filePath, error }) => {
    console.error(`[hermes-tailer] error reading ${filePath}:`, error.message);
  });
  hermesTailer.on("unavailable", ({ reason }) => {
    console.warn(`[hermes-tailer] disabled: ${reason}`);
  });
  hermesTailer.start();

  const shutdown = async () => {
    console.log("\n[daemon] shutting down");
    // open WS clients can keep server.stop() waiting forever — force exit
    // so launchd/Ctrl-C never hangs on a connected browser tab
    setTimeout(() => process.exit(0), 2000).unref();
    tailer.stop();
    hookTailer.stop();
    codexTailer.stop();
    geminiTailer.stop();
    hermesTailer.stop(); // lane L3
    rosterWatcher.stop();
    endMonitor.stop();
    radar.stop(); // lane L4
    interventionMetrics.stop(); // lane L4: flush the queued episodes
    multiPm.stop(); // aborts the in-flight getUpdates long-poll (Telegram allows only 1 consumer) + PM processes
    vieneuTts.dispose();
    chatManager.dispose(); // kill warm PM processes so they don't outlive the daemon
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("[daemon] fatal error:", error);
  process.exit(1);
});
