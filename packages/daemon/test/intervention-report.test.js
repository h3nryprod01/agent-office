import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { InterventionMetrics, readEpisodesFromDir, readAutoApprovals, summarizeEpisodes, formatReport, localDay } from "../src/intervention-metrics.js";

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0); // midday UTC: same calendar day in every timezone
const DAY = 24 * 60 * 60 * 1000;

let n = 0;
function ep(daysAgo, durationMs, over = {}) {
  const endTs = NOW - daysAgo * DAY;
  return {
    id: `x${++n}`,
    agentId: "a1",
    sessionId: "s1",
    kind: "waiting_permission",
    startTs: endTs - durationMs,
    endTs,
    durationMs,
    repo: "acme-web",
    project: "acme-web",
    harness: "claude-code",
    resolution: "approved",
    ...over,
  };
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ao-report-"));

test("summarizeEpisodes: 7 vs 30 day windows, total wait, longest, deny rate", () => {
  const eps = [
    ep(0, 10_000),
    ep(1, 50_000, { resolution: "denied" }),
    ep(2, 20_000, { kind: "error", resolution: "resumed" }),
    ep(20, 600_000, { project: "acme-api", repo: "acme-api" }),
  ];
  const r7 = summarizeEpisodes(eps, { now: NOW, days: 7 });
  assert.equal(r7.total.count, 3);
  assert.equal(r7.total.totalMs, 80_000);
  assert.equal(r7.longest.durationMs, 50_000);
  assert.equal(r7.longest.project, "acme-web");
  assert.equal(r7.permission.count, 2);
  assert.equal(r7.permission.denied, 1);
  assert.equal(r7.permission.denyRate, 0.5);
  const r30 = summarizeEpisodes(eps, { now: NOW, days: 30 });
  assert.equal(r30.total.count, 4);
  assert.equal(r30.longest.durationMs, 600_000);
  assert.equal(r30.longest.project, "acme-api");
  assert.equal(r30.window.days, 30);
});

test("summarizeEpisodes: split by project and by harness", () => {
  const eps = [
    ep(0, 1000),
    ep(0, 3000, { project: "acme-api", repo: "acme-api", harness: "claude-worker" }),
    ep(1, 5000, { project: null, repo: "loose-repo" }),
    ep(1, 7000, { project: null, repo: null, harness: null }),
  ];
  const r = summarizeEpisodes(eps, { now: NOW, days: 7 });
  assert.deepEqual(Object.keys(r.byProject).sort(), ["acme-api", "acme-web", "loose-repo", "other"]);
  assert.equal(r.byProject["acme-api"].totalMs, 3000);
  const harnesses = Object.fromEntries(r.byHarness.map((h) => [h.harness, h]));
  assert.equal(harnesses["claude-code"].count, 2);
  assert.equal(harnesses["claude-worker"].count, 1);
  assert.equal(harnesses.unknown.count, 1);
});

test("summarizeEpisodes: empty window gives zeros and no longest", () => {
  const r = summarizeEpisodes([], { now: NOW, days: 7 });
  assert.equal(r.total.count, 0);
  assert.equal(r.longest, null);
  assert.equal(r.permission.denyRate, 0);
  assert.deepEqual(r.byHarness, []);
});

test("summarizeEpisodes: episodes with no usable end day or duration are skipped and counted", () => {
  const good = ep(0, 1000);
  const noEnd = { ...ep(0, 2000), endTs: undefined, startTs: undefined };
  const noEndButStart = { ...ep(0, 2000), endTs: undefined, startTs: NOW - 2000 }; // end = start + duration
  const noDuration = { ...ep(0, 3000), durationMs: "x" };
  const r = summarizeEpisodes([good, noEnd, noEndButStart, noDuration], { now: NOW, days: 7 });
  assert.equal(r.total.count, 2);
  assert.equal(r.skipped, 2);
});

test("summarizeEpisodes: project filter keeps working", () => {
  const eps = [ep(0, 1000), ep(0, 2000, { project: "acme-api", repo: "acme-api" })];
  const r = summarizeEpisodes(eps, { now: NOW, days: 7, project: "acme-api" });
  assert.equal(r.total.count, 1);
});

test("readEpisodesFromDir: reads day files, skips torn lines, never deletes or writes", () => {
  const dir = tmp();
  const old = path.join(dir, "2020-01-01.jsonl"); // far outside any retention window
  fs.writeFileSync(old, `${JSON.stringify(ep(2000, 5000))}\n`);
  const f = path.join(dir, `${localDay(NOW)}.jsonl`);
  fs.writeFileSync(f, `${JSON.stringify(ep(0, 1000))}\n{"id":"torn","kind":\n${JSON.stringify(ep(0, 2000))}\n`);
  fs.writeFileSync(path.join(dir, "notes.txt"), "ignore me");
  const before = fs.readdirSync(dir).sort();
  const { episodes, badLines } = readEpisodesFromDir(dir);
  assert.equal(episodes.length, 3);
  assert.equal(badLines, 1);
  assert.deepEqual(fs.readdirSync(dir).sort(), before); // read-only: the old file is still there
});

test("readEpisodesFromDir: a missing directory is an empty result, not a throw", () => {
  const { episodes, badLines } = readEpisodesFromDir(path.join(tmp(), "nope"));
  assert.deepEqual(episodes, []);
  assert.equal(badLines, 0);
});

test("readAutoApprovals: counts allow entries per project inside the window, tolerates bad lines", () => {
  const dir = tmp();
  const mk = (slug, rows) => {
    fs.mkdirSync(path.join(dir, slug));
    fs.writeFileSync(path.join(dir, slug, "policy-audit.jsonl"), rows.join("\n") + "\n");
  };
  const row = (daysAgo, decision) => JSON.stringify({ ts: NOW - daysAgo * DAY, decision });
  mk("acme-web", [row(0, "allow"), row(1, "allow"), row(1, "deny"), row(40, "allow"), "{broken"]);
  mk("acme-api", [row(2, "allow")]);
  fs.mkdirSync(path.join(dir, "empty-project")); // no audit file at all
  const r = readAutoApprovals(dir, { now: NOW, days: 7 });
  assert.equal(r.autoApproved, 3);
  assert.equal(r.autoDenied, 1);
  assert.deepEqual(r.byProject, { "acme-web": 2, "acme-api": 1 });
  assert.equal(readAutoApprovals(path.join(dir, "missing"), { now: NOW, days: 7 }), null);
});

test("summarizeEpisodes: attaches autoApproved only when an audit result is given", () => {
  const without = summarizeEpisodes([ep(0, 1000)], { now: NOW, days: 7 });
  assert.equal(without.autoApproved, null);
  const withAudit = summarizeEpisodes([ep(0, 1000)], { now: NOW, days: 7, audit: { autoApproved: 4, autoDenied: 1, byProject: { "acme-web": 4 } } });
  assert.equal(withAudit.autoApproved, 4);
});

test("formatReport: text carries the headline numbers; empty data points at the approvals hook", () => {
  const eps = [ep(0, 90_000, { resolution: "denied" }), ep(1, 30_000)];
  const text = formatReport(summarizeEpisodes(eps, { now: NOW, days: 7 }));
  assert.match(text, /2 /); // count
  assert.match(text, /1m 30s/); // longest
  assert.match(text, /acme-web/);
  assert.match(text, /claude-code/);
  const empty = formatReport(summarizeEpisodes([], { now: NOW, days: 7 }));
  assert.match(empty, /ao approvals setup/);
  assert.match(empty, /hook/i);
});

test("InterventionMetrics.summary: auditDir adds the policy's auto-approvals, no auditDir leaves it null", () => {
  const dir = tmp();
  const audit = tmp();
  fs.mkdirSync(path.join(audit, "acme-web"));
  fs.writeFileSync(path.join(audit, "acme-web", "policy-audit.jsonl"), `${JSON.stringify({ ts: NOW - 1000, decision: "allow" })}\n`);
  fs.writeFileSync(path.join(dir, `${localDay(NOW)}.jsonl`), `${JSON.stringify(ep(0, 4000))}\n`);
  const plain = new InterventionMetrics({ dir, now: () => NOW, flushMs: 0 });
  assert.equal(plain.summary({ days: 7 }).autoApproved, null);
  const withAudit = new InterventionMetrics({ dir, now: () => NOW, flushMs: 0, auditDir: audit });
  const s = withAudit.summary({ days: 7 });
  assert.equal(s.autoApproved, 1);
  assert.equal(s.total.count, 1);
});
