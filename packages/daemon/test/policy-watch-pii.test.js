import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { attachPolicyWatch } from "../src/policy-watch.js";
import { PolicyStore } from "../src/policy-store.js";
import { makeEvent } from "../src/event-schema.js";

let tmp, projectsDir, repo, store, clock;

function mkProject(policy) {
  const dir = path.join(projectsDir, "crm");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ version: 1, slug: "crm", name: "CRM Lead", template: "coding", cwd: repo, ...(policy ? { policy } : {}) }));
}
function watch(opts = {}) {
  const sent = [];
  const delivered = [];
  const server = { broadcast: (e) => sent.push(e) };
  attachPolicyWatch(server, { store, deliver: (n) => delivered.push(n), now: () => clock, enabled: true, officeUrl: "http://localhost:5199", ...opts });
  return { server, sent, delivered, alerts: () => sent.filter((e) => e.type === "policy_alert") };
}
const ev = (over = {}) => makeEvent({ id: `e-${Math.random()}`, type: "tool_call", sessionId: "sess-1", cwd: repo, harness: "claude-code", ts: clock, status: "ok", ...over });

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ao-watch-pii-")));
  projectsDir = path.join(tmp, "projects");
  repo = path.join(tmp, "work", "crm");
  fs.mkdirSync(repo, { recursive: true });
  store = new PolicyStore({ projectsDir, cacheMs: 0 });
  clock = 1_700_000_000_000;
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("piiGuard on and no allowedHarnesses: one clear warning for the project, however many sessions and events follow", () => {
  mkProject({ piiGuard: true });
  const w = watch();
  w.server.broadcast(ev());
  w.server.broadcast(ev({ sessionId: "sess-2" }));
  w.server.broadcast(ev());
  assert.equal(w.alerts().length, 1);
  const a = w.alerts()[0];
  assert.equal(a.meta.kind, "pii_no_allowlist");
  assert.match(a.detail, /personal-data shield/i);
  assert.match(a.detail, /allowedHarnesses/);
  assert.match(a.detail, /warning only|does not block/i);
  assert.equal(w.delivered.length, 1);
  assert.match(w.delivered[0].message, /allowedHarnesses/);
});

test("piiGuard on with allowedHarnesses set and an allowed harness: no warning at all", () => {
  mkProject({ piiGuard: true, allowedHarnesses: ["claude"] });
  const w = watch();
  w.server.broadcast(ev());
  assert.equal(w.alerts().length, 0);
  assert.equal(w.delivered.length, 0);
});

test("piiGuard on and a session of a harness outside the list: the violation alert names the personal-data risk", () => {
  mkProject({ piiGuard: true, allowedHarnesses: ["claude"] });
  const w = watch();
  w.server.broadcast(ev({ harness: "codex" }));
  const alerts = w.alerts();
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].meta.kind, "harness");
  assert.match(alerts[0].detail, /personal data/i);
  assert.match(alerts[0].detail, /not allowed/);
  assert.match(w.delivered[0].message, /personal data/i);
});

test("without piiGuard nothing new is said (the plain data-rule behaviour is unchanged)", () => {
  mkProject({ allowedHarnesses: ["claude"] });
  const w = watch();
  w.server.broadcast(ev());
  assert.equal(w.alerts().length, 0);
  mkProject(null);
  const w2 = watch();
  w2.server.broadcast(ev({ sessionId: "other" }));
  assert.equal(w2.alerts().length, 0);
});

test("the warning does not block the event stream", () => {
  mkProject({ piiGuard: true });
  const w = watch();
  w.server.broadcast(ev());
  assert.equal(w.sent.filter((e) => e.type === "tool_call").length, 1);
});
