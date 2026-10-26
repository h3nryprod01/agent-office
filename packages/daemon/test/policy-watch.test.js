import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attachPolicyWatch } from "../src/policy-watch.js";
import { PolicyStore } from "../src/policy-store.js";
import { makeEvent } from "../src/event-schema.js";

let tmp;
let projectsDir;
let repo;
let store;

function mkProject(slug, cwd, policy) {
  const dir = path.join(projectsDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "project.json"),
    JSON.stringify({ version: 1, slug, name: "Acme Web", template: "coding", cwd, createdAt: "2026-01-01T00:00:00Z", ...(policy ? { policy } : {}) }),
  );
}

/** A server stand-in with the one method the watcher wraps. */
function fakeServer() {
  const sent = [];
  return { sent, broadcast: (e) => sent.push(e) };
}

let clock;
function watch(server, opts = {}) {
  const delivered = [];
  attachPolicyWatch(server, { store, deliver: (n) => delivered.push(n), now: () => clock, enabled: true, officeUrl: "http://localhost:5199", ...opts });
  return delivered;
}
const ev = (over = {}) =>
  makeEvent({ id: `e-${Math.random()}`, type: "tool_call", sessionId: "sess-1", cwd: repo, harness: "codex", ts: clock, status: "ok", ...over });

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ao-policy-watch-")));
  projectsDir = path.join(tmp, "projects");
  repo = path.join(tmp, "work", "acme-web");
  fs.mkdirSync(repo, { recursive: true });
  store = new PolicyStore({ projectsDir, cacheMs: 0 });
  clock = 1_700_000_000_000;
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("a forbidden harness raises ONE alert (event + OS notification) per session, however many events follow", () => {
  mkProject("acme-web", repo, { allowedHarnesses: ["claude"] });
  const server = fakeServer();
  const delivered = watch(server);
  server.broadcast(ev());
  server.broadcast(ev());
  server.broadcast(ev());
  const alerts = server.sent.filter((e) => e.type === "policy_alert");
  assert.equal(alerts.length, 1);
  assert.equal(server.sent.filter((e) => e.type === "tool_call").length, 3); // transcripts are never blocked
  assert.equal(alerts[0].meta.kind, "harness");
  assert.equal(alerts[0].meta.value, "codex");
  assert.deepEqual(alerts[0].meta.allowed, ["claude"]);
  assert.equal(alerts[0].meta.project, "acme-web");
  assert.equal(alerts[0].meta.targetSessionId, "sess-1");
  assert.equal(alerts[0].status, "ok"); // NOT "error": the stuck-agent notifier must not adopt it
  assert.notEqual(alerts[0].agentId, "sess-1"); // and must not count as sign of life for the real agent
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].message, /codex/);
  assert.match(delivered[0].url, /focus=sess-1/);
});

test("allowed harness, no rule, or cwd outside every project → silence", () => {
  mkProject("acme-web", repo, { allowedHarnesses: ["claude", "codex"] });
  const server = fakeServer();
  const delivered = watch(server);
  server.broadcast(ev({ harness: "codex" }));
  server.broadcast(ev({ sessionId: "sess-2", harness: "claude-code" })); // transcript name for "claude"
  server.broadcast(ev({ sessionId: "sess-3", harness: "gemini", cwd: path.join(tmp, "elsewhere") }));
  assert.equal(server.sent.filter((e) => e.type === "policy_alert").length, 0);
  assert.equal(delivered.length, 0);
});

test("project without any policy → silence (old projects behave as before)", () => {
  mkProject("acme-web", repo);
  const server = fakeServer();
  const delivered = watch(server);
  server.broadcast(ev({ harness: "gemini" }));
  assert.equal(server.sent.length, 1);
  assert.equal(delivered.length, 0);
});

test("the worker harness is refused in a company project that only allows claude", () => {
  mkProject("acme-web", repo, { allowedHarnesses: ["claude"] });
  const server = fakeServer();
  watch(server);
  server.broadcast(ev({ harness: "claude-worker", sessionId: "w-1" }));
  assert.equal(server.sent.filter((e) => e.type === "policy_alert")[0].meta.value, "claude-worker");
});

test("lane rule: judged only when the event reports a lane", () => {
  mkProject("acme-web", repo, { allowedLanes: ["glm"] });
  const server = fakeServer();
  watch(server);
  server.broadcast(ev({ harness: "claude-worker", sessionId: "a" })); // no lane → cannot judge
  server.broadcast(ev({ harness: "claude-worker", sessionId: "b", meta: { lane: "kimi" } }));
  const alerts = server.sent.filter((e) => e.type === "policy_alert");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].meta.kind, "lane");
  assert.equal(alerts[0].meta.value, "kimi");
});

test("history replay (old timestamps) does not alert", () => {
  mkProject("acme-web", repo, { allowedHarnesses: ["claude"] });
  const server = fakeServer();
  const delivered = watch(server);
  server.broadcast(ev({ ts: clock - 60 * 60 * 1000 }));
  assert.equal(server.sent.filter((e) => e.type === "policy_alert").length, 0);
  assert.equal(delivered.length, 0);
});

test("a rule added while the session is already running is caught on a later event", () => {
  mkProject("acme-web", repo);
  const server = fakeServer();
  const delivered = watch(server);
  server.broadcast(ev());
  assert.equal(delivered.length, 0);
  store.setPolicy("acme-web", { allowedHarnesses: ["claude"] });
  server.broadcast(ev()); // inside the recheck interval: still not looked at
  assert.equal(delivered.length, 0);
  clock += 61_000;
  server.broadcast(ev());
  assert.equal(delivered.length, 1);
  clock += 61_000;
  server.broadcast(ev());
  assert.equal(delivered.length, 1); // deduped
});

test("notifications off → the in-office alert still fires, the OS one does not", () => {
  mkProject("acme-web", repo, { allowedHarnesses: ["claude"] });
  const server = fakeServer();
  const delivered = watch(server, { enabled: false });
  server.broadcast(ev());
  assert.equal(server.sent.filter((e) => e.type === "policy_alert").length, 1);
  assert.equal(delivered.length, 0);
});

test("events without a session/cwd (chat, roster, approvals) and the alert itself are ignored; a throwing store never breaks delivery", () => {
  mkProject("acme-web", repo, { allowedHarnesses: ["claude"] });
  const server = fakeServer();
  watch(server);
  server.broadcast(makeEvent({ id: "r", type: "roster_updated", sessionId: "company-roster", ts: clock }));
  server.broadcast(makeEvent({ id: "a", type: "approval_pending", sessionId: "s", cwd: repo, harness: "codex", ts: clock }));
  assert.equal(server.sent.filter((e) => e.type === "policy_alert").length, 0);
  store.projectFor = () => {
    throw new Error("boom");
  };
  server.broadcast(ev({ sessionId: "z" }));
  assert.equal(server.sent.filter((e) => e.type === "tool_call").length, 1);
});
