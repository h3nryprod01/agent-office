// Review H1/H2: texts that are CUT BEFORE the shield sees them (the approval preview, the transcript
// detail every adapter shortens). A cut can leave half a number or half an e-mail, and a half value no longer
// matches any pattern, so every cut is marked with a trailing "…" and the shield drops the half-cut tail.
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PiiGuard } from "../src/pii-guard.js";
import { previewToolInput } from "../src/approvals.js";
import { composeNotification, guardedTelegramSend } from "../src/notifier.js";
import { SessionNormalizer } from "../src/normalize.js";
import { dropMarkedCuts } from "../src/redact-pii.js";

let root, projectsDir;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ao-cut-src-")));
  projectsDir = path.join(root, "projects");
  fs.mkdirSync(path.join(projectsDir, "crm"), { recursive: true });
  fs.writeFileSync(path.join(projectsDir, "crm", "project.json"), JSON.stringify({ version: 1, slug: "crm", name: "crm", template: "coding", cwd: path.join(root, "crm"), policy: { piiGuard: true } }));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const guard = () => new PiiGuard({ projectsDir, log: { warn() {} } });

const PHONES = ["0912345678", "0912 345 678", "+84 912 345 678", "0912​345​678"];
const EMAIL = "nguyen.van.a@example.com";
const digitsOf = (s) => s.replace(/\D/g, "");
function leaksDigits(out, phone) {
  const d = digitsOf(phone);
  const o = digitsOf(out);
  for (let i = 0; i + 4 <= d.length; i++) if (o.includes(d.slice(i, i + 4))) return true;
  return false;
}

// ── H1 ──
test("previewToolInput marks the cut it makes (a trailing …) and says nothing when it cut nothing", () => {
  assert.ok(previewToolInput("mcp__x__y", { note: "a".repeat(400) }).endsWith("…"));
  assert.equal(previewToolInput("mcp__x__y", { note: "short" }), '{"note":"short"}');
  assert.equal(previewToolInput("Bash", { command: "ls" }), "ls");
});

for (const phone of PHONES) {
  test(`an MCP tool call whose phone ${JSON.stringify(phone)} straddles the 200-character preview cut leaks nothing through the shield`, () => {
    const g = guard();
    for (let pad = 140; pad <= 200; pad++) {
      const preview = previewToolInput("mcp__crm__add_lead", { note: `${"x".repeat(pad)} ${phone} tail` });
      const out = g.maskForProject("crm", preview, { max: 300 });
      assert.equal(leaksDigits(out, phone), false, `pad=${pad}: ${JSON.stringify(out)}`);
    }
  });
}

test("an MCP tool call whose e-mail straddles the 200-character cut leaks neither the local part nor the @", () => {
  const g = guard();
  for (let pad = 140; pad <= 200; pad++) {
    const preview = previewToolInput("mcp__crm__add_lead", { note: `${"x".repeat(pad)} ${EMAIL} tail` });
    const out = g.maskForProject("crm", preview, { max: 300 });
    assert.doesNotMatch(out, /nguyen|van\.a|@|example/i, `pad=${pad}: ${JSON.stringify(out)}`);
  }
});

// ── H2 ──
function truncatedDetail(textBefore, value) {
  // what normalize.js does to an assistant text longer than 2000 characters
  const events = new SessionNormalizer("s1").normalizeLine({
    type: "assistant", uuid: "u1", cwd: "/w/crm", timestamp: new Date().toISOString(),
    message: { content: [{ type: "text", text: `${textBefore} ${value} và còn rất nhiều chữ nữa phía sau` }] },
  });
  return events.find((e) => e.type === "speak").detail;
}

for (const phone of PHONES) {
  test(`a notification built from a transcript detail cut by normalize.js mid-number ${JSON.stringify(phone)} leaks nothing`, async () => {
    for (let pad = 1975; pad <= 2000; pad++) {
      const detail = truncatedDetail("a".repeat(pad), phone);
      assert.ok(detail.endsWith("…"));
      const note = composeNotification({ agent: "pm", repo: "crm", agentId: "a1", detail, meta: { state: "waiting_permission" } }, "http://localhost:5199");
      const sent = [];
      await guardedTelegramSend(`${note.title} — ${note.subtitle}\n${note.message}\n${note.url}`, { guard: guard(), send: (t) => sent.push(t) });
      assert.equal(leaksDigits(sent[0], phone), false, `pad=${pad}: …${sent[0].slice(-80)}`);
    }
  });
}

test("a cut e-mail in a notification detail leaks nothing", async () => {
  for (let pad = 1975; pad <= 2000; pad++) {
    const detail = truncatedDetail("a".repeat(pad), EMAIL);
    const sent = [];
    await guardedTelegramSend(`Agent Office — pm · crm\nError >30s: ${detail}\nhttp://localhost:5199`, { guard: guard(), send: (t) => sent.push(t) });
    assert.doesNotMatch(sent[0], /nguyen|@|exam/i, `pad=${pad}`);
  }
});

test("the same rule holds for a text from a project that has NO flag, sent to a masked chat (no distinction by source)", () => {
  fs.mkdirSync(path.join(projectsDir, "plain"), { recursive: true });
  fs.writeFileSync(path.join(projectsDir, "plain", "project.json"), JSON.stringify({ version: 1, slug: "plain", name: "plain", template: "coding", cwd: path.join(root, "plain"), channels: { telegram: { chatId: "-9" } } }));
  const g = new PiiGuard({ projectsDir, legacy: [{ channel: "telegram", chatId: "555" }], log: { warn() {} } });
  const out = g.apply("telegram", "555", "hết giờ chờ: gọi lại 0912 345 6…\nhttp://x");
  assert.doesNotMatch(out, /0912|345/);
  assert.match(out, /\nhttp:\/\/x$/);
});

test("dropMarkedCuts only touches lines that end with …, and keeps the others whole", () => {
  assert.equal(dropMarkedCuts("keep this 0912\nthen a half 091234…\nlast line"), "keep this 0912\nthen a half\nlast line");
  assert.equal(dropMarkedCuts("no marker 123"), "no marker 123");
});
