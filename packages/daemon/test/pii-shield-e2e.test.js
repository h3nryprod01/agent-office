// End to end for the personal-data shield: the real router, hub, approval broker and Telegram channel
// wired by createMultiPm, talking to a FAKE Telegram server on a local port (never the real API).
// With piiGuard on, no phone number, ID number or e-mail may reach that server; with it off the same
// text goes through untouched (the control, so the test cannot pass by sending nothing).

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMultiPm } from "../src/multi-pm.js";
import { ApprovalBroker } from "../src/approvals.js";
import { makeEvent } from "../src/event-schema.js";
import { startFakeTelegram } from "./fixtures/fake-telegram.js";
import { guardedTelegramSend } from "../src/notifier.js";
import { sendMessage as telegramSendMessage } from "../src/telegram.js";
import { PiiGuard } from "../src/pii-guard.js";

// made-up values; every one must be masked when the shield is on
const PHONES = ["0912345678", "+84 987 654 321", "0912.345.678", "091-234-5678"];
const CCCD = "001000000000";
const CMND = "123456789";
const EMAIL = "khach.hang@example.com";
const SECRETS = [...PHONES, CCCD, CMND, EMAIL, "345678", "654321", "012345"];
const LEAKY = `Khách Lan: ${PHONES.join(" | ")} | CCCD ${CCCD} | CMND ${CMND} | ${EMAIL}`;

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = { written: [], write(s) { this.written.push(s); }, end() {}, on() {} };
  }
  kill() { if (!this._exited) { this._exited = true; queueMicrotask(() => this.emit("exit", null)); } }
  line(obj) { this.stdout.emit("data", JSON.stringify(obj) + "\n"); }
  reply(text, sid = "s1") {
    this.line({ type: "system", subtype: "init", session_id: sid });
    this.line({ type: "assistant", message: { content: [{ type: "text", text }] } });
    this.line({ type: "result", session_id: sid, is_error: false });
  }
}

async function boot({ shieldedRoom = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ao-pii-e2e-"));
  const projectsDir = path.join(root, "projects");
  const cwds = {};
  const rooms = { "crm-lead": "-1001", "plain-app": "-1002" };
  for (const slug of Object.keys(rooms)) {
    cwds[slug] = path.join(root, "repos", slug);
    fs.mkdirSync(cwds[slug], { recursive: true });
    fs.mkdirSync(path.join(projectsDir, slug), { recursive: true });
    fs.writeFileSync(
      path.join(projectsDir, slug, "project.json"),
      JSON.stringify({
        version: 1, slug, name: slug, template: "coding", cwd: cwds[slug],
        channels: { telegram: { chatId: rooms[slug] } },
        members: [{ id: `m-${slug}`, name: "Lan", role: "owner", telegram: { userId: "100" } }],
        ...(slug === "crm-lead" && shieldedRoom ? { policy: { piiGuard: true } } : {}),
      }),
    );
    fs.writeFileSync(path.join(projectsDir, slug, "items.json"), JSON.stringify({ version: 1, items: [{ id: "it-1", title: `${slug} job`, source: "agent", status: "doing" }] }));
  }
  const fake = await startFakeTelegram();
  const children = {};
  const broadcasts = [];
  const server = { broadcast: (e) => broadcasts.push(e) };
  const approvalBroker = new ApprovalBroker({ broadcast: (e) => server.broadcast(e), hasClients: () => true, makeEvent, ttlMs: 2000 });
  const multi = createMultiPm({
    projectsDir, stateDir: root,
    env: { TELEGRAM_BOT_TOKEN: fake.token },
    approvalBroker, broadcast: (e) => broadcasts.push(e),
    telegramApiBase: fake.apiBase, telegramOffsetFile: path.join(root, "offset.json"),
    spawnFn: (bin, args, opts) => { const c = new FakeChild(); children[path.basename(opts.cwd)] = c; return c; },
    metricsUrl: () => null,
    log: { warn() {}, error() {}, log() {} },
  });
  multi.attach(server);
  multi.start();
  const toRoom = (chatId) => fake.sent.filter((s) => s.chat_id === String(chatId));
  return {
    root, projectsDir, cwds, fake, multi, children, approvalBroker, toRoom,
    close: async () => { multi.stop(); await fake.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

const allText = (msgs) => msgs.map((m) => m.text).join("\n");
const noSecrets = (text) => { for (const s of SECRETS) assert.equal(text.includes(s), false, `leaked ${JSON.stringify(s)} in: ${text}`); };

test("PM reply in a shielded room: no phone, ID or e-mail reaches Telegram; the control room gets it raw", async () => {
  const w = await boot();
  w.fake.say({ chatId: "-1001", userId: 100, text: "tóm tắt khách", group: true });
  w.fake.say({ chatId: "-1002", userId: 100, text: "tóm tắt khách", group: true });
  assert.ok(await w.fake.waitFor(() => w.children["crm-lead"] && w.children["plain-app"]));
  w.children["crm-lead"].reply(LEAKY);
  w.children["plain-app"].reply(LEAKY);
  assert.ok(await w.fake.waitFor(() => w.toRoom("-1001").length >= 1 && w.toRoom("-1002").length >= 1));
  noSecrets(allText(w.toRoom("-1001")));
  assert.match(allText(w.toRoom("-1001")), /\[phone \*\*\*678\]/);
  assert.ok(allText(w.toRoom("-1002")).includes(PHONES[0]), "control: the unshielded room must still get the raw text");
  await w.close();
});

test("approval alert: the command preview is masked, even when the number sits at the cut-off", async () => {
  const w = await boot();
  // pad so the phone number straddles the 300-character preview cut
  const preview = `curl -d phone=${"x".repeat(280)} ${PHONES[0]} ${EMAIL}`;
  void w.approvalBroker.request({ sessionId: "s1", tool: "Bash", preview, cwd: w.cwds["crm-lead"] });
  assert.ok(await w.fake.waitFor(() => w.toRoom("-1001").length >= 1));
  const text = allText(w.toRoom("-1001"));
  noSecrets(text);
  assert.doesNotMatch(text, /09123|0912/); // not even a fragment
  // the buttons still carry their command, untouched
  assert.match(JSON.stringify(w.toRoom("-1001")[0].reply_markup), /\/approve/);
  await w.close();
});

test("approval with the number at the front of a short preview is masked and still tells the owner what is asked", async () => {
  const w = await boot();
  void w.approvalBroker.request({ sessionId: "s1", tool: "Bash", preview: `send-sms ${PHONES[1]} "hello"`, cwd: w.cwds["crm-lead"] });
  assert.ok(await w.fake.waitFor(() => w.toRoom("-1001").length >= 1));
  const text = allText(w.toRoom("-1001"));
  noSecrets(text);
  assert.match(text, /Approval needed/);
  assert.match(text, /send-sms \[phone \*\*\*321\]/);
  await w.close();
});

test("/pending and /status (the PM's last reply, cut at 200 characters) leak nothing either", async () => {
  const w = await boot();
  void w.approvalBroker.request({ sessionId: "s1", tool: "Bash", preview: `send-sms ${PHONES[0]}`, cwd: w.cwds["crm-lead"] });
  assert.ok(await w.fake.waitFor(() => w.toRoom("-1001").length >= 1));
  w.fake.say({ chatId: "100", userId: 100, text: "/use crm-lead", group: false });
  w.fake.say({ chatId: "100", userId: 100, text: "ask", group: false });
  assert.ok(await w.fake.waitFor(() => w.children["crm-lead"]));
  const child = w.children["crm-lead"];
  child.reply(`${"a".repeat(194)} 0912345678`); // the hub keeps 200 characters: a fragment of the phone number
  w.fake.say({ chatId: "100", userId: 100, text: "/pending", group: false });
  w.fake.say({ chatId: "100", userId: 100, text: "/status crm-lead", group: false });
  assert.ok(await w.fake.waitFor(() => w.toRoom("100").length >= 4));
  const text = allText(w.toRoom("100"));
  noSecrets(text);
  assert.doesNotMatch(text, /09123/);
  await w.close();
});

test("a member's private chat on a shielded project is masked too", async () => {
  const w = await boot();
  w.fake.say({ chatId: "100", userId: 100, text: "/use crm-lead", group: false });
  w.fake.say({ chatId: "100", userId: 100, text: "who is the lead?", group: false });
  assert.ok(await w.fake.waitFor(() => w.children["crm-lead"]));
  w.children["crm-lead"].reply(LEAKY);
  assert.ok(await w.fake.waitFor(() => w.toRoom("100").length >= 2));
  noSecrets(allText(w.toRoom("100")));
  await w.close();
});

test("switching the flag off on disk takes effect on the next message", async () => {
  const w = await boot();
  const file = path.join(w.projectsDir, "crm-lead", "project.json");
  const meta = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...meta, policy: { piiGuard: false } }));
  void w.approvalBroker.request({ sessionId: "s1", tool: "Bash", preview: `send-sms ${PHONES[0]}`, cwd: w.cwds["crm-lead"] });
  assert.ok(await w.fake.waitFor(() => w.toRoom("-1001").length >= 1));
  assert.ok(allText(w.toRoom("-1001")).includes(PHONES[0]));
  await w.close();
});

test("the audit says how many values were masked and never what they were", async () => {
  const w = await boot();
  void w.approvalBroker.request({ sessionId: "s1", tool: "Bash", preview: `send-sms ${PHONES[0]} ${EMAIL}`, cwd: w.cwds["crm-lead"] });
  assert.ok(await w.fake.waitFor(() => w.toRoom("-1001").length >= 1));
  const raw = fs.readFileSync(path.join(w.projectsDir, "crm-lead", "pii-audit.jsonl"), "utf8");
  const rows = raw.trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(rows.length >= 1);
  assert.ok(rows.reduce((n, r) => n + r.phone, 0) >= 1 && rows.reduce((n, r) => n + r.email, 0) >= 1);
  noSecrets(raw);
  assert.equal(fs.existsSync(path.join(w.projectsDir, "plain-app", "pii-audit.jsonl")), false);
  await w.close();
});

test("the notification push (notifier.js → Telegram) is masked when a project has the shield on", async () => {
  const w = await boot();
  const guard = new PiiGuard({ projectsDir: w.projectsDir });
  const env = { TELEGRAM_BOT_TOKEN: w.fake.token, TELEGRAM_CHAT_ID: "555" };
  // the real sendMessage, with its URL pointed at the fake server
  const fetchFn = (url, init) => fetch(String(url).replace("https://api.telegram.org", w.fake.apiBase), init);
  await guardedTelegramSend(`Agent Office — crm-lead\nwaiting on ${PHONES[0]} ${EMAIL}\nhttp://localhost:5199`, {
    guard,
    send: (text) => telegramSendMessage(text, { fetchFn, env }),
  });
  assert.equal(w.toRoom("555").length, 1);
  noSecrets(allText(w.toRoom("555")));
  await w.close();
});

test("with no project shielded the notification push is unchanged", async () => {
  const w = await boot({ shieldedRoom: false });
  const guard = new PiiGuard({ projectsDir: w.projectsDir });
  const sent = [];
  await guardedTelegramSend(`waiting on ${PHONES[0]}`, { guard, send: (t) => sent.push(t) });
  assert.deepEqual(sent, [`waiting on ${PHONES[0]}`]);
  await w.close();
});
