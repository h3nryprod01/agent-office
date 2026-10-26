// Approval broker — the daemon side of the PermissionRequest gateway spike.
//
// A PermissionRequest hook (hooks/approve-gateway.mjs) long-polls
// POST /approval-request while Claude Code holds the permission dialog for a
// real session. The office user answers via POST /approval-response (the ✓/✗
// buttons in the intervention queue). Every unhappy path resolves to
// {decision:"none"}, which the hook turns into "print nothing" → Claude Code
// shows its normal permission dialog. NOTHING here may ever invent "allow".
//
// Deliberately NOT persisted: a daemon restart drops all pending approvals,
// every waiting hook errors out on the dead socket and fails open to the
// normal dialog. That is the spec, not a gap.

import { randomUUID } from "node:crypto";

const DEFAULT_TTL_MS = 25_000; // < hook fetch abort (27s) < hook registration timeout (30s)
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

/**
 * @typedef {Object} PendingApproval
 * @property {string} id
 * @property {string} sessionId
 * @property {string} tool
 * @property {string} preview   one-line human-readable summary of tool_input
 * @property {string|null} cwd
 * @property {number} expiresAt ms epoch when this falls back to "none"
 */

export class ApprovalBroker {
  /**
   * @param {Object} opts
   * @param {(event: object) => void} opts.broadcast   ws-server broadcast
   * @param {() => boolean} opts.hasClients  any office (WS client) connected?
   * @param {number} [opts.ttlMs]
   * @param {(fields: object) => object} opts.makeEvent  event-schema factory
   */
  constructor({ broadcast, hasClients, makeEvent, ttlMs = DEFAULT_TTL_MS, isOverBudget = () => false, policy = null }) {
    this.broadcast = broadcast;
    // lane L2: optional per-project policy engine (policy-engine.js). null = every request goes to a human, as before.
    this.policy = policy;
    this.hasClients = hasClients;
    this.makeEvent = makeEvent;
    this.ttlMs = ttlMs;
    this.isOverBudget = isOverBudget;
    /** @type {Map<string, {item: PendingApproval, resolve: (d: string) => void, timer: NodeJS.Timeout}>} */
    this.pending = new Map();
  }

  /**
   * Register a permission wait. Resolves with "allow" | "deny" | "none".
   * Never rejects — the hook's fail-open must not depend on our error paths.
   * @param {{sessionId?: string, tool?: string, preview?: string, cwd?: string|null, toolInput?: object, harness?: string, lane?: string, role?: string}} payload
   * @returns {Promise<{id: string|null, decision: string, source?: string, message?: string}>}
   */
  request(payload) {
    // lane L2: the project's policy may answer by itself (auto allow, read-only/deny deny).
    // Checked BEFORE the "nobody is watching" shortcut: an auto-allowed call needs no office open.
    const verdict = this.#evaluatePolicy(payload);
    if (verdict && verdict.decision !== "ask") return Promise.resolve(this.#answerFromPolicy(payload, verdict));

    // Nobody is watching the office → don't make the terminal user wait.
    // The hook gets "none" immediately and the normal dialog shows.
    if (!this.hasClients()) {
      return Promise.resolve({ id: null, decision: "none" });
    }

    const id = randomUUID();
    const item = {
      id,
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : "",
      tool: typeof payload.tool === "string" ? payload.tool : "unknown",
      preview: typeof payload.preview === "string" ? payload.preview.slice(0, 500) : "",
      cwd: typeof payload.cwd === "string" ? payload.cwd : null,
      expiresAt: Date.now() + this.ttlMs,
      budgetExceeded: this.isOverBudget(),
      ...(verdict ? { policy: policySummary(verdict) } : {}),
    };

    return new Promise((resolve) => {
      const timer = setTimeout(() => this.#settle(id, "none", "expired"), this.ttlMs);
      this.pending.set(id, {
        item,
        timer,
        resolve: (decision) => resolve({ id, decision }),
      });
      this.#emit("approval_pending", item, { state: "pending" });
    });
  }

  /**
   * Office decision for one pending approval.
   * @returns {{ok: boolean, error?: string}}
   */
  respond(id, decision) {
    if (decision !== "allow" && decision !== "deny") {
      return { ok: false, error: "decision must be allow or deny" };
    }
    if (!this.pending.has(id)) {
      return { ok: false, error: "no such approval — it expired or was already answered" };
    }
    this.#settle(id, decision, "office");
    return { ok: true };
  }

  /** lane L2. A throwing engine must never auto-answer: null = ask a human, the old behaviour. */
  #evaluatePolicy(payload) {
    if (!this.policy) return null;
    try {
      return this.policy.evaluate(payload) ?? null;
    } catch (error) {
      console.warn("[approvals] policy evaluation failed, asking a human:", error.message);
      return null;
    }
  }

  /** lane L2: a decision the policy made on its own — announce it like an answered approval. */
  #answerFromPolicy(payload, verdict) {
    const id = randomUUID();
    const item = {
      id,
      sessionId: typeof payload.sessionId === "string" ? payload.sessionId : "",
      tool: typeof payload.tool === "string" ? payload.tool : "unknown",
      preview: typeof payload.preview === "string" ? payload.preview.slice(0, 500) : "",
      cwd: typeof payload.cwd === "string" ? payload.cwd : null,
      expiresAt: Date.now(),
      budgetExceeded: this.isOverBudget(),
      policy: policySummary(verdict),
    };
    this.#emit("approval_resolved", item, { state: "resolved", decision: verdict.decision, source: "policy" });
    return {
      id,
      decision: verdict.decision,
      source: "policy",
      ...(verdict.message ? { message: verdict.message } : {}),
    };
  }

  /** @returns {PendingApproval[]} for renderer late-join backfill */
  list() {
    return [...this.pending.values()].map((p) => p.item);
  }

  #settle(id, decision, source) {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    entry.resolve(decision);
    this.#emit("approval_resolved", entry.item, { state: "resolved", decision, source });
  }

  #emit(type, item, extraMeta) {
    try {
      this.broadcast(
        this.makeEvent({
          id: `approval:${item.id}:${extraMeta.state}`,
          type,
          sessionId: item.sessionId,
          agentId: item.sessionId,
          cwd: item.cwd,
          tool: item.tool,
          status: type === "approval_pending" ? "start" : "ok",
          detail:
            type === "approval_pending"
              ? `needs approval: ${item.tool}`
              : `answered: ${extraMeta.decision ?? "none"}`,
          meta: {
            approvalId: item.id,
            preview: item.preview,
            expiresAt: item.expiresAt,
            source: "approve-gateway",
            budgetExceeded: item.budgetExceeded,
            ...(item.policy ? { policy: item.policy } : {}),
            ...extraMeta,
          },
        })
      );
    } catch {
      // broadcast failure must never break the resolve path back to the hook
    }
  }
}

/** lane L2: the part of a policy verdict the office shows ("asked because: force-push"). */
function policySummary(verdict) {
  return {
    project: verdict.project,
    mode: verdict.mode,
    source: verdict.source,
    forced: verdict.forced,
    reasons: verdict.reasons,
  };
}

const ROLE_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const clean = (value, re) => (typeof value === "string" && re.test(value) ? value : undefined);

/** One-line summary of a tool_input for the queue UI. Built daemon-side so
 * the hook stays dumb; input arrives already truncated by the hook. */
export function previewToolInput(tool, toolInput) {
  if (!toolInput || typeof toolInput !== "object") return "";
  if (typeof toolInput.command === "string") return toolInput.command;
  if (typeof toolInput.file_path === "string") return toolInput.file_path;
  try {
    return JSON.stringify(toolInput).slice(0, 200);
  } catch {
    return "";
  }
}

/**
 * HTTP routes, same extension pattern as createChatHttpHandler:
 *   POST /approval-request   (hook long-poll; responds when decided/expired)
 *   POST /approval-response  {id, decision}
 *   GET  /approvals          current pending list (renderer backfill)
 * @param {ApprovalBroker} broker
 */
export function createApprovalHttpHandler(broker) {
  return (req, res, url) => {
    const path = url.pathname;
    if (path !== "/approval-request" && path !== "/approval-response" && path !== "/approvals") {
      return false;
    }

    const respond = (statusCode, payload) => {
      res.writeHead(statusCode, { ...CORS_HEADERS, "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return true;
    }

    if (req.method === "GET" && path === "/approvals") {
      respond(200, { items: broker.list() });
      return true;
    }
    if (req.method !== "POST") {
      respond(405, { ok: false, error: "method not allowed" });
      return true;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 65536) req.destroy(); // hook truncates; anything bigger is garbage
    });
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }

      if (path === "/approval-request") {
        if (!parsed || typeof parsed !== "object") {
          respond(400, { id: null, decision: "none", error: "invalid JSON body" });
          return;
        }
        const payload = {
          sessionId: parsed.sessionId,
          tool: parsed.tool,
          cwd: parsed.cwd,
          preview: previewToolInput(parsed.tool, parsed.toolInput),
          // lane L2: what the policy engine needs. Names are charset-checked — they end up in a log and a UI.
          toolInput: parsed.toolInput && typeof parsed.toolInput === "object" ? parsed.toolInput : {},
          harness: clean(parsed.harness, NAME_RE),
          lane: clean(parsed.lane, NAME_RE),
          role: clean(parsed.role, ROLE_RE),
        };
        broker.request(payload).then((result) => respond(200, result));
        return;
      }

      // /approval-response
      const id = typeof parsed?.id === "string" ? parsed.id : "";
      const decision = typeof parsed?.decision === "string" ? parsed.decision : "";
      const result = broker.respond(id, decision);
      respond(result.ok ? 200 : 400, result);
    });
    return true;
  };
}
