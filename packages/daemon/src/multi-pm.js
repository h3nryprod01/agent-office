// lane L5: assembly. One call builds the whole multi-project side of the daemon — PM hub,
// members + pairing, the chat channels (Telegram polling, Zalo webhook), the router that
// decides who may do what, the end-of-day digest — and the HTTP API the office UI uses.
// index.js only has to mount `http`, call `start()` / `stop()` and `attach(server)`.
//
// Roles over HTTP come from `roleOf(req)` (the platform lane's access control). Until that
// lands the default is "owner": the daemon binds loopback and the origin guard already
// refuses remote pages, which is the trust model the office had before roles existed.

import path from "node:path";

import { agentOfficeHome, hasVerifiedToken } from "./access.js";
import { ChannelRouter } from "./channel-router.js";
import { DigestService } from "./digest.js";
import { JsonState } from "./json-state.js";
import { PmHub } from "./pm-hub.js";
import { createTelegramChannel } from "./telegram-channel.js";
import { createZaloChannel } from "./zalo-channel.js";
import {
  CHANNELS,
  PairingStore,
  ROLES,
  boundChat,
  canApprove,
  canChat,
  canManageMembers,
  listMembers,
  projectSlugs,
  removeMember,
} from "./members.js";
import { DEFAULT_PROJECTS_DIR, listProjects, readItems, readProject } from "./projects.js";

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const STATUS_BY_CODE = { INVALID: 400, EXISTS: 409, NOT_FOUND: 404 };
const ROUTES = new Set(["/pms", "/pm/send", "/pm/read", "/pm/stop", "/overview", "/members", "/members/remove", "/pairing", "/channels"]);

/** Loopback, any IP literal, or a name listed in AGENT_OFFICE_ALLOWED_HOSTS (comma separated). */
export function hostAllowed(hostHeader, allowList = "") {
  if (!hostHeader) return false;
  let hostname;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname === "localhost" || hostname.endsWith(".localhost")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.startsWith("[")) return true; // IPv4 / IPv6 literal
  return String(allowList).split(",").map((h) => h.trim().toLowerCase()).filter(Boolean).includes(hostname);
}

/**
 * @param {Object} deps
 * @param {import("./chat-session.js").ChatSessionManager} [deps.chatManager] the legacy default-repo PM (plain text from the operator chat)
 * @param {import("./approvals.js").ApprovalBroker} deps.approvalBroker
 * @param {(event: object) => void} deps.broadcast
 * @param {(event: object) => void} [deps.broadcastLive]
 * @param {(req: import("node:http").IncomingMessage) => string} [deps.roleOf]
 */
export function createMultiPm({
  projectsDir = DEFAULT_PROJECTS_DIR,
  stateDir = agentOfficeHome(),
  env = process.env,
  chatManager = null,
  approvalBroker,
  broadcast,
  broadcastLive = broadcast,
  roleOf = () => "owner",
  spawnFn,
  claudeBin,
  fetchFn = fetch,
  telegramApiBase,
  telegramOffsetFile,
  metricsUrl = () => null,
  now = Date.now,
  log = console,
}) {
  const hub = new PmHub({ projectsDir, broadcast, broadcastLive, spawnFn, claudeBin, now });
  const pairing = new PairingStore({ projectsDir, now });
  const telegram = createTelegramChannel({
    env,
    log,
    ...(telegramApiBase ? { apiBase: telegramApiBase } : {}),
    ...(telegramOffsetFile ? { offsetFile: telegramOffsetFile } : {}),
  });
  const zalo = createZaloChannel({ env, fetchFn, log });
  const channels = { telegram, zalo };

  // The operator's own chat from the environment keeps working exactly as before the
  // project/member model existed: trusted as owner, plain text goes to the default PM.
  const legacy = [
    ...(env.TELEGRAM_CHAT_ID ? [{ channel: "telegram", chatId: env.TELEGRAM_CHAT_ID }] : []),
    ...(env.ZALO_ALLOWED_USER ? [{ channel: "zalo", chatId: env.ZALO_ALLOWED_USER }] : []),
  ];

  // Collect the default PM's streamed reply for a legacy plain-text message. One wrap for the
  // life of the hub (the old bridge re-wrapped per turn); the manager runs one turn at a time.
  let legacyWaiting = null;
  const originalChatBroadcast = chatManager?.broadcast;
  if (chatManager) {
    chatManager.broadcast = (event) => {
      originalChatBroadcast(event);
      if (!legacyWaiting || event?.type !== "chat_message" || event.meta?.role === "user") return;
      if (event.meta?.text) legacyWaiting.text += (legacyWaiting.text ? "\n" : "") + event.meta.text;
      if (event.meta?.done) {
        const { text, reply } = legacyWaiting;
        legacyWaiting = null;
        reply(text || "(the PM said nothing)");
      }
    };
  }
  const legacyAsk = (text, reply) => {
    if (!chatManager) return reply("No default PM is available on this machine.");
    let result;
    try {
      result = chatManager.send(text);
    } catch (err) {
      return reply(`PM error: ${err.message}`);
    }
    if (!result.accepted) return reply(result.message ?? "The PM is busy — try again shortly.");
    legacyWaiting = { text: "", reply };
  };

  // ONE state object for the file: two instances would each rewrite the whole thing and drop
  // the other's keys (/use choices vs. which digests already went out).
  const state = new JsonState(path.join(stateDir, "channels-state.json"));

  const send = async (channel, chatId, text) => {
    await channels[channel]?.send(chatId, text);
  };
  const router = new ChannelRouter({
    projectsDir,
    hub,
    broker: approvalBroker,
    pairing,
    send,
    legacy,
    legacyAsk,
    state,
    now,
  });

  const digest = new DigestService({
    listSlugs: () => projectSlugs(projectsDir),
    loadProject: (slug) => readProject({ projectsDir, slug }),
    loadItems: (slug) => readItems({ projectsDir, slug }),
    pmOf: (slug) => hub.list().find((p) => p.slug === slug) ?? null,
    approvalsOf: (slug) => router.approvalsOf(slug).length,
    fetchMetrics: async (slug) => {
      const url = metricsUrl(slug);
      if (!url) return null;
      const res = await fetchFn(url, { signal: AbortSignal.timeout(2000) });
      return res.ok ? res.json() : null;
    },
    sendToProject: (slug, text) => router.sendToProjectChats(slug, text),
    state,
    now,
    timeOfDay: env.AO_DIGEST_TIME,
  });

  // ── HTTP ───────────────────────────────────────────────────────────────────────────
  const countBy = (items) => {
    const out = { idea: 0, doing: 0, review: 0, done: 0, dropped: 0 };
    for (const i of items) if (i.status in out) out[i.status] += 1;
    return out;
  };

  function overview() {
    const pms = new Map(hub.list().map((p) => [p.slug, p]));
    return listProjects({ projectsDir }).map((p) => {
      const project = readProject({ projectsDir, slug: p.slug });
      const pm = pms.get(p.slug);
      return {
        slug: p.slug,
        name: p.name,
        template: p.template,
        pm: pm ? { state: pm.state, queued: pm.queued, unread: pm.unread, lastAt: pm.lastAt, lastText: pm.lastText, lastError: pm.lastError } : null,
        items: countBy(readItems({ projectsDir, slug: p.slug })),
        pendingApprovals: router.approvalsOf(p.slug).length,
        members: listMembers({ projectsDir, slug: p.slug }).map((m) => ({
          id: m.id,
          name: m.name,
          role: m.role,
          channels: CHANNELS.filter((c) => m[c]?.userId),
        })),
        rooms: CHANNELS.filter((c) => boundChat(project, c)),
      };
    });
  }

  function http(req, res, url) {
    if (zalo.http(req, res, url)) return true; // the webhook route has its own ack rules
    if (!ROUTES.has(url.pathname)) return false;
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return true;
    }
    const respond = (status, payload) => {
      res.writeHead(status, { ...CORS_HEADERS, "content-type": "application/json" });
      res.end(JSON.stringify(payload));
      return true; // "handled", so a route can `return respond(...)`
    };
    const role = roleOf(req);
    // Every route here either spends tokens (/pm/send), changes who may do what (/pairing,
    // /members/remove) or returns project data: none may be reachable by a DNS-rebinding page
    // (it passes the origin guard — same "origin" as the Host it asked for). Rebinding needs a
    // hostname, so a request must arrive on loopback, an IP literal, or an allow-listed name.
    // A caller that showed a valid access token (L1) is who it says, whatever name it used to reach us
    // (Tailscale MagicDNS, office.local, an HTTPS proxy): the Host check is only for token-less callers.
    if (req.method !== "OPTIONS" && !hasVerifiedToken(req) && !hostAllowed(req.headers?.host, env.AGENT_OFFICE_ALLOWED_HOSTS)) {
      res.writeHead(403, { ...CORS_HEADERS, "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "this request arrived on an unexpected host name" }));
      return true;
    }
    const guard = (fn) => {
      try {
        fn();
      } catch (err) {
        const status = STATUS_BY_CODE[err.code];
        if (status) return respond(status, { ok: false, error: err.message });
        log.error("[multi-pm] error:", err?.message);
        respond(500, { ok: false, error: "server error" });
      }
    };
    const withBody = (fn) => {
      let raw = "";
      req.on("data", (c) => {
        raw += c;
        if (raw.length > 65_536) req.destroy();
      });
      req.on("end", () => {
        let parsed = null;
        try {
          parsed = JSON.parse(raw);
        } catch {
          // fall through with {}
        }
        guard(() => fn(parsed && typeof parsed === "object" ? parsed : {}));
      });
    };
    const forbid = (what) => respond(403, { ok: false, error: `your role (${role}) cannot ${what}` });
    const str = (v) => (typeof v === "string" ? v : "");

    switch (url.pathname) {
      case "/pms":
        if (req.method !== "GET") return respond(405, { ok: false, error: "method not allowed" });
        respond(200, { pms: hub.list() });
        return true;
      case "/overview":
        if (req.method !== "GET") return respond(405, { ok: false, error: "method not allowed" });
        guard(() => respond(200, { projects: overview() }));
        return true;
      case "/channels":
        if (req.method !== "GET") return respond(405, { ok: false, error: "method not allowed" });
        respond(200, { channels: { telegram: { enabled: telegram.enabled }, zalo: { enabled: zalo.enabled } } });
        return true;
      case "/members":
        if (req.method !== "GET") return respond(405, { ok: false, error: "method not allowed" });
        guard(() => respond(200, { members: listMembers({ projectsDir, slug: url.searchParams.get("project") ?? "" }).map((m) => ({ id: m.id, name: m.name, role: m.role })) }));
        return true;
      default:
    }

    if (req.method !== "POST" && !(url.pathname === "/pairing" && req.method === "GET")) {
      respond(405, { ok: false, error: "method not allowed" });
      return true;
    }
    switch (url.pathname) {
      case "/pm/send":
        if (!canChat(role)) return forbid("talk to a PM");
        withBody((b) => {
          const text = str(b.text).trim();
          if (!text) return respond(400, { ok: false, error: "text is required and must be a non-empty string" });
          const r = hub.ask(str(b.project), text, { speaker: str(b.speaker) || undefined });
          if (r.accepted) return respond(202, { ok: true, ...(r.queued ? { queued: r.queued } : {}) });
          respond(r.reason === "unknown_project" ? 404 : 429, { ok: false, error: r.message ?? r.reason });
        });
        return true;
      case "/pm/read":
        withBody((b) => {
          hub.markRead(str(b.project));
          respond(200, { ok: true });
        });
        return true;
      case "/pm/stop":
        if (!canChat(role)) return forbid("stop a PM");
        withBody((b) => respond(200, { ok: true, ...hub.stop(str(b.project)) }));
        return true;
      case "/members/remove":
        if (!canManageMembers(role)) return forbid("remove members");
        withBody((b) => {
          removeMember({ projectsDir, slug: str(b.project), id: str(b.id) });
          respond(200, { ok: true });
        });
        return true;
      case "/pairing":
        if (!canManageMembers(role)) return forbid("manage pairing codes");
        if (req.method === "GET") {
          guard(() => respond(200, { codes: pairing.pending(url.searchParams.get("project") ?? undefined) }));
          return true;
        }
        withBody((b) => {
          const roleWanted = str(b.role);
          if (!ROLES.includes(roleWanted)) return respond(400, { ok: false, error: `role must be one of ${ROLES.join("|")}` });
          const made = pairing.create({ slug: str(b.project), role: roleWanted, createdBy: "ui" });
          respond(201, { ok: true, ...made, instructions: `Send "/pair ${made.code}" to the bot within 15 minutes. The code works once.` });
        });
        return true;
      default:
        return false;
    }
  }

  /**
   * Is a human reachable through a chat channel who could answer an approval? The approval
   * broker answers "none" at once when nobody is watching (so the terminal user is not left
   * waiting) — a phone-only owner counts as watching.
   */
  function hasApprovers() {
    if (!telegram.enabled && !zalo.enabled) return false;
    if (legacy.some((l) => !l.chatId.startsWith("-"))) return true; // an operator GROUP cannot answer
    return projectSlugs(projectsDir).some((slug) => {
      try {
        const project = readProject({ projectsDir, slug });
        if (CHANNELS.some((c) => boundChat(project, c))) return true;
        return listMembers({ projectsDir, slug }).some((m) => canApprove(m.role) && CHANNELS.some((c) => m[c]?.userId));
      } catch {
        return false;
      }
    });
  }

  // ── lifecycle ──────────────────────────────────────────────────────────────────────
  const onInbound = (msg) => router.handle(msg);
  let started = false;

  return {
    hub,
    pairing,
    router,
    digest,
    channels,
    hasApprovers,
    http,
    /** Wrap server.broadcast the way notifier.js does, to push approvals to people's chats. */
    attach(server) {
      const original = server.broadcast.bind(server);
      server.broadcast = (event) => {
        original(event);
        if (event?.type !== "approval_pending") return;
        void router
          .notifyApproval({
            id: event.meta.approvalId,
            tool: event.tool ?? "tool",
            preview: event.meta.preview,
            cwd: event.cwd,
            expiresAt: event.meta.expiresAt,
          })
          .catch(() => {});
      };
    },
    start() {
      if (started) return;
      started = true;
      telegram.start(onInbound);
      zalo.start(onInbound);
      if (env.AO_DIGEST !== "0") digest.start();
    },
    stop() {
      started = false;
      telegram.stop();
      zalo.stop();
      digest.stop();
      hub.dispose();
      if (chatManager) chatManager.broadcast = originalChatBroadcast;
    },
  };
}
