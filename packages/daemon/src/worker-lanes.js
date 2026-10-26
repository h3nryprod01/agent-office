// Worker lanes: Claude Code can run against a non-Anthropic model behind an
// isolated config dir (DeepSeek, MiMo, GLM, Kimi...). Its transcripts have the
// same format as the main ones but live in another root, so the daemon tails
// several roots and tags each with a harness. A "lane" is the model vendor,
// derived from the model id in the transcript.

import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// [lane, test on the lowercased model id] — first match wins. Kimi's own id is
// "k3[1m]", which never contains the word "kimi".
const KNOWN_LANES = [
  ["deepseek", (m) => m.includes("deepseek")],
  ["mimo", (m) => m.includes("mimo")],
  ["glm", (m) => m.includes("glm")],
  ["kimi", (m) => m.includes("kimi") || m.includes("moonshot") || /^k\d/.test(m)],
  ["qwen", (m) => m.includes("qwen")],
];

/**
 * Vendor lane of a model id, or null for Anthropic / synthetic / missing ids.
 * An unrecognised id still gets a readable lane ("openai/gpt-oss-20b" ->
 * "gpt-oss") so a new worker shows up without a code change — unless
 * `strict`, which only answers for the known worker vendors (free text such
 * as a scorecard "executor" must not turn "main" into a lane).
 * @param {string|null|undefined} model
 * @param {{strict?: boolean}} [opts]
 * @returns {string|null}
 */
export function laneOfModel(model, { strict = false } = {}) {
  const m = String(model ?? "").trim().toLowerCase();
  if (!m || m.startsWith("<") || m.startsWith("claude-")) return null;
  for (const [lane, test] of KNOWN_LANES) if (test(m)) return lane;
  if (strict) return null;
  const slug = m.split("/").pop().replace(/\[.*$/, "").replace(/[-_.]?\d.*$/, "").replace(/-+$/, "");
  return slug || null;
}

/**
 * Transcript roots to tail, each tagged with the harness its agents report.
 * Main root: CLAUDE_PROJECTS_ROOT or ~/.claude/projects. Worker root:
 * <EXEC_CONFIG_DIR or ~/.claude-worker>/projects when it exists (the same dir
 * the worker launchers and `session-usage` use). Extra roots come from
 * AGENT_OFFICE_CLAUDE_ROOTS, path.delimiter-separated; an entry is a worker
 * root unless written `claude=<path>`.
 * @returns {{root: string, harness: "claude-code"|"claude-worker"}[]}
 */
export function resolveClaudeRoots({ env = process.env, homeDir = os.homedir() } = {}) {
  const roots = [
    { root: env.CLAUDE_PROJECTS_ROOT ?? path.join(homeDir, ".claude", "projects"), harness: "claude-code" },
  ];
  const workerRoot = path.join(env.EXEC_CONFIG_DIR ?? path.join(homeDir, ".claude-worker"), "projects");
  if (existsSync(workerRoot)) roots.push({ root: workerRoot, harness: "claude-worker" });
  for (const entry of (env.AGENT_OFFICE_CLAUDE_ROOTS ?? "").split(path.delimiter)) {
    const raw = entry.trim();
    if (!raw) continue;
    const plain = raw.startsWith("claude=");
    roots.push({ root: plain ? raw.slice("claude=".length) : raw, harness: plain ? "claude-code" : "claude-worker" });
  }
  const seen = new Set();
  return roots.filter(({ root }) => {
    let key = path.resolve(root);
    try {
      key = realpathSync(key); // a symlinked or relative alias of a root already listed
    } catch {
      // root does not exist (yet): the resolved string is all we can compare
    }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
