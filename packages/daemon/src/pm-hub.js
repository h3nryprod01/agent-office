// lane L5: one PM per PROJECT (keyed by project slug, not by repo). Every project gets its
// own ChatSessionManager — own warm `claude` process, own cwd (the project's), own saved
// session under ~/.agent-office/projects/<slug>/pm-session.json — so PMs of different
// projects talk at the same time. Inside one project the PM is a single conversation, so
// messages queue and run one after another (a turn is one Claude turn; two at once would
// interleave replies in one session).
//
// The hub adds what the chat manager does not know about: a per-PM state for the UI
// (idle / working / queued n / unread n), a reply callback so any channel (office chat,
// Telegram, Zalo) can get "the answer to MY message", and event fan-out:
//   pm_message — the chat lines (buffered by the WS server for page-reload replay)
//   pm_status  — state changes (live only: replaying stale statuses to a new client is wrong)
// Both are ADDITIVE event types; nothing existing reads them but the PM chat box.

import fs from "node:fs";
import path from "node:path";

import { ChatSessionManager } from "./chat-session.js";
import { makeEvent } from "./event-schema.js";
import { DEFAULT_PROJECTS_DIR, listProjects, readProject } from "./projects.js";

export const MAX_QUEUE = 5;

/** Project PM prompt. `[Name]` prefixes come from channels where several people share one PM. */
export function projectPmPrompt(project, projectDir) {
  return (
    `You are the PM of the project "${project.name}" (template: ${project.template}), ` +
    "answering through Agent Office (the office chat box, Telegram or Zalo). " +
    `The project's goals are in ${path.join(projectDir, "goals.md")} and its work items in ` +
    `${path.join(projectDir, "items.json")}; the code lives in your working directory. ` +
    "Before you answer anything about the state of the work, read those and git log / git status. " +
    "Several people can talk to you; a message that starts with [Name] comes from that person — " +
    "address them by name when it helps. " +
    "ALWAYS reply in the language the person wrote in. Keep it short, like a chat message. " +
    "You cannot approve permissions yourself: members approve them with the /approve command " +
    "or in the office; if asked, say so plainly."
  );
}

export class PmHub {
  /**
   * @param {Object} opts
   * @param {string} [opts.projectsDir]
   * @param {(event: object) => void} opts.broadcast      buffered fan-out (pm_message)
   * @param {(event: object) => void} [opts.broadcastLive] unbuffered fan-out (pm_status)
   * @param {typeof import("node:child_process").spawn} [opts.spawnFn] injectable for tests
   * @param {string} [opts.claudeBin]
   * @param {number} [opts.timeoutMs]
   * @param {() => number} [opts.now]
   */
  constructor({
    projectsDir = DEFAULT_PROJECTS_DIR,
    broadcast,
    broadcastLive = broadcast,
    spawnFn,
    claudeBin,
    timeoutMs,
    now = Date.now,
  }) {
    this.projectsDir = projectsDir;
    this.broadcast = broadcast;
    this.broadcastLive = broadcastLive;
    this.now = now;
    this.managerOpts = {
      ...(spawnFn ? { spawnFn } : {}),
      ...(claudeBin ? { claudeBin } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    };
    /** @type {Map<string, {slug: string, manager: ChatSessionManager, active: object|null, queue: object[], unread: number, lastAt: number|null, lastText: string, lastError: string|null, sessionId: string|null}>} */
    this.pms = new Map();
    this.statusSeq = 0;
  }

  /** Every project on disk as a PM row, whether or not anyone has spoken to it yet. */
  list() {
    return listProjects({ projectsDir: this.projectsDir }).map((p) => {
      const pm = this.pms.get(p.slug);
      return {
        slug: p.slug,
        name: p.name,
        template: p.template,
        state: pm?.active ? "working" : "idle",
        queued: pm?.queue.length ?? 0,
        unread: pm?.unread ?? 0,
        lastAt: pm?.lastAt ?? null,
        lastText: pm?.lastText ?? "",
        lastError: pm?.lastError ?? null,
      };
    });
  }

  /**
   * Hand one message to a project's PM.
   * @param {string} slug
   * @param {string} text
   * @param {Object} [opts]
   * @param {string} [opts.speaker]   who is talking (several people share one PM)
   * @param {(reply: {text: string, error: boolean}) => void} [opts.onReply] called when THIS message's turn ends
   * @returns {{accepted: true, queued?: number} | {accepted: false, reason: string, message?: string}}
   */
  ask(slug, text, { speaker, onReply } = {}) {
    const pm = this.#pm(slug);
    if (!pm) return { accepted: false, reason: "unknown_project", message: `No such project "${slug}".` };
    if (pm.queue.length >= MAX_QUEUE) {
      return { accepted: false, reason: "queue_full", message: "The PM has too many messages waiting — try again in a minute." };
    }
    const req = { text: speaker ? `[${speaker}] ${text}` : text, onReply };
    if (pm.active) {
      pm.queue.push(req);
      this.#status(pm);
      return { accepted: true, queued: pm.queue.length };
    }
    return this.#start(pm, req);
  }

  /** Stop the running turn and forget what was queued behind it (the asker's intent was "stop"). */
  stop(slug) {
    const pm = this.pms.get(slug);
    if (!pm) return { stopped: false, reason: "idle" };
    // whoever was told "queued" must hear that their message is not going to run
    const dropped = pm.queue.splice(0);
    for (const req of dropped) {
      try {
        req.onReply?.({ text: "Cancelled: the PM was stopped before your message ran.", error: true });
      } catch (err) {
        console.error("[pm-hub] reply callback failed:", err.message);
      }
    }
    const result = pm.manager.stop();
    this.#status(pm);
    return result;
  }

  markRead(slug) {
    const pm = this.pms.get(slug);
    if (!pm || pm.unread === 0) return;
    pm.unread = 0;
    this.#status(pm);
  }

  dispose() {
    for (const pm of this.pms.values()) pm.manager.dispose();
    this.pms.clear();
  }

  /** Lazy: a PM exists in memory only once someone talks to it. Null = no such project. */
  #pm(slug) {
    const existing = this.pms.get(slug);
    if (existing) return existing;
    let project;
    try {
      project = readProject({ projectsDir: this.projectsDir, slug });
    } catch {
      return null;
    }
    if (typeof project.cwd !== "string" || !fs.existsSync(project.cwd)) return null;
    const projectDir = path.join(this.projectsDir, slug);
    const pm = {
      slug,
      active: null,
      queue: [],
      unread: 0,
      lastAt: null,
      lastText: "",
      lastError: null,
      sessionId: null,
      manager: new ChatSessionManager({
        stateFile: path.join(projectDir, "pm-session.json"),
        cwd: project.cwd,
        defaultRepo: slug, // the project's PM is that manager's "default repo" PM
        systemPrompt: projectPmPrompt(project, projectDir),
        broadcast: (event) => this.#onChatEvent(pm, event),
        ...this.managerOpts,
      }),
    };
    this.pms.set(slug, pm);
    return pm;
  }

  #start(pm, req) {
    const active = { ...req, reply: "", failure: "" };
    pm.active = active;
    this.#status(pm);
    // The manager can report a failure synchronously (its own `done` event fires inside
    // send()), so `active` is already set when that event arrives.
    const result = pm.manager.send(req.text);
    if (!result.accepted && pm.active === active) {
      this.#finish(pm, { text: result.message ?? result.reason ?? "The PM could not start.", error: true });
      return { accepted: false, reason: result.reason ?? "failed", message: result.message };
    }
    return { accepted: true };
  }

  #onChatEvent(pm, event) {
    const meta = event.meta ?? {};
    const sessionId = meta.targetSessionId;
    if (typeof sessionId === "string" && sessionId && sessionId !== "pm-pending") pm.sessionId = sessionId;
    this.broadcast(
      makeEvent({
        id: `pm:${pm.slug}:${event.id}`, // each manager numbers from 0 — namespace per project
        type: "pm_message",
        sessionId: `pm:${pm.slug}`, // one replay bucket per PM; real session ids fork every turn
        agentId: `pm:${pm.slug}`,
        cwd: event.cwd,
        repo: pm.slug,
        ts: event.ts,
        // never "error": the notifier treats a lingering error as "agent stuck" and pushes it
        status: meta.done ? "ok" : "start",
        detail: event.detail,
        meta: { ...meta, project: pm.slug },
      }),
    );
    if (meta.role === "user" || !pm.active) return;
    if (meta.role === "assistant" && meta.text) {
      pm.active.reply += (pm.active.reply ? "\n" : "") + meta.text;
    } else if (meta.role === "system" && meta.text) {
      pm.active.failure = meta.text;
    }
    if (meta.done) {
      this.#finish(pm, {
        text: pm.active.reply || pm.active.failure || "(the PM said nothing)",
        error: meta.error === true,
      });
    }
  }

  #finish(pm, { text, error }) {
    const req = pm.active;
    if (!req) return;
    pm.active = null;
    pm.unread += 1;
    pm.lastAt = this.now();
    pm.lastText = text.slice(0, 200);
    pm.lastError = error ? text.slice(0, 200) : null;
    try {
      req.onReply?.({ text, error });
    } catch (err) {
      console.error("[pm-hub] reply callback failed:", err.message);
    }
    const next = pm.queue.shift();
    if (next) this.#start(pm, next);
    else this.#status(pm);
  }

  #status(pm) {
    try {
      this.broadcastLive(
        makeEvent({
          id: `pm-status:${pm.slug}:${this.statusSeq++}`,
          type: "pm_status",
          sessionId: `pm:${pm.slug}`,
          agentId: `pm:${pm.slug}`,
          repo: pm.slug,
          status: "ok",
          detail: pm.active ? "working" : "idle",
          meta: {
            project: pm.slug,
            state: pm.active ? "working" : "idle",
            queued: pm.queue.length,
            unread: pm.unread,
          },
        }),
      );
    } catch {
      // a status push must never break the turn that caused it
    }
  }
}
