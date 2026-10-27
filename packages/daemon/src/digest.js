// lane L5: the end-of-day digest — one short message per project, posted to the project's
// chat room (the group an owner /bind-ed). Nothing is sent for a project without a room:
// a digest nobody asked for in someone's DM is spam, not a feature.
//
// The text is plain on purpose (no markup: replies are sent as plain text so a work item
// title can never inject formatting or links). The time-to-intervene line comes from the
// radar lane's GET /metrics/intervention when that endpoint exists; if it does not, or
// answers in a shape we do not recognise, the line is simply left out.

const DEFAULT_TIME = { h: 18, m: 0 };
const TITLE_LIMIT = 5;

export function parseTimeOfDay(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? "").trim());
  if (!m) return DEFAULT_TIME;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h <= 23 && min <= 59 ? { h, m: min } : DEFAULT_TIME;
}

const localDate = (ms) => {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** One line out of whatever the radar returns, or null when there is nothing usable. */
export function describeMetrics(metrics) {
  if (!metrics || typeof metrics !== "object") return null;
  if (typeof metrics.summary === "string" && metrics.summary) return metrics.summary.slice(0, 200);
  const ms = [metrics.medianMs, metrics.p50Ms, metrics.avgMs].find((v) => Number.isFinite(v));
  if (ms === undefined) return null;
  const minutes = Math.max(1, Math.round(ms / 60_000));
  const count = Number.isFinite(metrics.count) ? `, ${metrics.count} interventions` : "";
  return `median ${minutes} min${count}`;
}

/**
 * @param {Object} input
 * @param {{slug: string, name: string}} input.project
 * @param {Array<{title: string, status: string, updatedAt?: string}>} input.items
 * @param {{state?: string, lastText?: string}|null} input.pm
 * @param {number} input.approvals open approvals of this project
 * @param {object|null} [input.metrics]
 * @param {number} input.now
 */
export function composeDigest({ project, items, pm, approvals, metrics = null, now }) {
  const today = localDate(now);
  const count = (s) => items.filter((i) => i.status === s).length;
  const doneToday = items.filter((i) => i.status === "done" && i.updatedAt && localDate(Date.parse(i.updatedAt)) === today);
  const lines = [`📋 ${project.name} — end of day ${today}`];

  if (doneToday.length === 0) {
    lines.push("Nothing finished today.");
  } else {
    lines.push(`Done today: ${doneToday.length}`);
    for (const i of doneToday.slice(0, TITLE_LIMIT)) lines.push(`  ✓ ${i.title}`);
    if (doneToday.length > TITLE_LIMIT) lines.push(`  … and ${doneToday.length - TITLE_LIMIT} more`);
  }
  lines.push(`In progress: ${count("doing")} · In review: ${count("review")} · Ideas: ${count("idea")}`);
  if (approvals > 0) lines.push(`⚠ ${approvals} approval${approvals === 1 ? "" : "s"} waiting — /pending`);
  const intervene = describeMetrics(metrics);
  if (intervene) lines.push(`Time to intervene: ${intervene}`);
  // (no "PM said…" line: the digest goes to a group, and the last reply may have been private)
  return lines.join("\n");
}

export class DigestService {
  /**
   * @param {Object} deps all injected: this class owns the schedule, not the data sources
   * @param {() => string[]} deps.listSlugs
   * @param {(slug: string) => {slug: string, name: string}} deps.loadProject
   * @param {(slug: string) => object[]} deps.loadItems
   * @param {(slug: string) => object|null} deps.pmOf
   * @param {(slug: string) => number} deps.approvalsOf
   * @param {(slug: string) => Promise<object|null>} deps.fetchMetrics
   * @param {(slug: string, text: string) => Promise<boolean>} deps.sendToProject false = nowhere to send
   * @param {import("./json-state.js").JsonState} deps.state
   * @param {() => number} [deps.now]
   * @param {string} [deps.timeOfDay] "HH:MM" local time
   */
  constructor({ listSlugs, loadProject, loadItems, pmOf, approvalsOf, fetchMetrics, sendToProject, state, now = Date.now, timeOfDay }) {
    Object.assign(this, { listSlugs, loadProject, loadItems, pmOf, approvalsOf, fetchMetrics, sendToProject, state, now });
    this.at = parseTimeOfDay(timeOfDay);
    this.timer = null;
    this.running = false;
  }

  /** Send every project's digest that is due now and has not gone out today. */
  async runDue() {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.now();
      const d = new Date(now);
      const due = new Date(d.getFullYear(), d.getMonth(), d.getDate(), this.at.h, this.at.m).getTime();
      if (now < due) return;
      const today = localDate(now);
      const sentOn = this.state.get("digestSent", {});
      for (const slug of this.listSlugs()) {
        if (sentOn[slug] === today) continue;
        try {
          const metrics = await this.fetchMetrics(slug).catch(() => null);
          const text = composeDigest({
            project: this.loadProject(slug),
            items: this.loadItems(slug),
            pm: this.pmOf(slug),
            approvals: this.approvalsOf(slug),
            metrics,
            now,
          });
          if (await this.sendToProject(slug, text)) {
            sentOn[slug] = today;
            this.state.set("digestSent", { ...sentOn });
          }
        } catch (err) {
          console.warn(`[digest] ${slug}: ${err.message}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  // ponytail: a plain interval tick rather than computing "ms until 18:00" — it survives clock
  // changes and DST for free, and a due-check every minute is nothing.
  start(tickMs = 60_000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runDue(), tickMs);
    this.timer.unref?.();
    void this.runDue();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}
