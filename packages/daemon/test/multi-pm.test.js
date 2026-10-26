// End-to-end for lane L5: a real router, hub, members, pairing and digest wired by
// createMultiPm, talking to a FAKE Telegram server on a local port (no real API, no real
// message) and to a real HTTP server for the office's own API. The `claude` processes are
// fakes that answer on cue.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createMultiPm, hostAllowed } from "../src/multi-pm.js";
import { request } from "node:http";
import { ApprovalBroker } from "../src/approvals.js";
import { makeEvent } from "../src/event-schema.js";
import { listMembers } from "../src/members.js";
import { startFakeTelegram } from "./fixtures/fake-telegram.js";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = { written: [], write(s) { this.written.push(s); }, end() {}, on() {} };
  }
  kill() { if (!this._exited) { this._exited = true; queueMicrotask(() => this.emit("exit", null)); } }
  line(obj) { this.stdout.emit("data", JSON.stringify(obj) + "\n"); }
  asked() { return this.stdin.written.map((w) => JSON.parse(w).message.content[0].text); }
  reply(text, sid) {
    this.line({ type: "system", subtype: "init", session_id: sid });
    this.line({ type: "assistant", message: { content: [{ type: "text", text }] } });
    this.line({ type: "result", session_id: sid, is_error: false });
  }
}

async function boot({ roleOf, nowMs = new Date(2026, 9, 27, 19, 0).getTime(), env = {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ao-l5-e2e-"));
  const projectsDir = path.join(root, "projects");
  const cwds = {};
  for (const slug of ["demo-app", "acme-web"]) {
    cwds[slug] = path.join(root, "repos", slug);
    fs.mkdirSync(cwds[slug], { recursive: true });
    fs.mkdirSync(path.join(projectsDir, slug), { recursive: true });
    fs.writeFileSync(path.join(projectsDir, slug, "project.json"), JSON.stringify({ version: 1, slug, name: slug, template: "coding", cwd: cwds[slug] }));
    fs.writeFileSync(
      path.join(projectsDir, slug, "items.json"),
      JSON.stringify({
        version: 1,
        items: [
          { id: "it-1", title: `${slug} landing`, source: "agent", status: "done", updatedAt: new Date(nowMs - 3600_000).toISOString() },
          { id: "it-2", title: `${slug} seo`, source: "agent", status: "doing" },
        ],
      }),
    );
  }
  const fake = await startFakeTelegram();
  const children = {};
  const clock = { t: nowMs };
  const broadcasts = [];
  const server = { broadcast: (e) => broadcasts.push(e) };
  const approvalBroker = new ApprovalBroker({ broadcast: (e) => server.broadcast(e), hasClients: () => true, makeEvent, ttlMs: 2000 });
  const multi = createMultiPm({
    projectsDir,
    stateDir: root,
    env: { TELEGRAM_BOT_TOKEN: fake.token, ...env },
    approvalBroker,
    broadcast: (e) => broadcasts.push(e),
    roleOf,
    telegramApiBase: fake.apiBase,
    telegramOffsetFile: path.join(root, "offset.json"),
    spawnFn: (bin, args, opts) => { const c = new FakeChild(); children[path.basename(opts.cwd)] = c; return c; },
    now: () => clock.t,
    metricsUrl: () => null,
    log: process.env.AO_TEST_DEBUG ? console : { warn() {}, error() {}, log() {} },
  });
  multi.attach(server);
  multi.start();

  const api = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (!multi.http(req, res, url)) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${api.address().port}`;
  const call = async (method, p, body) => {
    const res = await fetch(base + p, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const lastTo = (chatId) => fake.sent.filter((s) => s.chat_id === String(chatId)).at(-1)?.text;
  const waitSent = (n) => fake.waitFor(() => fake.sent.length >= n);
  return {
    baseUrl: base, root, projectsDir, cwds, fake, multi, children, clock, broadcasts, approvalBroker, call, lastTo, waitSent,
    close: async () => { multi.stop(); await fake.close(); await new Promise((r) => { api.closeAllConnections?.(); api.close(r); }); },
  };
}

/** owner mints a code in the UI (HTTP), the person sends it to the bot */
async function pairVia(w, { project, role, userId, name }) {
  const made = await w.call("POST", "/pairing", { project, role });
  assert.equal(made.status, 201);
  const before = w.fake.sent.length;
  w.fake.say({ chatId: userId, userId, name, text: `/pair ${made.body.code}` });
  assert.ok(await w.waitSent(before + 1), `bot should answer the pairing of ${name} (polls=${w.fake.polls.length}, sent=${JSON.stringify(w.fake.sent)})`);
  return w.lastTo(userId);
}

test("pairing flow end to end: code minted in the UI, redeemed on Telegram, member lands in project.json", async () => {
  const w = await boot();
  const reply = await pairVia(w, { project: "demo-app", role: "owner", userId: 100, name: "Lan" });
  assert.match(reply, /owner of "demo-app"/);
  const members = listMembers({ projectsDir: w.projectsDir, slug: "demo-app" });
  assert.deepEqual(members.map((m) => [m.name, m.role, m.telegram.userId]), [["Lan", "owner", "100"]]);
  await w.close();
});

test("hasApprovers: a phone-only owner counts as someone watching, so approvals are not auto-skipped", async () => {
  const w = await boot();
  assert.equal(w.multi.hasApprovers(), false); // nobody paired yet
  await pairVia(w, { project: "demo-app", role: "viewer", userId: 102, name: "Cam" });
  assert.equal(w.multi.hasApprovers(), false); // a viewer cannot answer
  await pairVia(w, { project: "demo-app", role: "manager", userId: 101, name: "Binh" });
  assert.equal(w.multi.hasApprovers(), true);
  await w.close();

  // no channel configured at all: members exist but nobody can be reached
  const off = await boot({ env: { TELEGRAM_BOT_TOKEN: "" } });
  const { addMember } = await import("../src/members.js");
  addMember({ projectsDir: off.projectsDir, slug: "demo-app", name: "Lan", role: "owner", telegram: { userId: 100 } });
  assert.equal(off.multi.hasApprovers(), false);
  await off.close();
});

test("two projects, two Telegram rooms, two PMs running at the same time — and strangers hear nothing", async () => {
  const w = await boot();
  await pairVia(w, { project: "demo-app", role: "owner", userId: 100, name: "Lan" });
  await pairVia(w, { project: "acme-web", role: "owner", userId: 200, name: "Minh" });

  w.fake.say({ chatId: -1001, userId: 100, text: "/bind demo-app", group: true });
  w.fake.say({ chatId: -1002, userId: 200, text: "/bind acme-web", group: true });
  assert.ok(await w.fake.waitFor(() => w.lastTo(-1001) && w.lastTo(-1002)));

  w.fake.say({ chatId: -1001, userId: 100, name: "Lan", text: "how is demo?", group: true });
  w.fake.say({ chatId: -1002, userId: 200, name: "Minh", text: "how is acme?", group: true });
  assert.ok(await w.fake.waitFor(() => w.children["demo-app"] && w.children["acme-web"]));
  // both PMs are alive at once, in their own project's folder
  assert.deepEqual(w.children["demo-app"].asked(), ["[Lan (owner, telegram)] how is demo?"]);
  assert.deepEqual(w.children["acme-web"].asked(), ["[Minh (owner, telegram)] how is acme?"]);
  assert.deepEqual(w.multi.hub.list().map((p) => [p.slug, p.state]), [["acme-web", "working"], ["demo-app", "working"]]);

  w.children["acme-web"].reply("acme is fine", "s-acme");
  w.children["demo-app"].reply("demo is fine", "s-demo");
  assert.ok(await w.fake.waitFor(() => w.lastTo(-1001) === "demo is fine" && w.lastTo(-1002) === "acme is fine"));

  // a stranger in either room, or in DM, gets nothing at all
  const before = w.fake.sent.length;
  w.fake.say({ chatId: -1001, userId: 999, text: "hello?", group: true });
  w.fake.say({ chatId: 999, userId: 999, text: "/projects" });
  w.fake.say({ chatId: 999, userId: 999, text: "/approve deadbeef" });
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(w.fake.sent.length, before);
  assert.equal(w.children["demo-app"].asked().length, 1); // the stranger's "hello?" never reached the PM
  await w.close();
});

test("three roles over Telegram: viewer reads only, manager chats and approves, owner does everything", async () => {
  const w = await boot();
  await pairVia(w, { project: "demo-app", role: "owner", userId: 100, name: "Lan" });
  w.fake.say({ chatId: -1001, userId: 100, text: "/bind demo-app", group: true });
  assert.ok(await w.fake.waitFor(() => w.lastTo(-1001)));
  await pairVia(w, { project: "demo-app", role: "manager", userId: 101, name: "Binh" });
  await pairVia(w, { project: "demo-app", role: "viewer", userId: 102, name: "Cam" });

  // an agent in demo-app hits a permission prompt: the room is told, with the command to answer
  const pending = w.approvalBroker.request({ sessionId: "s1", tool: "Bash", preview: "npm publish", cwd: path.join(w.cwds["demo-app"], "src") });
  assert.ok(await w.fake.waitFor(() => /\/approve [0-9a-f]{8}/.test(w.lastTo(-1001) ?? "")));
  const short = /\/approve ([0-9a-f]{8})/.exec(w.lastTo(-1001))[1];
  assert.match(w.lastTo(-1001), /npm publish/);

  // viewer: can look, cannot talk to the PM, cannot approve
  w.fake.say({ chatId: -1001, userId: 102, text: "/status", group: true });
  assert.ok(await w.fake.waitFor(() => /PM: idle/.test(w.lastTo(-1001) ?? "")));
  w.fake.say({ chatId: -1001, userId: 102, text: "deploy now please", group: true });
  assert.ok(await w.fake.waitFor(() => /read-only/i.test(w.lastTo(-1001) ?? "")));
  w.fake.say({ chatId: -1001, userId: 102, text: `/approve ${short}`, group: true });
  assert.ok(await w.fake.waitFor(() => /cannot approve/i.test(w.lastTo(-1001) ?? "")));
  assert.equal(w.approvalBroker.list().length, 1, "the viewer must not have answered the approval");
  assert.equal(w.children["demo-app"], undefined, "the viewer's message must not have woken the PM");

  // manager: talks to the PM, and approves
  w.fake.say({ chatId: -1001, userId: 101, text: "status?", group: true });
  assert.ok(await w.fake.waitFor(() => w.children["demo-app"]));
  w.fake.say({ chatId: -1001, userId: 101, text: `/approve ${short}`, group: true });
  const decided = await pending;
  assert.equal(decided.decision, "allow");
  assert.ok(await w.fake.waitFor(() => /approved/i.test(w.lastTo(-1001) ?? "")));

  // owner: denies the next one
  const pending2 = w.approvalBroker.request({ sessionId: "s1", tool: "Write", preview: "secrets.txt", cwd: w.cwds["demo-app"] });
  assert.ok(await w.fake.waitFor(() => /secrets\.txt/.test(w.lastTo(-1001) ?? "")));
  const short2 = /\/deny ([0-9a-f]{8})/.exec(w.lastTo(-1001))[1];
  w.fake.say({ chatId: -1001, userId: 100, text: `/deny ${short2}`, group: true });
  assert.equal((await pending2).decision, "deny");
  await w.close();
});

test("end-of-day digest goes to each project's room once, and not at all to a project without one", async () => {
  const w = await boot();
  await pairVia(w, { project: "demo-app", role: "owner", userId: 100, name: "Lan" });
  w.fake.say({ chatId: -1001, userId: 100, text: "/bind demo-app", group: true });
  assert.ok(await w.fake.waitFor(() => w.lastTo(-1001)));
  const base = w.fake.sent.length;

  await w.multi.digest.runDue();
  const digests = w.fake.sent.slice(base).filter((s) => /end of day/.test(s.text));
  assert.equal(digests.length, 1); // acme-web has no room: nothing sent for it
  assert.equal(digests[0].chat_id, "-1001");
  assert.match(digests[0].text, /Done today: 1/);
  assert.match(digests[0].text, /demo-app landing/);

  await w.multi.digest.runDue();
  assert.equal(w.fake.sent.slice(base).filter((s) => /end of day/.test(s.text)).length, 1);

  w.clock.t += 86400_000; // the next evening
  await w.multi.digest.runDue();
  assert.equal(w.fake.sent.slice(base).filter((s) => /end of day/.test(s.text)).length, 2);
  await w.close();
});

test("HTTP API: overview, PM list, chat from the office, unread, pairing — and role gates", async () => {
  const w = await boot();
  const pm = await w.call("GET", "/pms");
  assert.equal(pm.status, 200);
  assert.deepEqual(pm.body.pms.map((p) => p.slug), ["acme-web", "demo-app"]);

  const sent = await w.call("POST", "/pm/send", { project: "demo-app", text: "hello from the office" });
  assert.equal(sent.status, 202);
  assert.equal((await w.call("POST", "/pm/send", { project: "nope", text: "x" })).status, 404);
  assert.equal((await w.call("POST", "/pm/send", { project: "demo-app", text: "  " })).status, 400);

  w.children["demo-app"].reply("hi!", "s1");
  let ov = await w.call("GET", "/overview");
  const demo = ov.body.projects.find((p) => p.slug === "demo-app");
  assert.deepEqual([demo.pm.state, demo.pm.unread], ["idle", 1]);
  assert.deepEqual(demo.items, { idea: 0, doing: 1, review: 0, done: 1, dropped: 0 });
  assert.equal(demo.pendingApprovals, 0);

  await w.call("POST", "/pm/read", { project: "demo-app" });
  ov = await w.call("GET", "/overview");
  assert.equal(ov.body.projects.find((p) => p.slug === "demo-app").pm.unread, 0);

  const code = await w.call("POST", "/pairing", { project: "demo-app", role: "viewer" });
  assert.equal(code.status, 201);
  assert.match(code.body.code, /^AO-/);
  assert.equal((await w.call("POST", "/pairing", { project: "demo-app", role: "emperor" })).status, 400);
  assert.equal((await w.call("POST", "/pairing", { project: "nope", role: "viewer" })).status, 404);
  assert.equal((await w.call("GET", "/pairing?project=demo-app")).body.codes.length, 1);

  assert.equal((await w.call("GET", "/channels")).body.channels.telegram.enabled, true);
  assert.equal((await w.call("GET", "/channels")).body.channels.zalo.enabled, false); // dormant
  await w.close();
});

test("HTTP API: a viewer may look but not talk, stop, mint codes or remove members", async () => {
  const w = await boot({ roleOf: () => "viewer" });
  assert.equal((await w.call("GET", "/overview")).status, 200);
  assert.equal((await w.call("GET", "/pms")).status, 200);
  assert.equal((await w.call("POST", "/pm/send", { project: "demo-app", text: "hi" })).status, 403);
  assert.equal((await w.call("POST", "/pm/stop", { project: "demo-app" })).status, 403);
  assert.equal((await w.call("POST", "/pairing", { project: "demo-app", role: "viewer" })).status, 403);
  assert.equal((await w.call("GET", "/pairing?project=demo-app")).status, 403);
  assert.equal((await w.call("POST", "/members/remove", { project: "demo-app", id: "m-x" })).status, 403);
  assert.equal(w.children["demo-app"], undefined);
  await w.close();
});

test("HTTP API: a manager can chat but not manage members; an owner can remove a member (never the last owner)", async () => {
  let role = "manager";
  const w = await boot({ roleOf: () => role });
  assert.equal((await w.call("POST", "/pm/send", { project: "demo-app", text: "hi" })).status, 202);
  assert.equal((await w.call("POST", "/pairing", { project: "demo-app", role: "viewer" })).status, 403);

  role = "owner";
  await pairVia(w, { project: "demo-app", role: "owner", userId: 100, name: "Lan" });
  await pairVia(w, { project: "demo-app", role: "viewer", userId: 102, name: "Cam" });
  const members = (await w.call("GET", "/members?project=demo-app")).body.members;
  assert.equal(members.length, 2);
  const lan = members.find((m) => m.name === "Lan");
  const cam = members.find((m) => m.name === "Cam");
  assert.equal((await w.call("POST", "/members/remove", { project: "demo-app", id: lan.id })).status, 400); // last owner
  assert.equal((await w.call("POST", "/members/remove", { project: "demo-app", id: cam.id })).status, 200);
  // removed means removed: Cam is a stranger again
  const before = w.fake.sent.length;
  w.fake.say({ chatId: 102, userId: 102, text: "/projects" });
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(w.fake.sent.length, before);
  await w.close();
});

test("the operator's TELEGRAM_CHAT_ID keeps working as before: owner everywhere, plain text → the default PM", async () => {
  const sentToDefault = [];
  const chatManager = {
    broadcast: () => {},
    send: (text) => { sentToDefault.push(text); queueMicrotask(() => chatManager.broadcast({ type: "chat_message", meta: { role: "assistant", text: "default PM here", done: true } })); return { accepted: true }; },
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ao-l5-legacy-"));
  const fake = await startFakeTelegram();
  const broker = new ApprovalBroker({ broadcast: () => {}, hasClients: () => true, makeEvent, ttlMs: 500 });
  const multi = createMultiPm({
    projectsDir: path.join(root, "projects"), stateDir: root, env: { TELEGRAM_BOT_TOKEN: fake.token, TELEGRAM_CHAT_ID: "555" },
    chatManager, approvalBroker: broker, broadcast: () => {}, telegramApiBase: fake.apiBase, telegramOffsetFile: path.join(root, "o.json"),
    log: { warn() {}, error() {}, log() {} },
  });
  multi.start();
  fake.say({ chatId: 555, userId: 555, text: "what's up" });
  assert.ok(await fake.waitFor(() => fake.sent.length === 1));
  assert.deepEqual(sentToDefault, ["what's up"]);
  assert.equal(fake.sent[0].text, "default PM here");
  multi.stop();
  await fake.close();
});

test("hostAllowed: loopback and IP literals pass; a rebinding-style host name does not unless allow-listed", () => {
  assert.equal(hostAllowed("127.0.0.1:8787"), true);
  assert.equal(hostAllowed("localhost:8787"), true);
  assert.equal(hostAllowed("[::1]:8787"), true);
  assert.equal(hostAllowed("192.168.1.20:8787"), true);
  assert.equal(hostAllowed("evil.example.com:8787"), false);
  assert.equal(hostAllowed("evil.example.com"), false);
  assert.equal(hostAllowed(undefined), false);
  assert.equal(hostAllowed("office.lan", "office.lan, other.lan"), true);
});

test("minting a pairing code through a foreign Host name (DNS rebinding) is refused; the same call on loopback works", async () => {
  const w = await boot();


  const port = Number(new URL(w.baseUrl).port);
  const viaHost = (host) => new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: "/pairing", method: "POST", headers: { host, "content-type": "application/json" } }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on("error", reject);
    req.end(JSON.stringify({ project: "demo-app", role: "owner" }));
  });
  assert.equal(await viaHost("evil.example.com"), 403);
  for (const route of ["/pm/send", "/overview", "/members?project=demo-app", "/pms"]) {
    const code = await new Promise((resolve, reject) => {
      const r = request({ host: "127.0.0.1", port, path: route, method: route === "/pm/send" ? "POST" : "GET", headers: { host: "evil.example.com" } }, (res) => { res.resume(); resolve(res.statusCode); });
      r.on("error", reject);
      r.end(route === "/pm/send" ? JSON.stringify({ project: "demo-app", text: "x" }) : undefined);
    });
    assert.equal(code, 403, route);
  }
  assert.equal(w.children["demo-app"], undefined); // nothing was spawned by the foreign-host call
  assert.equal(await viaHost(`127.0.0.1:${port}`), 201);
  assert.equal(w.multi.pairing.pending("demo-app").length, 1); // only the legitimate one exists
  await w.close();
});

test("the digest and the router share one state file: neither run erases the other's keys", async () => {
  const w = await boot();
  await pairVia(w, { project: "demo-app", role: "owner", userId: 100, name: "Lan" });
  await pairVia(w, { project: "acme-web", role: "owner", userId: 100, name: "Lan" }).catch(() => {});
  w.fake.say({ chatId: -1001, userId: 100, text: "/bind demo-app", group: true });
  assert.ok(await w.fake.waitFor(() => w.lastTo(-1001)));
  w.fake.say({ chatId: 100, userId: 100, text: "/use demo-app" });
  await new Promise((r) => setTimeout(r, 150));
  await w.multi.digest.runDue(); // writes digestSent
  w.fake.say({ chatId: 100, userId: 100, text: "/use demo-app" }); // router writes again
  await new Promise((r) => setTimeout(r, 150));
  const state = JSON.parse(fs.readFileSync(path.join(w.root, "channels-state.json"), "utf8"));
  assert.ok(state.digestSent?.["demo-app"], "digestSent survived the router's later write");
  assert.ok(Object.keys(state).some((k) => k.startsWith("dm:")), "the /use choice is still there");
  await w.close();
});
