import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePolicy, validatePolicy, requiredRole } from "../src/policy.js";

test("piiGuard is off unless the project turns it on, and the default shape does not change", () => {
  assert.equal(Object.hasOwn(normalizePolicy(undefined), "piiGuard"), false);
  assert.equal(normalizePolicy({ piiGuard: false }).piiGuard, false); // explicit off is remembered (see the store test below)
  assert.equal(normalizePolicy({ piiGuard: true }).piiGuard, true);
});

test("normalizePolicy ignores a garbage piiGuard instead of switching the shield on or throwing", () => {
  for (const junk of ["true", 1, {}, [], null, "yes"]) {
    assert.equal(Object.hasOwn(normalizePolicy({ piiGuard: junk }), "piiGuard"), false, JSON.stringify(junk));
  }
});

test("validatePolicy accepts a boolean piiGuard and rejects anything else", () => {
  assert.equal(validatePolicy({ piiGuard: true }).piiGuard, true);
  assert.equal(validatePolicy({ piiGuard: false }).piiGuard, false);
  for (const bad of ["true", 1, null, {}, []]) {
    assert.throws(() => validatePolicy({ piiGuard: bad }), (e) => e.code === "INVALID", JSON.stringify(bad));
  }
});

test("requiredRole: switching the shield OFF explicitly is owner work; a save that just does not mention it is not", () => {
  const n = (raw) => normalizePolicy(raw);
  assert.equal(requiredRole(n({ piiGuard: true }), n({})), "manager"); // the store keeps the flag, so nothing loosens
  assert.equal(requiredRole(n({ piiGuard: true }), n({ approval: { mode: "deny" } })), "manager");
  assert.equal(requiredRole(n({ piiGuard: true }), n({ piiGuard: false })), "owner");
  assert.equal(requiredRole(n({}), n({ piiGuard: true })), "manager");
  assert.equal(requiredRole(n({ piiGuard: true }), n({ piiGuard: true, approval: { mode: "deny" } })), "manager");
});

// ── the stored flag survives a save from a panel that does not know about it ──
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PolicyStore } from "../src/policy-store.js";

function storeWith(policy) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-pii-store-"));
  fs.mkdirSync(path.join(dir, "acme-web"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "acme-web", "project.json"),
    JSON.stringify({ version: 1, slug: "acme-web", name: "Acme Web", template: "coding", cwd: dir, createdAt: "2026-01-01T00:00:00Z", ...(policy ? { policy } : {}) }),
  );
  return { dir, store: new PolicyStore({ projectsDir: dir, cacheMs: 0 }) };
}
const onDisk = (dir) => JSON.parse(fs.readFileSync(path.join(dir, "acme-web", "project.json"), "utf8")).policy;

test("saving a policy that does not mention piiGuard keeps it on (an older settings panel must not switch the shield off)", () => {
  const { dir, store } = storeWith({ piiGuard: true });
  store.setPolicy("acme-web", { approval: { mode: "ask" } });
  assert.equal(onDisk(dir).piiGuard, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("saving piiGuard:false switches it off, explicitly (also through the normalized form the HTTP handler passes)", () => {
  const { dir, store } = storeWith({ piiGuard: true });
  store.setPolicy("acme-web", normalizePolicy(validatePolicy({ piiGuard: false })));
  assert.equal(onDisk(dir).piiGuard, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a project that never had piiGuard does not gain it by being saved", () => {
  const { dir, store } = storeWith(null);
  store.setPolicy("acme-web", { approval: { mode: "deny" } });
  assert.equal(Object.hasOwn(onDisk(dir), "piiGuard"), false);
  fs.rmSync(dir, { recursive: true, force: true });
});
