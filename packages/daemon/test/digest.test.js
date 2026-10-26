import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { composeDigest, describeMetrics, DigestService, parseTimeOfDay } from "../src/digest.js";
import { JsonState } from "../src/json-state.js";

const day = (h, m = 0) => new Date(2026, 9, 27, h, m, 0).getTime(); // local time, so "today" is stable in any timezone
const iso = (ms) => new Date(ms).toISOString();

const items = [
  { id: "a", title: "Landing page", status: "done", source: "agent", updatedAt: iso(day(10)) },
  { id: "b", title: "Pricing table", status: "done", source: "agent", updatedAt: iso(day(15)) },
  { id: "c", title: "Old thing", status: "done", source: "agent", updatedAt: iso(day(10) - 3 * 86400_000) },
  { id: "d", title: "SEO pass", status: "doing", source: "agent", updatedAt: iso(day(9)) },
  { id: "e", title: "Review copy", status: "review", source: "agent", updatedAt: iso(day(9)) },
  { id: "f", title: "Idea: newsletter", status: "idea", source: "human", updatedAt: iso(day(9)) },
];

test("composeDigest: what shipped today, what is open, what waits on a human — in plain words", () => {
  const text = composeDigest({
    project: { slug: "demo-app", name: "Demo App" },
    items,
    pm: { state: "idle", lastText: "All green." },
    approvals: 2,
    now: day(18),
  });
  assert.match(text, /Demo App/);
  assert.match(text, /2026-10-27/);
  assert.match(text, /Done today: 2/);
  assert.match(text, /Landing page/);
  assert.match(text, /Pricing table/);
  assert.doesNotMatch(text, /Old thing/); // finished days ago
  assert.match(text, /In progress: 1/);
  assert.match(text, /In review: 1/);
  assert.match(text, /Ideas: 1/);
  assert.match(text, /2 approvals waiting/);
  assert.doesNotMatch(text, /All green/); // the digest goes to a group: no PM chatter
});

test("composeDigest: a quiet day still says so, and long lists are cut", () => {
  const quiet = composeDigest({ project: { slug: "p", name: "P" }, items: [], pm: null, approvals: 0, now: day(18) });
  assert.match(quiet, /Nothing finished today/);
  assert.doesNotMatch(quiet, /approvals? waiting/);
  const many = Array.from({ length: 12 }, (_, i) => ({ id: `x${i}`, title: `Task ${i}`, status: "done", source: "agent", updatedAt: iso(day(11)) }));
  const text = composeDigest({ project: { slug: "p", name: "P" }, items: many, pm: null, approvals: 0, now: day(18) });
  assert.match(text, /Done today: 12/);
  assert.match(text, /and 7 more/);
});

test("describeMetrics: tolerates whatever the radar lane returns; unknown shapes are skipped, never thrown on", () => {
  assert.equal(describeMetrics({ summary: "median 4m, 3 interventions" }), "median 4m, 3 interventions");
  assert.match(describeMetrics({ medianMs: 240_000, count: 3 }), /4 min/);
  assert.equal(describeMetrics(null), null);
  assert.equal(describeMetrics("nope"), null);
  assert.equal(describeMetrics({ unrelated: true }), null);
});

test("composeDigest adds the intervention line only when metrics exist", () => {
  const withM = composeDigest({ project: { slug: "p", name: "P" }, items: [], pm: null, approvals: 0, metrics: { summary: "median 4m" }, now: day(18) });
  assert.match(withM, /Time to intervene: median 4m/);
  const without = composeDigest({ project: { slug: "p", name: "P" }, items: [], pm: null, approvals: 0, metrics: null, now: day(18) });
  assert.doesNotMatch(without, /intervene/i);
});

test("parseTimeOfDay: HH:MM, and junk falls back to the default", () => {
  assert.deepEqual(parseTimeOfDay("18:30"), { h: 18, m: 30 });
  assert.deepEqual(parseTimeOfDay("7:05"), { h: 7, m: 5 });
  assert.deepEqual(parseTimeOfDay("25:99"), { h: 18, m: 0 });
  assert.deepEqual(parseTimeOfDay(undefined), { h: 18, m: 0 });
});

function service({ sendOk = true, metrics = async () => ({ summary: "median 4m" }), nowRef }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-l5-digest-"));
  const sent = [];
  const svc = new DigestService({
    listSlugs: () => ["demo-app", "acme-web"],
    loadProject: (slug) => ({ slug, name: slug }),
    loadItems: () => items,
    pmOf: () => ({ state: "idle", lastText: "" }),
    approvalsOf: () => 0,
    fetchMetrics: metrics,
    sendToProject: async (slug, text) => { sent.push({ slug, text }); return sendOk; },
    state: new JsonState(path.join(dir, "state.json")),
    now: () => nowRef.t,
    timeOfDay: "18:00",
  });
  return { svc, sent, dir };
}

test("DigestService: nothing before the time of day; one digest per project after it; never twice the same day", async () => {
  const nowRef = { t: day(17, 59) };
  const { svc, sent } = service({ nowRef });
  await svc.runDue();
  assert.equal(sent.length, 0);

  nowRef.t = day(18, 1);
  await svc.runDue();
  assert.deepEqual(sent.map((s) => s.slug).sort(), ["acme-web", "demo-app"]);
  assert.match(sent[0].text, /Time to intervene: median 4m/);

  nowRef.t = day(21);
  await svc.runDue();
  assert.equal(sent.length, 2); // already sent today

  nowRef.t = day(18, 5) + 86400_000;
  await svc.runDue();
  assert.equal(sent.length, 4); // next day: again
});

test("DigestService: remembers across a restart (state file), so a restart at 19:00 does not resend", async () => {
  const nowRef = { t: day(19) };
  const a = service({ nowRef });
  await a.svc.runDue();
  assert.equal(a.sent.length, 2);
  const sent2 = [];
  const b = new DigestService({
    listSlugs: () => ["demo-app", "acme-web"], loadProject: (slug) => ({ slug, name: slug }), loadItems: () => [],
    pmOf: () => null, approvalsOf: () => 0, fetchMetrics: async () => null,
    sendToProject: async (slug) => { sent2.push(slug); return true; },
    state: new JsonState(path.join(a.dir, "state.json")), now: () => nowRef.t, timeOfDay: "18:00",
  });
  await b.runDue();
  assert.deepEqual(sent2, []);
});

test("DigestService: a project with no chat bound is not marked as sent (it can still get one after /bind)", async () => {
  const nowRef = { t: day(19) };
  const a = service({ nowRef, sendOk: false });
  await a.svc.runDue();
  assert.equal(a.sent.length, 2); // attempted
  a.sent.length = 0;
  await a.svc.runDue();
  assert.equal(a.sent.length, 2); // attempted again, since nothing was delivered
});

test("DigestService: missing or failing radar endpoint is skipped quietly; the digest still goes out", async () => {
  const nowRef = { t: day(19) };
  const { svc, sent } = service({ nowRef, metrics: async () => { throw new Error("404"); } });
  await svc.runDue();
  assert.equal(sent.length, 2);
  assert.doesNotMatch(sent[0].text, /intervene/i);
});

test("DigestService.start() ticks on a timer and stop() clears it", async () => {
  const nowRef = { t: day(19) };
  const { svc, sent } = service({ nowRef });
  svc.start(20);
  await new Promise((r) => setTimeout(r, 80));
  svc.stop();
  const n = sent.length;
  assert.equal(n, 2);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(sent.length, n);
});
