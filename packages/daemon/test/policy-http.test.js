import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventBroadcastServer } from "../src/ws-server.js";
import { PolicyStore } from "../src/policy-store.js";
import { createPolicyHttpHandler, loopbackRole } from "../src/policy-http.js";
import { requiredRole, normalizePolicy } from "../src/policy.js";

let tmp;
let projectsDir;
let store;
let srv;
let base;
let role = "owner"; // what the injected roleOf returns

function mkProject(slug, cwd, policy) {
  const dir = path.join(projectsDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "project.json"),
    JSON.stringify({ version: 1, slug, name: slug, template: "coding", cwd, createdAt: "2026-01-01T00:00:00Z", ...(policy ? { policy } : {}) }),
  );
}
const get = (p) => fetch(`${base}${p}`).then(async (r) => ({ status: r.status, body: await r.json() }));
const post = (p, body) =>
  fetch(`${base}${p}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

beforeEach(async () => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ao-policy-http-")));
  projectsDir = path.join(tmp, "projects");
  const repo = path.join(tmp, "work", "acme-web");
  fs.mkdirSync(repo, { recursive: true });
  mkProject("acme-web", repo);
  store = new PolicyStore({ projectsDir, cacheMs: 0 });
  role = "owner";
  srv = new EventBroadcastServer({ port: 0, extraHttp: createPolicyHttpHandler({ store, roleOf: () => role }) });
  await srv.start();
  base = `http://127.0.0.1:${srv.server.address().port}`;
});
afterEach(async () => {
  await srv.stop();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("requiredRole: tightening is manager work, loosening to auto or touching data rules is owner work", () => {
  const n = (raw) => normalizePolicy(raw);
  assert.equal(requiredRole(n({}), n({ approval: { mode: "deny" } })), "manager");
  assert.equal(requiredRole(n({ approval: { mode: "auto" } }), n({ approval: { mode: "ask" } })), "manager");
  assert.equal(requiredRole(n({}), n({ approval: { mode: "auto" } })), "owner");
  assert.equal(requiredRole(n({}), n({ approval: { roles: { qa: "auto" } } })), "owner");
  assert.equal(requiredRole(n({}), n({ approval: { tools: { Bash: "auto" } } })), "owner");
  // an auto that was already there is not "new"
  assert.equal(requiredRole(n({ approval: { tools: { Bash: "auto" } } }), n({ approval: { tools: { Bash: "auto" }, mode: "deny" } })), "manager");
  // loosening WITHOUT writing "auto" is still loosening
  assert.equal(requiredRole(n({ approval: { mode: "deny" } }), n({ approval: { mode: "ask" } })), "owner");
  assert.equal(requiredRole(n({ approval: { mode: "read-only" } }), n({ approval: { mode: "ask" } })), "owner");
  assert.equal(requiredRole(n({ approval: { tools: { Bash: "deny" } } }), n({})), "owner");
  assert.equal(requiredRole(n({ approval: { roles: { qa: "read-only" } } }), n({ approval: { roles: { qa: "ask" } } })), "owner");
  assert.equal(requiredRole(n({ approval: { tools: { Bash: "deny" } } }), n({ approval: { tools: { Bash: "read-only" } } })), "owner");
  assert.equal(requiredRole(n({ approval: { tools: { Bash: "ask" } } }), n({ approval: { tools: { Bash: "deny" } } })), "manager");
  assert.equal(requiredRole(n({}), n({ allowedHarnesses: ["claude"] })), "owner");
  assert.equal(requiredRole(n({ allowedHarnesses: ["claude"] }), n({ allowedHarnesses: ["claude"] })), "manager");
});

test("GET /policy lists projects with their normalized policy and the repo name the office tabs use", async () => {
  const { status, body } = await get("/policy");
  assert.equal(status, 200);
  assert.equal(body.projects.length, 1);
  assert.equal(body.projects[0].slug, "acme-web");
  assert.equal(body.projects[0].repo, "other"); // tmp dir is not a git repo → deriveRepo's fallback
  assert.equal(body.projects[0].policy.approval.mode, "ask");
  assert.equal(body.projects[0].hasPolicy, false);
});

test("GET /policy?project= returns one; unknown → 404; bad slug → 400", async () => {
  assert.equal((await get("/policy?project=acme-web")).body.policy.approval.mode, "ask");
  assert.equal((await get("/policy?project=ghost")).status, 404);
  assert.equal((await get("/policy?project=..%2Fevil")).status, 400);
});

test("POST /policy by an owner: sets auto, persists to project.json", async () => {
  const { status, body } = await post("/policy", { project: "acme-web", policy: { approval: { mode: "auto" }, allowedHarnesses: ["claude"] } });
  assert.equal(status, 200);
  assert.equal(body.policy.approval.mode, "auto");
  const onDisk = JSON.parse(fs.readFileSync(path.join(projectsDir, "acme-web", "project.json"), "utf8"));
  assert.equal(onDisk.policy.approval.mode, "auto");
  assert.deepEqual(onDisk.policy.allowedHarnesses, ["claude"]);
});

test("POST /policy by a manager: may tighten, may NOT switch anything to auto or edit data rules", async () => {
  role = "manager";
  assert.equal((await post("/policy", { project: "acme-web", policy: { approval: { mode: "read-only" } } })).status, 200);
  const denied = await post("/policy", { project: "acme-web", policy: { approval: { mode: "auto" } } });
  assert.equal(denied.status, 403);
  assert.match(denied.body.error, /owner/);
  assert.equal((await post("/policy", { project: "acme-web", policy: { allowedHarnesses: ["codex"] } })).status, 403);
  assert.equal((await get("/policy?project=acme-web")).body.policy.approval.mode, "read-only"); // unchanged by the refused writes
});

test("POST /policy by a viewer or an unknown caller → 403; viewers may still read", async () => {
  role = "viewer";
  assert.equal((await post("/policy", { project: "acme-web", policy: { approval: { mode: "deny" } } })).status, 403);
  assert.equal((await get("/policy")).status, 200);
  role = null;
  assert.equal((await get("/policy")).status, 403);
  assert.equal((await post("/policy", { project: "acme-web", policy: {} })).status, 403);
});

test("POST /policy: invalid body → 400 and nothing is written", async () => {
  for (const body of [
    { project: "acme-web", policy: { approval: { mode: "yolo" } } },
    { project: "acme-web", policy: "x" },
    { project: "acme-web" },
    { policy: {} },
  ]) {
    assert.equal((await post("/policy", body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await post("/policy", { project: "ghost", policy: {} })).status, 404);
  assert.equal((await get("/policy?project=acme-web")).body.hasPolicy, false);
});

test("GET /policy/audit: per project newest-first, or merged across projects; limit honoured", async () => {
  fs.mkdirSync(path.join(tmp, "work", "other-app"), { recursive: true });
  mkProject("other-app", path.join(tmp, "work", "other-app"));
  store.appendAudit("acme-web", { ts: 1, tool: "Bash", decision: "allow", project: "acme-web" });
  store.appendAudit("acme-web", { ts: 3, tool: "Edit", decision: "deny", project: "acme-web" });
  store.appendAudit("other-app", { ts: 2, tool: "Write", decision: "allow", project: "other-app" });
  assert.deepEqual((await get("/policy/audit?project=acme-web")).body.items.map((r) => r.ts), [3, 1]);
  assert.deepEqual((await get("/policy/audit")).body.items.map((r) => r.ts), [3, 2, 1]);
  assert.deepEqual((await get("/policy/audit?limit=2")).body.items.map((r) => r.ts), [3, 2]);
  assert.equal((await get("/policy/audit?project=ghost")).status, 404);
});

test("unrelated routes fall through (handler returns false)", async () => {
  assert.equal((await fetch(`${base}/nothing-here`)).status, 404);
});

test("POST /policy without a JSON content type → 415 (a cross-origin form/text post cannot reach it)", async () => {
  const r = await fetch(`${base}/policy`, { method: "POST", body: JSON.stringify({ project: "acme-web", policy: { approval: { mode: "deny" } } }) });
  assert.equal(r.status, 415);
  assert.equal((await get("/policy?project=acme-web")).body.hasPolicy, false);
});

test("loopbackRole: a rebound hostname is not the owner even over a loopback socket", () => {
  const req = (host) => ({ socket: { remoteAddress: "127.0.0.1" }, headers: { host } });
  assert.equal(loopbackRole(req("localhost:8787")), "owner");
  assert.equal(loopbackRole(req("127.0.0.1:8787")), "owner");
  assert.equal(loopbackRole(req("[::1]:8787")), "owner");
  assert.equal(loopbackRole(req("evil.example.com:8787")), null);
});

test("loopbackRole: owner for a plain loopback socket, nobody for anything else or proxied", () => {
  const req = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers });
  assert.equal(loopbackRole(req("127.0.0.1")), "owner");
  assert.equal(loopbackRole(req("::1")), "owner");
  assert.equal(loopbackRole(req("::ffff:127.0.0.1")), "owner");
  assert.equal(loopbackRole(req("192.168.1.20")), null); // leak-ok: invented fixture value
  assert.equal(loopbackRole(req("127.0.0.1", { "x-forwarded-for": "8.8.8.8" })), null);
  assert.equal(loopbackRole({ headers: {} }), null);
});
