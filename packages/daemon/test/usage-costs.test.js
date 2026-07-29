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
