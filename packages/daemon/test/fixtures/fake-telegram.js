// A stand-in for api.telegram.org on a local port: tests never touch the real API and never
// send a real message. Implements just the two methods the bot uses.
//   getUpdates  — long poll: returns queued updates >= offset, else holds `holdMs` and returns []
//   sendMessage — recorded in `sent`
// `push(update)` queues an inbound update; `failNext(n, body)` makes the next n sendMessage
// calls return an error body (e.g. a 429 with retry_after).

import { createServer } from "node:http";

export async function startFakeTelegram({ token = "123456:FAKE-TOKEN", holdMs = 40 } = {}) {
  let nextId = 1;
  const queue = [];
  const sent = [];
  const answered = []; // answerCallbackQuery ids
  const polls = [];
  let failures = [];
  let drop = false; // simulate the network dying mid-poll
  const waiting = new Set(); // held long polls, released as soon as an update arrives (like the real API)

  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url.split("?")[0]);
      const json = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (!m || m[1] !== token) return json(401, { ok: false, error_code: 401, description: "Unauthorized" });
      let body = {};
      try { body = raw ? JSON.parse(raw) : {}; } catch { /* leave empty */ }
      if (m[2] === "getUpdates") {
        polls.push(body);
        if (drop) return req.socket.destroy();
        const offset = Number(body.offset ?? 0);
        const reply = () => json(200, { ok: true, result: queue.filter((u) => u.update_id >= offset) });
        if (queue.some((u) => u.update_id >= offset)) return reply();
        const release = () => {
          clearTimeout(timer);
          waiting.delete(release);
          reply();
        };
        const timer = setTimeout(release, holdMs);
        waiting.add(release);
        // the RESPONSE closing = client gone (req "close" fires as soon as the body is read)
        res.on("close", () => { clearTimeout(timer); waiting.delete(release); });
        return undefined;
      }
      if (m[2] === "sendMessage") {
        if (failures.length > 0) {
          const f = failures.shift();
          return json(f.status ?? 429, f.body);
        }
        sent.push({ chat_id: String(body.chat_id), text: body.text, ...(body.reply_markup ? { reply_markup: body.reply_markup } : {}) });
        return json(200, { ok: true, result: { message_id: sent.length } });
      }
      if (m[2] === "answerCallbackQuery") {
        answered.push(String(body.callback_query_id));
        return json(200, { ok: true, result: true });
      }
      return json(404, { ok: false, description: "Not Found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();

  return {
    token,
    apiBase: `http://127.0.0.1:${port}`,
    sent,
    polls,
    answered,
    /** queue a tap on one of the bot's inline buttons, as Telegram delivers it */
    tap({ chatId, userId, name = "Tester", data, group = false }) {
      const update = {
        update_id: nextId++,
        callback_query: {
          id: `cq-${nextId}`,
          from: { id: Number(userId), first_name: name, is_bot: false },
          message: { message_id: nextId, chat: { id: Number(chatId), type: group ? "supergroup" : "private" } },
          data,
        },
      };
      queue.push(update);
      for (const release of [...waiting]) release();
      return update;
    },
    /** queue an inbound text message as Telegram would deliver it */
    say({ chatId, userId, name = "Tester", text, group = false, isBot = false }) {
      const update = {
        update_id: nextId++,
        message: {
          message_id: nextId,
          chat: { id: Number(chatId), type: group ? "supergroup" : "private" },
          from: { id: Number(userId), first_name: name, is_bot: isBot },
          text,
        },
      };
      queue.push(update);
      for (const release of [...waiting]) release();
      return update;
    },
    failNext(n, body, status = 429) { failures = Array.from({ length: n }, () => ({ status, body })); },
    dropConnections(on) { drop = on; },
    async waitFor(predicate, ms = 2000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (predicate()) return true;
        await new Promise((r) => setTimeout(r, 10));
      }
      return false;
    },
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }),
  };
}
