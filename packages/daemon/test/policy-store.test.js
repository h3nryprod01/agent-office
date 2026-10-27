import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PolicyStore } from "../src/policy-store.js";

let tmp;
let projectsDir;
let repoA;
let repoB;

function mkProject(slug, cwd, extra = {}) {
  const dir = path.join(projectsDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "project.json"),
    JSON.stringify({ version: 1, slug, name: slug, template: "coding", cwd, createdAt: "2026-01-01T00:00:00Z", ...extra }),
  );
}

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ao-policy-store-")));
  projectsDir = path.join(tmp, "projects");
  repoA = path.join(tmp, "work", "acme-web");
  repoB = path.join(tmp, "work", "acme-web-docs"); // shares a name prefix with repoA on purpose
  fs.mkdirSync(repoA, { recursive: true });
  fs.mkdirSync(path.join(repoA, "packages", "api"), { recursive: true });
  fs.mkdirSync(repoB, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("projectFor: longest-prefix match on directory boundaries, null when nothing matches", () => {
  mkProject("acme-web", repoA);
  mkProject("acme-docs", repoB);
  const store = new PolicyStore({ projectsDir });
  assert.equal(store.projectFor(repoA).slug, "acme-web");
  assert.equal(store.projectFor(path.join(repoA, "packages", "api")).slug, "acme-web");
  assert.equal(store.projectFor(repoB).slug, "acme-docs"); // not swallowed by the "acme-web" prefix
  assert.equal(store.projectFor(path.join(tmp, "elsewhere")), null);
  assert.equal(store.projectFor(null), null);
  assert.equal(store.projectFor(""), null);
});

test("projectFor: nested projects → the deeper one wins", () => {
  mkProject("outer", repoA);
  mkProject("inner", path.join(repoA, "packages", "api"));
  const store = new PolicyStore({ projectsDir });
  assert.equal(store.projectFor(path.join(repoA, "packages", "api", "src")).slug, "inner");
  assert.equal(store.projectFor(path.join(repoA, "packages")).slug, "outer");
});

test("a project without `policy` normalizes to ask / no data rules", () => {
  mkProject("acme-web", repoA);
  const store = new PolicyStore({ projectsDir });
  const p = store.projectFor(repoA);
  assert.equal(p.policy.approval.mode, "ask");
  assert.equal(p.policy.allowedHarnesses, null);
  assert.equal(p.hasPolicy, false);
});

test("missing projects dir and corrupt project.json are tolerated", () => {
  const store = new PolicyStore({ projectsDir });
  assert.equal(store.projectFor(repoA), null);
  mkProject("good", repoA);
  fs.mkdirSync(path.join(projectsDir, "broken"));
  fs.writeFileSync(path.join(projectsDir, "broken", "project.json"), "{not json");
  assert.equal(new PolicyStore({ projectsDir }).projectFor(repoA).slug, "good");
});

test("setPolicy writes only the policy key, preserves siblings (members), validates, refreshes the cache", () => {
  mkProject("acme-web", repoA, { members: [{ id: "m1", role: "manager" }] });
  const store = new PolicyStore({ projectsDir });
  assert.equal(store.projectFor(repoA).policy.approval.mode, "ask"); // warm the cache
  const saved = store.setPolicy("acme-web", { approval: { mode: "read-only" }, allowedHarnesses: ["claude"] });
  assert.equal(saved.approval.mode, "read-only");
  const onDisk = JSON.parse(fs.readFileSync(path.join(projectsDir, "acme-web", "project.json"), "utf8"));
  assert.deepEqual(onDisk.members, [{ id: "m1", role: "manager" }]);
  assert.equal(onDisk.policy.approval.mode, "read-only");
  assert.equal(store.projectFor(repoA).policy.approval.mode, "read-only"); // cache invalidated by the write
  assert.equal(store.projectFor(repoA).hasPolicy, true);

  assert.throws(() => store.setPolicy("acme-web", { approval: { mode: "yolo" } }), (e) => e.code === "INVALID");
  assert.throws(() => store.setPolicy("nope", {}), (e) => e.code === "NOT_FOUND");
  assert.throws(() => store.setPolicy("../evil", {}), (e) => e.code === "INVALID");
});

test("getPolicy: unknown slug → NOT_FOUND", () => {
  assert.throws(() => new PolicyStore({ projectsDir }).getPolicy("ghost"), (e) => e.code === "NOT_FOUND");
});

test("audit: append + newest-first read, limit, survives garbage lines", () => {
  mkProject("acme-web", repoA);
  const store = new PolicyStore({ projectsDir });
  for (let i = 0; i < 5; i++) store.appendAudit("acme-web", { ts: 1000 + i, tool: "Bash", decision: "allow", n: i });
  fs.appendFileSync(path.join(projectsDir, "acme-web", "policy-audit.jsonl"), "garbage line\n");
  const rows = store.readAudit("acme-web", 3);
  assert.deepEqual(rows.map((r) => r.n), [4, 3, 2]);
  assert.equal(store.readAudit("acme-web", 100).length, 5);
  assert.deepEqual(store.readAudit("never-written", 10), []);
});

test("audit: the file is trimmed instead of growing forever", () => {
  mkProject("acme-web", repoA);
  const store = new PolicyStore({ projectsDir, auditMaxBytes: 2000, auditKeepLines: 10 });
  for (let i = 0; i < 100; i++) store.appendAudit("acme-web", { ts: i, tool: "Bash", decision: "allow", pad: "x".repeat(50) });
  const rows = store.readAudit("acme-web", 1000);
  assert.ok(rows.length <= 60, `kept ${rows.length}`);
  assert.equal(rows[0].ts, 99); // newest survives
});
