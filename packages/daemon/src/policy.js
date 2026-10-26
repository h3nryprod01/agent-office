// lane L2: per-project policy = how permission requests are answered
// (`policy.approval`) and which harnesses/lanes may run in the project at all
// (`policy.allowedHarnesses` / `allowedLanes`). Stored in project.json.
//
// Pure functions only — file I/O lives in policy-store.js, HTTP in policy-http.js.
// A project WITHOUT a `policy` key normalizes to mode "ask" with no data rules,
// which is exactly the behaviour before this lane existed.

import { classifyDanger } from "./policy-danger.js";

export const APPROVAL_MODES = Object.freeze(["ask", "auto", "read-only", "deny"]);

/** Tools that only look. Everything else is "writes or runs" for read-only mode. */
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead"]);

const ROLE_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const TOOL_RE = /^[A-Za-z0-9_.:-]{1,79}\*?$/; // a `*` only as the last character (prefix match)
const HARNESS_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LIST_MAX = 20;

function invalid(message) {
  const err = new Error(message);
  err.code = "INVALID";
  return err;
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The transcript tailers say "claude-code"; the shared contract says "claude". */
export function normalizeHarness(harness) {
  if (typeof harness !== "string" || harness === "" || harness === "claude-code") return "claude";
  return harness;
}

function cleanModeMap(raw, keyRe) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const [key, mode] of Object.entries(raw)) {
    if (keyRe.test(key) && APPROVAL_MODES.includes(mode)) out[key] = mode;
  }
  return out;
}

function cleanList(raw) {
  if (!Array.isArray(raw)) return null;
  const list = raw.filter((v) => typeof v === "string" && HARNESS_RE.test(v)).slice(0, LIST_MAX);
  return list.length > 0 ? list : null; // an empty whitelist would mean "nothing may run" — treat as no rule
}

/**
 * Tolerant read of whatever is in project.json: unknown/garbage → safe defaults,
 * never throws (a hand-edited file must not take the approval path down).
 */
export function normalizePolicy(raw) {
  const p = isPlainObject(raw) ? raw : {};
  const a = isPlainObject(p.approval) ? p.approval : {};
  return {
    approval: {
      mode: APPROVAL_MODES.includes(a.mode) ? a.mode : "ask",
      roles: cleanModeMap(a.roles, ROLE_RE),
      tools: cleanModeMap(a.tools, TOOL_RE),
    },
    allowedHarnesses: cleanList(p.allowedHarnesses),
    allowedLanes: cleanList(p.allowedLanes),
  };
}

/** Strict version for the write API: reject instead of silently dropping. Returns the normalized policy. */
export function validatePolicy(input) {
  if (!isPlainObject(input)) throw invalid("policy must be an object");
  for (const key of Object.keys(input)) {
    if (!["approval", "allowedHarnesses", "allowedLanes"].includes(key)) throw invalid(`policy: unknown field "${key}"`);
  }
  if (input.approval !== undefined) {
    if (!isPlainObject(input.approval)) throw invalid("policy.approval must be an object");
    const { mode, roles, tools, ...rest } = input.approval;
    if (Object.keys(rest).length > 0) throw invalid(`policy.approval: unknown field "${Object.keys(rest)[0]}"`);
    if (mode !== undefined && !APPROVAL_MODES.includes(mode)) throw invalid(`policy.approval.mode must be one of ${APPROVAL_MODES.join("|")}`);
    for (const [name, map, keyRe] of [["roles", roles, ROLE_RE], ["tools", tools, TOOL_RE]]) {
      if (map === undefined) continue;
      if (!isPlainObject(map)) throw invalid(`policy.approval.${name} must be an object`);
      for (const [key, value] of Object.entries(map)) {
        if (!keyRe.test(key)) throw invalid(`policy.approval.${name}: bad key ${JSON.stringify(key)}`);
        if (!APPROVAL_MODES.includes(value)) throw invalid(`policy.approval.${name}.${key} must be one of ${APPROVAL_MODES.join("|")}`);
      }
    }
  }
  for (const field of ["allowedHarnesses", "allowedLanes"]) {
    const list = input[field];
    if (list === undefined || list === null) continue;
    if (!Array.isArray(list) || list.length > LIST_MAX) throw invalid(`policy.${field} must be an array of at most ${LIST_MAX} names`);
    for (const name of list) {
      if (typeof name !== "string" || !HARNESS_RE.test(name)) throw invalid(`policy.${field}: bad name ${JSON.stringify(name)}`);
    }
  }
  return normalizePolicy(input);
}

/** Which mode applies to this call, and why. Most specific wins: tool > role > project. */
export function resolveMode(policy, { role, tool } = {}) {
  const { approval } = policy;
  if (tool && Object.hasOwn(approval.tools, tool)) return { mode: approval.tools[tool], source: "tool" };
  // `mcp__github__*`: the longest matching prefix wins (a key that did match nothing would fail open)
  const prefix = tool && Object.keys(approval.tools).filter((k) => k.endsWith("*") && tool.startsWith(k.slice(0, -1))).sort((a, b) => b.length - a.length)[0];
  if (prefix) return { mode: approval.tools[prefix], source: "tool" };
  if (role && Object.hasOwn(approval.roles, role)) return { mode: approval.roles[role], source: "role" };
  return { mode: approval.mode, source: "project" };
}

const POLICY_TAG = "Denied by Agent Office policy";

/**
 * Answer one permission request from policy alone.
 *   decision "allow" | "deny" → answered automatically (caller audits it)
 *   decision "ask"            → a human must answer; `forced` says why a looser
 *                               mode was pulled back ("danger" | "budget"), null
 *                               when the mode itself is ask.
 * @returns {{decision: "allow"|"deny"|"ask", mode: string, source: string, reasons: string[], forced: "danger"|"budget"|null, message?: string}}
 */
export function decide({ policy, tool, toolInput, role, overBudget = false, root, home }) {
  const { mode, source } = resolveMode(policy, { role, tool });
  const base = { mode, source, reasons: [], forced: null };

  if (mode === "ask") return { ...base, decision: "ask" };
  if (mode === "deny") return { ...base, decision: "deny", message: `${POLICY_TAG}: this project denies all tool requests.` };

  if (mode === "read-only") {
    if (!READ_TOOLS.has(tool)) {
      return { ...base, decision: "deny", message: `${POLICY_TAG} (read-only): ${tool || "this tool"} can write files or run commands.` };
    }
    const reasons = classifyDanger({ tool, toolInput, root, home });
    return reasons.length > 0 ? { ...base, decision: "ask", reasons, forced: "danger" } : { ...base, decision: "allow" };
  }

  // mode === "auto"
  if (overBudget) return { ...base, decision: "ask", forced: "budget" };
  const reasons = classifyDanger({ tool, toolInput, root, home });
  return reasons.length > 0 ? { ...base, decision: "ask", reasons, forced: "danger" } : { ...base, decision: "allow" };
}

/**
 * Data rule: is a session of this harness/lane allowed in this project?
 * @returns {null | {kind: "harness"|"lane", value: string, allowed: string[]}}
 */
export function harnessViolation(policy, { harness, lane } = {}) {
  const h = normalizeHarness(harness);
  if (policy.allowedHarnesses && !policy.allowedHarnesses.includes(h)) {
    return { kind: "harness", value: h, allowed: policy.allowedHarnesses };
  }
  // A lane rule can only judge sessions that report their lane; an unknown lane is not a violation.
  if (policy.allowedLanes && typeof lane === "string" && lane !== "" && !policy.allowedLanes.includes(lane)) {
    return { kind: "lane", value: lane, allowed: policy.allowedLanes };
  }
  return null;
}

const RANK = { deny: 0, "read-only": 1, ask: 2, auto: 3 };

/**
 * Least role allowed to turn `before` into `after`: "owner" when ANY effective mode gets more
 * permissive (deny→ask counts, so does deleting a per-tool deny) or the data rules change (they
 * decide what leaves the building); "manager" when it only tightens or leaves things as they were.
 * Effective modes are compared for every tool/role named in either policy plus the unnamed case.
 */
export function requiredRole(before, after) {
  const tools = [undefined, ...new Set([...Object.keys(before.approval.tools), ...Object.keys(after.approval.tools)])];
  const roles = [undefined, ...new Set([...Object.keys(before.approval.roles), ...Object.keys(after.approval.roles)])];
  for (const tool of tools) {
    for (const role of roles) {
      if (RANK[resolveMode(after, { tool, role }).mode] > RANK[resolveMode(before, { tool, role }).mode]) return "owner";
    }
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (!same(before.allowedHarnesses, after.allowedHarnesses) || !same(before.allowedLanes, after.allowedLanes)) return "owner";
  return "manager";
}
