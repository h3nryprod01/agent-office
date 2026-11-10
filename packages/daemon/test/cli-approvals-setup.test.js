// `ao approvals setup|remove`: the settings.json merge (pure + on a temp HOME), then the whole command
// against an in-process daemon (real router, broker, policy and pairing code) and a FAKE Telegram server.
// Nothing here touches the real ~/.claude, a real daemon, or the real Telegram API.

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  gatewayCommand, gatewayScript, planInstall, planRemove, readSettings, writeSettings, settingsPath, runApprovalsCommand, GATEWAY_FILE,
} from "../src/cli/approvals-setup.js";
import { createMultiPm } from "../src/multi-pm.js";
import { ApprovalBroker, createApprovalHttpHandler } from "../src/approvals.js";
import { PolicyStore } from "../src/policy-store.js";
import { createPolicyHttpHandler } from "../src/policy-http.js";
import { makeEvent } from "../src/event-schema.js";
import { startFakeTelegram } from "./fixtures/fake-telegram.js";

const REPO = "/opt/agent-office-checkout"; // made up
const CMD = gatewayCommand({ repo: REPO, port: 8787, platform: "darwin" });
const SCRIPT = gatewayScript(REPO);
const mkHome = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ao-setup-home-")));
const rm = (d) => fs.rmSync(d, { recursive: true, force: true });

// ── pure merge ──
test("the hook command points at the gateway script, and carries a non-default port", () => {
  assert.equal(CMD, `node '${REPO}/packages/daemon/hooks/${GATEWAY_FILE}'`);
  assert.match(gatewayCommand({ repo: REPO, port: 18787, platform: "darwin" }), /^AGENT_OFFICE_PORT=18787 node /);
  assert.doesNotMatch(gatewayCommand({ repo: REPO, port: 18787, platform: "win32" }), /AGENT_OFFICE_PORT/);
});

test("planInstall adds the hook and keeps every other key and every other hook", () => {
  const before = { model: "opus", permissions: { allow: ["Bash(ls)"] }, hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "x" }] }], PermissionRequest: [{ matcher: "Edit", hooks: [{ type: "command", command: "other-hook" }] }] } };
  const snapshot = JSON.stringify(before);
  const r = planInstall(before, CMD);
  assert.equal(r.ok, true);
  assert.equal(r.state, "added");
  assert.equal(JSON.stringify(before), snapshot, "the input must not be mutated");
  assert.equal(r.next.model, "opus");
  assert.deepEqual(r.next.permissions, before.permissions);
  assert.deepEqual(r.next.hooks.PreToolUse, before.hooks.PreToolUse);
  assert.equal(r.next.hooks.PermissionRequest.length, 2);
  assert.equal(r.next.hooks.PermissionRequest[0].hooks[0].command, "other-hook");
  assert.equal(r.next.hooks.PermissionRequest[1].matcher, "Bash|Edit|Write");
  assert.equal(r.next.hooks.PermissionRequest[1].hooks[0].timeout, 120);
});

test("planInstall on an empty settings object, twice: second time is 'already', no duplicate", () => {
  const first = planInstall({}, CMD);
  assert.equal(first.state, "added");
  const second = planInstall(first.next, CMD);
  assert.equal(second.state, "already");
  assert.equal(second.next.hooks.PermissionRequest.length, 1);
});

test("planInstall refuses shapes it would have to clobber, and a conflicting registration", () => {
  for (const bad of [[], "x", null, { hooks: [] }, { hooks: "x" }, { hooks: { PermissionRequest: {} } }]) {
    assert.equal(planInstall(bad, CMD).ok, false, JSON.stringify(bad));
  }
  const elsewhere = planInstall({}, gatewayCommand({ repo: "/other/checkout", port: 8787, platform: "darwin" })).next;
  const r = planInstall(elsewhere, CMD);
  assert.equal(r.ok, false);
  assert.match(r.error, /ao approvals remove/);
});

test("planRemove takes out only our hook, keeps a sibling hook in the same entry, and tidies empty containers", () => {
  const mixed = { hooks: { PermissionRequest: [{ matcher: "Bash", hooks: [{ type: "command", command: "other" }, { type: "command", command: CMD }] }] }, model: "m" };
  const r = planRemove(mixed, SCRIPT, "darwin");
  assert.equal(r.removed, 1);
  assert.deepEqual(r.next, { hooks: { PermissionRequest: [{ matcher: "Bash", hooks: [{ type: "command", command: "other" }] }] }, model: "m" });
  const only = planRemove(planInstall({ model: "m" }, CMD).next, SCRIPT, "darwin");
  assert.deepEqual(only.next, { model: "m" });
  assert.equal(planRemove({ model: "m" }, SCRIPT, "darwin").removed, 0);
});

test("the hook path is single-quoted, so a space or an apostrophe in it cannot break the command", () => {
  const odd = gatewayCommand({ repo: "/Users/o'brien/my repo", port: 8787, platform: "darwin" });
  assert.equal(odd, `node '/Users/o'\\''brien/my repo/packages/daemon/hooks/${GATEWAY_FILE}'`);
  assert.equal(gatewayCommand({ repo: "C:\\ao", port: 8787, platform: "win32" }).startsWith('node "'), true);
});

test("planRemove takes out only THIS checkout's hook and reports the other checkout's as left alone", () => {
  const other = gatewayCommand({ repo: "/other/checkout", port: 8787, platform: "darwin" });
  const both = { hooks: { PermissionRequest: [{ matcher: "Bash", hooks: [{ type: "command", command: other }] }, { matcher: "Bash", hooks: [{ type: "command", command: CMD }] }] } };
  const r = planRemove(both, SCRIPT, "darwin");
  assert.equal(r.removed, 1);
  assert.equal(r.foreign, 1);
  assert.deepEqual(r.next.hooks.PermissionRequest.map((e) => e.hooks[0].command), [other]);
  const onlyOther = planRemove({ hooks: { PermissionRequest: [{ hooks: [{ command: other }] }] } }, SCRIPT, "darwin");
  assert.equal(onlyOther.removed, 0);
  assert.equal(onlyOther.foreign, 1);
});

// ── files ──
test("writeSettings backs up first, keeps the file's permissions, and leaves no temp file", () => {
  const home = mkHome();
  const file = settingsPath(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ model: "opus" }), { mode: 0o640 });
  const { backup } = writeSettings(file, { model: "opus", extra: 1 }, { now: () => Date.UTC(2026, 10, 10, 8, 30, 0) });
  assert.match(path.basename(backup), /^settings\.json\.ao-backup-20261110-083000$/);
  assert.deepEqual(JSON.parse(fs.readFileSync(backup, "utf8")), { model: "opus" });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).extra, 1);
  assert.equal(fs.statSync(file).mode & 0o777, 0o640);
  assert.deepEqual(fs.readdirSync(path.dirname(file)).filter((f) => f.includes("tmp")), []);
  rm(home);
});

test("writeSettings on a symlinked settings.json writes the target and keeps the link", () => {
  const home = mkHome();
  const real = path.join(home, "dotfiles", "claude-settings.json");
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, JSON.stringify({ model: "opus" }));
  const link = settingsPath(home);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(real, link);
  const { backup } = writeSettings(link, { model: "opus", extra: 1 });
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, "the link must survive");
  assert.equal(JSON.parse(fs.readFileSync(real, "utf8")).extra, 1);
  assert.ok(backup.startsWith(path.dirname(real)), "the backup sits next to the real file");
  rm(home);
});

test("readSettings: missing file is {}, broken JSON is an error that names the problem", () => {
  const home = mkHome();
  const file = settingsPath(home);
  assert.deepEqual(readSettings(file), { ok: true, settings: {}, exists: false });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ not json");
  const r = readSettings(file);
  assert.equal(r.ok, false);
  assert.match(r.error, /not valid JSON; nothing was changed/);
  rm(home);
});

// ── the whole command ──
async function world({ telegram = true, projects = ["crm"] } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ao-setup-w-")));
  const projectsDir = path.join(root, "projects");
  const cwds = {};
  for (const slug of projects) {
    cwds[slug] = path.join(root, "repos", slug);
    fs.mkdirSync(cwds[slug], { recursive: true });
    fs.mkdirSync(path.join(projectsDir, slug), { recursive: true });
    fs.writeFileSync(path.join(projectsDir, slug, "project.json"), JSON.stringify({ version: 1, slug, name: slug, template: "coding", cwd: cwds[slug] }));
    fs.writeFileSync(path.join(projectsDir, slug, "items.json"), JSON.stringify({ version: 1, items: [] }));
  }
  const fake = await startFakeTelegram();
  const broadcasts = [];
  const server = { broadcast: (e) => broadcasts.push(e) };
  const broker = new ApprovalBroker({ broadcast: (e) => server.broadcast(e), hasClients: () => multi.hasApprovers(), makeEvent, ttlMs: 5000 }); // index.js wires the same
  // eslint-disable-next-line prefer-const
  let multi;
  multi = createMultiPm({
    projectsDir, stateDir: root, env: telegram ? { TELEGRAM_BOT_TOKEN: fake.token } : {}, approvalBroker: broker, broadcast: (e) => broadcasts.push(e),
    telegramApiBase: fake.apiBase, telegramOffsetFile: path.join(root, "offset.json"),
    spawnFn: () => { throw new Error("no PM in this test"); }, metricsUrl: () => null, log: { warn() {}, error() {}, log() {} },
  });
  multi.attach(server);
  multi.start();
  const approvalHttp = createApprovalHttpHandler(broker);
  const policyHttp = createPolicyHttpHandler({ store: new PolicyStore({ projectsDir, cacheMs: 0 }) });
  const api = createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    if (!(multi.http(req, res, url) || approvalHttp(req, res, url) || policyHttp(req, res, url))) { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const port = api.address().port;
  const home = mkHome();
  const logs = [];
  const run = (argv, over = {}) => runApprovalsCommand(argv, {
    repo: REPO, home, port, log: (m) => logs.push(m), env: {}, telegramApiBase: fake.apiBase,
    ...over,
  });
  return {
    root, projectsDir, home, fake, port, run, logs, broker, text: () => logs.join("\n"),
    settings: () => JSON.parse(fs.readFileSync(settingsPath(home), "utf8")),
    close: async () => { multi.stop(); await fake.close(); await new Promise((r) => { api.closeAllConnections?.(); api.close(r); }); rm(root); rm(home); },
  };
}

test("dry run on a temp HOME: runs to the end, writes NOTHING, sends no test approval, never prints a token", async () => {
  const w = await world();
  // the person pairs while the command waits
  const sleep = async () => {
    const codes = (await (await fetch(`http://127.0.0.1:${w.port}/pairing?project=crm`)).json()).codes ?? [];
    const code = codes[0]?.code;
    if (code && !w.paired) { w.paired = true; w.fake.say({ chatId: 100, userId: 100, name: "Lan", text: `/pair ${code}` }); }
    await new Promise((r) => setTimeout(r, 30));
  };
  const code = await w.run(["setup", "--dry-run"], { sleep, env: { TELEGRAM_BOT_TOKEN: w.fake.token } });
  assert.equal(code, 0, w.text());
  assert.equal(fs.existsSync(settingsPath(w.home)), false, "dry run must not create settings.json");
  assert.match(w.text(), /\(dry run: nothing written\)/);
  assert.match(w.text(), /PermissionRequest/);
  assert.match(w.text(), new RegExp(`AGENT_OFFICE_PORT=${w.port}`));
  assert.match(w.text(), /paired: Lan \(owner\)/);
  assert.match(w.text(), /\(dry run: not sent\)/);
  assert.equal(w.broker.list().length, 0, "no approval may have been requested");
  assert.doesNotMatch(w.text(), new RegExp(w.fake.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await w.close();
});

test("dry run refuses the default port 8787, before doing anything", async () => {
  const w = await world();
  const code = await w.run(["setup", "--dry-run"], { port: 8787 });
  assert.equal(code, 2);
  assert.match(w.text(), /refuses port 8787/);
  assert.equal(fs.existsSync(settingsPath(w.home)), false);
  await w.close();
});

test("full setup: asks before writing, backs up an existing file, merges, pairs, and the phone's Allow comes back", async () => {
  const w = await world();
  const file = settingsPath(w.home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ model: "opus", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "keep-me" }] }] } }));
  const asked = [];
  const ask = async (q) => (asked.push(q), "y");
  let tapped = false;
  const sleep = async () => {
    const codes = (await (await fetch(`http://127.0.0.1:${w.port}/pairing?project=crm`)).json()).codes ?? [];
    if (codes[0]?.code && !w.paired) { w.paired = true; w.fake.say({ chatId: 100, userId: 100, name: "Lan", text: `/pair ${codes[0].code}` }); }
    // once the test approval's message reaches the phone, tap Allow
    const alert = w.fake.sent.find((m) => /Approval needed/.test(m.text));
    if (alert && !tapped) { tapped = true; w.fake.tap({ chatId: 100, userId: 100, name: "Lan", data: alert.reply_markup.inline_keyboard[0][0].callback_data }); }
    await new Promise((r) => setTimeout(r, 30));
  };
  // the approval request blocks until the tap, so keep tapping from a side loop
  const tapper = setInterval(() => { void sleep(); }, 50);
  const code = await w.run(["setup"], { ask, sleep, env: {} });
  clearInterval(tapper);
  assert.equal(code, 0, w.text());
  assert.ok(asked.some((q) => /Write this to/.test(q)), "must ask before writing");
  const written = w.settings();
  assert.equal(written.model, "opus");
  assert.equal(written.hooks.PreToolUse[0].hooks[0].command, "keep-me");
  assert.equal(written.hooks.PermissionRequest.length, 1);
  assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.startsWith("settings.json.ao-backup-")), "a backup must exist");
  assert.match(w.text(), /got "allow" from your phone/);
  await w.close();
});

test("answering no (or no answer at all) writes nothing", async () => {
  const w = await world();
  const code = await w.run(["setup", "--wait", "0"], { ask: async () => "n", sleep: async () => {} });
  assert.equal(fs.existsSync(settingsPath(w.home)), false);
  assert.match(w.text(), /Not written/);
  assert.equal(code, 3); // stopped: nobody paired in time (--wait 0)
  await w.close();
});

test("remove: takes the hook out, backs up, and --dry-run shows without writing", async () => {
  const w = await world();
  const file = settingsPath(w.home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(planInstall({ model: "opus" }, gatewayCommand({ repo: REPO, port: w.port, platform: process.platform })).next));
  const before = fs.readFileSync(file, "utf8");
  assert.equal(await w.run(["remove", "--dry-run"], { port: w.port }), 0);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  assert.equal(await w.run(["remove", "--yes"]), 0);
  assert.deepEqual(w.settings(), { model: "opus" });
  assert.ok(fs.readdirSync(path.dirname(file)).some((f) => f.includes("ao-backup")));
  await w.close();
});

test("broken settings.json: the command stops and the file is untouched", async () => {
  const w = await world();
  const file = settingsPath(w.home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "{ nope");
  assert.equal(await w.run(["setup", "--yes"]), 1);
  assert.equal(fs.readFileSync(file, "utf8"), "{ nope");
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["settings.json"]);
  await w.close();
});

test("daemon without a bot token: explains how to make one, never stores or prints the token it was shown", async () => {
  const w = await world({ telegram: false });
  const code = await w.run(["setup", "--dry-run"], { env: { TELEGRAM_BOT_TOKEN: w.fake.token } });
  assert.equal(code, 3);
  assert.match(w.text(), /@BotFather/);
  assert.match(w.text(), /belongs to @fake_ao_bot/);
  assert.doesNotMatch(w.text(), new RegExp(w.fake.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  await w.close();
});

test("no daemon on that port: says so, still shows the hook, exits 1", async () => {
  const w = await world();
  const code = await w.run(["setup", "--dry-run"], { port: 1 });
  assert.equal(code, 1);
  assert.match(w.text(), /no Agent Office daemon answered on port 1/);
  assert.match(w.text(), /PermissionRequest/);
  await w.close();
});

test("with several projects, --project picks one and an unknown slug is an error", async () => {
  const w = await world({ projects: ["crm", "web"] });
  assert.equal(await w.run(["setup", "--dry-run", "--project", "nope"]), 1);
  assert.match(w.text(), /no project "nope"/);
  await w.close();
});

test("--port must be a whole number from 1 to 65535", async () => {
  const w = await world();
  for (const bad of [NaN, 0, 70000, 8787.5, -1]) {
    assert.equal(await w.run(["setup", "--dry-run"], { port: bad }), 2, String(bad));
  }
  assert.match(w.text(), /--port must be a whole number from 1 to 65535/);
  await w.close();
});

test("on Windows a port other than 8787 is refused instead of silently pointing the hook at 8787", async () => {
  const w = await world();
  assert.equal(await w.run(["setup", "--yes"], { platform: "win32" }), 2);
  assert.match(w.text(), /cannot carry a port other than 8787/);
  assert.equal(fs.existsSync(settingsPath(w.home)), false);
  await w.close();
});

test("remove --dry-run does not call the daemon, so it is allowed on the default port and changes nothing", async () => {
  const w = await world();
  const file = settingsPath(w.home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(planInstall({}, gatewayCommand({ repo: REPO, port: 8787, platform: process.platform })).next));
  const before = fs.readFileSync(file, "utf8");
  assert.equal(await w.run(["remove", "--dry-run"], { port: 8787, fetchFn: () => { throw new Error("must not touch the network"); } }), 0);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  await w.close();
});

test("the usage text says what --dry-run still does (pairing code, getMe) instead of 'sends nothing'", async () => {
  const w = await world();
  await w.run([]);
  assert.match(w.text(), /still talks to the daemon/);
  assert.match(w.text(), /pairing code/);
  assert.doesNotMatch(w.text(), /changes nothing and sends nothing/);
  await w.close();
});
