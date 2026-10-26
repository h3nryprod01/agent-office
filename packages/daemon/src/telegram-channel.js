// lane L5: Telegram as a channel — transport only. It long-polls getUpdates (outbound
// HTTPS, so an on-prem machine opens no inbound port), turns each text message into the
// router's message shape, and posts replies with sendMessage. WHO may do WHAT is the
// router's business (channel-router.js); this file never decides that.
//
// One bot serves every project: which project a chat belongs to is a binding on the
// project (/bind), not configuration here. Config is the bot token only
// (TELEGRAM_BOT_TOKEN); TELEGRAM_CHAT_ID, if set, is still honoured as the operator's own
// chat (see index wiring) and by telegram.js's one-way alerts.
//
// Secrets: the token sits in every request URL, and Node's fetch errors can quote the URL —
// so every string that reaches a log goes through redact(), and a failure is logged once per
// outage instead of once per retry. Telegram allows one getUpdates consumer per bot, so
// stop() aborts the in-flight request instead of letting it linger.

import path from "node:path";

import { agentOfficeHome } from "./access.js";
import { nextOffset, readOffset, writeOffset } from "./telegram.js";

const DEFAULT_API_BASE = "https://api.telegram.org";
const DEFAULT_OFFSET_FILE = path.join(agentOfficeHome(), "telegram-offset.json"); // honours AGENT_OFFICE_HOME (on-prem service accounts)
const MESSAGE_LIMIT = 4096;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function redact(text, token) {
  const s = String(text);
  return token ? s.split(token).join("<token>") : s;
}

/** Split on line boundaries into pieces Telegram accepts; a single huge line is cut hard. */
export function splitMessage(text, limit = MESSAGE_LIMIT) {
  if (!text) return [];
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    const cut = rest.lastIndexOf("\n", limit);
    if (cut > 0) {
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut + 1);
    } else {
      parts.push(rest.slice(0, limit));
      rest = rest.slice(limit);
    }
  }
  parts.push(rest);
  return parts;
}

/**
 * @param {Object} opts
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.apiBase]   tests point this at a local fake server
 * @param {typeof fetch} [opts.fetchFn]
 * @param {string} [opts.offsetFile]
 * @param {(ms: number) => Promise<void>} [opts.sleepFn]
 * @param {{warn: Function}} [opts.log]
 * @param {number} [opts.pollTimeoutSec]
 */
export function createTelegramChannel({
  env = process.env,
  apiBase = env.TELEGRAM_API_BASE || DEFAULT_API_BASE,
  fetchFn = fetch,
  offsetFile = DEFAULT_OFFSET_FILE,
  sleepFn = defaultSleep,
  log = console,
  pollTimeoutSec = 30,
} = {}) {
  const token = env.TELEGRAM_BOT_TOKEN || null;
  const enabled = Boolean(token);
  const controller = new AbortController();
  let stopped = false;
  let pollFailing = false;
  let sendFailing = false;

  const warn = (message) => log.warn(`[telegram] ${redact(message, token)}`);
  const describe = (err) => `${err?.name ?? "Error"}: ${err?.message ?? err}`;

  async function call(method, payload, signal) {
    const res = await fetchFn(`${apiBase}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      ...(signal ? { signal } : {}),
    });
    let body = null;
    try {
      body = await res.json();
    } catch {
      // non-JSON error page
    }
    if (!res.ok || body?.ok === false) {
      const err = new Error(body?.description ?? `HTTP ${res.status}`);
      err.retryAfter = body?.parameters?.retry_after;
      throw err;
    }
    return body;
  }

  async function sendOne(chatId, text) {
    try {
      await call("sendMessage", { chat_id: chatId, text });
    } catch (err) {
      if (err.retryAfter && !stopped) {
        await sleepFn(Math.min(err.retryAfter, 30) * 1000);
        await call("sendMessage", { chat_id: chatId, text });
        return;
      }
      throw err;
    }
  }

  async function send(chatId, text) {
    if (!enabled) return;
    try {
      for (const part of splitMessage(String(text))) await sendOne(chatId, part);
      sendFailing = false;
    } catch (err) {
      // secondary path: a failed reply must never break the caller; say so once per outage
      if (!sendFailing) warn(`could not send a message (${describe(err)})`);
      sendFailing = true;
    }
  }

  function toMessage(update) {
    const m = update?.message;
    // a group became a supergroup: same room, new chat id
    if (m?.migrate_to_chat_id != null && m.chat?.id != null) {
      return { channel: "telegram", type: "migrate", from: String(m.chat.id), chatId: String(m.migrate_to_chat_id) };
    }
    if (!m || typeof m.text !== "string" || !m.text || m.from?.is_bot) return null;
    if (m.chat?.id == null || m.from?.id == null) return null;
    return {
      channel: "telegram",
      chatId: String(m.chat.id),
      userId: String(m.from.id),
      name: m.from.first_name || m.from.username || "",
      text: m.text,
      isGroup: m.chat.type === "group" || m.chat.type === "supergroup",
    };
  }

  /** @param {(msg: object) => Promise<void>|void} handler router.handle */
  function start(handler) {
    if (!enabled) return;
    let offset = readOffset(offsetFile);
    let failures = 0;
    (async () => {
      while (!stopped) {
        let updates = [];
        try {
          const body = await call(
            "getUpdates",
            { offset, timeout: pollTimeoutSec, allowed_updates: ["message"] },
            controller.signal,
          );
          updates = Array.isArray(body?.result) ? body.result : [];
          failures = 0;
          pollFailing = false;
        } catch (err) {
          if (stopped) break; // aborted by stop() — exit quietly
          if (!pollFailing) warn(`polling failed, will keep retrying (${describe(err)})`);
          pollFailing = true;
          failures += 1;
          await sleepFn(Math.min(30_000, 1000 * 2 ** (failures - 1)));
          continue;
        }
        for (const update of updates) {
          if (stopped) break;
          const msg = toMessage(update);
          if (!msg) continue;
          try {
            await handler(msg);
          } catch (err) {
            warn(`handler failed (${describe(err)})`);
          }
        }
        offset = nextOffset(updates, offset);
        if (updates.length > 0) writeOffset(offsetFile, offset);
      }
    })();
  }

  function stop() {
    stopped = true;
    controller.abort();
  }

  return { id: "telegram", enabled, start, stop, send };
}
