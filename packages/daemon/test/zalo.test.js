import { test } from "node:test";
import assert from "node:assert/strict";
import { isAllowed, parseMessage, createZaloHttpHandler } from "../src/zalo.js";

// ── isAllowed (trust boundary — a Zalo OA webhook is a public endpoint) ──

test("isAllowed: message from the allowed user (string or number id) → true", () => {
  assert.equal(isAllowed({ sender: { id: 123 } }, "123"), true);
  assert.equal(isAllowed({ sender: { id: "123" } }, 123), true);
});

test("isAllowed: a different sender → false", () => {
  assert.equal(isAllowed({ sender: { id: 999 } }, "123"), false);
});

test("isAllowed: missing/malformed sender → false", () => {
  assert.equal(isAllowed({}, "123"), false);
  assert.equal(isAllowed({ sender: {} }, "123"), false);
  assert.equal(isAllowed(null, "123"), false);
});

// ── parseMessage ──

test("parseMessage: user_send_text → {senderId, text} (id coerced to string)", () => {
  assert.deepEqual(
    parseMessage({ event_name: "user_send_text", sender: { id: 7 }, message: { text: "chào PM" } }),
    { senderId: "7", text: "chào PM" },
  );
});

test("parseMessage: non-text event / empty text / no event_name → null", () => {
  assert.equal(parseMessage({ event_name: "user_send_image", sender: { id: 7 }, message: {} }), null);
  assert.equal(parseMessage({ event_name: "user_send_text", sender: { id: 7 }, message: {} }), null);
  assert.equal(parseMessage({ sender: { id: 7 }, message: { text: "x" } }), null);
});

// ── webhook handler routing (disabled env: `on` is a no-op so no body fires) ──

test("createZaloHttpHandler: false for non-webhook requests", () => {
  const h = createZaloHttpHandler({}, { env: {} });
  assert.equal(h({ method: "GET", on() {} }, {}, new URL("http://x/costs")), false);
  assert.equal(h({ method: "POST", on() {} }, {}, new URL("http://x/other")), false);
});

test("createZaloHttpHandler: claims POST /zalo/webhook", () => {
  const h = createZaloHttpHandler({}, { env: {} });
  const req = { method: "POST", on() {} };
  assert.equal(h(req, { writeHead() {}, end() {} }, new URL("http://x/zalo/webhook")), true);
});
