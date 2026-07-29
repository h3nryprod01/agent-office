// Parser tests for the three cost sources (wi-cost-multiharness).
//
// Every number asserted here comes from a REAL session file on this machine:
//   fixtures/codex-rollout.jsonl  — 8 lines lifted verbatim out of
//     ~/.codex/sessions/2026/07/09/rollout-…-019f478d….jsonl (only `cwd` was
//     rewritten to a fake repo path so deriveRepo resolves without a .git).
//     It deliberately includes the real adjacent re-emission pair (identical
//     last_token_usage, total_token_usage does NOT advance) and a real
//     rate-limit-only token_count with `info: null`.
//   fixtures/gemini-session.json  — the real session already used by the
//     gemini tailer tests; its `tokens` blocks are untouched.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseCodexFile, parseGeminiFile } from "../src/usage-parsers.js";
import { UsageCostIndex } from "../src/usage-costs.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const CODEX_UUID = "019f478d-8ad4-7ab3-b976-f2b58f8a542c";
const GEMINI_SID = "9efa18e9-0761-4d8d-93bd-8667266e4464";
const CWD = "/tmp/fakerepo/.claude/worktrees/x";

/** Real fixture, timestamps re-stamped to `now` so window filtering is deterministic. */
function codexFixture(now) {
  return readFileSync(path.join(FIXTURES, "codex-rollout.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.stringify({ ...JSON.parse(line), timestamp: new Date(now).toISOString() }))
    .join("\n");
}

function geminiFixture(now) {
  const doc = JSON.parse(readFileSync(path.join(FIXTURES, "gemini-session.json"), "utf8"));
  doc.messages = doc.messages.map((m) => ({ ...m, timestamp: new Date(now).toISOString() }));
  return JSON.stringify(doc);
}

function tmpdir() {
  return mkdtempSync(path.join(os.tmpdir(), "usage-parsers-test-"));
}

/** `<root>/<slug>/chats/session-*.json` + the `.project_root` that carries cwd. */
function writeGeminiTree(root, content, { projectRoot = CWD } = {}) {
  const projectDir = path.join(root, "slug");
  mkdirSync(path.join(projectDir, "chats"), { recursive: true });
  if (projectRoot) writeFileSync(path.join(projectDir, ".project_root"), `${projectRoot}\n`);
  const file = path.join(projectDir, "chats", "session-2026-07-09T18-53-9efa18e9.json");
  writeFileSync(file, content);
  return file;
}

function writeCodexTree(root, content) {
  const dir = path.join(root, "2026", "07", "09");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-07-09T22-44-46-${CODEX_UUID}.jsonl`);
  writeFileSync(file, content);
  return file;
}

test("codex: last_token_usage summed, re-emission skipped, info:null ignored", async () => {
  const root = tmpdir();
  const file = writeCodexTree(root, codexFixture(Date.now()));

  const buckets = await parseCodexFile(file);
  assert.equal(buckets.length, 1); // one (session, model, hour)
  const b = buckets[0];

  assert.equal(b.harness, "codex");
  assert.equal(b.sessionId, CODEX_UUID);
  assert.equal(b.repo, "fakerepo"); // cwd came from turn_context
  assert.equal(b.model, "gpt-5.5");
  assert.equal(b.known, true); // priced from OpenAI's published table (2026-07-10)
  assert.ok(b.usd > 0);

  // 4 accepted events (26349 + 30655 + 30777 + 182456); the 5th repeats
  // last_token_usage while total_token_usage stands still → not counted twice.
  assert.equal(b.tokens, 270_237);
  assert.equal(b.input, 26_842); // input_tokens minus cached_input_tokens
  assert.equal(b.cacheRead, 242_688); // cached_input_tokens, priced separately
  assert.equal(b.output, 707); // output_tokens (already includes reasoning)
  assert.equal(b.cacheWrite, 0); // codex has no cache-creation counter
  // tokens must equal the four counters — no bucket may be double-added
  assert.equal(b.tokens, b.input + b.output + b.cacheWrite + b.cacheRead);

  rmSync(root, { recursive: true, force: true });
});

test("codex: without the re-emission guard the same tokens would be counted twice", async () => {
  const root = tmpdir();
  // Same fixture, but drop the duplicate line: the total must not change.
  const lines = codexFixture(Date.now()).split("\n");
  const withoutDup = lines.filter((_, i) => i !== 6).join("\n"); // line 6 = the re-emission
  const file = writeCodexTree(root, withoutDup);

  const [b] = await parseCodexFile(file);
  assert.equal(b.tokens, 270_237); // identical to the run that saw the duplicate

  rmSync(root, { recursive: true, force: true });
});

test("codex: a decreasing cumulative total is a reset, not a duplicate", async () => {
  const root = tmpdir();
  const now = Date.now();
  const base = codexFixture(now).split("\n");
  const meta = base[0];
  const ctx = base[1];
  const ev = (last, total) =>
    JSON.stringify({
      timestamp: new Date(now).toISOString(),
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: { input_tokens: last, cached_input_tokens: 0, output_tokens: 0, total_tokens: last },
          total_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0, total_tokens: total },
        },
      },
    });
  // 100 → 300 (advance) → 100 (reset baseline, real new tokens) → 100 (re-emission, skipped)
  const file = writeCodexTree(root, [meta, ctx, ev(100, 100), ev(200, 300), ev(100, 100), ev(100, 100)].join("\n"));

  const [b] = await parseCodexFile(file);
  assert.equal(b.tokens, 100 + 200 + 100);

  rmSync(root, { recursive: true, force: true });
});

test("gemini: cached is a subset of input, thoughts bill as output", async () => {
  const root = tmpdir();
  const file = writeGeminiTree(root, geminiFixture(Date.now()));

  const buckets = await parseGeminiFile(file, CWD);
  assert.equal(buckets.length, 1);
  const b = buckets[0];

  assert.equal(b.harness, "gemini");
  assert.equal(b.sessionId, GEMINI_SID);
  assert.equal(b.repo, "fakerepo");
  assert.equal(b.model, "gemini-2.5-pro");
  assert.equal(b.known, true); // priced from Google's published table (2026-07-10)
  assert.ok(b.usd > 0);

  // msg1 tokens.total 8780 + msg2 tokens.total 9088
  assert.equal(b.tokens, 17_868);
  assert.equal(b.input, 10_802); // (8606-0) + (9086-6890)
  assert.equal(b.cacheRead, 6_890);
  assert.equal(b.output, 176); // (29+145) + (2+0) — thoughts are reasoning output
  assert.equal(b.cacheWrite, 0);
  assert.equal(b.tokens, b.input + b.output + b.cacheWrite + b.cacheRead);

  rmSync(root, { recursive: true, force: true });
});

test("gemini: torn read of a half-rewritten file yields nothing, never a partial count", async () => {
  const root = tmpdir();
  const file = writeGeminiTree(root, '{"sessionId":"x","messages":[{"id":"a","tok');
  assert.deepEqual(await parseGeminiFile(file, CWD), []);
  rmSync(root, { recursive: true, force: true });
});

test("gemini: a rewritten (grown) file replaces its buckets — no double count", async () => {
  const root = tmpdir();
  const now = Date.now();
  const file = writeGeminiTree(root, geminiFixture(now));

  const index = new UsageCostIndex({ projectsRoot: undefined, geminiTmpRoot: root, scanTtlMs: 0 });
  const first = await index.query("24h");
  assert.equal(first.tokensTotal, 17_868);

  // gemini-cli rewrites the WHOLE document on every message: same two messages
  // again, plus a third. A naive appender would report 17868*2 + 1000.
  const doc = JSON.parse(geminiFixture(now));
  doc.messages.push({
    id: "third-message",
    type: "gemini",
    timestamp: new Date(now).toISOString(),
    model: "gemini-2.5-pro",
    content: "ok",
    tokens: { input: 900, output: 100, cached: 0, thoughts: 0, tool: 0, total: 1000 },
  });
  writeFileSync(file, JSON.stringify(doc));
  utimesSync(file, new Date(), new Date(now + 5000));

  const second = await index.query("24h");
  assert.equal(second.tokensTotal, 18_868);
  assert.equal(index.stats.filesParsed, 2);

  rmSync(root, { recursive: true, force: true });
});

test("gemini: missing .project_root leaves cwd unknown rather than guessing", async () => {
  const root = tmpdir();
  const file = writeGeminiTree(root, geminiFixture(Date.now()), { projectRoot: null });
  const index = new UsageCostIndex({ geminiTmpRoot: root, scanTtlMs: 0 });
  const res = await index.query("24h");
  assert.equal(res.byRepo[0].repo, "other");
  rmSync(root, { recursive: true, force: true });
});

test("aggregation: byHarness splits all three sources, unknown models keep USD at 0", async () => {
  const now = Date.now();
  const claudeRoot = tmpdir();
  const codexRoot = tmpdir();
  const geminiRoot = tmpdir();

  const project = path.join(claudeRoot, "-tmp-fakerepo");
  mkdirSync(project, { recursive: true });
  writeFileSync(
    path.join(project, "sid.jsonl"),
    JSON.stringify({
      type: "assistant",
      sessionId: "sid",
      timestamp: new Date(now).toISOString(),
      cwd: CWD,
      message: {
        id: "msg_a",
        model: "claude-sonnet-5",
        usage: { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000 },
      },
    }) + "\n",
  );
  writeCodexTree(codexRoot, codexFixture(now));
  writeGeminiTree(geminiRoot, geminiFixture(now));

  const index = new UsageCostIndex({
    projectsRoot: claudeRoot,
    codexSessionsRoot: codexRoot,
    geminiTmpRoot: geminiRoot,
    scanTtlMs: 0,
  });
  const res = await index.query("24h");

  const harnesses = Object.fromEntries(res.byHarness.map((h) => [h.harness, h]));
  assert.deepEqual(Object.keys(harnesses).sort(), ["claude-code", "codex", "gemini"]);
  assert.equal(harnesses["claude-code"].tokens, 3100);
  assert.equal(harnesses.codex.tokens, 270_237);
  assert.equal(harnesses.gemini.tokens, 17_868);
  assert.equal(res.tokensTotal, 3100 + 270_237 + 17_868);

  // every harness is priced from its vendor's published table now, so each one
  // contributes real USD and the total is strictly more than Claude's share
  assert.ok(harnesses.codex.usd > 0);
  assert.ok(harnesses.gemini.usd > 0);
  assert.ok(res.totalUsd > harnesses["claude-code"].usd);

  // nothing in this fixture is unpriced; the unknown-model path (tokens counted,
  // USD 0, name surfaced) is covered in usage-costs.test.js with a sentinel model
  assert.deepEqual(res.unknownModels, []);

  // all three sessions land in byAgent, each tagged with its harness
  assert.equal(res.byAgent.length, 3);
  assert.equal(res.byAgent.find((a) => a.sessionId === CODEX_UUID).harness, "codex");
  // one repo: all three cwds resolve to the same fake worktree
  assert.equal(res.byRepo.length, 1);
  assert.equal(res.byRepo[0].repo, "fakerepo");

  for (const r of [claudeRoot, codexRoot, geminiRoot]) rmSync(r, { recursive: true, force: true });
});
