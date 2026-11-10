import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PiiGuard, sumAudit } from "../src/pii-guard.js";

let root;
let projectsDir;

function mkProject(slug, extra = {}) {
  const dir = path.join(projectsDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ version: 1, slug, name: slug, template: "coding", cwd: path.join(root, slug), ...extra }));
}
const warnings = [];
const guard = (opts = {}) => new PiiGuard({ projectsDir, now: () => 1_700_000_000_000, log: { warn: (m) => warnings.push(m) }, ...opts });
const PHONE = "0912345678";

beforeEach(() => {
  warnings.length = 0;
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
  const g = guard();
  assert.equal(g.apply("telegram", "-1", PHONE), PHONE);
  mkProject("crm", { policy: { piiGuard: true }, channels: { telegram: { chatId: "-1" } } });
  assert.equal(g.apply("telegram", "-1", PHONE), "[phone ***678]");
  mkProject("crm", { policy: { piiGuard: false }, channels: { telegram: { chatId: "-1" } } });
  assert.equal(g.apply("telegram", "-1", PHONE), PHONE);
});

// ── fail closed (the shield must never switch itself off because something could not be read) ──
const plainRoom = { channels: { telegram: { chatId: "-77" } } };

test("FAIL CLOSED: the project list cannot be listed → every chat is masked, with one warning", () => {
  mkProject("plain", plainRoom);
  const g = guard({ readDir: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } });
  assert.equal(g.apply("telegram", "-77", PHONE), "[phone ***678]");
  assert.equal(g.apply("telegram", "-1", PHONE), "[phone ***678]");
  assert.equal(g.applyToOperator("telegram", PHONE), "[phone ***678]");
  assert.equal(g.maskForProject("plain", PHONE), "[phone ***678]");
  assert.equal(warnings.length, 1, "one warning per outage, not per message");
  assert.match(warnings[0], /masking all chat output/);
  assert.doesNotMatch(warnings[0], /0912|plain|-77/); // no data in the log line
});

test("FAIL CLOSED: a project with a corrupt project.json → every chat is masked", () => {
  mkProject("plain", plainRoom);
  fs.mkdirSync(path.join(projectsDir, "broken"), { recursive: true });
  fs.writeFileSync(path.join(projectsDir, "broken", "project.json"), "{ not json");
  const g = guard();
  assert.equal(g.apply("telegram", "-77", PHONE), "[phone ***678]");
  assert.equal(warnings.length, 1);
});

test("FAIL CLOSED: a project.json that is valid JSON but not an object → every chat is masked", () => {
  mkProject("plain", plainRoom);
  fs.mkdirSync(path.join(projectsDir, "odd"), { recursive: true });
  fs.writeFileSync(path.join(projectsDir, "odd", "project.json"), "[]");
  assert.equal(guard().apply("telegram", "-77", PHONE), "[phone ***678]");
});

test("FAIL CLOSED: piiGuard:true on a project whose policy is invalid in another field is still shielded", () => {
  mkProject("crm", { policy: { piiGuard: true, approval: { mode: "yolo" }, allowedHarnesses: "claude", unknownKey: 1 }, channels: { telegram: { chatId: "-5" } } });
  const g = guard();
  assert.equal(g.apply("telegram", "-5", PHONE), "[phone ***678]");
  assert.deepEqual(g.shielded(), ["crm"]);
});

test("FAIL CLOSED: a piiGuard value that is not a clean boolean (\"true\", 1) counts as on", () => {
  mkProject("crm", { policy: { piiGuard: "true" }, channels: { telegram: { chatId: "-5" } } });
  assert.equal(guard().apply("telegram", "-5", PHONE), "[phone ***678]");
});

test("after the outage ends the warning can fire again, and masking goes back to normal", () => {
  mkProject("plain", plainRoom);
  let broken = true;
  const readFile = (f) => { if (broken) throw Object.assign(new Error("io"), { code: "EIO" }); return fs.readFileSync(f, "utf8"); };
  const g = guard({ readFile });
  g.apply("telegram", "-77", PHONE);
  g.apply("telegram", "-77", PHONE);
  assert.equal(warnings.length, 1);
  broken = false;
  assert.equal(g.apply("telegram", "-77", PHONE), PHONE); // readable again, nothing shielded
  broken = true;
  g.apply("telegram", "-77", PHONE);
  assert.equal(warnings.length, 2);
});

test("a directory without a project.json is not a project (and does not switch the shield on)", () => {
  mkProject("plain", plainRoom);
  fs.mkdirSync(path.join(projectsDir, "leftover"), { recursive: true });
  assert.equal(guard().apply("telegram", "-77", PHONE), PHONE);
  assert.equal(warnings.length, 0);
});
