// Telegram bridge: outbound "agent stuck" alerts to a phone (called from
// notifier.js) and inbound PM chat over the same bot (pollUpdates below,
// bridging to the existing PM turn loop in chat-session.js). Built on Node's
// global fetch (>=18) only — no grammY/Telegraf/node-fetch dependency.
//
// Config: env TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID. Either missing → every
// exported function that talks to Telegram is a silent no-op (default OFF,
// same posture as AGENT_OFFICE_NOTIFY=0 for the OS notifier).
//
// Security: the bot token is a secret — read from env only, never logged,
// never included in a thrown error or console message. A Telegram bot is a
// PUBLIC endpoint (anyone who finds it can message it), so pollUpdates only
// ever acts on updates from TELEGRAM_CHAT_ID (isAllowed) — every other
// sender is dropped with no reply, so a stranger can't even tell the bot is
// alive, let alone drive the PM on someone's machine.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const API_BASE = "https://api.telegram.org";
const DEFAULT_OFFSET_FILE = path.join(os.homedir(), ".agent-office", "telegram-offset.json");

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {{token: string, chatId: string} | null} null = Telegram disabled
 */
function readConfig(env) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return null;
  return { token, chatId };
}

/**
 * Push one message to the configured chat. No-op when Telegram isn't
 * configured. This is a secondary channel: a network/API failure is
 * swallowed here, never thrown, so it can never break the caller (the OS
 * notification, or the daemon itself).
 * @param {string} text
 * @param {Object} [opts]
 * @param {typeof fetch} [opts.fetchFn] injectable for tests — no real network call
 * @param {NodeJS.ProcessEnv} [opts.env]
 */
export async function sendMessage(text, { fetchFn = fetch, env = process.env } = {}) {
  const cfg = readConfig(env);
  if (!cfg) return;
  try {
    await fetchFn(`${API_BASE}/bot${cfg.token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: cfg.chatId, text }),
    });
  } catch {
    // best-effort — never surfaced, never logged (would risk the token).
  }
}

function readOffset(offsetFile) {
  try {
    const parsed = JSON.parse(fs.readFileSync(offsetFile, "utf8"));
    return typeof parsed?.offset === "number" ? parsed.offset : 0;
  } catch {
    return 0; // missing/corrupt — replay from the beginning of Telegram's buffer
  }
}

function writeOffset(offsetFile, offset) {
  try {
    fs.mkdirSync(path.dirname(offsetFile), { recursive: true });
    fs.writeFileSync(offsetFile, JSON.stringify({ offset }));
  } catch {
    // best-effort persistence — a lost write just replays one batch on restart
  }
}

/**
 * Security boundary: true iff `update`'s message is from the one allowed
 * chat. Anything else — a stranger's chat id, a missing/malformed update —
 * is rejected, and the caller must reply to none of it (see file header).
 * @param {any} update raw Telegram Update object
 * @param {string|number} allowedChatId
 * @returns {boolean}
 */
export function isAllowed(update, allowedChatId) {
  const chatId = update?.message?.chat?.id;
  return chatId != null && String(chatId) === String(allowedChatId);
}

/**
 * Next getUpdates offset: one past the highest update_id in this batch, so a
 * batch already delivered is never redelivered after a daemon restart.
 * Empty batch → unchanged. Never regresses, even if update_ids in the batch
 * are out of order or the batch is a stale/duplicate re-delivery.
 * @param {Array<{update_id: number}>} updates
 * @param {number} current
 * @returns {number}
 */
export function nextOffset(updates, current) {
  if (!Array.isArray(updates) || updates.length === 0) return current;
  const ids = updates.map((u) => u?.update_id).filter((n) => Number.isFinite(n));
  if (ids.length === 0) return current;
  return Math.max(current, Math.max(...ids) + 1);
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Long-poll inbound Telegram messages and bridge them to the PM chat. Reuses
 * `manager.send()` (chat-session.js's ChatSessionManager) verbatim — this
 * never spawns `claude` itself. No-op immediately when Telegram isn't
 * configured.
 *
 * The PM's reply streams out asynchronously as "chat_message" broadcast
 * events (same pipeline the renderer's chatbox reads), so this wraps
 * `manager.broadcast` — the same technique notifier.js's attachNotifier uses
 * on `server.broadcast` — to collect this turn's assistant text and relay it
 * back with sendMessage() once the turn reports done.
 *
 * ponytail: ChatSessionManager only ever allows ONE turn in flight globally
 * (its own `this.busy` gate), so "the next chat_message events after
 * send()" are unambiguously this turn's — no per-session correlation needed.
 * Upgrade path if that global limit is ever lifted: match on the
 * targetSessionId send() returns.
 *
 * @param {import("./chat-session.js").ChatSessionManager} manager
 * @param {Object} [opts]
 * @param {typeof fetch} [opts.fetchFn] injectable for tests — no real network call
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.offsetFile]
 * @param {(ms: number) => Promise<void>} [opts.sleepFn]
 * @returns {{stop(): void}}
 */
export function pollUpdates(
  manager,
  { fetchFn = fetch, env = process.env, offsetFile = DEFAULT_OFFSET_FILE, sleepFn = defaultSleep } = {},
) {
  const cfg = readConfig(env);
  if (!cfg) return { stop() {} };

  let waiting = null; // {resolve, reply} for the in-flight turn's reply text, else null
  const originalBroadcast = manager.broadcast;
  manager.broadcast = (event) => {
    originalBroadcast(event);
    if (!waiting || event?.type !== "chat_message" || event.meta?.role === "user") return;
    if (event.meta?.text) waiting.reply += (waiting.reply ? "\n" : "") + event.meta.text;
    if (event.meta?.done) {
      waiting.resolve(waiting.reply || "(PM không trả lời gì)");
      waiting = null;
    }
  };

  const askPm = (text) =>
    new Promise((resolve) => {
      let result;
      try {
        result = manager.send(text);
      } catch (error) {
        // defensive — chat-session.js already guards its own risky calls, but
        // this loop must never die because the PM turn failed to start.
        resolve(`PM lỗi: ${error.message}`);
        return;
      }
      if (!result.accepted) {
        resolve(result.message ?? "PM đang bận, thử lại sau.");
        return;
      }
      waiting = { resolve, reply: "" };
    });

  let stopped = false;
  let offset = readOffset(offsetFile);
  // Telegram allows exactly one getUpdates long-poll consumer per bot — a
  // stop() that just sets a flag would leave the in-flight 30s request open
  // until it naturally times out, risking two overlapping consumers across a
  // restart. abort() drops that connection immediately.
  const controller = new AbortController();

  (async () => {
    while (!stopped) {
      let updates = [];
      try {
        const res = await fetchFn(
          `${API_BASE}/bot${cfg.token}/getUpdates?offset=${offset}&timeout=30`,
          { signal: controller.signal },
        );
        const body = await res.json();
        updates = Array.isArray(body?.result) ? body.result : [];
      } catch {
        if (stopped) break; // aborted by stop() — exit quietly, no backoff
        await sleepFn(1000); // avoid a hot loop while the network is down
      }
      for (const update of updates) {
        if (stopped) break; // stop() fired mid-batch — don't start a new PM turn
        if (!isAllowed(update, cfg.chatId)) continue; // stranger — no reply, see file header
        const text = update.message?.text;
        if (typeof text !== "string" || !text) continue;
        const reply = await askPm(text);
        await sendMessage(reply, { fetchFn, env });
      }
      offset = nextOffset(updates, offset);
      writeOffset(offsetFile, offset);
    }
  })();

  return {
    stop() {
      stopped = true;
      controller.abort();
      manager.broadcast = originalBroadcast;
    },
  };
}
