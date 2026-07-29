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
import { createZaloHttpHandler } from "./zalo.js";
import { attachNotifier } from "./notifier.js";
import { pollUpdates } from "./telegram.js";
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

const PROJECTS_ROOT =
  process.env.CLAUDE_PROJECTS_ROOT ?? path.join(os.homedir(), ".claude", "projects");
const CODEX_SESSIONS_ROOT =
  process.env.CODEX_SESSIONS_ROOT ?? path.join(os.homedir(), ".codex", "sessions");
const GEMINI_TMP_ROOT = process.env.GEMINI_TMP_ROOT ?? path.join(os.homedir(), ".gemini", "tmp");
const WS_PORT = Number(process.env.DAEMON_WS_PORT ?? 8787);
const WS_HOST = process.env.DAEMON_WS_HOST ?? "127.0.0.1";
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
    hasClients: () => server.clientCount > 0,
    makeEvent,
    isOverBudget: () => usageIndex.overBudgetNow(),
    ...(process.env.APPROVAL_TTL_MS ? { ttlMs: Number(process.env.APPROVAL_TTL_MS) } : {}),
  });
  const chatHttp = createChatHttpHandler(chatManager);
  const zaloHttp = createZaloHttpHandler(chatManager);
  const approvalHttp = createApprovalHttpHandler(approvalBroker);
  // Cost dashboard (wi-cost-dashboard, wi-cost-multiharness): lazy usage
  // aggregation over the same three session trees the tailers watch — parsed
  // per request, never in RAM.
  const budgetUsd = Number(process.env.AGENT_OFFICE_BUDGET_USD) || null;
  const usageIndex = new UsageCostIndex({
    projectsRoot: PROJECTS_ROOT,
    codexSessionsRoot: CODEX_SESSIONS_ROOT,
    geminiTmpRoot: GEMINI_TMP_ROOT,
    budgetUsd,
  });
  const costsHttp = createCostsHttpHandler(usageIndex);
  // Filing cabinet (wi-office-life): needs server.workItemsPath, which only
  // exists once `server` is constructed — same lazy-reference trick as
  // approvalBroker's hasClients above (assigned before any request can land).
  let outputsHttp;
  // Hiring Hall (wi-hiring-hall): company roster read from
  // ~/.claude/company/roster.yaml; file changes broadcast as the ADDITIVE
  // event type "roster_updated" (renderer diffs members → walk-in greeting).
  const rosterPath = process.env.COMPANY_ROSTER_PATH ?? DEFAULT_ROSTER_PATH;
  const rosterHttp = createRosterHttpHandler({ rosterPath });
  // "Công ty đóng hộp" (wi-templates-panel): browse templates/ and apply one
  // onto ~/.claude/company/roster.yaml (timestamped backup first).
  const templatesHttp = createTemplatesHttpHandler();
  // R13-A: ~/.agent-office/projects/<slug>/ — daemon là cổng ghi duy nhất của item.
  const projectsHttp = createProjectsHttpHandler();
  // R13-INFRA: harness install/login probe for the onboarding wizard, and a
  // static handler serving the renderer build (1 process, 1 port).
  const harnessHttp = createHarnessHttpHandler();
  const staticHttp = createStaticHttpHandler();
  // Voice VN (wi-voice-vieneu): POST /tts → VieNeu WAV; renderer fallback về
  // speechSynthesis khi 503 nên thiếu venv không chặn gì.
  const vieneuTts = new VieNeuTts();
  const ttsHttp = createTtsHttpHandler(vieneuTts);

  const server = new EventBroadcastServer({
    port: WS_PORT,
    host: WS_HOST,
    // wi-office-life: the side panel's transcript "Xem thêm" grows its
    // request up to limit=500 — bump the ring buffer to match, or higher
    // tiers would just re-return the same 100 events.
    perSessionLimit: 500,
    ...(process.env.WORK_ITEMS_PATH ? { workItemsPath: process.env.WORK_ITEMS_PATH } : {}),
    extraHttp: (req, res, url) =>
      chatHttp(req, res, url) ||
      zaloHttp(req, res, url) ||
      approvalHttp(req, res, url) ||
      costsHttp(req, res, url) ||
      outputsHttp(req, res, url) ||
      rosterHttp(req, res, url) ||
      templatesHttp(req, res, url) ||
      projectsHttp(req, res, url) ||
      harnessHttp(req, res, url) ||
      ttsHttp(req, res, url) ||
      staticHttp(req, res, url), // static-serve LAST: catch-all GET, must not shadow an API route
    // reject cross-origin requests before any route runs (CSRF: a remote page
    // must not trip /harnesses?probe= or POST /templates/apply). Same-origin app
    // works; AGENT_OFFICE_DEV=1 additionally allows the Vite dev origin.
    originGuard: createOriginGuard(),
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
  attachNotifier(server); // macOS notification khi agent kẹt >30s (AGENT_OFFICE_NOTIFY=0 để tắt)
  // Telegram 2 chiều (B11/B12): no-op silently unless TELEGRAM_BOT_TOKEN +
  // TELEGRAM_CHAT_ID are both set — see telegram.js's own config gate.
  const telegramPoll = pollUpdates(chatManager);
  console.log(`[daemon] approve gateway: POST http://${WS_HOST}:${WS_PORT}/approval-request|/approval-response`);
  console.log(`[daemon] PM chat endpoint: POST http://${WS_HOST}:${WS_PORT}/chat (repo: ${repoRoot})`);
  console.log(`[daemon] cost dashboard: GET http://${WS_HOST}:${WS_PORT}/costs?window=24h|7d|30d`);
  console.log(`[daemon] outputs (tủ hồ sơ): GET http://${WS_HOST}:${WS_PORT}/outputs, POST /open`);
  console.log(`[daemon] hiring hall roster: GET http://${WS_HOST}:${WS_PORT}/roster (${rosterPath})`);
  console.log(
    `[daemon] company templates: GET http://${WS_HOST}:${WS_PORT}/templates, POST /templates/apply (${DEFAULT_TEMPLATES_DIR})`
  );
  console.log(
    `[daemon] VieNeu TTS: POST http://${WS_HOST}:${WS_PORT}/tts (python: ${vieneuTts.pythonBin}, available: ${vieneuTts.available()})`
  );
  console.log(`[daemon] WebSocket server listening on ws://${WS_HOST}:${WS_PORT}`);
  console.log(`[daemon] serving work registry from ${server.workItemsPath}`);
  console.log(`[daemon] tailing transcripts under ${PROJECTS_ROOT}`);
  console.log(`[daemon] session inactivity timeout: ${SESSION_INACTIVITY_TIMEOUT_MS}ms`);

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

  const tailer = new TranscriptTailer({ projectsRoot: PROJECTS_ROOT });

  tailer.on("line", ({ sessionId, subagent, line }) => {
    const agentId = subagent?.agentId ?? sessionId;
    let normalizer = normalizers.get(agentId);
    if (!normalizer) {
      normalizer = subagent
        ? new SessionNormalizer(sessionId, {
            agentId: subagent.agentId,
            registry,
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
        : new SessionNormalizer(sessionId, { agentId: sessionId, parentId: null, registry });
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

  const shutdown = async () => {
    console.log("\n[daemon] shutting down");
    // open WS clients can keep server.stop() waiting forever — force exit
    // so launchd/Ctrl-C never hangs on a connected browser tab
    setTimeout(() => process.exit(0), 2000).unref();
    tailer.stop();
    hookTailer.stop();
    codexTailer.stop();
    geminiTailer.stop();
    rosterWatcher.stop();
    endMonitor.stop();
    telegramPoll.stop(); // aborts the in-flight getUpdates long-poll (Telegram allows only 1 consumer)
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
