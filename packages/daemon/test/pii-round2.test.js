// Second Opus review: cuts in non-ASCII digits, cuts that were never marked, exotic separators, and a
// hand-written piiGuard value. Made-up values throughout.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { redactPii, safePreview, dropMarkedCuts } from "../src/redact-pii.js";
import { clip, ApprovalBroker } from "../src/approvals.js";
import { PiiGuard } from "../src/pii-guard.js";
import { ChatSessionManager } from "../src/chat-session.js";
import { describeMetrics } from "../src/digest.js";
import { normalizePolicy, requiredRole, shieldOn } from "../src/policy.js";
import { PolicyStore } from "../src/policy-store.js";

const ascii = (s) => s.normalize("NFKC").replace(/\D/g, "");
function leaks(out, phone) {
  const d = ascii(phone);
  const o = ascii(out);
  for (let i = 0; i + 4 <= d.length; i++) if (o.includes(d.slice(i, i + 4))) return true;
  return false;
}

// ── 1. cuts in full-width digits ──
const FW = ["０９１２３４５６７８", "０９１２ ３４５ ６７８", "０９１２　３４５　６７８"];
for (const phone of FW) {
  test(`a cut at ANY position through ${JSON.stringify(phone)} (full-width) leaks no digits, marked or not`, () => {
    const text = `gọi ${phone} hôm qua`;
    for (let k = 1; k <= text.length; k++) {
      const half = text.slice(0, k);
      assert.equal(leaks(safePreview(half, 1000, { alreadyCut: true }), phone), false, `cut=${k} alreadyCut`);
      assert.equal(leaks(safePreview(`${half}…`, 1000), phone), false, `cut=${k} marked: ${JSON.stringify(safePreview(`${half}…`, 1000))}`);
    }
  });
}
test("the two examples from the review", () => {
  assert.doesNotMatch(dropMarkedCuts("gọi ０９１２ ３４５ ６７…"), /[０-９0-9]/);
  assert.doesNotMatch(dropMarkedCuts("aaaa０９１２３４５６７…"), /[０-９0-9]{4}/);
});
test("a cut tail made of other digit scripts (Arabic-Indic) and keycaps is dropped too", () => {
  assert.doesNotMatch(dropMarkedCuts("gọi ٠٩١٢ ٣٤٥…"), /[٠-٩]/);
  assert.doesNotMatch(dropMarkedCuts("gọi 0️⃣9️⃣1️⃣2️⃣3️⃣…"), /[0-9]/);
});

// ── 3. separators and scripts ──
const FORMS = [
  ["middle dot", "0912·345·678"],
  ["bullet", "0912•345•678"],
  ["underscore", "0912_345_678"],
  ["bidi isolates", "⁦0912⁩ 345 678"],
  ["combining grapheme joiner", "0912͏345͏678"],
  ["variation selector", "0912️345️678"],
  ["Hangul filler", "0912ㅤ345ㅤ678"],
  ["Arabic-Indic digits", "٠٩١٢٣٤٥٦٧٨"],
  ["Devanagari digits", "०९१२३४५६७८"],
  ["keycap digits", "0️⃣9️⃣1️⃣2️⃣3️⃣4️⃣5️⃣6️⃣7️⃣8️⃣"],
  ["combining low line", "0̲9̲1̲2̲3̲4̲5̲6̲7̲8̲"],
  ["right-to-left mark", "0912‏345‏678"],
];
for (const [name, input] of FORMS) {
  test(`masks a phone written with: ${name}`, () => {
    const out = redactPii(`Khách: ${input} nhé`);
    assert.equal(out.counts.phone, 1, JSON.stringify(out));
    assert.ok(ascii(out.text).length <= 3, JSON.stringify(out.text));
  });
}
for (const [name, input, kind] of [["CMND slashes", "CMND 123/456/789", "id"], ["CMND 4+5", "CMND 1234 56789", "id"], ["CMND 5+4", "CMND 12345-6789", "id"]]) {
  test(`masks: ${name}`, () => assert.equal(redactPii(input).counts[kind], 1));
}
test("still leaves an IP address, a version and a date alone", () => {
  for (const t of ["ip 203.0.113.20", "v2.1.308", "ngày 12/11/2026", "1.500.000.000 đ", "Phí 123.456.789 đ"]) assert.equal(redactPii(t).text, t, t);
});
test("100k characters of exotic text stay under 100 ms", () => {
  for (const s of ["٠١٢٣".repeat(25000), "0️⃣".repeat(50000), "ㅤ".repeat(100000), "0912_".repeat(20000), "０９１２　".repeat(20000)]) {
    for (const run of [() => redactPii(s), () => safePreview(s, 400, { alreadyCut: true })]) {
      const t0 = performance.now();
      run();
      assert.ok(performance.now() - t0 < 100, JSON.stringify(s.slice(0, 6)));
    }
  }
});

// ── 2. cuts that were never marked ──
test("clip is exported from approvals.js and marks what it cuts", () => {
  assert.equal(clip("abcdef", 4), "abc…");
  assert.equal(clip("abc", 4), "abc");
});

test("chat-session: the event detail is cut with a marker", () => {
  const events = [];
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write() {}, end() {}, on() {} }, kill() {} });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-r2-chat-"));
  const m = new ChatSessionManager({ stateFile: path.join(dir, "s.json"), cwd: dir, defaultRepo: "acme-web", broadcast: (e) => events.push(e), spawnFn: () => child, timeoutMs: 5000 });
  m.send("hi");
  child.stdout.emit("data", `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `${"x".repeat(194)} 0912 345 678 tail` }] } })}\n`);
  const detail = events.find((e) => e.meta?.role === "assistant").detail;
  assert.ok(detail.endsWith("…") && detail.length <= 200, detail);
  assert.doesNotMatch(dropMarkedCuts(detail), /0912|09/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("digest: the radar summary is cut with a marker", () => {
  const out = describeMetrics({ summary: `${"y".repeat(195)} 0912 345 678` });
  assert.ok(out.endsWith("…") && out.length <= 200);
});

let root, projectsDir;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ao-r2-")));
  projectsDir = path.join(root, "projects");
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const mk = (slug, extra) => {
  fs.mkdirSync(path.join(projectsDir, slug), { recursive: true });
  fs.writeFileSync(path.join(projectsDir, slug, "project.json"), JSON.stringify({ version: 1, slug, name: slug, template: "coding", cwd: path.join(root, slug), ...extra }));
};

test("an UNshielded project's approval preview, sent to the operator's masked chat, is cut with a marker (router) and loses its half-cut tail", async () => {
  const { ChannelRouter } = await import("../src/channel-router.js");
  const { PairingStore } = await import("../src/members.js");
  mk("crm", { policy: { piiGuard: true } });
  mk("plain", {});
  const sent = [];
  const guard = new PiiGuard({ projectsDir, legacy: [{ channel: "telegram", chatId: "555" }], log: { warn() {} } });
  const router = new ChannelRouter({
    projectsDir, hub: { list: () => [] }, broker: { list: () => [] }, pairing: new PairingStore({ projectsDir }),
    send: async (channel, chatId, text) => sent.push(guard.apply(channel, chatId, text)),
    legacy: [{ channel: "telegram", chatId: "555" }], mask: (slug, text, o) => guard.maskForProject(slug, text, o),
  });
  for (let pad = 255; pad <= 300; pad++) {
    sent.length = 0;
    await router.notifyApproval({ id: "ffeeddccbb", tool: "Bash", preview: `${"x".repeat(pad)} 0912 345 678 tail`, cwd: path.join(root, "plain", "src") });
    assert.equal(leaks(sent[0], "0912345678"), false, `pad=${pad}: ${JSON.stringify(sent[0])}`);
  }
});

// ── 4. a hand-written piiGuard value ──
test("shieldOn: anything except absent, null or false is ON, and normalizePolicy / the store / requiredRole all agree", () => {
  for (const v of ["true", 1, "yes", {}, [], true]) assert.equal(shieldOn(v), true, JSON.stringify(v));
  for (const v of [undefined, null, false]) assert.equal(shieldOn(v), false, String(v));
  assert.equal(normalizePolicy({ piiGuard: "true" }).piiGuard, true);
  assert.equal(normalizePolicy({ piiGuard: 1 }).piiGuard, true);
  assert.equal(requiredRole(normalizePolicy({ piiGuard: "true" }), normalizePolicy({ piiGuard: false })), "owner");
  assert.equal(requiredRole(normalizePolicy({ piiGuard: 1 }), normalizePolicy({})), "manager");
});
test("a save that does not mention piiGuard keeps a hand-written \"true\" or 1 ON", () => {
  for (const handWritten of ["true", 1]) {
    mk("crm", { policy: { piiGuard: handWritten } });
    const store = new PolicyStore({ projectsDir, cacheMs: 0 });
    store.setPolicy("crm", { approval: { mode: "ask" } });
    const onDisk = JSON.parse(fs.readFileSync(path.join(projectsDir, "crm", "project.json"), "utf8")).policy;
    assert.equal(shieldOn(onDisk.piiGuard), true, `lost ${JSON.stringify(handWritten)}`);
  }
});
