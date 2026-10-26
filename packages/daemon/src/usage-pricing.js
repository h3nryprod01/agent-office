// Per-model pricing (USD per million tokens), taken from each vendor's official
// pricing page on 2026-07-10 (see SOURCES below). Nothing here is guessed.
//
// A model not in this table is reported as "unknown": its tokens are still
// counted, its USD contribution is 0, and the model name is surfaced in the
// /costs payload so a human can add a row here instead of the code guessing.
//
// Cache pricing is NOT one rule across vendors, so a row may override it:
//   - Anthropic: cache write = 1.25× input, cache read = 0.1× input.
//   - OpenAI / Gemini: cached input = 0.1× input; no per-token cache-write charge.
//   - Z.ai GLM: cached input ≈ 0.19× input ($0.26 on $1.40) — NOT 0.1×.
// Hence the optional 4th tuple element: an absolute cache-read price. Codex and
// Gemini buckets only ever carry cacheRead (their parsers subtract cached from
// input and never set cacheWrite), so the write multiplier is moot for them.
//
// Known limits, stated rather than papered over:
//   - Gemini 2.5 Pro charges 2× above a 200k-token prompt; this flat row
//     undercounts those requests.
//   - Claude Sonnet 5 is on introductory pricing ($2/$10) through 2026-08-31,
//     reverting to $3/$15 on 2026-09-01. Update this row then.
//
// SOURCES (fetched 2026-07-10):
//   Anthropic  https://platform.claude.com/docs/en/about-claude/pricing
//   OpenAI     https://developers.openai.com/api/docs/pricing
//   Google     https://ai.google.dev/gemini-api/docs/pricing
//   Z.ai GLM   https://docs.z.ai/guides/overview/pricing
//   lane L3 (worker lanes) — the rates below are copied from the owner's own
//   price table (exec_prices.py, read 2026-10-19), not guessed:
//   MiMo       https://mimo.mi.com/docs/en-US/price/pay-as-you-go (overseas table)
//   DeepSeek   https://api-docs.deepseek.com/quick_start/pricing — off-peak is
//              half of peak; peak = Mon–Fri 01–04 and 06–10 UTC. Chinese public
//              holidays are not modelled, so a holiday weekday is priced as peak
//              (an upper bound), and so is a call with no timestamp.
//   Kimi has no per-token price (flat-fee plan): its tokens count, usd stays 0.

/** [familyPrefix, inputUsdPerMTok, outputUsdPerMTok, cacheReadUsdPerMTok?] */
const PRICING_TABLE = [
  // ── Anthropic (Claude Code) ────────────────────────────────────────────
  ["claude-fable-5", 10, 50],
  ["claude-opus-4-8", 5, 25],
  ["claude-opus-4-7", 5, 25],
  ["claude-opus-4-6", 5, 25],
  ["claude-opus-4-5", 5, 25],
  ["claude-opus-4-1", 15, 75],
  ["claude-opus-4", 15, 75],
  ["claude-sonnet-5", 2, 10], // introductory price; $3/$15 from 2026-09-01
  ["claude-sonnet-4-6", 3, 15],
  ["claude-sonnet-4-5", 3, 15],
  ["claude-sonnet-4", 3, 15],
  ["claude-haiku-4-5", 1, 5],
  ["claude-3-7-sonnet", 3, 15],
  ["claude-3-5-haiku", 0.8, 4],
  // ── OpenAI (Codex CLI) — cached input is an absolute price, no write fee ─
  ["gpt-5.5", 5, 30, 0.5],
  ["gpt-5.4-mini", 0.75, 4.5, 0.075], // before the gpt-5.4 row: longest match first
  ["gpt-5.4-nano", 0.2, 1.25, 0.02],
  ["gpt-5.4", 2.5, 15, 0.25],
  ["gpt-5.3-codex", 1.75, 14, 0.175],
  // ── Google (Gemini CLI) ────────────────────────────────────────────────
  ["gemini-2.5-flash", 0.3, 2.5, 0.03],
  ["gemini-2.5-pro", 1.25, 10, 0.125], // flat row: >200k prompts cost 2× (undercounts)
  // ── Z.ai GLM — cache read ≈ 0.19× input, NOT 0.1× ──────────────────────
  ["glm-5.2", 1.4, 4.4, 0.26],
  ["glm-4.7", 0.6, 2.2, 0.11],
];

// Pay-as-you-go worker lanes: [cache-miss input, cache-hit input, output].
// Cache writes bill as fresh input (no 1.25× surcharge as on Anthropic).
const MIMO = { pro: [0.435, 0.0036, 0.87], flash: [0.14, 0.0028, 0.28] };
const DEEPSEEK_PEAK = { flash: [0.3, 0.006, 1.2], pro: [1.32, 0.044, 3.96] };
const DEEPSEEK_OFFPEAK = { flash: [0.15, 0.003, 0.6], pro: [0.66, 0.022, 1.98] };

/** DeepSeek peak = Mon–Fri, 01–04 and 06–10 UTC. No/invalid `ts` -> peak. */
export function isDeepseekPeak(ts) {
  if (typeof ts !== "number" || Number.isNaN(ts)) return true;
  const d = new Date(ts);
  return d.getUTCDay() >= 1 && d.getUTCDay() <= 5 && [1, 2, 3, 6, 7, 8, 9].includes(d.getUTCHours());
}

function workerPrice(model, ts) {
  const m = model.toLowerCase();
  let row = null;
  if (m.includes("deepseek")) {
    row = (isDeepseekPeak(ts) ? DEEPSEEK_PEAK : DEEPSEEK_OFFPEAK)[m.includes("pro") ? "pro" : "flash"];
  } else if (m.includes("mimo")) {
    row = MIMO[m.includes("flash") ? "flash" : "pro"];
  }
  return row && { input: row[0], output: row[2], cacheWrite: row[0], cacheRead: row[1] };
}

/**
 * Price entry for a model name as it appears in transcripts (may carry a
 * date suffix, e.g. "claude-haiku-4-5-20251001"). A row matches when the
 * name IS the family or is the family plus a "-2…" date suffix — so
 * "claude-opus-4-8" can never fall through to the "claude-opus-4" row.
 * `ts` (ms) only matters for time-of-day pricing (DeepSeek peak/off-peak).
 * @param {string|null|undefined} model
 * @param {number} [ts]
 * @returns {{input:number, output:number, cacheWrite:number, cacheRead:number}|null}
 */
export function priceFor(model, ts) {
  if (!model) return null;
  const worker = workerPrice(model, ts);
  if (worker) return worker;
  for (const [prefix, input, output, cacheRead] of PRICING_TABLE) {
    if (model === prefix || model.startsWith(`${prefix}-2`)) {
      return {
        input,
        output,
        cacheWrite: input * 1.25,
        // an explicit vendor price wins; otherwise Anthropic's 0.1× rule
        cacheRead: cacheRead ?? input * 0.1,
      };
    }
  }
  return null;
}

/**
 * USD cost of one API response's usage block. Unknown model → usd 0,
 * known false.
 * @param {string|null|undefined} model
 * @param {{input_tokens?:number, output_tokens?:number, cache_creation_input_tokens?:number, cache_read_input_tokens?:number}} usage
 * @param {number} [ts] call time in ms, for time-of-day pricing
 * @returns {{usd:number, known:boolean}}
 */
export function costUsd(model, usage, ts) {
  const p = priceFor(model, ts);
  if (!p) return { usd: 0, known: false };
  const usd =
    ((usage.input_tokens ?? 0) * p.input +
      (usage.output_tokens ?? 0) * p.output +
      (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite +
      (usage.cache_read_input_tokens ?? 0) * p.cacheRead) /
    1e6;
  return { usd, known: true };
}
