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

/**
 * Price entry for a model name as it appears in transcripts (may carry a
 * date suffix, e.g. "claude-haiku-4-5-20251001"). A row matches when the
 * name IS the family or is the family plus a "-2…" date suffix — so
 * "claude-opus-4-8" can never fall through to the "claude-opus-4" row.
 * @param {string|null|undefined} model
 * @returns {{input:number, output:number, cacheWrite:number, cacheRead:number}|null}
 */
export function priceFor(model) {
  if (!model) return null;
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
 * @returns {{usd:number, known:boolean}}
 */
export function costUsd(model, usage) {
  const p = priceFor(model);
  if (!p) return { usd: 0, known: false };
  const usd =
    ((usage.input_tokens ?? 0) * p.input +
      (usage.output_tokens ?? 0) * p.output +
      (usage.cache_creation_input_tokens ?? 0) * p.cacheWrite +
      (usage.cache_read_input_tokens ?? 0) * p.cacheRead) /
    1e6;
  return { usd, known: true };
}
