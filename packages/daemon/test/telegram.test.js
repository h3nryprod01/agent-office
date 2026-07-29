import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { sendMessage, isAllowed, nextOffset, pollUpdates } from "../src/telegram.js";

/** A fresh, throwaway offset file per test — pollUpdates persists to disk. */
function tmpOffsetFile() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "telegram-test-"));
  return { dir, offsetFile: path.join(dir, "offset.json") };
}

test("sendMessage: both env vars set → POSTs to the bot's sendMessage URL with chat_id + text", async () => {
  const calls = [];
  const fetchFn = async (url, opts) => {
    calls.push({ url, opts });
    return { ok: true };
  };
  await sendMessage("agent kẹt >30s", {
    fetchFn,
    env: { TELEGRAM_BOT_TOKEN: "T:abc", TELEGRAM_CHAT_ID: "12345" },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.telegram.org/botT:abc/sendMessage");
  assert.equal(calls[0].opts.method, "POST");
  const body = JSON.parse(calls[0].opts.body);
  assert.equal(body.chat_id, "12345");
  assert.equal(body.text, "agent kẹt >30s");
});

test("sendMessage: missing either env var → fetch never called (default OFF)", async () => {
  const calls = [];
  const fetchFn = async (...args) => {
    calls.push(args);
    return { ok: true };
  };
  await sendMessage("x", { fetchFn, env: { TELEGRAM_BOT_TOKEN: "T:abc" } }); // no chat id
  await sendMessage("x", { fetchFn, env: { TELEGRAM_CHAT_ID: "12345" } }); // no token
  await sendMessage("x", { fetchFn, env: {} }); // neither
  assert.equal(calls.length, 0);
});

test("sendMessage: fetch throws → does not throw out to the caller (secondary channel, swallow)", async () => {
  const fetchFn = async () => {
    throw new Error("network down");
  };
  await assert.doesNotReject(() =>
    sendMessage("x", { fetchFn, env: { TELEGRAM_BOT_TOKEN: "T:abc", TELEGRAM_CHAT_ID: "1" } }),
  );
});

test("isAllowed: message from the configured chat → true (string or number chat id)", () => {
  const update = { update_id: 1, message: { chat: { id: 555 }, text: "hi" } };
  assert.equal(isAllowed(update, "555"), true);
  assert.equal(isAllowed(update, 555), true);
});

test("isAllowed: a stranger's chat id → false (security boundary — caller must not reply)", () => {
  const update = { update_id: 1, message: { chat: { id: 999 }, text: "hi" } };
  assert.equal(isAllowed(update, "555"), false);
});

test("isAllowed: empty/malformed update → false", () => {
  assert.equal(isAllowed({}, "555"), false);
  assert.equal(isAllowed(null, "555"), false);
  assert.equal(isAllowed(undefined, "555"), false);
  assert.equal(isAllowed({ update_id: 1 }, "555"), false); // no message at all
  assert.equal(isAllowed({ update_id: 1, message: {} }, "555"), false); // message, no chat
});

test("isAllowed: channel_post (not message) from the allowed chat → false — bot only ever reads update.message", () => {
  const update = { update_id: 1, channel_post: { chat: { id: 555 }, text: "hi" } };
  assert.equal(isAllowed(update, "555"), false);
});

test("isAllowed: edited_message (not message) from the allowed chat → false", () => {
  const update = { update_id: 1, edited_message: { chat: { id: 555 }, text: "hi" } };
  assert.equal(isAllowed(update, "555"), false);
});

test("isAllowed: from.id equals the allowed id but message.chat.id does not → false (must gate on chat.id, never from.id)", () => {
  const update = { update_id: 1, message: { chat: { id: 999 }, from: { id: 555 }, text: "hi" } };
  assert.equal(isAllowed(update, "555"), false);
});

test("nextOffset: advances to one past the highest update_id in the batch", () => {
  assert.equal(nextOffset([{ update_id: 10 }, { update_id: 12 }, { update_id: 11 }], 5), 13);
});

test("nextOffset: empty batch leaves the offset unchanged", () => {
  assert.equal(nextOffset([], 42), 42);
  assert.equal(nextOffset(null, 42), 42);
});

test("nextOffset: update_id jumping ahead still advances correctly, and never regresses on a stale batch", () => {
  assert.equal(nextOffset([{ update_id: 100 }], 5), 101); // big jump/gap
  assert.equal(nextOffset([{ update_id: 3 }], 50), 50); // stale/duplicate redelivery — never go backwards
});

test("nextOffset: malformed/missing update_id entries are ignored, not NaN-poisoned", () => {
  assert.equal(nextOffset([{ no_update_id: true }], 42), 42); // no numeric id anywhere in the batch
  assert.equal(nextOffset([{ update_id: "12" }], 42), 42); // string, not a number — Number.isFinite rejects it
  assert.equal(nextOffset([{ update_id: 12 }, { no_update_id: true }], 5), 13); // one good id among junk still advances
});

test("pollUpdates: missing env → never calls fetch (does not start polling), stop() is a harmless no-op", async () => {
  const calls = [];
  const fetchFn = async (...args) => {
    calls.push(args);
    return { ok: true, json: async () => ({ result: [] }) };
  };
  const manager = { broadcast: () => {}, send: () => ({ accepted: false }) };
  const { dir, offsetFile } = tmpOffsetFile();
  const handle = pollUpdates(manager, { fetchFn, env: {}, offsetFile });
  await new Promise((r) => setTimeout(r, 20)); // give a real bug a chance to fire
  assert.equal(calls.length, 0);
  assert.doesNotThrow(() => handle.stop());
  rmSync(dir, { recursive: true, force: true });
});

test("pollUpdates: both env vars set → starts polling (calls getUpdates); stop() aborts the in-flight request and un-wraps manager.broadcast", async () => {
  let aborted = false;
  const calls = [];
  const fetchFn = (url, opts) =>
    new Promise((_resolve, reject) => {
      calls.push(url);
      opts?.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      });
    });
  const originalBroadcast = () => {};
  const manager = { broadcast: originalBroadcast, send: () => ({ accepted: false }) };
  const { dir, offsetFile } = tmpOffsetFile();

  const handle = pollUpdates(manager, {
    fetchFn,
    env: { TELEGRAM_BOT_TOKEN: "T:abc", TELEGRAM_CHAT_ID: "1" },
    offsetFile,
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 1);
  assert.match(calls[0], /^https:\/\/api\.telegram\.org\/botT:abc\/getUpdates\?offset=0&timeout=30$/);
  assert.notEqual(manager.broadcast, originalBroadcast); // wrapped while running

  handle.stop();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(aborted, true); // in-flight long-poll cancelled, not left to time out
  assert.equal(manager.broadcast, originalBroadcast); // restored on stop
  rmSync(dir, { recursive: true, force: true });
});

test("pollUpdates: stop() halts the loop for real — no further getUpdates calls land after it fires", async () => {
  const calls = [];
  const fetchFn = (url, opts) =>
    new Promise((_resolve, reject) => {
      calls.push(url);
      opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const manager = { broadcast: () => {}, send: () => ({ accepted: false }) };
  const { dir, offsetFile } = tmpOffsetFile();
  const handle = pollUpdates(manager, {
    fetchFn,
    env: { TELEGRAM_BOT_TOKEN: "T:abc", TELEGRAM_CHAT_ID: "1" },
    offsetFile,
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(calls.length, 1);
  handle.stop();
  // wait well past the abort + any would-be re-loop so a lingering consumer has time to show up
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls.length, 1); // still exactly one — the loop did not re-enter after stop()
  rmSync(dir, { recursive: true, force: true });
});

test("pollUpdates: stop() is idempotent — calling it twice never throws", async () => {
  const fetchFn = (_url, opts) =>
    new Promise((_resolve, reject) => {
      opts?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const manager = { broadcast: () => {}, send: () => ({ accepted: false }) };
  const { dir, offsetFile } = tmpOffsetFile();
  const handle = pollUpdates(manager, {
    fetchFn,
    env: { TELEGRAM_BOT_TOKEN: "T:abc", TELEGRAM_CHAT_ID: "1" },
    offsetFile,
  });
  await new Promise((r) => setTimeout(r, 20));
  assert.doesNotThrow(() => handle.stop());
  assert.doesNotThrow(() => handle.stop()); // a restart racing a slow shutdown must not crash the daemon
  rmSync(dir, { recursive: true, force: true });
});

test("pollUpdates: end-to-end happy path — an allowed message reaches manager.send(), and the PM's streamed chat_message reply is relayed back via sendMessage()", async () => {
  const sentMessages = []; // bodies POSTed to the real sendMessage() endpoint
  let getUpdatesCalls = 0;
  const fetchFn = async (url, opts) => {
    if (url.includes("/getUpdates")) {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return {
          ok: true,
          json: async () => ({
            result: [{ update_id: 7, message: { chat: { id: "1" }, text: "trạng thái sao rồi?" } }],
          }),
        };
      }
      return new Promise(() => {}); // park after the first batch — nothing new
    }
    // this is sendMessage()'s POST .../sendMessage
    sentMessages.push(JSON.parse(opts.body));
    return { ok: true };
  };
  let askedText = null;
  const manager = {
    broadcast: () => {}, // pollUpdates wraps this in place
    send: (text) => {
      askedText = text;
      return { accepted: true }; // chat-session.js's real shape on a fresh turn
    },
  };
  const env = { TELEGRAM_BOT_TOKEN: "T:abc", TELEGRAM_CHAT_ID: "1" };
  const { dir, offsetFile } = tmpOffsetFile();
  const handle = pollUpdates(manager, { fetchFn, env, offsetFile });

  await new Promise((r) => setTimeout(r, 20));
  assert.equal(askedText, "trạng thái sao rồi?"); // the allowed message's text reached the PM turn

  // Simulate chat-session.js streaming the PM's reply out over the same
  // broadcast pipeline pollUpdates wrapped — two assistant chunks, then done.
  manager.broadcast({ type: "chat_message", meta: { role: "assistant", text: "Đang làm B12.", done: false } });
  manager.broadcast({ type: "chat_message", meta: { role: "assistant", text: "Xong rồi.", done: true } });
  await new Promise((r) => setTimeout(r, 20));
  handle.stop();

  assert.equal(sentMessages.length, 1); // exactly one reply relayed back to Telegram
  assert.equal(sentMessages[0].text, "Đang làm B12.\nXong rồi."); // streamed chunks joined in order
  assert.equal(sentMessages[0].chat_id, "1");

  rmSync(dir, { recursive: true, force: true });
});

test("pollUpdates: manager.send() reports busy (PM already mid-turn) → the busy message itself is relayed back, no reply ever awaited from broadcast", async () => {
  const sentMessages = [];
  let getUpdatesCalls = 0;
  const fetchFn = async (url, opts) => {
    if (url.includes("/getUpdates")) {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return {
          ok: true,
          json: async () => ({ result: [{ update_id: 9, message: { chat: { id: "1" }, text: "ping" } }] }),
        };
      }
      return new Promise(() => {});
    }
    sentMessages.push(JSON.parse(opts.body));
    return { ok: true };
  };
  const manager = {
    broadcast: () => {},
    send: () => ({ accepted: false, message: "PM đang trả lời tin nhắn trước — chờ chút rồi gửi lại." }),
  };
  const env = { TELEGRAM_BOT_TOKEN: "T:abc", TELEGRAM_CHAT_ID: "1" };
  const { dir, offsetFile } = tmpOffsetFile();
  const handle = pollUpdates(manager, { fetchFn, env, offsetFile });

  await new Promise((r) => setTimeout(r, 20));
  handle.stop();

  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, "PM đang trả lời tin nhắn trước — chờ chút rồi gửi lại.");
  rmSync(dir, { recursive: true, force: true });
});

test("pollUpdates: manager.send() throwing synchronously is caught — the error itself is relayed back, the poll loop survives", async () => {
  const sentMessages = [];
  let getUpdatesCalls = 0;
  const fetchFn = async (url, opts) => {
    if (url.includes("/getUpdates")) {
      getUpdatesCalls += 1;
      if (getUpdatesCalls === 1) {
        return {
          ok: true,
          json: async () => ({ result: [{ update_id: 3, message: { chat: { id: "1" }, text: "hi" } }] }),
        };
      }
      return new Promise(() => {});
    }
    sentMessages.push(JSON.parse(opts.body));
    return { ok: true };
  };
  const manager = {
    broadcast: () => {},
    send: () => {
      throw new Error("spawn ENOENT");
    },
  };
  const env = { TELEGRAM_BOT_TOKEN: "T:abc", TELEGRAM_CHAT_ID: "1" };
  const { dir, offsetFile } = tmpOffsetFile();
  const handle = pollUpdates(manager, { fetchFn, env, offsetFile });
  await new Promise((r) => setTimeout(r, 20));
  handle.stop();
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].text, "PM lỗi: spawn ENOENT");
  rmSync(dir, { recursive: true, force: true });
});

test("pollUpdates: a getUpdates network failure is caught, backs off via sleepFn, then retries — loop survives, no crash", async () => {
  let getUpdatesCalls = 0;
  const fetchFn = async () => {
    getUpdatesCalls += 1;
    if (getUpdatesCalls === 1) throw new Error("ECONNRESET");
    return new Promise(() => {}); // second attempt just parks — we only need to see it happen
  };
  const sleepCalls = [];
  const sleepFn = (ms) => {
    sleepCalls.push(ms);
    return Promise.resolve(); // fast fake — the real 1000ms backoff would slow the suite for nothing
  };
  const manager = { broadcast: () => {}, send: () => ({ accepted: false }) };
  const env = { TELEGRAM_BOT_TOKEN: "T:abc", TELEGRAM_CHAT_ID: "1" };
  const { dir, offsetFile } = tmpOffsetFile();
  const handle = pollUpdates(manager, { fetchFn, env, offsetFile, sleepFn });
  await new Promise((r) => setTimeout(r, 20));
  handle.stop();
  assert.deepEqual(sleepCalls, [1000]); // backs off exactly the documented 1s before retrying
  assert.equal(getUpdatesCalls, 2); // retried after the backoff, loop did not die on the network error
  rmSync(dir, { recursive: true, force: true });
});

test("pollUpdates: offset is PERSISTED TO DISK, not just held in RAM — a fresh pollUpdates() call (simulated daemon restart) resumes from it, never replaying an already-seen batch", async () => {
  const { dir, offsetFile } = tmpOffsetFile();
  const env = { TELEGRAM_BOT_TOKEN: "T:abc", TELEGRAM_CHAT_ID: "1" };

  // "Process 1": one batch (update_id 41, from a stranger so no PM/sendMessage
  // side call complicates this — offset advancement doesn't depend on isAllowed),
  // then the long-poll hangs (nothing new) so the loop parks without spinning.
  let getUpdatesCalls = 0;
  const fetchFn1 = () => {
    getUpdatesCalls += 1;
    if (getUpdatesCalls === 1) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ result: [{ update_id: 41, message: { chat: { id: "999" }, text: "hi" } }] }),
      });
    }
    return new Promise(() => {}); // simulates a real long-poll with nothing new — never resolves
  };
  const manager1 = { broadcast: () => {}, send: () => ({ accepted: false }) };
  const handle1 = pollUpdates(manager1, { fetchFn: fetchFn1, env, offsetFile });
  await new Promise((r) => setTimeout(r, 30)); // let the first batch be processed and offset written
  handle1.stop();

  // The write must be REAL disk I/O — read it back with a plain fs call, not
  // through telegram.js's own reader, so a "kept in a module-level variable
  // only" regression can't fake this out.
  const onDisk = JSON.parse(readFileSync(offsetFile, "utf8"));
  assert.equal(onDisk.offset, 42); // update_id 41 + 1

  // "Process 2" (simulated restart): a BRAND NEW pollUpdates() call, same
  // offsetFile, no shared in-memory state with process 1 whatsoever.
  const calls2 = [];
  const fetchFn2 = (url) => {
    calls2.push(url);
    return new Promise(() => {}); // never resolves — only the requested URL matters here
  };
  const manager2 = { broadcast: () => {}, send: () => ({ accepted: false }) };
  const handle2 = pollUpdates(manager2, { fetchFn: fetchFn2, env, offsetFile });
  await new Promise((r) => setTimeout(r, 20));
  handle2.stop();
  assert.equal(calls2.length, 1);
  assert.match(calls2[0], /offset=42&timeout=30$/); // NOT offset=0 — proves the restart read the persisted value

  rmSync(dir, { recursive: true, force: true });
});
