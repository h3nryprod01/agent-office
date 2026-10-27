// Worker-lane scorecard: how each non-Anthropic worker lane (DeepSeek, MiMo,
// GLM, Kimi...) performs on real work. Two append-only logs written by the
// owner's own review/worker tooling feed it:
//   exec-usage.jsonl     one row per headless worker run: {ts, lane, turns, seconds,
//                        miss, hit, out, cost_usd, is_error, timeout, repo}
//                        cost_usd is the exact figure from the run, not an estimate
//   exec-scorecard.jsonl one row per independent review of a worker's output:
//                        {ts, executor, critical, high, rework, repo, task, findings...}
// "Passed review" = no critical, no high finding and no rework requested.
//
// The response is aggregates per lane only: repo names, task text and
// findings never leave this module (the endpoint may be served to a LAN).

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { laneOfModel } from "./worker-lanes.js";

const DAY_MS = 86_400_000;
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

export const DEFAULT_EXEC_DIR = process.env.AGENT_OFFICE_EXEC_DIR ?? path.join(os.homedir(), ".claude");

function readJsonl(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { rows: [], broken: 0 };
  }
  const rows = [];
  let broken = 0;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      broken += 1;
    }
  }
  return { rows, broken };
}

/**
 * @param {Object} opts
 * @param {string} [opts.execDir]     dir holding the two logs (default ~/.claude)
 * @param {number} [opts.windowDays]  0 = all time
 * @param {number} [opts.now]
 */
export function readScorecard({ execDir = DEFAULT_EXEC_DIR, windowDays = 30, now = Date.now() } = {}) {
  const cutoff = windowDays > 0 ? now - windowDays * DAY_MS : -Infinity;
  // all-time keeps rows without a usable ts; a bounded window cannot place them, so drops them
  const inWindow = (r) => windowDays === 0 || Date.parse(r?.ts) >= cutoff;
  const usageLog = readJsonl(path.join(execDir, "exec-usage.jsonl"));
  const reviewLog = readJsonl(path.join(execDir, "exec-scorecard.jsonl"));

  const lanes = new Map();
  const lane = (name) => {
    let l = lanes.get(name);
    if (!l) {
      l = {
        lane: name, jobs: 0, errors: 0, timeouts: 0, seconds: 0, usd: null,
        tokens: { miss: 0, hit: 0, out: 0 },
        reviews: 0, passed: 0, passRate: null, rework: 0, critical: 0, high: 0,
      };
      lanes.set(name, l);
    }
    return l;
  };

  for (const r of usageLog.rows.filter(inWindow)) {
    if (typeof r.lane !== "string" || !r.lane) continue;
    const l = lane(r.lane);
    l.jobs += 1;
    if (r.is_error) l.errors += 1;
    if (r.timeout) l.timeouts += 1;
    l.seconds += num(r.seconds) ?? 0;
    l.tokens.miss += num(r.miss) ?? 0;
    l.tokens.hit += num(r.hit) ?? 0;
    l.tokens.out += num(r.out) ?? 0;
    // usd stays null until at least one run reported a cost, so "unknown" is not shown as $0
    if (num(r.cost_usd) !== null) l.usd = (l.usd ?? 0) + r.cost_usd;
  }

  let unattributedReviews = 0;
  for (const r of reviewLog.rows.filter(inWindow)) {
    const name = laneOfModel(r.executor, { strict: true });
    if (!name) {
      unattributedReviews += 1; // e.g. executor "main": the session itself, not a worker lane
      continue;
    }
    const l = lane(name);
    const critical = num(r.critical) ?? 0;
    const high = num(r.high) ?? 0;
    l.reviews += 1;
    l.critical += critical;
    l.high += high;
    if (r.rework) l.rework += 1;
    if (!r.rework && critical === 0 && high === 0) l.passed += 1;
  }
  for (const l of lanes.values()) l.passRate = l.reviews > 0 ? l.passed / l.reviews : null;

  return {
    windowDays,
    lanes: [...lanes.values()].sort((a, b) => b.jobs - a.jobs || b.reviews - a.reviews || a.lane.localeCompare(b.lane)),
    unattributedReviews,
    brokenLines: usageLog.broken + reviewLog.broken,
  };
}

/**
 * GET /scorecard?days=N (default 30, 0 = all time) — same extraHttp contract
 * as the other handlers: returns true when the request was handled.
 */
export function createScorecardHttpHandler({ execDir = DEFAULT_EXEC_DIR } = {}) {
  return (req, res, url) => {
    if (req.method !== "GET" || url.pathname !== "/scorecard") return false;
    const headers = { "content-type": "application/json", "access-control-allow-origin": "*" };
    const raw = url.searchParams.get("days") ?? "30";
    const days = /^\d{1,4}$/.test(raw) ? Number(raw) : NaN;
    if (Number.isNaN(days)) {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ error: "days must be an integer 0..9999 (0 = all time)" }));
      return true;
    }
    res.writeHead(200, headers);
    res.end(JSON.stringify(readScorecard({ execDir, windowDays: days })));
    return true;
  };
}
