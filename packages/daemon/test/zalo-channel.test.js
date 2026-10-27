import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { createZaloChannel, zaloSignature } from "../src/zalo-channel.js";

const ENV = { ZALO_OA_TOKEN: "oa-token-xyz", ZALO_APP_ID: "app1", ZALO_OA_SECRET: "sekret" };

/** Drive the webhook handler without a socket. */
function post(handler, body, headers = {}) {
  const req = new EventEmitter();
  req.method = "POST";
  req.headers = headers;
  const res = { status: null, body: "", writeHead(s) { this.status = s; }, end(b) { this.body = b ?? ""; } };
  const handled = handler(req, res, new URL("http://x/zalo/webhook"));
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  req.emit("data", raw);
  req.emit("end");
  return { handled, res, raw };
}

const textEvent = (id, text) => ({ event_name: "user_send_text", timestamp: String(Date.now()), sender: { id }, message: { text } });

function signed(body) {
  const raw = JSON.stringify(body);
  return { raw, headers: { "x-zevent-signature": `mac=${zaloSignature({ appId: ENV.ZALO_APP_ID, raw, timestamp: body.timestamp, secret: ENV.ZALO_OA_SECRET })}` } };
}

test("dormant until configured: without token, app id and secret the channel is disabled but the webhook still acks 200", () => {
  const seen = [];
  const ch = createZaloChannel({ env: {}, log: { warn() {} } });
  ch.start((m) => seen.push(m));
  assert.equal(ch.enabled, false);
  const { handled, res } = post(ch.http, textEvent("u1", "hi"));
  assert.equal(handled, true);
  assert.equal(res.status, 200);
  assert.deepEqual(seen, []);
});

test("other routes are not handled (falls through the extraHttp chain)", () => {
  const ch = createZaloChannel({ env: ENV, log: { warn() {} } });
  const req = new EventEmitter();
  req.method = "GET";
  assert.equal(ch.http(req, {}, new URL("http://x/zalo/webhook")), false);
  req.method = "POST";
  assert.equal(ch.http(req, {}, new URL("http://x/other")), false);
});

test("a correctly signed text event becomes a router message (DM-only, sender id as both chat and user)", async () => {
  const seen = [];
  const ch = createZaloChannel({ env: ENV, log: { warn() {} } });
  ch.start((m) => seen.push(m));
  const body = textEvent("u42", "status?");
  const { raw, headers } = signed(body);
  const { res } = post(ch.http, raw, headers);
  assert.equal(res.status, 200);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, [{ channel: "zalo", chatId: "u42", userId: "u42", name: "", text: "status?", isGroup: false }]);
});

test("a forged event (bad or missing signature) is acked and dropped — a public endpoint must not trust sender ids", async () => {
  const seen = [];
  const ch = createZaloChannel({ env: ENV, log: { warn() {} } });
  ch.start((m) => seen.push(m));
  post(ch.http, textEvent("u42", "I am the owner"), {});
  post(ch.http, textEvent("u42", "I am the owner"), { "x-zevent-signature": "mac=deadbeef" });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, []);
});

test("signature follows Zalo's documented recipe: sha256(appId + body + timestamp + secret)", () => {
  const expected = createHash("sha256").update("app1" + '{"a":1}' + "123" + "sekret").digest("hex");
  assert.equal(zaloSignature({ appId: "app1", raw: '{"a":1}', timestamp: "123", secret: "sekret" }), expected);
});

test("send() posts to the OA message API with the access token, and swallows failures", async () => {
  const calls = [];
  const ch = createZaloChannel({ env: ENV, fetchFn: async (url, opts) => { calls.push({ url, opts }); return { ok: true }; }, log: { warn() {} } });
  await ch.send("u42", "hello");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.headers.access_token, "oa-token-xyz");
  assert.deepEqual(JSON.parse(calls[0].opts.body), { recipient: { user_id: "u42" }, message: { text: "hello" } });

  const dead = createZaloChannel({ env: ENV, fetchFn: async () => { throw new Error("down"); }, log: { warn() {} } });
  await assert.doesNotReject(() => dead.send("u1", "x"));

  const off = createZaloChannel({ env: {}, fetchFn: async () => { throw new Error("must not be called"); }, log: { warn() {} } });
  await off.send("u1", "x");
});

test("a correctly signed but OLD event is dropped (replay), and a token-only setup is told why it is quiet", async () => {
  const warnings = [];
  const seen = [];
  const ch = createZaloChannel({ env: ENV, log: { warn: (m) => warnings.push(m) } });
  ch.start((m) => seen.push(m));
  const old = { ...textEvent("u42", "replayed"), timestamp: String(Date.now() - 3600_000) };
  const { raw, headers } = signed(old);
  post(ch.http, raw, headers);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen, []);

  createZaloChannel({ env: { ZALO_OA_TOKEN: "t" }, log: { warn: (m) => warnings.push(m) } });
  assert.match(warnings.join("\n"), /ZALO_APP_ID/);
  assert.doesNotMatch(warnings.join("\n"), /oa-token-xyz|"t"/);
});
