// Third Opus review: more separators, combining marks kept intact, a stderr tail cut at the front.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactPii, dropMarkedCuts, dropCutTail, dropCutHead } from "../src/redact-pii.js";
import { ChatSessionManager } from "../src/chat-session.js";
import { ChannelRouter } from "../src/channel-router.js";
import { PairingStore } from "../src/members.js";

const ascii = (s) => s.normalize("NFKC").replace(/\D/g, "");
const leaks = (out, phone) => {
  const d = ascii(phone);
  const o = ascii(out);
  for (let i = 0; i + 4 <= d.length; i++) if (o.includes(d.slice(i, i + 4))) return true;
  return false;
};

// ── 1. separators ──
for (const [name, input] of [
  ["katakana middle dot", "0912・345・678"],
  ["hyphenation point", "0912‧345‧678"],
  ["bullet operator", "0912∙345∙678"],
  ["dot operator", "0912⋅345⋅678"],
  ["half-width katakana middle dot", "0912･345･678"],
  ["full-width digits with katakana middle dot", "０９１２・３４５・６７８"],
  ["commas", "0912,345,678"],
  ["commas and spaces", "0912, 345, 678"],
]) {
  test(`masks a phone written with: ${name}`, () => {
    const out = redactPii(`Khách: ${input} nhé`);
    assert.equal(out.counts.phone, 1, JSON.stringify(out));
    assert.ok(ascii(out.text).length <= 3, out.text);
  });
}
test("a list of two numbers separated by a comma is still two numbers", () => {
  assert.equal(redactPii("0912345678, 0987654321").counts.phone, 2);
});
test("amounts written with commas are NOT masked", () => {
  for (const t of ["Giá 1,500,000", "Giá 1,500,000,000 đ", "Tổng 2,345,678,901", "Doanh thu 12,345,678", "Tăng 3,5% lên 1,234,567"]) {
    assert.equal(redactPii(t).text, t, t);
  }
});
test("dropCutTail removes a half number that ends in a separator", () => {
  assert.equal(dropCutTail("gọi 0912,345,"), "gọi");
  assert.equal(dropCutTail("gọi ０９１２・３４５・"), "gọi");
});

// ── 2. combining marks stay with their letter ──
test("a decomposed Vietnamese letter before the cut keeps its accent", () => {
  assert.equal(dropMarkedCuts("gọi cho Hà 0912 3…"), "gọi cho Hà");
  assert.equal(dropCutTail("gọi cho Hà 0912 3"), "gọi cho Hà");
});
test("a masked value followed by its own variation selector / keycap leaves no orphan mark", () => {
  assert.equal(redactPii("0912345678️⃣ nhé").text, "[phone ***678] nhé");
  assert.doesNotMatch(dropMarkedCuts("gọi cho 1️⃣2️⃣…"), /[️⃣]/);
});

// ── 3. a stream tail cut at the FRONT ──
test("dropCutHead drops the half word and the digits left at the front", () => {
  assert.equal(dropCutHead("345 678 rồi sau đó lỗi"), "rồi sau đó lỗi");
  assert.equal(dropCutHead("12 345 678\nboom"), "boom");
  assert.equal(dropCutHead("ếu rồi mới lỗi"), "rồi mới lỗi");
  assert.equal(dropCutHead("３４５ ６７８ rồi"), "rồi");
});

const PHONE = "0912 345 678";
function stderrScenario(send) {
  const events = [];
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write() {}, end() {}, on() {} }, kill() {} });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-r3-chat-"));
  const m = new ChatSessionManager({ stateFile: path.join(dir, "s.json"), cwd: dir, defaultRepo: "acme-web", broadcast: (e) => events.push(e), spawnFn: () => child, timeoutMs: 5000 });
  send(m);
  return { events, child, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
for (const [label, send] of [["warm PM process", (m) => m.send("hi")], ["one-shot targeted turn", (m) => m.send("hi", { targetSessionId: "sess-x" })]]) {
  test(`${label}: a 500-character stderr tail cut anywhere through a phone number leaves no digits in the error text`, () => {
    // the phone sits so that the last-500-characters window starts at every position inside it
    for (let t = 500 - PHONE.length - 2; t <= 500; t++) {
      const { events, child, done } = stderrScenario(send);
      child.stderr.emit("data", `${"filler ".repeat(30)}${PHONE}${" z".repeat(Math.ceil(t / 2))}`.slice(0, 210 + PHONE.length + t));
      child.emit("exit", 1);
      const err = events.find((e) => e.meta?.error && /ended unexpectedly/.test(e.meta.text ?? ""));
      assert.ok(err, "an error event is expected");
      assert.equal(leaks(err.meta.text, PHONE), false, `t=${t}: ${JSON.stringify(err.meta.text)}`);
      done();
    }
  });
}

// ── 4. safeName marks its cut ──
test("a long display name is clipped with a marker", async () => {
  const who = [];
  const router = new ChannelRouter({
    projectsDir: fs.mkdtempSync(path.join(os.tmpdir(), "ao-r3-router-")),
    hub: { list: () => [] },
    broker: { list: () => [{ id: "ffeeddccbb", tool: "Bash", preview: "ls", cwd: null }], respond: (id, d, w) => (who.push(w), { ok: true }) },
    pairing: new PairingStore({ projectsDir: os.tmpdir() }),
    send: async () => {},
    legacy: [{ channel: "telegram", chatId: "555" }],
  });
  await router.handle({ channel: "telegram", chatId: "555", userId: "555", name: `${"x".repeat(34)} 0912345678 tail`, text: "/approve ffeeddcc" });
  assert.equal(who.length, 1);
  assert.match(who[0], /…\)$/);
});
