// One parser per harness, each turning a session file into hour buckets.
// Extracted from usage-costs.js when the cost dashboard grew from one source
// (Claude Code) to three (+ Codex, + Gemini).
//
// Memory discipline (post-OOM #17): JSONL sources are streamed line by line
// and only numeric buckets are kept. Gemini is the exception — its session
// file is ONE JSON document rewritten in full on every message, so it must be
// read whole. ponytail: real files are a few KB; if one ever reaches tens of
// MB, parse incrementally off `lastUpdated` instead.
//
// Token model. All three harnesses are folded into the same four counters
// (input / output / cacheWrite / cacheRead) so `tokens` always equals their
// sum. `input` means *billable, non-cached* input — the cached portion is
// reported separately as `cacheRead`, never counted twice.
//
//   Claude Code  usage.{input,output,cache_creation_input,cache_read_input}_tokens
//                are already disjoint. Passed through unchanged.
//   Codex        input_tokens INCLUDES cached_input_tokens, and
//                total_tokens == input_tokens + output_tokens (verified on 249
//                real rollout files). output_tokens already includes
//                reasoning_output_tokens. No cache-creation counter exists.
//   Gemini       total == input + output + thoughts + tool, and `cached` is a
//                subset of `input` (verified on every real session on this
//                machine). `thoughts` is reasoning → output side. `tool`
//                (toolUsePromptTokenCount) is prompt side → input; it is 0 in
//                all real data observed.

import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import path from "node:path";
import { deriveRepo } from "./event-schema.js";
import { costUsd, priceFor } from "./usage-pricing.js";

const HOUR_MS = 3_600_000;

/** @typedef {{harness:string, sessionId:string, repo:string, model:string, known:boolean, hour:number, usd:number, tokens:number, input:number, output:number, cacheWrite:number, cacheRead:number}} Bucket */

/** Accumulates per-(session, model, hour) buckets for one file. */
class BucketSet {
  constructor(harness) {
    this.harness = harness;
    this.map = new Map();
  }

  /** @param {{sessionId:string, cwd:string|null|undefined, model:string, ts:number, input:number, output:number, cacheWrite?:number, cacheRead?:number}} rec */
  add({ sessionId, cwd, model, ts, input, output, cacheWrite = 0, cacheRead = 0 }) {
    const hour = Math.floor(ts / HOUR_MS);
    const key = `${sessionId}|${model}|${hour}`;
    let b = this.map.get(key);
    if (!b) {
      b = {
        harness: this.harness,
        sessionId,
        repo: deriveRepo(cwd),
        model,
        known: priceFor(model) !== null,
        hour: hour * HOUR_MS,
        usd: 0,
        tokens: 0,
        input: 0,
        output: 0,
        cacheWrite: 0,
        cacheRead: 0,
      };
      this.map.set(key, b);
    }
    const { usd } = costUsd(model, {
      input_tokens: input,
      output_tokens: output,
      cache_creation_input_tokens: cacheWrite,
      cache_read_input_tokens: cacheRead,
    });
    b.input += input;
    b.output += output;
    b.cacheWrite += cacheWrite;
    b.cacheRead += cacheRead;
    b.tokens += input + output + cacheWrite + cacheRead;
    b.usd += usd;
    return b;
  }

  /** @returns {Bucket[]} */
  values() {
    return [...this.map.values()];
  }
}

/** Stream a JSONL file, yielding parsed objects for lines passing `preFilter`. */
async function* jsonlRecords(filePath, preFilter) {
  const rl = createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!preFilter(line)) continue;
      try {
        yield JSON.parse(line);
      } catch {
        // torn write at EOF — the next mtime change re-parses the whole file
      }
    }
  } finally {
    rl.close();
  }
}

/**
 * Claude Code transcript (~/.claude/projects/**\/<session>.jsonl).
 *
 * Dedupe: the transcript writes one line per content block of an API
 * response, each repeating the same `message.id` and identical usage (up to 9
 * copies observed) — count once.
 * @returns {Promise<Bucket[]>}
 */
export async function parseClaudeFile(filePath) {
  const fallbackSession = path.basename(filePath, ".jsonl");
  const seenIds = new Set();
  const buckets = new BucketSet("claude-code");

  for await (const o of jsonlRecords(filePath, (l) => l.includes('"usage"'))) {
    if (o.type !== "assistant") continue;
    const u = o.message?.usage;
    if (!u) continue;
    const id = o.message.id ?? o.requestId;
    if (id) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }
    const ts = Date.parse(o.timestamp);
    if (Number.isNaN(ts)) continue;

    buckets.add({
      sessionId: o.sessionId ?? fallbackSession,
      cwd: o.cwd,
      model: o.message.model ?? "unknown",
      ts,
      input: u.input_tokens ?? 0,
      output: u.output_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
    });
  }
  return buckets.values();
}

/**
 * Codex rollout (~/.codex/sessions/<y>/<m>/<d>/rollout-<ts>-<uuid>.jsonl).
 *
 * Usage lives on `event_msg` / `token_count` records:
 *   info.last_token_usage  — this API response
 *   info.total_token_usage — running cumulative for the session
 *
 * Dedupe: codex re-emits a token_count carrying the SAME `last_token_usage`
 * when only `rate_limits` changed; on those the cumulative total does not
 * advance. Skipping events whose `total_token_usage.total_tokens` equals the
 * previously accepted one makes the summed `last_token_usage` reconcile
 * exactly with codex's own final total on 243 of 244 real rollout files (the
 * one outlier reports total=0 on its first event while last=16028 — real
 * tokens codex never folded into its counter, so they are counted).
 *
 * A decreasing total (session reset) is treated as a new baseline, not a
 * duplicate — no such file exists on this machine, but the rule is free.
 *
 * `token_count` carries no model; the model comes from the most recent
 * `turn_context` (every real token_count on this machine is preceded by one).
 * @returns {Promise<Bucket[]>}
 */
export async function parseCodexFile(filePath) {
  const uuid = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(
    path.basename(filePath),
  );
  const buckets = new BucketSet("codex");
  let sessionId = uuid?.[1] ?? path.basename(filePath, ".jsonl");
  let model = null;
  let cwd = null;
  let prevTotal = null;

  const preFilter = (l) =>
    l.includes('"token_count"') || l.includes('"turn_context"') || l.includes('"session_meta"');

  for await (const o of jsonlRecords(filePath, preFilter)) {
    if (o.type === "session_meta") {
      sessionId = o.payload?.id ?? o.payload?.session_id ?? sessionId;
      cwd ??= o.payload?.cwd ?? null;
      continue;
    }
    if (o.type === "turn_context") {
      model = o.payload?.model ?? model;
      cwd = o.payload?.cwd ?? cwd;
      continue;
    }
    if (o.payload?.type !== "token_count") continue;
    const info = o.payload.info;
    if (!info) continue; // rate-limit-only refresh

    const total = info.total_token_usage?.total_tokens ?? 0;
    if (prevTotal !== null && total === prevTotal) continue; // re-emission
    prevTotal = total;

    const last = info.last_token_usage;
    if (!last) continue;
    const ts = Date.parse(o.timestamp);
    if (Number.isNaN(ts)) continue;

    const cached = last.cached_input_tokens ?? 0;
    buckets.add({
      sessionId,
      cwd,
      model: model ?? "unknown",
      ts,
      input: Math.max(0, (last.input_tokens ?? 0) - cached),
      output: last.output_tokens ?? 0,
      cacheRead: cached,
    });
  }
  return buckets.values();
}

/**
 * Gemini CLI chat session (~/.gemini/tmp/<slug>/chats/session-*.json).
 *
 * The file is a single JSON document REWRITTEN IN FULL after every message
 * (see docs/gemini-adapter.md). Double-counting is prevented structurally:
 * a changed mtime replaces this file's whole bucket array rather than adding
 * to it. The per-message id Set guards the remaining case — a rewind that
 * replays an id within one parse.
 *
 * `cwd` is not in the chat file; the caller passes it (read from the sibling
 * `.project_root`).
 * @param {string} filePath
 * @param {string|null} cwd
 * @returns {Promise<Bucket[]>}
 */
export async function parseGeminiFile(filePath, cwd) {
  let doc;
  try {
    doc = JSON.parse(await readFile(filePath, "utf8"));
  } catch {
    return []; // torn read of a file being rewritten — next mtime change retries
  }
  const messages = Array.isArray(doc?.messages) ? doc.messages : [];
  const sessionId = doc?.sessionId ?? path.basename(filePath, ".json");
  const seenIds = new Set();
  const buckets = new BucketSet("gemini");

  for (const m of messages) {
    const t = m?.tokens;
    if (!t) continue;
    if (m.id) {
      if (seenIds.has(m.id)) continue;
      seenIds.add(m.id);
    }
    const ts = Date.parse(m.timestamp);
    if (Number.isNaN(ts)) continue;

    const cached = t.cached ?? 0;
    buckets.add({
      sessionId,
      cwd,
      model: m.model ?? "unknown",
      ts,
      input: Math.max(0, (t.input ?? 0) - cached) + (t.tool ?? 0),
      output: (t.output ?? 0) + (t.thoughts ?? 0),
      cacheRead: cached,
    });
  }
  return buckets.values();
}
