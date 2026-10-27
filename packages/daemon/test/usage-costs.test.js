import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, rmSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { priceFor, costUsd } from "../src/usage-pricing.js";
import { UsageCostIndex, createCostsHttpHandler, overBudget } from "../src/usage-costs.js";

test("overBudget: over when total >= a positive budget (threshold counts as over)", () => {
  assert.equal(overBudget(50, 40), true);
  assert.equal(overBudget(40, 40), true);
});
test("overBudget: under budget → false", () => {
  assert.equal(overBudget(30, 40), false);
});
test("overBudget: off when budget is null/0/undefined", () => {
  assert.equal(overBudget(999, null), false);
  assert.equal(overBudget(999, 0), false);
  assert.equal(overBudget(999, undefined), false);
});

const SID = "11111111-2222-3333-4444-555555555555";
// cwd with the worktree marker so deriveRepo resolves without touching the
// real filesystem (fixture dirs have no .git)
const CWD = "/tmp/fakerepo/.claude/worktrees/x";

/** One transcript line as Claude Code writes it (shape verified against real files 2026-07-08). */
function usageLine({ ts, model = "claude-sonnet-5", id, input = 100, output = 10, cacheWrite = 0, cacheRead = 0, sessionId = SID }) {
  return (
    JSON.stringify({
      type: "assistant",
      sessionId,
      timestamp: new Date(ts).toISOString(),
      cwd: CWD,
      requestId: `req_${id}`,
      message: {
        id: `msg_${id}`,
        model,
        usage: {
          input_tokens: input,
          output_tokens: output,
          cache_creation_input_tokens: cacheWrite,
          cache_read_input_tokens: cacheRead,
        },
      },
    }) + "\n"
  );
}

function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "usage-costs-test-"));
  const project = path.join(root, "-Users-x-fakerepo");
  mkdirSync(project, { recursive: true });
  return { root, project, file: path.join(project, `${SID}.jsonl`) };
}

test("priceFor: family match, date suffix, no cross-family bleed, unknown", () => {
  assert.equal(priceFor("claude-sonnet-5").input, 2); // introductory price until 2026-08-31
  assert.equal(priceFor("claude-haiku-4-5-20251001").input, 1); // date suffix
  assert.equal(priceFor("claude-opus-4-8").input, 5); // must NOT hit the claude-opus-4 (15/75) row
  assert.equal(priceFor("claude-opus-4-20250514").input, 15);
  assert.equal(priceFor("gpt-5.4-mini").input, 0.75); // must NOT hit the gpt-5.4 (2.5/15) row
  assert.equal(priceFor("mystery-model-9"), null); // not priced → unknown, don't guess
  assert.equal(priceFor("<synthetic>"), null);
  assert.equal(priceFor(null), null);
});

test("priceFor: a vendor's own cache-read price overrides Anthropic's 0.1× rule", () => {
  // Z.ai bills cached input at $0.26 on a $1.40 input — ~0.19×, not 0.1×.
  assert.equal(priceFor("glm-5.2").cacheRead, 0.26);
  assert.equal(priceFor("gemini-2.5-flash").cacheRead, 0.03);
  // no override → fall back to 0.1× input (Anthropic / OpenAI rule)
  assert.equal(priceFor("claude-haiku-4-5").cacheRead, 0.1);
});

test("costUsd: cache_read priced at 0.1× input, not full input rate", () => {
  const { usd, known } = costUsd("claude-sonnet-5", {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_creation_input_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
  });
  assert.ok(known);
  assert.equal(usd, 2 + 10 + 2.5 + 0.2); // input + output + 1.25× write + 0.1× read
  assert.deepEqual(costUsd("mystery-model-9", { input_tokens: 1e6 }), { usd: 0, known: false });
});

test("aggregation: dedupe by message.id, skip non-usage lines, unknown models tracked, windows filter", async () => {
  const { root, file } = makeFixture();
  const now = Date.now();
  const dup = usageLine({ ts: now, id: "a", input: 1000, output: 100, cacheRead: 2000 });
  let content = "";
  content += JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }) + "\n";
  content += JSON.stringify({ type: "assistant", sessionId: SID, message: { id: "msg_nousage", model: "claude-sonnet-5" } }) + "\n";
  content += dup + dup + dup; // streaming duplicates: one API response, 3 records
  content += usageLine({ ts: now, id: "b", model: "mystery-model-9", input: 500, output: 50 });
  content += usageLine({ ts: now - 3 * 24 * 3_600_000, id: "old", input: 7000, output: 700 }); // 3 days ago
  content += "{torn json\n";
  writeFileSync(file, content);

  const index = new UsageCostIndex({ projectsRoot: root, scanTtlMs: 0 });
  const day = await index.query("24h");

  // dedup: "a" counted once → sonnet tokens 1000+100+2000; unpriced "b" 550
  assert.equal(day.tokensTotal, 3100 + 550);
  assert.deepEqual(day.tokens, { input: 1500, output: 150, cacheWrite: 0, cacheRead: 2000 });
  // usd: sonnet only, at its introductory $2/$10 (cache read 0.1× = $0.2)
  assert.equal(day.totalUsd, round((1000 * 2 + 100 * 10 + 2000 * 0.2) / 1e6));
  // the unpriced model's tokens are counted, its USD is 0, its name is surfaced
  assert.deepEqual(day.unknownModels, [{ model: "mystery-model-9", tokens: 550 }]);
  assert.equal(day.byRepo.length, 1);
  assert.equal(day.byRepo[0].repo, "fakerepo");
  assert.equal(day.byAgent[0].sessionId, SID);

  // 7d window additionally includes the 3-day-old record
  const week = await index.query("7d");
  assert.equal(week.tokensTotal, 3650 + 7700);
  assert.equal(week.byDay.length, 2);

  rmSync(root, { recursive: true, force: true });
});

test("mtime cache: unchanged file not re-parsed, appended file is", async () => {
  const { root, file } = makeFixture();
  writeFileSync(file, usageLine({ ts: Date.now(), id: "a" }));

  const index = new UsageCostIndex({ projectsRoot: root, scanTtlMs: 0 });
  await index.query("24h");
  assert.equal(index.stats.filesParsed, 1);

  await index.query("24h"); // nothing changed
  assert.equal(index.stats.filesParsed, 1);

  appendFileSync(file, usageLine({ ts: Date.now(), id: "b" }));
  utimesSync(file, new Date(), new Date(Date.now() + 5000)); // force a distinct mtime
  const after = await index.query("24h");
  assert.equal(index.stats.filesParsed, 2);
  assert.equal(after.tokensTotal, 220);

  rmSync(root, { recursive: true, force: true });
});

test("subagent transcript files under <sid>/subagents/ are included", async () => {
  const { root, project } = makeFixture();
  const subDir = path.join(project, SID, "subagents");
  mkdirSync(subDir, { recursive: true });
  writeFileSync(path.join(subDir, "agent-x.jsonl"), usageLine({ ts: Date.now(), id: "sub" }));

  const index = new UsageCostIndex({ projectsRoot: root, scanTtlMs: 0 });
  const res = await index.query("24h");
  assert.equal(res.tokensTotal, 110);
  assert.equal(res.byAgent[0].sessionId, SID); // record's own sessionId, not the filename

  rmSync(root, { recursive: true, force: true });
});

test("http handler: routes /costs, validates window, ignores other paths", async () => {
  const { root, file } = makeFixture();
  writeFileSync(file, usageLine({ ts: Date.now(), id: "a" }));
  const handler = createCostsHttpHandler(new UsageCostIndex({ projectsRoot: root, scanTtlMs: 0 }));

  const call = (pathname, search = "") =>
    new Promise((resolve) => {
      const req = { method: "GET" };
      const res = {
        writeHead(status) {
          this.status = status;
        },
        end(body) {
          resolve({ status: this.status, body: body && JSON.parse(body) });
        },
      };
      const handled = handler(req, res, new URL(`http://x${pathname}${search}`));
      if (!handled) resolve({ handled: false });
    });

  assert.deepEqual(await call("/nope"), { handled: false });
  assert.equal((await call("/costs", "?window=1y")).status, 400);
  const ok = await call("/costs", "?window=24h");
  assert.equal(ok.status, 200);
  assert.equal(ok.body.tokensTotal, 110);
  assert.equal(ok.body.window, "24h");

  rmSync(root, { recursive: true, force: true });
});

function round(usd) {
  return Math.round(usd * 10000) / 10000;
}

// ── lane L3: worker model pricing (rates from the user's own exec_prices.py,
// read 2026-10-19: MiMo pay-as-you-go table + DeepSeek pricing page) ──────────
const TUE_PEAK = Date.UTC(2026, 9, 27, 7, 30); // Tue 07:30Z — inside 06–10 UTC
const TUE_OFF = Date.UTC(2026, 9, 27, 12, 0);
const SAT_07 = Date.UTC(2026, 9, 31, 7, 30); // Saturday: never peak

test("deepseek flash: peak is double off-peak; cache write bills like fresh input", () => {
  const usage = { input_tokens: 1e6, output_tokens: 1e6, cache_creation_input_tokens: 1e6, cache_read_input_tokens: 1e6 };
  const peak = costUsd("deepseek-flash", usage, TUE_PEAK);
  const off = costUsd("deepseek-flash", usage, TUE_OFF);
  // (miss 0.30 + write 0.30 + hit 0.006 + out 1.20) peak; half of that off-peak
  assert.ok(Math.abs(peak.usd - 1.806) < 1e-9);
  assert.ok(Math.abs(off.usd - 0.903) < 1e-9);
  assert.equal(peak.known, true);
  assert.ok(Math.abs(costUsd("deepseek-flash[1m]", usage, SAT_07).usd - 0.903) < 1e-9);
});

test("deepseek without a timestamp is priced as peak (upper bound); pro tier by name", () => {
  const usage = { input_tokens: 1e6 };
  assert.ok(Math.abs(costUsd("deepseek-flash", usage).usd - 0.3) < 1e-9);
  assert.ok(Math.abs(costUsd("deepseek-v4-pro", usage, TUE_PEAK).usd - 1.32) < 1e-9);
  assert.ok(Math.abs(costUsd("deepseek-v4-pro", usage, TUE_OFF).usd - 0.66) < 1e-9);
});

test("mimo: flat price, flash vs pro", () => {
  const usage = { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 1e6 };
  assert.ok(Math.abs(costUsd("mimo-v2.6-pro", usage, TUE_PEAK).usd - (0.435 + 0.87 + 0.0036)) < 1e-9);
  assert.ok(Math.abs(costUsd("mimo-v2.6-flash", usage, TUE_OFF).usd - (0.14 + 0.28 + 0.0028)) < 1e-9);
});

test("kimi (flat-fee plan) stays unpriced: tokens count, usd 0, known false", () => {
  assert.deepEqual(costUsd("k3[1m]", { input_tokens: 1e6 }), { usd: 0, known: false });
  assert.equal(priceFor("k3[1m]"), null);
});

test("existing Anthropic rows are unaffected by the optional timestamp", () => {
  assert.deepEqual(priceFor("claude-opus-4-8", TUE_PEAK), priceFor("claude-opus-4-8"));
});

test("worker root: tailed as harness claude-worker, lane from model, priced; main root untouched", async () => {
  const main = makeFixture();
  const worker = makeFixture();
  const now = Date.now();
  writeFileSync(main.file, usageLine({ ts: now, id: "m", input: 1000, output: 100 }));
  writeFileSync(
    worker.file,
    usageLine({ ts: now, id: "w1", model: "deepseek-flash", input: 1e6, output: 0, sessionId: "wk-1" }) +
      usageLine({ ts: now, id: "w2", model: "k3[1m]", input: 500, output: 5, sessionId: "wk-2" }),
  );

  const index = new UsageCostIndex({
    claudeRoots: [
      { root: main.root, harness: "claude-code" },
      { root: worker.root, harness: "claude-worker" },
    ],
    scanTtlMs: 0,
  });
  const day = await index.query("24h");

  assert.deepEqual(day.byHarness.map((r) => r.harness).sort(), ["claude-code", "claude-worker"]);
  const lanes = Object.fromEntries(day.byLane.map((r) => [r.lane, r]));
  assert.deepEqual(Object.keys(lanes).sort(), ["deepseek", "kimi"]);
  assert.equal(lanes.deepseek.harness, "claude-worker");
  assert.equal(lanes.deepseek.tokens, 1e6);
  assert.ok(lanes.deepseek.usd === 0.15 || lanes.deepseek.usd === 0.3, "off-peak 0.15 or peak 0.30"); // exact rate pinned in the fixed-time test below
  assert.equal(lanes.kimi.usd, 0); // flat-fee plan: tokens only
  assert.ok(day.unknownModels.some((u) => u.model === "k3[1m]"));
  assert.equal(day.byAgent.find((a) => a.sessionId === "wk-1").harness, "claude-worker");

  rmSync(main.root, { recursive: true, force: true });
  rmSync(worker.root, { recursive: true, force: true });
});

test("hermes: tokens per session from state.db, cost as Hermes recorded it (not re-priced)", { skip: !(await import("./hermes-fixture.js")).hasSqlite && "node:sqlite unavailable" }, async () => {
  const { makeHermesDb } = await import("./hermes-fixture.js");
  const f = await makeHermesDb();
  const now = Date.now() / 1000;
  f.addSession({ id: "h1", started_at: now - 600, last_activity_at: now - 60, model: "gpt-5.5", input_tokens: 1000, output_tokens: 100, cache_read_tokens: 5000, estimated_cost_usd: 0, cost_status: "included" });
  f.addSession({ id: "h2", started_at: now - 600, last_activity_at: now - 30, model: "gpt-5.5", input_tokens: 10, output_tokens: 1, actual_cost_usd: 0.25, cost_status: "actual" });
  f.addSession({ id: "h-old", started_at: now - 40 * 86400, last_activity_at: now - 40 * 86400, input_tokens: 999999 });

  const index = new UsageCostIndex({ claudeRoots: [], hermesDbPath: f.dbPath, scanTtlMs: 0 });
  const day = await index.query("24h");
  assert.equal(day.tokensTotal, 1000 + 100 + 5000 + 10 + 1);
  assert.equal(day.totalUsd, 0.25);
  assert.deepEqual(day.byHarness.map((r) => r.harness), ["hermes"]);
  assert.equal(day.unknownModels.length, 0, "recorded cost counts as known even when gpt-5.5 has a table price");

  // new writes show up without the main db file changing (WAL): every scan re-reads
  f.addSession({ id: "h3", started_at: now - 10, last_activity_at: now - 5, input_tokens: 7 });
  assert.equal((await index.query("24h")).tokensTotal, 6111 + 7);
  f.db.close();
  rmSync(f.dir, { recursive: true, force: true });
});

test("worker lane pricing is wired through the aggregation: a Saturday call bills off-peak, a Tuesday-07Z call peak", async () => {
  const worker = makeFixture();
  const sat = lastUtc(6, 12); // Saturday 12:00Z — never peak
  const tue = lastUtc(2, 7); // Tuesday 07:00Z — peak
  writeFileSync(
    worker.file,
    usageLine({ ts: sat, id: "s", model: "deepseek-flash", input: 1e6, output: 0 }) +
      usageLine({ ts: tue, id: "t", model: "deepseek-flash", input: 1e6, output: 0 }),
  );
  const index = new UsageCostIndex({ claudeRoots: [{ root: worker.root, harness: "claude-worker" }], scanTtlMs: 0 });
  const day = await index.query("30d");
  assert.ok(Math.abs(day.totalUsd - (0.15 + 0.3)) < 1e-9, `got ${day.totalUsd}`);
  rmSync(worker.root, { recursive: true, force: true });
});

test("main root: MiMo run from the main config dir lands in byLane too; Claude and codex ids do not", async () => {
  const main = makeFixture();
  writeFileSync(
    main.file,
    usageLine({ ts: Date.now(), id: "a", model: "mimo-v2.6-pro", input: 100, output: 10 }) +
      usageLine({ ts: Date.now(), id: "b", model: "claude-sonnet-5", input: 100, output: 10 }),
  );
  const index = new UsageCostIndex({ claudeRoots: [{ root: main.root, harness: "claude-code" }], scanTtlMs: 0 });
  const day = await index.query("24h");
  assert.deepEqual(day.byLane.map((r) => [r.harness, r.lane]), [["claude-code", "mimo"]]);
  rmSync(main.root, { recursive: true, force: true });
});

/** ms of the most recent UTC `weekday` (0=Sun) at `hour`:00, within the last 7 days. */
function lastUtc(weekday, hour) {
  const d = new Date();
  d.setUTCHours(hour, 0, 0, 0);
  while (d.getUTCDay() !== weekday || d.getTime() > Date.now()) d.setUTCDate(d.getUTCDate() - 1);
  return d.getTime();
}

test("hermes: a session with NULL last_activity_at is placed by its newest message, not its start", { skip: !(await import("./hermes-fixture.js")).hasSqlite && "node:sqlite unavailable" }, async () => {
  const { makeHermesDb } = await import("./hermes-fixture.js");
  const f = await makeHermesDb();
  const now = Date.now() / 1000;
  f.addSession({ id: "old-start", started_at: now - 5 * 86400, input_tokens: 500 }); // last_activity_at NULL
  f.addMessage({ session_id: "old-start", role: "user", content: "x", timestamp: now - 60 });
  const index = new UsageCostIndex({ claudeRoots: [], hermesDbPath: f.dbPath, scanTtlMs: 0 });
  assert.equal((await index.query("24h")).tokensTotal, 500);
  f.db.close();
  rmSync(f.dir, { recursive: true, force: true });
});
