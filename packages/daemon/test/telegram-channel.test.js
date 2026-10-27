import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createTelegramChannel, redact, splitMessage } from "../src/telegram-channel.js";
import { startFakeTelegram } from "./fixtures/fake-telegram.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ao-l5-tg-"));

function quietLog() {
  const lines = [];
  return { lines, warn: (m) => lines.push(String(m)), error: (m) => lines.push(String(m)), log: (m) => lines.push(String(m)) };
}

async function boot({ handler, env, ...rest } = {}) {
  const fake = await startFakeTelegram();
  const log = quietLog();
  const dir = tmp();
  const handled = [];
  const channel = createTelegramChannel({
    env: env ?? { TELEGRAM_BOT_TOKEN: fake.token },
    apiBase: fake.apiBase,
    offsetFile: path.join(dir, "offset.json"),
    log,
    sleepFn: () => new Promise((r) => setTimeout(r, 5)),
    pollTimeoutSec: 1,
    ...rest,
  });
  channel.start(handler ?? (async (msg) => { handled.push(msg); }));
  return { fake, channel, log, dir, handled, stop: async () => { channel.stop(); await fake.close(); } };
}

test("no token → disabled: start() polls nothing, send() is a no-op", async () => {
  const fake = await startFakeTelegram();
  const channel = createTelegramChannel({ env: {}, apiBase: fake.apiBase, offsetFile: path.join(tmp(), "o.json"), log: quietLog() });
  assert.equal(channel.enabled, false);
  channel.start(async () => {});
  await channel.send("1", "hi");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(fake.polls.length, 0);
  assert.equal(fake.sent.length, 0);
  channel.stop();
  await fake.close();
});

test("long polling (outbound only): inbound updates become router messages with chat, person and group flag", async () => {
  const t = await boot();
  t.fake.say({ chatId: 555, userId: 42, name: "Binh", text: "/status" });
  t.fake.say({ chatId: -100777, userId: 43, name: "An", text: "hello team", group: true });
  assert.ok(await t.fake.waitFor(() => t.handled.length === 2));
  assert.deepEqual(t.handled[0], { channel: "telegram", chatId: "555", userId: "42", name: "Binh", text: "/status", isGroup: false });
  assert.deepEqual(t.handled[1], { channel: "telegram", chatId: "-100777", userId: "43", name: "An", text: "hello team", isGroup: true });
  await t.stop();
});

test("bots and non-text updates never reach the router", async () => {
  const t = await boot();
  t.fake.say({ chatId: 1, userId: 2, text: "from a bot", isBot: true });
  t.fake.say({ chatId: 1, userId: 3, text: "human" });
  assert.ok(await t.fake.waitFor(() => t.handled.length === 1));
  assert.equal(t.handled[0].text, "human");
  await t.stop();
});

test("a reply is posted with sendMessage to the right chat, as plain text", async () => {
  const t = await boot({ handler: async (msg) => { await t.channel.send(msg.chatId, "pong <b>x</b>"); } });
  t.fake.say({ chatId: 555, userId: 42, text: "ping" });
  assert.ok(await t.fake.waitFor(() => t.fake.sent.length === 1));
  assert.deepEqual(t.fake.sent[0], { chat_id: "555", text: "pong <b>x</b>" });
  await t.stop();
});

test("the update offset is persisted: a restart never replays an update it already handled", async () => {
  const t = await boot();
  const dir = t.dir;
  t.fake.say({ chatId: 1, userId: 2, text: "once" });
  assert.ok(await t.fake.waitFor(() => t.handled.length === 1));
  await t.fake.waitFor(() => t.fake.polls.some((p) => p.offset >= 2));
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "offset.json"), "utf8"));
  assert.equal(onDisk.offset, 2);
  t.channel.stop();

  const again = [];
  const channel2 = createTelegramChannel({
    env: { TELEGRAM_BOT_TOKEN: t.fake.token }, apiBase: t.fake.apiBase, offsetFile: path.join(dir, "offset.json"),
    log: quietLog(), pollTimeoutSec: 1,
  });
  channel2.start(async (m) => { again.push(m); });
  await new Promise((r) => setTimeout(r, 120));
  assert.deepEqual(again, []);
  channel2.stop();
  await t.fake.close();
});

test("stop() aborts the in-flight long poll and no further poll starts (Telegram allows one consumer)", async () => {
  const t = await boot();
  await t.fake.waitFor(() => t.fake.polls.length >= 1);
  t.channel.stop();
  const n = t.fake.polls.length;
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(t.fake.polls.length <= n + 1);
  const after = t.fake.polls.length;
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(t.fake.polls.length, after);
  assert.doesNotThrow(() => t.channel.stop()); // idempotent
  await t.fake.close();
});

test("network errors back off and recover; the loop survives", async () => {
  const t = await boot();
  t.fake.dropConnections(true);
  await new Promise((r) => setTimeout(r, 80));
  t.fake.dropConnections(false);
  t.fake.say({ chatId: 1, userId: 2, text: "back again" });
  assert.ok(await t.fake.waitFor(() => t.handled.length === 1));
  await t.stop();
});

test("the bot token never appears in logs — not in errors, not in connection failures, not in a bad-token response", async () => {
  const fake = await startFakeTelegram({ token: "999:SECRET-TOKEN-VALUE" });
  const log = quietLog();
  const channel = createTelegramChannel({
    env: { TELEGRAM_BOT_TOKEN: "999:SECRET-TOKEN-VALUE" },
    apiBase: "http://127.0.0.1:1", // nothing listens: ECONNREFUSED
    offsetFile: path.join(tmp(), "o.json"),
    log,
    sleepFn: () => new Promise((r) => setTimeout(r, 5)),
    pollTimeoutSec: 1,
  });
  channel.start(async () => {});
  await channel.send("1", "x");
  await new Promise((r) => setTimeout(r, 80));
  channel.stop();

  // a wrong token against a live server: Unauthorized, description comes back, token still hidden
  const log2 = quietLog();
  const bad = createTelegramChannel({
    env: { TELEGRAM_BOT_TOKEN: "111:OTHER-SECRET" }, apiBase: fake.apiBase,
    offsetFile: path.join(tmp(), "o2.json"), log: log2, sleepFn: () => new Promise((r) => setTimeout(r, 5)), pollTimeoutSec: 1,
  });
  bad.start(async () => {});
  await bad.send("1", "x");
  await new Promise((r) => setTimeout(r, 80));
  bad.stop();
  await fake.close();

  const all = [...log.lines, ...log2.lines].join("\n");
  assert.ok(log.lines.length + log2.lines.length > 0, "failures should be logged somehow");
  assert.doesNotMatch(all, /SECRET-TOKEN-VALUE|OTHER-SECRET/);
  assert.doesNotMatch(all, /\/bot\d+:/); // no URL with a token either
});

test("redact() scrubs the token wherever it sits in a string", () => {
  assert.equal(redact("GET https://x/bot12:AB/getUpdates failed", "12:AB"), "GET https://x/bot<token>/getUpdates failed");
  assert.equal(redact("plain", "12:AB"), "plain");
  assert.equal(redact("12:AB and 12:AB", "12:AB"), "<token> and <token>");
});

test("failures are logged once per outage, not once per retry", async () => {
  const log = quietLog();
  const channel = createTelegramChannel({
    env: { TELEGRAM_BOT_TOKEN: "1:T" }, apiBase: "http://127.0.0.1:1", offsetFile: path.join(tmp(), "o.json"),
    log, sleepFn: () => new Promise((r) => setTimeout(r, 2)), pollTimeoutSec: 1,
  });
  channel.start(async () => {});
  await new Promise((r) => setTimeout(r, 150));
  channel.stop();
  assert.ok(log.lines.length <= 2, `expected at most 2 log lines, got ${log.lines.length}`);
});

test("send(): Telegram's 429 retry_after is honoured once, then the message goes through", async () => {
  const sleeps = [];
  const t = await boot({ sleepFn: (ms) => { sleeps.push(ms); return Promise.resolve(); } });
  t.fake.failNext(1, { ok: false, error_code: 429, description: "Too Many Requests", parameters: { retry_after: 2 } });
  await t.channel.send("9", "retry me");
  assert.deepEqual(t.fake.sent, [{ chat_id: "9", text: "retry me" }]);
  assert.ok(sleeps.includes(2000));
  await t.stop();
});

test("send(): a long reply is split into messages under Telegram's 4096-char limit, nothing lost", async () => {
  const t = await boot();
  const long = Array.from({ length: 300 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
  await t.channel.send("9", long);
  assert.ok(t.fake.sent.length >= 3);
  assert.ok(t.fake.sent.every((m) => m.text.length <= 4096));
  assert.equal(t.fake.sent.map((m) => m.text).join("\n"), long);
  await t.stop();
});

test("splitMessage: short text untouched, hard-splits a single huge line", () => {
  assert.deepEqual(splitMessage("hi"), ["hi"]);
  const parts = splitMessage("y".repeat(9000));
  assert.ok(parts.every((p) => p.length <= 4096));
  assert.equal(parts.join(""), "y".repeat(9000));
  assert.deepEqual(splitMessage(""), []);
});

test("send(): a dead API never throws into the caller", async () => {
  const channel = createTelegramChannel({
    env: { TELEGRAM_BOT_TOKEN: "1:T" }, apiBase: "http://127.0.0.1:1", offsetFile: path.join(tmp(), "o.json"), log: quietLog(),
  });
  await assert.doesNotReject(() => channel.send("1", "hi"));
});

test("a group becoming a supergroup is passed on as a migration (old id → new id), not as chat text", async () => {
  const t = await boot();
  const u = t.fake.say({ chatId: -100, userId: 2, text: "service", group: true });
  delete u.message.text;
  u.message.migrate_to_chat_id = -1009999;
  assert.ok(await t.fake.waitFor(() => t.handled.length === 1));
  assert.deepEqual(t.handled[0], { channel: "telegram", type: "migrate", from: "-100", chatId: "-1009999" });
  await t.stop();
});

// one-tap approvals: buttons under the message, a tap arrives as the command it stands for
test("buttons ride on the last part of a message as an inline keyboard", async () => {
  const t = await boot();
  await t.channel.send("555", "Approval needed", { buttons: [{ text: "✓ Allow", data: "/approve 1a2b3c4d" }, { text: "✗ Deny", data: "/deny 1a2b3c4d" }] });
  assert.equal(t.fake.sent.length, 1);
  assert.deepEqual(t.fake.sent[0].reply_markup, {
    inline_keyboard: [[{ text: "✓ Allow", callback_data: "/approve 1a2b3c4d" }, { text: "✗ Deny", callback_data: "/deny 1a2b3c4d" }]],
  });
  await t.channel.send("555", "plain");
  assert.equal(t.fake.sent[1].reply_markup, undefined);
  await t.stop();
});

test("a tap on a button reaches the router as the command it carries, and the spinner is answered", async () => {
  const t = await boot();
  t.fake.tap({ chatId: 555, userId: 42, name: "Binh", data: "/approve 1a2b3c4d" });
  assert.ok(await t.fake.waitFor(() => t.handled.length === 1 && t.fake.answered.length === 1));
  const { callbackId, ...msg } = t.handled[0];
  assert.deepEqual(msg, { channel: "telegram", chatId: "555", userId: "42", name: "Binh", text: "/approve 1a2b3c4d", isGroup: false });
  assert.equal(t.fake.answered[0], callbackId);
  assert.ok(t.fake.polls.some((p) => Array.isArray(p.allowed_updates) && p.allowed_updates.includes("callback_query")));
  await t.stop();
});

test("a tap whose data is not one of our buttons is answered and dropped; a channel counts as a shared room", async () => {
  const t = await boot();
  t.fake.tap({ chatId: 555, userId: 42, data: "/bind other-project" });
  assert.ok(await t.fake.waitFor(() => t.fake.answered.length === 1));
  assert.equal(t.handled.length, 0);
  t.fake.tap({ chatId: -200, userId: 42, data: "/deny 1a2b3c4d", chatType: "channel" });
  assert.ok(await t.fake.waitFor(() => t.handled.length === 1));
  assert.equal(t.handled[0].isGroup, true);
  await t.stop();
});
