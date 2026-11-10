import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PiiGuard, sumAudit } from "../src/pii-guard.js";
import { PolicyStore } from "../src/policy-store.js";

let root;
let projectsDir;

function mkProject(slug, extra = {}) {
  const dir = path.join(projectsDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ version: 1, slug, name: slug, template: "coding", cwd: path.join(root, slug), ...extra }));
}
const guard = (opts = {}) => new PiiGuard({ projectsDir, now: () => 1_700_000_000_000, ...opts });
const PHONE = "0912345678";

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ao-pii-guard-")));
  projectsDir = path.join(root, "projects");
  fs.mkdirSync(projectsDir, { recursive: true });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test("a shielded project's bound room gets masked text; the same text to another chat is untouched", () => {
  mkProject("crm", { policy: { piiGuard: true }, channels: { telegram: { chatId: "-1001" } } });
  const g = guard();
  assert.equal(g.apply("telegram", "-1001", `gọi ${PHONE}`), "gọi [phone ***678]");
  assert.equal(g.apply("telegram", "-9999", `gọi ${PHONE}`), `gọi ${PHONE}`);
});

test("a project without the flag, or with piiGuard:false, is never masked", () => {
  mkProject("plain", { channels: { telegram: { chatId: "-1" } } });
  mkProject("off", { policy: { piiGuard: false }, channels: { telegram: { chatId: "-2" } } });
  const g = guard();
  assert.equal(g.apply("telegram", "-1", PHONE), PHONE);
  assert.equal(g.apply("telegram", "-2", PHONE), PHONE);
});

test("a member's private chat (id = user id) is masked, on the channel the member uses", () => {
  mkProject("crm", { policy: { piiGuard: true }, members: [{ id: "m1", name: "Lan", role: "owner", telegram: { userId: "100" } }] });
  const g = guard();
  assert.equal(g.apply("telegram", 100, PHONE), "[phone ***678]");
  assert.equal(g.apply("zalo", "100", PHONE), PHONE); // not that member's Zalo id
});

test("the operator's own chat is masked as soon as ANY project has the shield on, and not before", () => {
  const legacy = [{ channel: "telegram", chatId: "555" }];
  mkProject("plain");
  assert.equal(guard({ legacy }).apply("telegram", "555", PHONE), PHONE);
  mkProject("crm", { policy: { piiGuard: true } });
  assert.equal(guard({ legacy }).apply("telegram", "555", PHONE), "[phone ***678]");
  assert.equal(guard({ legacy }).applyToOperator("telegram", `x ${PHONE}`), "x [phone ***678]");
});

test("the audit counts what was masked and never stores a value", () => {
  mkProject("crm", { policy: { piiGuard: true }, channels: { telegram: { chatId: "-1001" } } });
  const g = guard();
  g.apply("telegram", "-1001", `${PHONE} và khach@example.com và 079099012345`);
  g.apply("telegram", "-1001", "không có gì để che");
  const rows = g.readAudit("crm");
  assert.equal(rows.length, 1); // a message with nothing masked leaves no row
  assert.deepEqual({ phone: rows[0].phone, id: rows[0].id, email: rows[0].email }, { phone: 1, id: 1, email: 1 });
  assert.equal(rows[0].kind, "pii_redacted");
  assert.equal(rows[0].ts, 1_700_000_000_000);
  const raw = fs.readFileSync(path.join(projectsDir, "crm", "pii-audit.jsonl"), "utf8");
  assert.doesNotMatch(raw, /0912345678|example\.com|079099012345|345678/);
  assert.deepEqual(sumAudit(rows), { phone: 1, id: 1, email: 1 });
});

test("a failing audit write never un-masks the message", () => {
  mkProject("crm", { policy: { piiGuard: true }, channels: { telegram: { chatId: "-1001" } } });
  fs.mkdirSync(path.join(projectsDir, "crm", "pii-audit.jsonl")); // a directory where the file should go
  assert.equal(guard().apply("telegram", "-1001", PHONE), "[phone ***678]");
});

test("no projects directory at all: the guard is a no-op", () => {
  fs.rmSync(projectsDir, { recursive: true });
  assert.equal(guard().apply("telegram", "1", PHONE), PHONE);
});

test("the shield follows the flag as it is edited on disk", () => {
  mkProject("crm", { channels: { telegram: { chatId: "-1" } } });
  const g = guard({ store: new PolicyStore({ projectsDir, cacheMs: 0 }) });
  assert.equal(g.apply("telegram", "-1", PHONE), PHONE);
  mkProject("crm", { policy: { piiGuard: true }, channels: { telegram: { chatId: "-1" } } });
  assert.equal(g.apply("telegram", "-1", PHONE), "[phone ***678]");
  mkProject("crm", { policy: { piiGuard: false }, channels: { telegram: { chatId: "-1" } } });
  assert.equal(g.apply("telegram", "-1", PHONE), PHONE);
});
