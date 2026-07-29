import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventBroadcastServer } from "../src/ws-server.js";
import { EMPTY_ROSTER, RosterWatcher, createRosterHttpHandler, parseRoster } from "../src/roster.js";

// Mirrors the real ~/.claude/company/roster.yaml shapes: comments, inline
// members with quoted `:` values, a block member with nested inline cv,
// inline repos array, model_routing noise the parser must skip over.
const FIXTURE = `# Company roster — sơ đồ nhân sự
version: 1
updated: 2026-07-08
departments:
  dev:
    model_routing: # gợi ý cho PM
      plan_review: opus
      implement: sonnet
    budget_usd_per_day: 500
    repos: ["Acme Web", "demo-app"]
    members:
      - { name: forge, source: "plugin forge:forge", hired: 2026-07-08, role: "Pipeline build" }
      - { name: "marketing:seo-audit", source: "plugin marketing", hired: 2026-07-08, role: "Audit SEO" }
  marketing:
    budget_usd_per_day: 50
    repos: []
    members:
      - name: youtube-seo
        source: "https://github.com/kostja94/marketing-skills (skills/platforms/youtube)"
        hired: 2026-07-08
        role: "SEO YouTube: title/description/tags thành 1 hệ thống"
        cv: { scan_verdict: SAFE, scan_score: 0, scanned: 2026-07-08 }
  ops:
    members: []
`;

test("parseRoster handles the real-world roster shapes", () => {
  const roster = parseRoster(FIXTURE);
  assert.equal(roster.version, 1);
  assert.equal(roster.updated, "2026-07-08");
  assert.deepEqual(
    roster.departments.map((d) => d.name),
    ["dev", "marketing", "ops"]
  );

  const dev = roster.departments[0];
  assert.equal(dev.budgetUsdPerDay, 500);
  assert.deepEqual(dev.members[0], {
    name: "forge",
    source: "plugin forge:forge", // quoted `:` must not split the pair
    hired: "2026-07-08", // dates stay strings, never numbers
    role: "Pipeline build",
    cv: null,
  });
  assert.equal(dev.members[1].name, "marketing:seo-audit");

  const mkt = roster.departments[1];
  assert.equal(mkt.members.length, 1);
  const ys = mkt.members[0];
  assert.equal(ys.name, "youtube-seo");
  assert.equal(ys.role, "SEO YouTube: title/description/tags thành 1 hệ thống");
  assert.match(ys.source, /^https:\/\/github\.com\//);
  assert.deepEqual(ys.cv, { scan_verdict: "SAFE", scan_score: 0, scanned: "2026-07-08" });

  assert.deepEqual(roster.departments[2].members, []);
});

test("parseRoster tolerates odd/missing fields without crashing", () => {
  assert.deepEqual(parseRoster(""), EMPTY_ROSTER);
  assert.deepEqual(parseRoster("# chỉ có comment\n"), EMPTY_ROSTER);
  // no departments key
  assert.deepEqual(parseRoster("version: 2\n").departments, []);
  // member missing name is dropped; unknown fields ignored
  const roster = parseRoster(
    "departments:\n  dev:\n    members:\n      - { role: \"vô danh\" }\n      - { name: a, mood: happy }\n"
  );
  assert.equal(roster.departments[0].members.length, 1);
  assert.equal(roster.departments[0].members[0].name, "a");
});

async function getRoster(srv) {
  const { port } = srv.server.address();
  const res = await fetch(`http://127.0.0.1:${port}/roster`);
  return { status: res.status, body: await res.json() };
}

test("GET /roster serves the parsed file and degrades to empty when missing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "roster-"));
  const file = path.join(dir, "roster.yaml");
  writeFileSync(file, FIXTURE);
  const srv = new EventBroadcastServer({
    port: 0,
    extraHttp: createRosterHttpHandler({ rosterPath: file }),
  });
  await srv.start();
  try {
    const { status, body } = await getRoster(srv);
    assert.equal(status, 200);
    assert.equal(body.departments.length, 3);
    assert.equal(body.departments[0].members[0].name, "forge");
  } finally {
    await srv.stop();
    rmSync(dir, { recursive: true, force: true });
  }

  const missing = new EventBroadcastServer({
    port: 0,
    extraHttp: createRosterHttpHandler({ rosterPath: "/nonexistent/roster.yaml" }),
  });
  await missing.start();
  try {
    const { status, body } = await getRoster(missing);
    assert.equal(status, 200);
    assert.deepEqual(body, EMPTY_ROSTER);
  } finally {
    await missing.stop();
  }
});

test("RosterWatcher emits once per content change, not per fs event", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "roster-w-"));
  const file = path.join(dir, "roster.yaml");
  writeFileSync(file, FIXTURE);
  const seen = [];
  const watcher = new RosterWatcher({
    rosterPath: file,
    debounceMs: 50,
    onRoster: (roster) => seen.push(roster),
  });
  watcher.start();
  try {
    // same content again → no event
    writeFileSync(file, FIXTURE);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(seen.length, 0);

    // new member → one event carrying the parsed roster
    writeFileSync(
      file,
      FIXTURE.replace(
        "    members:\n      - name: youtube-seo",
        "    members:\n      - { name: thumbnail-designer, hired: 2026-07-08, role: \"Thumbnail\" }\n      - name: youtube-seo"
      )
    );
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(seen.length, 1);
    const mkt = seen[0].departments.find((d) => d.name === "marketing");
    assert.ok(mkt.members.some((m) => m.name === "thumbnail-designer"));
  } finally {
    watcher.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("RosterWatcher survives a missing directory", () => {
  const watcher = new RosterWatcher({
    rosterPath: "/nonexistent-dir-xyz/roster.yaml",
    onRoster: () => assert.fail("must not emit"),
  });
  watcher.start(); // must not throw
  watcher.stop();
});
