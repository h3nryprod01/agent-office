// Collision radar. Keeps, per file, the set of agents that recently set out to
// write it (events carry `meta.paths` — see touched-paths.js) and warns when
// agents that are NOT part of one parent/child tree step on each other:
//
//   file      two unrelated sessions write the same absolute path (hard)
//   worktree  same repo, different worktrees, same repo-relative path — no
//             overwrite today, but a merge conflict tomorrow (soft)
//   worker    two `claude-worker` sessions on one repo — a standing house rule
//
// One alert per (kind, subject) — a third agent joining the same file updates
// the open alert instead of raising another. It stays open while at least two
// trees are still active on the subject, then a `collision_resolved` closes it.
//
// Alerts ride the normal event stream (additive types `collision_alert` /
// `collision_resolved`, anchored on a real agent so the renderer's raw tap and
// the ws replay buffer treat them like approval events) and are served again
// by GET /radar for late-joining pages.

import { createHash } from "node:crypto";
import path from "node:path";
import { makeEvent } from "./event-schema.js";
import { checkoutOf, checkoutOfDir } from "./checkout.js";
import { buildOfficeUrl, deliverNotification } from "./notifier.js";

export const DEFAULT_TTL_MS = 10 * 60 * 1000;
const RADAR_EVENT_TYPES = new Set(["collision_alert", "collision_resolved"]);
const MAX_ALERTS = 50;
const MAX_CWDS = 2000;
/** an alert raised from an event older than this is a replay (daemon restart): show it, do not notify again */
const FRESH_MS = 30_000;
const SWEEP_EVERY_MS = 10_000;
const WORKER_HARNESS = "claude-worker";

const shortId = (s) => createHash("sha1").update(s).digest("hex").slice(0, 12);

export class FileRadar {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.ttlMs] how long a touch (or worker activity) counts
   * @param {() => number} [opts.now]
   * @param {(event: object) => void} [opts.emit] where alert events go (the raw broadcast)
   * @param {(n: {title,subtitle,message,url}) => void} [opts.notify] desktop notification
   * @param {(absPath: string) => ({root,repoId,rel}|null)} [opts.checkout]
   * @param {(dir: string) => ({root,repoId}|null)} [opts.checkoutDir]
   * @param {string} [opts.officeUrl]
   */
  constructor({
    ttlMs = DEFAULT_TTL_MS,
    now = Date.now,
    emit = () => {},
    notify = () => {},
    checkout = checkoutOf,
    checkoutDir = checkoutOfDir,
    officeUrl = process.env.AGENT_OFFICE_URL ?? "http://localhost:5199",
  } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.emit = emit;
    this.notify = notify;
    this.checkout = checkout;
    this.checkoutDir = checkoutDir;
    this.officeUrl = officeUrl;
    /** @type {Map<string, object>} agentId → last known identity */
    this.agents = new Map();
    /** absPath → agentId → touch */
    this.byPath = new Map();
    /** `${repoId}\0${rel}` → agentId → touch */
    this.byRel = new Map();
    /** @type {Map<string, object>} alertId → alert */
    this.alerts = new Map();
    /** agentId/sessionId → cwd, kept past the TTL so "open terminal" still works for a quiet session */
    this.cwds = new Map();
    this.lastSweep = 0;
  }

  // ---- ingest ---------------------------------------------------------------

  /** @param {import("./event-schema.js").NormalizedEvent} event */
  onEvent(event) {
    if (!event?.agentId || RADAR_EVENT_TYPES.has(event.type) || !Number.isFinite(event.ts)) return;
    const now = this.now();
    this.#rememberCwd(event);
    // boot replays whole transcripts: ignore anything that cannot matter now
    if (now - event.ts > this.ttlMs * 6) return;
    if (event.type === "session_end") {
      this.#forget(event.agentId);
      return;
    }

    const agent = this.#remember(event);
    if (event.type === "tool_call" && event.status === "start" && Array.isArray(event.meta?.paths)) {
      for (const p of event.meta.paths) this.#touch(agent, p, event, now);
    }
    if (agent.harness === WORKER_HARNESS && now - event.ts <= this.ttlMs) this.#checkWorkers(agent, now);
    if (now - this.lastSweep >= SWEEP_EVERY_MS) this.sweep();
  }

  #rememberCwd(event) {
    if (!event.cwd) return;
    for (const key of [event.agentId, event.sessionId]) {
      if (key && (key === event.agentId || !this.cwds.has(key))) {
        this.cwds.delete(key); // re-insert: Map order = recency
        this.cwds.set(key, event.cwd);
      }
    }
    while (this.cwds.size > MAX_CWDS) this.cwds.delete(this.cwds.keys().next().value);
  }

  /** A finished session is no longer writing anything: drop its touches so a hand-over is not a collision. */
  #forget(agentId) {
    for (const index of [this.byPath, this.byRel]) {
      for (const [key, bucket] of index) {
        bucket.delete(agentId);
        if (bucket.size === 0) index.delete(key);
      }
    }
    const agent = this.agents.get(agentId);
    if (agent) agent.ended = true;
    this.sweep();
  }

  #remember(event) {
    const prev = this.agents.get(event.agentId);
    const agent = {
      agentId: event.agentId,
      sessionId: event.sessionId,
      parentId: event.parentId ?? prev?.parentId ?? null,
      name: event.agent ?? prev?.name ?? event.agentId,
      harness: event.harness ?? prev?.harness ?? null,
      lane: event.lane ?? event.meta?.lane ?? prev?.lane ?? null,
      cwd: event.cwd ?? prev?.cwd ?? null,
      repo: event.repo ?? prev?.repo ?? null,
      lastTs: Math.max(event.ts, prev?.lastTs ?? 0),
      ended: false, // any new activity revives a session that had timed out
    };
    this.agents.set(event.agentId, agent);
    return agent;
  }

  /** Root of the parent/child tree this agent belongs to. */
  #treeKey(agent) {
    let cur = agent;
    for (let hops = 0; hops < 32 && cur.parentId; hops++) {
      const parent = this.agents.get(cur.parentId);
      if (!parent) return cur.parentId; // parent not seen (yet): its id IS the root's id
      cur = parent;
    }
    return cur.sessionId ?? cur.agentId;
  }

  #related(a, b) {
    return a.agentId === b.agentId || a.sessionId === b.sessionId || this.#treeKey(a) === this.#treeKey(b);
  }

  #touch(agent, absPath, event, now) {
    if (now - event.ts > this.ttlMs) return;
    const co = this.checkout(absPath);
    const entry = { agentId: agent.agentId, ts: event.ts, tool: event.tool, path: absPath, ...(co ?? {}) };

    for (const other of this.#liveEntries(this.byPath.get(absPath), now)) {
      const o = this.agents.get(other.agentId);
      if (o && !this.#related(agent, o)) this.#raise("file", absPath, agent, o, event, { path: absPath, relPath: co?.rel ?? null });
    }
    if (co) {
      const relKey = `${co.repoId}\0${co.rel}`;
      for (const other of this.#liveEntries(this.byRel.get(relKey), now)) {
        const o = this.agents.get(other.agentId);
        if (o && other.root !== co.root && !this.#related(agent, o)) {
          this.#raise("worktree", relKey, agent, o, event, { path: absPath, relPath: co.rel, repoId: co.repoId });
        }
      }
      this.#store(this.byRel, relKey, entry);
    }
    this.#store(this.byPath, absPath, entry);
  }

  #store(index, key, entry) {
    let bucket = index.get(key);
    if (!bucket) index.set(key, (bucket = new Map()));
    bucket.set(entry.agentId, entry);
  }

  #liveEntries(bucket, now) {
    return bucket ? [...bucket.values()].filter((e) => now - e.ts <= this.ttlMs) : [];
  }

  #repoIdOfAgent(agent) {
    return (agent.cwd && this.checkoutDir(agent.cwd)?.repoId) || agent.repo || null;
  }

  #checkWorkers(agent, now) {
    const repoId = this.#repoIdOfAgent(agent);
    if (!repoId) return;
    for (const other of this.agents.values()) {
      if (other.harness !== WORKER_HARNESS || other.ended || now - other.lastTs > this.ttlMs) continue;
      if (this.#related(agent, other) || this.#repoIdOfAgent(other) !== repoId) continue;
      this.#raise("worker", repoId, agent, other, null, { repoId });
    }
  }

  // ---- alerts ---------------------------------------------------------------

  #raise(kind, subject, agent, other, event, extra) {
    const alertId = shortId(`${kind}|${subject}`);
    const snap = (a) => ({
      agentId: a.agentId,
      sessionId: a.sessionId,
      name: a.name,
      harness: a.harness,
      lane: a.lane,
      cwd: a.cwd,
      repo: a.repo,
    });

    const existing = this.alerts.get(alertId);
    if (existing) {
      // already open: only a tree we have not listed yet is news
      const fresh = [other, agent].filter((a) => !existing.trees.includes(this.#treeKey(a)));
      if (fresh.length === 0) return;
      for (const a of fresh) {
        existing.trees.push(this.#treeKey(a));
        existing.agents.unshift(snap(a));
      }
      existing.agents.sort((x, y) => Number(x.agentId === agent.agentId) - Number(y.agentId === agent.agentId));
      this.#emitAlert(existing, agent, event, `${existing.trees.length}`);
      return;
    }
    if (this.alerts.size >= MAX_ALERTS) return;

    const alert = {
      alertId,
      kind,
      severity: kind === "worktree" ? "soft" : "hard",
      subject,
      trees: [this.#treeKey(other), this.#treeKey(agent)],
      since: this.now(),
      ...extra,
      agents: [snap(other), snap(agent)],
    };
    this.alerts.set(alertId, alert);
    this.#emitAlert(alert, agent, event, "1");
    if (alert.severity === "hard" && this.now() - (event?.ts ?? agent.lastTs) <= FRESH_MS) {
      this.notify({
        title: "Agent Office",
        subtitle: `${agent.name} · ${agent.repo ?? "other"}`,
        message: alertLabel(alert),
        url: buildOfficeUrl(this.officeUrl, agent.agentId),
      });
    }
  }

  /** `rev` keeps the event id unique per revision of the same alert. */
  #emitAlert(alert, agent, event, rev) {
    this.emit(
      makeEvent({
        id: `radar:${alert.alertId}:alert:${rev}`,
        type: "collision_alert",
        sessionId: agent.sessionId,
        agentId: agent.agentId,
        parentId: agent.parentId,
        cwd: agent.cwd,
        repo: agent.repo ?? undefined,
        harness: agent.harness ?? undefined,
        tool: event?.tool ?? null,
        status: "start",
        detail: alertLabel(alert),
        meta: { source: "radar", ...publicAlert(alert) },
      }),
    );
  }

  #isLive(alert, now) {
    const aliveTrees = new Set();
    if (alert.kind === "worker") {
      for (const a of this.agents.values()) {
        if (a.harness === WORKER_HARNESS && !a.ended && now - a.lastTs <= this.ttlMs && this.#repoIdOfAgent(a) === alert.subject) {
          aliveTrees.add(this.#treeKey(a));
        }
      }
    } else {
      const index = alert.kind === "file" ? this.byPath : this.byRel;
      for (const e of this.#liveEntries(index.get(alert.subject), now)) {
        const a = this.agents.get(e.agentId);
        if (a) aliveTrees.add(this.#treeKey(a));
      }
    }
    return alert.trees.filter((t) => aliveTrees.has(t)).length >= 2;
  }

  /** Close alerts whose evidence aged out; drop dead touches and long-silent agents. */
  sweep() {
    const now = this.now();
    this.lastSweep = now;
    for (const [id, alert] of this.alerts) {
      if (this.#isLive(alert, now)) continue;
      this.alerts.delete(id);
      const anchor = this.agents.get(alert.agents.at(-1).agentId);
      this.emit(
        makeEvent({
          id: `radar:${id}:resolved:${now}`,
          type: "collision_resolved",
          sessionId: alert.agents.at(-1).sessionId,
          agentId: alert.agents.at(-1).agentId,
          cwd: anchor?.cwd ?? null,
          repo: anchor?.repo ?? undefined,
          status: "ok",
          detail: `collision cleared: ${alertLabel(alert)}`,
          meta: { source: "radar", alertId: id },
        }),
      );
    }
    for (const index of [this.byPath, this.byRel]) {
      for (const [key, bucket] of index) {
        for (const [agentId, e] of bucket) if (now - e.ts > this.ttlMs) bucket.delete(agentId);
        if (bucket.size === 0) index.delete(key);
      }
    }
    for (const [id, a] of this.agents) if (now - a.lastTs > this.ttlMs * 6) this.agents.delete(id);
  }

  // ---- queries --------------------------------------------------------------

  /** Open alerts, for GET /radar (renderer backfill). */
  list() {
    return { ttlMs: this.ttlMs, alerts: [...this.alerts.values()].map(publicAlert) };
  }

  /**
   * Who is writing `absPath` right now?
   * `touching` = same file; `worktreeTwins` = same repo-relative path in another worktree.
   * @param {string} absPath
   * @param {{excludeSessionId?: string}} [opts] leave the asker out of the answer
   */
  whoIsTouching(absPath, { excludeSessionId } = {}) {
    const now = this.now();
    const describe = (e) => {
      const a = this.agents.get(e.agentId);
      return {
        agentId: e.agentId,
        sessionId: a?.sessionId ?? null,
        name: a?.name ?? e.agentId,
        harness: a?.harness ?? null,
        lane: a?.lane ?? null,
        cwd: a?.cwd ?? null,
        repo: a?.repo ?? null,
        tool: e.tool ?? null,
        path: e.path,
        ts: e.ts,
        ageMs: now - e.ts,
      };
    };
    const keep = (e) => {
      const a = this.agents.get(e.agentId);
      return !excludeSessionId || (a?.sessionId !== excludeSessionId && e.agentId !== excludeSessionId);
    };
    const touching = this.#liveEntries(this.byPath.get(absPath), now).filter(keep).map(describe);
    let worktreeTwins = [];
    const co = this.checkout(absPath);
    if (co) {
      worktreeTwins = this.#liveEntries(this.byRel.get(`${co.repoId}\0${co.rel}`), now)
        .filter((e) => e.root !== co.root && keep(e))
        .map(describe);
    }
    return { path: absPath, ttlMs: this.ttlMs, touching, worktreeTwins };
  }

  /** cwd of an agent the radar has seen — by agentId, else any agent of that session. */
  agentCwd(id) {
    return this.cwds.get(id) ?? null;
  }
}

function publicAlert(alert) {
  const { subject: _subject, trees: _trees, ...rest } = alert;
  return rest;
}

function alertLabel(alert) {
  // two sessions in one folder share a cwd-derived label: tell them apart by id
  const dupes = new Set(alert.agents.map((a) => a.name)).size < alert.agents.length;
  const names = alert.agents.map((a) => (dupes ? `${a.name}#${a.agentId.slice(0, 4)}` : a.name));
  const who = `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  if (alert.kind === "file") return `${who} are editing ${path.basename(alert.path)}`;
  if (alert.kind === "worktree") return `${who} edit ${alert.relPath} in different worktrees (merge conflict risk)`;
  return `${who} are workers on one repo`;
}

/**
 * Observe every broadcast event (same wrapping trick as attachNotifier) and
 * publish alerts straight to the underlying broadcast — they must not pass back
 * through the notifier, which would read them as "agent is alive again".
 * @param {import("./ws-server.js").EventBroadcastServer} server
 * @param {ConstructorParameters<typeof FileRadar>[0]} [opts]
 */
export function attachRadar(server, opts = {}) {
  const base = server.broadcast.bind(server);
  const notifyEnabled = process.env.AGENT_OFFICE_NOTIFY !== "0";
  const radar = new FileRadar({
    ttlMs: Number(process.env.AGENT_OFFICE_RADAR_TTL_MS) || DEFAULT_TTL_MS,
    emit: base,
    notify: notifyEnabled ? deliverNotification : () => {},
    ...opts,
  });
  server.broadcast = (event) => {
    base(event);
    try {
      radar.onEvent(event);
    } catch (error) {
      console.error("[radar] error handling event:", error.message);
    }
  };
  const timer = setInterval(() => {
    try {
      radar.sweep();
    } catch (error) {
      console.error("[radar] sweep failed:", error.message);
    }
  }, SWEEP_EVERY_MS);
  timer.unref?.();
  radar.stop = () => clearInterval(timer);
  return radar;
}

/**
 * GET /radar                              → {ttlMs, alerts}
 * GET /radar/touching?path=&cwd=&exclude= → whoIsTouching (relative paths resolve against cwd)
 * @param {FileRadar} radar
 */
export function createRadarHttpHandler(radar) {
  return (req, res, url) => {
    if (url.pathname !== "/radar" && url.pathname !== "/radar/touching") return false;
    const respond = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (req.method !== "GET") {
      respond(405, { error: "method not allowed" });
      return true;
    }
    if (url.pathname === "/radar") {
      respond(200, radar.list());
      return true;
    }
    const raw = url.searchParams.get("path");
    if (!raw) {
      respond(400, { error: "path required" });
      return true;
    }
    const cwd = url.searchParams.get("cwd");
    const abs = path.isAbsolute(raw) ? path.normalize(raw) : cwd && path.isAbsolute(cwd) ? path.resolve(cwd, raw) : null;
    if (!abs) {
      respond(400, { error: "path must be absolute, or pass an absolute cwd" });
      return true;
    }
    respond(200, radar.whoIsTouching(abs, { excludeSessionId: url.searchParams.get("exclude") || undefined }));
    return true;
  };
}
