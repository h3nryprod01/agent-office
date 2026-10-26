// "How long does the human keep an agent waiting?" — time-to-intervene.
//
// An EPISODE opens when an agent enters a state that needs a person:
//   waiting_permission  hook_signal waiting_permission, or an office approval_pending
//   blocked             a tool_call error whose text says the permission was denied
//   error               any other failing tool_call
// and closes when it is lifted: the person approved/denied it in the office,
// answered in the terminal, or the agent simply carried on (its next event).
// Closing uses the EVENT timestamps (not the wall clock), so replaying the
// transcripts at daemon boot reproduces the same episodes; ids are
// deterministic and deduplicated against what is already on disk.
//
// Episodes are bucketed by the local calendar day they were resolved on and
// stored one JSONL file per day:
//   <AGENT_OFFICE_HOME or ~/.agent-office>/metrics/intervention/YYYY-MM-DD.jsonl
// No paths or text are stored — only ids, kind, timings and the project key.
//
// ponytail: a self-recovering `error` (the model retries a failed command within
// seconds) counts as an episode too. The per-kind breakdown separates them from
// permission waits; add a min-duration filter if the error median proves noisy.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const AGENT_OFFICE_HOME = process.env.AGENT_OFFICE_HOME ?? path.join(os.homedir(), ".agent-office");
export const DEFAULT_METRICS_DIR = path.join(AGENT_OFFICE_HOME, "metrics", "intervention");
export const DEFAULT_PROJECTS_DIR = path.join(AGENT_OFFICE_HOME, "projects");
export const KINDS = ["waiting_permission", "blocked", "error"];

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const MAX_OPEN = 5000;

const pad = (n) => String(n).padStart(2, "0");

/** Local calendar day, "YYYY-MM-DD". */
export function localDay(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** count / median (mean of the middle pair when even) / p90 (nearest rank) / total, in ms. */
export function stats(durations) {
  const sorted = [...durations].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0) return { count: 0, medianMs: 0, p90Ms: 0, totalMs: 0 };
  const mid = n >> 1;
  const medianMs = n % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return {
    count: n,
    medianMs,
    p90Ms: sorted[Math.ceil(0.9 * n) - 1],
    totalMs: sorted.reduce((a, b) => a + b, 0),
  };
}

/**
 * cwd → project slug. A project claims its own cwd and everything below it
 * (worktrees live under `<cwd>/.claude/worktrees`). Re-read every 30s so a
 * newly created project is picked up without a restart.
 */
export function createProjectResolver({ projectsDir = DEFAULT_PROJECTS_DIR, now = Date.now } = {}) {
  let loadedAt = -Infinity;
  let projects = [];
  const load = () => {
    projects = [];
    let entries = [];
    try {
      entries = fs.readdirSync(projectsDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const p = JSON.parse(fs.readFileSync(path.join(projectsDir, e.name, "project.json"), "utf8"));
        if (typeof p.cwd === "string" && p.cwd) {
          const slug = p.slug ?? e.name;
          projects.push({ slug, cwd: p.cwd });
          try {
            const real = fs.realpathSync(p.cwd); // events carry the cwd as the CLI saw it (/tmp vs /private/tmp)
            if (real !== p.cwd) projects.push({ slug, cwd: real });
          } catch {
            // project folder gone: the stored path still matches
          }
        }
      } catch {
        // unreadable project.json: skip it, never take the daemon down
      }
    }
    // longest cwd first so a nested project wins over its parent
    projects.sort((a, b) => b.cwd.length - a.cwd.length);
  };
  return (cwd) => {
    if (!cwd) return null;
    if (now() - loadedAt > 30_000) {
      loadedAt = now();
      load();
    }
    const hit = projects.find((p) => cwd === p.cwd || cwd.startsWith(p.cwd + path.sep) || cwd.startsWith(`${p.cwd}/`));
    return hit ? hit.slug : null;
  };
}

function classify(event) {
  switch (event.type) {
    case "hook_signal":
      if (event.meta?.state === "waiting_permission") return { start: "waiting_permission" };
      return event.meta?.state === "working" ? { end: "resumed" } : null;
    case "approval_pending":
      return { start: "waiting_permission" };
    case "approval_resolved": {
      const d = event.meta?.decision;
      // "none" = expired with nobody deciding: the terminal dialog is still waiting
      return d === "allow" ? { end: "approved" } : d === "deny" ? { end: "denied" } : null;
    }
    case "session_end":
      // a permission prompt writes no transcript line, so the 5-minute inactivity
      // timeout fires while a person is still being waited on: keep that wait
      return event.meta?.reason === "inactivity_timeout" ? { dropUnlessWaiting: true } : { drop: true };
    case "tool_call":
      if (event.status === "error") return { start: /has been denied/i.test(event.detail ?? "") ? "blocked" : "error" };
      return { end: "resumed" };
    case "speak":
    case "session_start":
      return { end: "resumed" };
    default:
      return null;
  }
}

export class InterventionMetrics {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.dir] where the day files live
   * @param {() => number} [opts.now]
   * @param {(cwd: string|null, repo: string|null) => string|null} [opts.projectOf]
   * @param {number} [opts.retentionDays]
   * @param {number} [opts.flushMs] 0 = write each episode immediately
   */
  constructor({
    dir = DEFAULT_METRICS_DIR,
    now = Date.now,
    projectOf = createProjectResolver({ now }),
    retentionDays = 90,
    flushMs = 1000,
  } = {}) {
    this.dir = dir;
    this.now = now;
    this.projectOf = projectOf;
    this.retentionDays = retentionDays;
    this.flushMs = flushMs;
    /** @type {Map<string, object>} agentId → open episode */
    this.open = new Map();
    /** @type {Map<string, object>} episode id → episode */
    this.done = new Map();
    this.queue = [];
    this.timer = null;
    this.#load();
  }

  #load() {
    let files = [];
    try {
      files = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    const cutoff = localDay(this.now() - this.retentionDays * DAY_MS);
    for (const f of files) {
      const m = DAY_FILE_RE.exec(f);
      if (!m) continue;
      if (m[1] < cutoff) {
        try {
          fs.unlinkSync(path.join(this.dir, f)); // outside retention: the file is ours, drop it
        } catch {
          // best effort
        }
        continue;
      }
      let text;
      try {
        text = fs.readFileSync(path.join(this.dir, f), "utf8");
      } catch {
        continue; // unreadable (a folder, permissions): the metrics are optional, startup is not
      }
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          const ep = JSON.parse(line);
          this.done.set(ep.id, ep);
        } catch {
          // torn last line after a crash: skip it
        }
      }
    }
  }

  /** @param {import("./event-schema.js").NormalizedEvent} event */
  onEvent(event) {
    if (!event?.agentId || !Number.isFinite(event.ts) || this.now() - event.ts > this.retentionDays * DAY_MS) return;
    const c = classify(event);
    if (!c) return;
    const id = event.agentId;
    const ep = this.open.get(id);
    if (c.drop || (c.dropUnlessWaiting && ep?.kind !== "waiting_permission")) {
      this.open.delete(id);
      return;
    }
    if (c.dropUnlessWaiting) return;
    // declining a prompt in the terminal surfaces as a tool error: that ends the wait
    if (c.start && ep?.kind === "waiting_permission" && event.type === "tool_call" && event.ts > ep.startTs) {
      this.open.delete(id);
      this.#record({ ...ep, id: `${id}:${ep.startTs}:${ep.kind}`, endTs: event.ts, durationMs: event.ts - ep.startTs, resolution: "denied" });
      return;
    }
    if (c.start) {
      // a permission wait outranks an error the agent had just hit: close that one, open the wait
      if (ep && !(c.start === "waiting_permission" && ep.kind !== "waiting_permission" && event.ts > ep.startTs)) return;
      if (ep) {
        this.open.delete(id);
        this.#record({ ...ep, id: `${id}:${ep.startTs}:${ep.kind}`, endTs: event.ts, durationMs: event.ts - ep.startTs, resolution: "resumed" });
      }
      if (this.open.size >= MAX_OPEN) this.open.delete(this.open.keys().next().value);
      this.open.set(id, {
        agentId: id,
        sessionId: event.sessionId,
        kind: c.start,
        startTs: event.ts,
        repo: event.repo ?? null,
        project: this.projectOf(event.cwd, event.repo ?? null),
        harness: event.harness ?? null,
      });
      return;
    }
    // `<=`: sibling tool_results of one transcript line share a timestamp, so
    // an erroring result followed by an ok one must not close as a 0 ms episode
    if (!ep || event.ts <= ep.startTs) return;
    this.open.delete(id);
    this.#record({
      ...ep,
      id: `${id}:${ep.startTs}:${ep.kind}`,
      endTs: event.ts,
      durationMs: event.ts - ep.startTs,
      resolution: c.end,
    });
  }

  #record(ep) {
    if (this.done.has(ep.id)) return;
    this.done.set(ep.id, ep);
    this.queue.push(ep);
    if (this.flushMs <= 0) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.flushMs);
      this.timer.unref?.();
    }
  }

  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.queue.length === 0) return;
    const byDay = new Map();
    for (const ep of this.queue.splice(0)) {
      const day = localDay(ep.endTs);
      byDay.set(day, `${byDay.get(day) ?? ""}${JSON.stringify(ep)}\n`);
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      for (const [day, text] of byDay) {
        const file = path.join(this.dir, `${day}.jsonl`);
        // a crash can leave a torn last line; start on a fresh line so it cannot swallow ours
        const torn = fs.existsSync(file) && !fs.readFileSync(file, "utf8").endsWith("\n") && fs.statSync(file).size > 0;
        fs.appendFileSync(file, (torn ? "\n" : "") + text);
      }
    } catch (error) {
      console.error("[intervention-metrics] write failed:", error.message);
    }
  }

  stop() {
    this.flush();
  }

  /** Every resolved episode held in memory (retention window). */
  episodes() {
    return [...this.done.values()];
  }

  /**
   * @param {Object} [q]
   * @param {number} [q.days] window length ending today (default 7)
   * @param {string} [q.date] a single local day, overrides days
   * @param {string} [q.project] project slug or repo name
   * @param {string} [q.kind] one of KINDS
   */
  summary({ days = 7, date, project, kind } = {}) {
    const now = this.now();
    const span = Math.min(Math.max(Math.trunc(days) || 7, 1), this.retentionDays);
    const dates = date
      ? [date]
      : Array.from({ length: span }, (_, i) => {
          const d = new Date(now);
          d.setDate(d.getDate() - (span - 1 - i)); // calendar steps: a DST day is not 24 h
          return localDay(d.getTime());
        });
    const inWindow = new Set(dates);
    const key = (e) => e.project ?? e.repo ?? "other";

    const eps = this.episodes().filter(
      (e) =>
        inWindow.has(localDay(e.endTs)) &&
        (!kind || e.kind === kind) &&
        (!project || e.project === project || e.repo === project),
    );
    const group = (list, by) => {
      const out = {};
      for (const k of new Set(list.map(by))) out[k] = stats(list.filter((e) => by(e) === k).map((e) => e.durationMs));
      return out;
    };
    return {
      generatedAt: now,
      window: { from: dates[0], to: dates.at(-1), days: dates.length },
      filters: { project: project ?? null, kind: kind ?? null },
      total: stats(eps.map((e) => e.durationMs)),
      byKind: group(eps, (e) => e.kind),
      byProject: group(eps, key),
      byDay: dates.map((d) => {
        const day = eps.filter((e) => localDay(e.endTs) === d);
        return { date: d, ...stats(day.map((e) => e.durationMs)), byProject: group(day, key) };
      }),
      open: this.open.size,
    };
  }
}

/** GET /metrics/intervention?days=&date=&project=&kind= */
export function createMetricsHttpHandler(metrics) {
  return (req, res, url) => {
    if (url.pathname !== "/metrics/intervention") return false;
    const respond = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.method !== "GET") {
      respond(405, { error: "method not allowed" });
      return true;
    }
    const q = url.searchParams;
    const date = q.get("date");
    const kind = q.get("kind");
    respond(
      200,
      metrics.summary({
        days: Number(q.get("days")) || 7,
        date: date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined,
        project: q.get("project") || undefined,
        kind: KINDS.includes(kind) ? kind : undefined,
      }),
    );
    return true;
  };
}

/** Observe every broadcast event (the attachNotifier wrapping trick). */
export function attachInterventionMetrics(server, opts = {}) {
  const metrics = new InterventionMetrics(opts);
  const original = server.broadcast.bind(server);
  server.broadcast = (event) => {
    original(event);
    try {
      metrics.onEvent(event);
    } catch (error) {
      console.error("[intervention-metrics] error handling event:", error.message);
    }
  };
  return metrics;
}
