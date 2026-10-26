// lane L2: data rule enforcement — WARN only. A session whose harness/lane is not
// on its project's allow-list raises one in-office alert (policy_alert, shown in
// the intervention queue) plus an OS notification. It never blocks reading the
// transcript: the session is already running, the point is that a human knows.
//
// Observes the same broadcast stream as notifier.js (wraps server.broadcast), so
// every tailer — Claude, Codex, Gemini, future harnesses — is covered with no
// per-harness code.

import { makeEvent } from "./event-schema.js";
import { deliverNotification, buildOfficeUrl } from "./notifier.js";
import { harnessViolation } from "./policy.js";

const IGNORED_TYPES = new Set(["policy_alert", "approval_pending", "approval_resolved", "roster_updated", "chat_message"]);
const RECHECK_MS = 60_000; // per session: a rule added mid-session is noticed within a minute
const MAX_EVENT_AGE_MS = 10 * 60_000; // history replayed at daemon start must not alert
const DEFAULT_OFFICE_URL = process.env.AGENT_OFFICE_URL ?? "http://localhost:5199";

/**
 * @param {{broadcast: (event: object) => void}} server
 * @param {Object} opts
 * @param {import("./policy-store.js").PolicyStore} opts.store
 */
export function attachPolicyWatch(
  server,
  {
    store,
    deliver = deliverNotification,
    enabled = process.env.AGENT_OFFICE_NOTIFY !== "0",
    officeUrl = DEFAULT_OFFICE_URL,
    now = Date.now,
  },
) {
  const lastChecked = new Map(); // sessionId -> ms
  const alerted = new Set(); // `${sessionId}|${kind}|${value}`
  const original = server.broadcast.bind(server);

  const check = (event) => {
    if (IGNORED_TYPES.has(event.type) || !event.sessionId || !event.cwd) return;
    if (now() - event.ts > MAX_EVENT_AGE_MS) return;
    if (now() - (lastChecked.get(event.sessionId) ?? -Infinity) < RECHECK_MS) return;
    if (lastChecked.size > 5000) lastChecked.clear(); // a long-lived daemon sees many sessions; re-checking is cheap
    lastChecked.set(event.sessionId, now());

    const project = store.projectFor(event.cwd);
    if (!project) return;
    // L3 JOIN POINT: the worker lane arrives as event.lane or event.meta.lane once L3 emits it.
    const violation = harnessViolation(project.policy, { harness: event.harness, lane: event.lane ?? event.meta?.lane });
    if (!violation) return;
    const key = `${event.sessionId}|${violation.kind}|${violation.value}`;
    if (alerted.has(key)) return;
    alerted.add(key);

    const what = violation.kind === "harness" ? `harness "${violation.value}"` : `lane "${violation.value}"`;
    const detail = `${what} is not allowed in ${project.name} (allowed: ${violation.allowed.join(", ")})`;
    // sessionId/agentId are namespaced: this must not read as "sign of life" for the real agent
    // (notifier.js clears a stuck episode on any event carrying that agentId).
    original(
      makeEvent({
        id: `policy_alert:${key}`,
        type: "policy_alert",
        sessionId: `policy:${event.sessionId}`,
        agentId: `policy:${event.sessionId}`,
        cwd: event.cwd,
        status: "ok",
        detail,
        meta: {
          project: project.slug,
          projectName: project.name,
          kind: violation.kind,
          value: violation.value,
          allowed: violation.allowed,
          targetSessionId: event.sessionId,
        },
      }),
    );
    if (enabled) {
      deliver({
        title: "Agent Office",
        subtitle: `${project.name} · data rule`,
        message: `Not allowed here: ${detail}`,
        url: buildOfficeUrl(officeUrl, event.sessionId),
      });
    }
  };

  server.broadcast = (event) => {
    original(event);
    try {
      check(event);
    } catch (error) {
      console.error("[policy-watch] error handling event:", error.message);
    }
  };
}
