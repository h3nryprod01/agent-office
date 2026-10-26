import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readScorecard, createScorecardHttpHandler } from "../src/scorecard.js";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const day = (n) => new Date(NOW - n * 86_400_000).toISOString();

// Field names copied from the real ~/.claude/exec-*.jsonl; every value invented.
const review = (over) => ({ ts: day(1), repo: "demo-app", executor: "deepseek-flash", critical: 0, high: 0, rework: false, task: "t", advisor: "opus", findings: "", ...over });
const usage = (over) => ({ ts: day(1), lane: "deepseek", repo: "demo-app", turns: 10, seconds: 60, miss: 1000, hit: 9000, out: 500, cost_usd: 0.01, is_error: false, timeout: false, ...over });

function fixture({ reviews = [], usages = [], raw = "" }) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ao-score-"));
  writeFileSync(path.join(dir, "exec-scorecard.jsonl"), reviews.map((r) => JSON.stringify(r)).join("\n") + raw);
  writeFileSync(path.join(dir, "exec-usage.jsonl"), usages.map((r) => JSON.stringify(r)).join("\n"));
  return dir;
}

test("per-lane jobs, real logged cost, review pass rate and rework", () => {
  const dir = fixture({
    usages: [
      usage({ cost_usd: 0.01 }),
      usage({ cost_usd: 0.03, is_error: true }),
      usage({ lane: "mimo", cost_usd: 0.5, timeout: true }),
    ],
    reviews: [
      review({}), // clean
      review({ high: 2 }), // not clean
      review({ rework: true }), // not clean
      review({ executor: "GLM (worker tab)", critical: 1 }),
      review({ executor: "main" }), // not a worker lane
    ],
  });
  const sc = readScorecard({ execDir: dir, windowDays: 30, now: NOW });
  const by = Object.fromEntries(sc.lanes.map((l) => [l.lane, l]));

  assert.deepEqual(Object.keys(by).sort(), ["deepseek", "glm", "mimo"]);
  assert.equal(by.deepseek.jobs, 2);
  assert.equal(by.deepseek.errors, 1);
  assert.ok(Math.abs(by.deepseek.usd - 0.04) < 1e-9);
  assert.deepEqual(by.deepseek.tokens, { miss: 2000, hit: 18000, out: 1000 });
  assert.equal(by.deepseek.reviews, 3);
  assert.equal(by.deepseek.passed, 1);
  assert.ok(Math.abs(by.deepseek.passRate - 1 / 3) < 1e-9);
  assert.equal(by.deepseek.rework, 1);
  assert.equal(by.mimo.timeouts, 1);
  assert.equal(by.mimo.reviews, 0);
  assert.equal(by.mimo.passRate, null, "no reviews → no rate, not 0%");
  assert.equal(by.glm.jobs, 0); // reviewed but never run headless
  assert.equal(by.glm.passed, 0);
  assert.equal(sc.unattributedReviews, 1); // executor "main"
  rmSync(dir, { recursive: true, force: true });
});

test("window filter drops old rows; windowDays 0 keeps everything", () => {
  const dir = fixture({
    usages: [usage({}), usage({ ts: day(60) })],
    reviews: [review({}), review({ ts: day(60) })],
  });
  assert.equal(readScorecard({ execDir: dir, windowDays: 30, now: NOW }).lanes[0].jobs, 1);
  const all = readScorecard({ execDir: dir, windowDays: 0, now: NOW });
  assert.equal(all.lanes[0].jobs, 2);
  assert.equal(all.lanes[0].reviews, 2);
  rmSync(dir, { recursive: true, force: true });
});

test("null cost_usd/turns are tolerated; bad lines are counted, not fatal; lane with unknown cost shows null usd", () => {
  const dir = fixture({
    usages: [usage({ cost_usd: null, turns: null })],
    reviews: [review({})],
    raw: "\n{not json\n",
  });
  const sc = readScorecard({ execDir: dir, windowDays: 30, now: NOW });
  assert.equal(sc.lanes[0].usd, null);
  assert.equal(sc.brokenLines, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("all-time keeps rows with no usable ts; a bounded window drops them", () => {
  const dir = fixture({ usages: [usage({ ts: undefined }), usage({})], reviews: [review({ ts: undefined })] });
  const all = readScorecard({ execDir: dir, windowDays: 0, now: NOW });
  assert.equal(all.lanes[0].jobs, 2);
  assert.equal(all.lanes[0].reviews, 1);
  assert.equal(readScorecard({ execDir: dir, windowDays: 30, now: NOW }).lanes[0].jobs, 1);
  rmSync(dir, { recursive: true, force: true });
});

test("missing files → empty scorecard", () => {
  const sc = readScorecard({ execDir: path.join(os.tmpdir(), "ao-does-not-exist"), windowDays: 30, now: NOW });
  assert.deepEqual(sc.lanes, []);
});

test("output is aggregates only — no repo, task or findings text leaks", () => {
  const dir = fixture({
    usages: [usage({ repo: "secret-client-repo" })],
    reviews: [review({ repo: "secret-client-repo", task: "SECRET TASK", findings: "SECRET FINDING" })],
  });
  const json = JSON.stringify(readScorecard({ execDir: dir, windowDays: 30, now: NOW }));
  assert.ok(!/secret/i.test(json));
  rmSync(dir, { recursive: true, force: true });
});

test("GET /scorecard?days=N", async () => {
  const dir = fixture({ usages: [usage({})], reviews: [review({})] });
  const handle = createScorecardHttpHandler({ execDir: dir });
  const run = (method, url) =>
    new Promise((resolve) => {
      let status = 0;
      let body = "";
      const res = { writeHead: (s) => (status = s), end: (b) => resolve({ status, body: b ? JSON.parse(b) : null, handled: true }) };
      if (!handle({ method }, res, new URL(url, "http://x"))) resolve({ handled: false });
    });
  assert.equal((await run("POST", "/scorecard")).handled, false);
  assert.equal((await run("GET", "/other")).handled, false);
  assert.equal((await run("GET", "/scorecard?days=nope")).status, 400);
  const ok = await run("GET", "/scorecard?days=30");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.lanes[0].lane, "deepseek");
  rmSync(dir, { recursive: true, force: true });
});
