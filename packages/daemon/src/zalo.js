// Zalo OA bridge (PLACEHOLDER — dormant until the customer configures a Zalo
// Official Account). Inbound PM chat over a Zalo OA webhook + outbound replies
// via the Zalo OA Message API. Node global fetch only, no SDK. Sibling of
// telegram.js; same env-gated, secret-safe, trust-boundary posture.
//
// Config: env ZALO_OA_TOKEN + ZALO_ALLOWED_USER. Either missing → every entry
// point is a silent no-op (default OFF, same as telegram.js).
//
// Security: ZALO_OA_TOKEN is a secret — env only, never logged/thrown. A Zalo
// OA webhook is a PUBLIC endpoint, so we only ever act on messages whose sender
// id equals ZALO_ALLOWED_USER (isAllowed); every other sender is dropped with
// no reply.
//
// Why this ships as a placeholder — two things only the customer can do:
//   1. Create a Zalo OA and obtain an access token. Zalo OA tokens EXPIRE
//      (~1 day) and must be refreshed via Zalo's OAuth refresh-token flow with
//      the app secret. This module reads a *current* token from env; wiring the
//      periodic refresh is left to the customer's deployment (documented in the
//      installer env template).
//   2. Expose POST /zalo/webhook publicly over HTTPS so Zalo can reach it.
//
// NOTE: the live Zalo API shapes below follow Zalo's v3.0 OA docs but are NOT
// verified against a real OA in this repo (no account) — the pure logic
// (isAllowed/parseMessage) is unit-tested; the HTTP calls are structural.

const ZALO_SEND_API = "https://openapi.zalo.me/v3.0/oa/message/cs";

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{token: string, allowedUserId: string} | null} null = Zalo disabled
 */
function readConfig(env) {
  const token = env.ZALO_OA_TOKEN;
  const allowedUserId = env.ZALO_ALLOWED_USER;
  if (!token || !allowedUserId) return null;
  return { token, allowedUserId };
}

/**
 * Trust boundary: true iff the webhook event is from the one allowed Zalo user
 * id. Missing/malformed/other-sender → false. Pure.
 * @param {any} event raw Zalo OA webhook event
 * @param {string|number} allowedUserId
 * @returns {boolean}
 */
export function isAllowed(event, allowedUserId) {
  const senderId = event?.sender?.id;
  return senderId != null && String(senderId) === String(allowedUserId);
}

/**
 * Pull {senderId, text} out of a Zalo OA `user_send_text` webhook event, or
 * null when it isn't a usable text message. Pure.
 * @param {any} event
 * @returns {{senderId: string, text: string} | null}
 */
export function parseMessage(event) {
  if (event?.event_name !== "user_send_text") return null;
  const senderId = event?.sender?.id;
  const text = event?.message?.text;
  if (senderId == null || typeof text !== "string" || !text) return null;
  return { senderId: String(senderId), text };
}

/**
 * Send one text back to a Zalo user via the OA Message API. No-op without
 * config. Secondary channel — network/API errors swallowed, never thrown, so a
 * broken Zalo can never take down the daemon.
 * @param {string} userId
 * @param {string} text
 * @param {Object} [opts]
 * @param {typeof fetch} [opts.fetchFn] injectable for tests — no real network call
 * @param {NodeJS.ProcessEnv} [opts.env]
 */
export async function sendMessage(userId, text, { fetchFn = fetch, env = process.env } = {}) {
  const cfg = readConfig(env);
  if (!cfg) return;
  try {
    await fetchFn(ZALO_SEND_API, {
      method: "POST",
      headers: { "content-type": "application/json", access_token: cfg.token },
      body: JSON.stringify({ recipient: { user_id: userId }, message: { text } }),
    });
  } catch {
    // best-effort — never surfaced, never logged (would risk the token).
  }
}

/**
 * One PM turn: send `text`, collect the streamed assistant reply, restore the
 * broadcast wrap when the turn is done. Mirrors telegram.js's inline bridge —
 * ChatSessionManager runs exactly one turn globally (its `busy` gate), so a
 * second concurrent call is rejected (not accepted) and never nests the wrap.
 * @param {import("./chat-session.js").ChatSessionManager} manager
 * @param {string} text
 * @returns {Promise<string>}
 */
function askPm(manager, text) {
  return new Promise((resolve) => {
    let result;
    try {
      result = manager.send(text);
    } catch (error) {
      resolve(`PM lỗi: ${error.message}`);
      return;
    }
    if (!result.accepted) {
      resolve(result.message ?? "PM đang bận, thử lại sau.");
      return;
    }
    let reply = "";
    const original = manager.broadcast;
    manager.broadcast = (event) => {
      original(event);
      if (event?.type !== "chat_message" || event.meta?.role === "user") return;
      if (event.meta?.text) reply += (reply ? "\n" : "") + event.meta.text;
      if (event.meta?.done) {
        manager.broadcast = original;
        resolve(reply || "(PM không trả lời gì)");
      }
    };
  });
}

/**
 * HTTP handler for POST /zalo/webhook. Always acks 200 FIRST (Zalo retries on
 * non-200 or a slow response, and the PM turn is far slower than a webhook
 * timeout), then — only when configured and only for the allowed user —
 * bridges the message to the PM and sends the reply back out of band.
 * @param {import("./chat-session.js").ChatSessionManager} manager
 * @param {Object} [opts]
 * @param {typeof fetch} [opts.fetchFn]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL) => boolean}
 */
export function createZaloHttpHandler(manager, { fetchFn = fetch, env = process.env } = {}) {
  const cfg = readConfig(env);
  return (req, res, url) => {
    if (req.method !== "POST" || url.pathname !== "/zalo/webhook") return false;
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      if (!cfg) return; // disabled → acked and ignored
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        return;
      }
      if (!isAllowed(event, cfg.allowedUserId)) return; // stranger — no reply
      const msg = parseMessage(event);
      if (!msg) return;
      askPm(manager, msg.text).then((reply) => sendMessage(msg.senderId, reply, { fetchFn, env }));
    });
    return true;
  };
}
