import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runReport } from "../src/cli/report.js";
import { localDay } from "../src/intervention-metrics.js";

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ao-cli-report-"));

function fixture() {
  const dir = tmp();
  const rows = [
    { id: "1", kind: "waiting_permission", startTs: NOW - 70_000, endTs: NOW - 10_000, durationMs: 60_000, project: "acme-web", repo: "acme-web", harness: "claude-code", resolution: "approved" },
    { id: "2", kind: "waiting_permission", startTs: NOW - 5000, endTs: NOW, durationMs: 5000, project: "acme-web", repo: "acme-web", harness: "claude-code", resolution: "denied" },
  ];
  fs.writeFileSync(path.join(dir, `${localDay(NOW)}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return dir;
}

function run(argv, opts = {}) {
  const out = [];
  const err = [];
  const code = runReport(argv, { dir: fixture(), auditDir: null, now: () => NOW, log: (m) => out.push(m), error: (m) => err.push(m), ...opts });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

test("report: text by default, exit 0", () => {
  const r = run([]);
  assert.equal(r.code, 0);
  assert.match(r.out, /Waits: 2/);
  assert.match(r.out, /declined 1 \(50%\)/);
});

test("report --json: parseable and carries the window", () => {
  const r = run(["--json", "--days", "30"]);
  const j = JSON.parse(r.out);
  assert.equal(j.window.days, 30);
  assert.equal(j.total.count, 2);
});

test("report --dir: reads that directory instead of the default", () => {
  const other = tmp();
  const r = run(["--dir", other]);
  assert.equal(r.code, 0);
  assert.match(r.out, /Nothing has been recorded/);
});

test("report: bad --days is a usage error", () => {
  const r = run(["--days", "abc"]);
  assert.equal(r.code, 2);
  assert.match(r.err, /--days/);
});

test("report: never touches the files it reads", () => {
  const dir = fixture();
  const before = fs.readdirSync(dir).map((f) => [f, fs.statSync(path.join(dir, f)).mtimeMs]);
  run(["--dir", dir]);
  assert.deepEqual(fs.readdirSync(dir).map((f) => [f, fs.statSync(path.join(dir, f)).mtimeMs]), before);
});
