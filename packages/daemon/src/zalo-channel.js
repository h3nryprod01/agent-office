// lane L5: Zalo OA as a channel — same shape as telegram-channel.js, but the transport is a
// webhook, not polling: Zalo POSTs events to /zalo/webhook, which has to be reachable from
// the internet. It stays asleep until ZALO_OA_TOKEN + ZALO_APP_ID + ZALO_OA_SECRET are all
// set; with any of them missing the route still answers 200 (Zalo retries on anything else)
// and ignores the event.
//
// Why the secret is mandatory here and the Telegram bot needs nothing of the kind: a webhook
// is a public URL, so anyone can POST an event claiming to be a member's sender id. Telegram
// hands us updates over a connection WE opened to Telegram; here the only authenticity proof is
// the X-ZEvent-Signature header. A request without a valid one is dropped.
//
// NOT verified against a live OA (no account in this repo): the signature recipe and the
// payload/send shapes follow Zalo's v3.0 docs as zalo.js already assumed. OA access tokens
// expire (~1 day); refreshing them is the deployment's job (see zalo.js).

import { createHash, timingSafeEqual } from "node:crypto";

import { parseMessage, sendWithToken } from "./zalo.js";

export const ZALO_WEBHOOK_PATH = "/zalo/webhook";
const BODY_LIMIT = 65_536;
const MAX_EVENT_AGE_MS = 5 * 60_000; // a signed event older than this is a replay

/** sha256(appId + rawBody + timestamp + OA secret), hex — Zalo's X-ZEvent-Signature recipe. */
export function zaloSignature({ appId, raw, timestamp, secret }) {
  return createHash("sha256").update(`${appId}${raw}${timestamp}${secret}`).digest("hex");
}

function sameHex(a, b) {
  const x = Buffer.from(String(a), "utf8");
  const y = Buffer.from(String(b), "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * @param {Object} [opts]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {typeof fetch} [opts.fetchFn]
 * @param {{warn: Function}} [opts.log]
 */
export function createZaloChannel({ env = process.env, fetchFn = fetch, log = console } = {}) {
  const token = env.ZALO_OA_TOKEN || null;
  const appId = env.ZALO_APP_ID || null;
  const secret = env.ZALO_OA_SECRET || null;
  const enabled = Boolean(token && appId && secret);
  if (token && !enabled) {
    // an existing token-only setup would otherwise just go quiet
    log.warn("[zalo] ZALO_OA_TOKEN is set but ZALO_APP_ID / ZALO_OA_SECRET are not: the webhook stays off (signed events are required)");
  }
  let handler = null;

  function accept(raw, signatureHeader) {
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      return;
    }
    const mac = /^mac=(.+)$/.exec(String(signatureHeader ?? ""))?.[1];
    const expected = zaloSignature({ appId, raw, timestamp: event?.timestamp ?? "", secret });
    if (!mac || !sameHex(mac, expected)) return; // forged or unsigned: drop silently
    const sentAt = Number(event?.timestamp);
    if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > MAX_EVENT_AGE_MS) return; // stale or undated: replay
    const parsed = parseMessage(event);
    if (!parsed || !handler) return;
    Promise.resolve(
      handler({ channel: "zalo", chatId: parsed.senderId, userId: parsed.senderId, name: "", text: parsed.text, isGroup: false }),
    ).catch((err) => log.warn(`[zalo] handler failed (${err?.message ?? err})`));
  }

  /** extraHttp route: always ack 200 first, then process out of band. */
  function http(req, res, url) {
    if (req.method !== "POST" || url.pathname !== ZALO_WEBHOOK_PATH) return false;
    let raw = "";
    req.setEncoding?.("utf8"); // a multi-byte character split across chunks must not corrupt the signed body
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > BODY_LIMIT) req.destroy?.();
    });
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
      if (enabled) accept(raw, req.headers?.["x-zevent-signature"]);
    });
    return true;
  }

  return {
    id: "zalo",
    enabled,
    http,
    start(h) {
      handler = h;
    },
    stop() {
      handler = null;
    },
    async send(userId, text) {
      if (!enabled) return;
      await sendWithToken(token, String(userId), text, { fetchFn });
    },
  };
}
