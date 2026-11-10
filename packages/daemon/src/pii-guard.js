// Personal-data shield, the part that knows about projects (lane A, N5).
//
// redact-pii.js is the pure masker; this decides WHEN to use it. Everything the daemon posts to a
// chat channel (Telegram, Zalo) goes through `apply(channel, chatId, text)`: when the chat belongs to
// a project whose policy says `piiGuard: true`, the text is masked and the number of masked values
// (never the values) is appended to that project's `pii-audit.jsonl`.
//
// A chat "belongs" to a project when it is the project's bound room, or it is the private chat of one
// of its members, or it is the operator's own chat from the environment and ANY project has the shield
// on (that chat is trusted as owner of every project, so it may receive any project's text). That is
// deliberately on the safe side: a person who belongs to a shielded project and to a plain one gets the
// masked text in their private chat for both.
//
// Fail closed: if a shielded project's files cannot be read, its chats are masked rather than let through.

import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PROJECTS_DIR, PROJECT_SLUG_RE, readProject } from "./projects.js";
import { PolicyStore } from "./policy-store.js";
import { boundChat, CHANNELS } from "./members.js";
import { dropCutTail, emptyCounts, redactPii, totalCount } from "./redact-pii.js";

const AUDIT_FILE = "pii-audit.jsonl";
const AUDIT_MAX_BYTES = 256 * 1024;
const AUDIT_KEEP_LINES = 500;

export class PiiGuard {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.projectsDir]
   * @param {PolicyStore} [opts.store]
   * @param {Array<{channel: string, chatId: string}>} [opts.legacy] operator chats from the environment
   * @param {() => number} [opts.now]
   */
  constructor({ projectsDir = DEFAULT_PROJECTS_DIR, store = null, legacy = [], now = Date.now } = {}) {
    this.projectsDir = projectsDir;
    this.store = store ?? new PolicyStore({ projectsDir, cacheMs: 0 });
    this.legacy = legacy.map((l) => ({ channel: l.channel, chatId: String(l.chatId) }));
    this.now = now;
  }

  /** Slugs of the projects with the shield on (empty = the guard is a no-op). */
  shielded() {
    try {
      return this.store.projects().filter((p) => p.policy.piiGuard === true).map((p) => p.slug);
    } catch {
      return [];
    }
  }

  /** The shielded projects this chat belongs to. */
  projectsFor(channel, chatId) {
    const slugs = this.shielded();
    if (slugs.length === 0) return [];
    const id = String(chatId);
    if (this.legacy.some((l) => l.channel === channel && l.chatId === id)) return slugs;
    return slugs.filter((slug) => {
      try {
        const project = readProject({ projectsDir: this.projectsDir, slug });
        if (boundChat(project, channel) === id) return true;
        const members = Array.isArray(project.members) ? project.members : [];
        return CHANNELS.includes(channel) && members.some((m) => m?.[channel]?.userId != null && String(m[channel].userId) === id);
      } catch {
        return true; // cannot tell → treat as belonging
      }
    });
  }

  /** @returns {string} the text to send */
  apply(channel, chatId, text) {
    const slugs = this.projectsFor(channel, chatId);
    if (slugs.length === 0) return text;
    return this.#mask(slugs, channel, text);
  }

  /**
   * Shorten text for a chat. For a shielded project (`slug` null = text that belongs to no project, which
   * can only go to the operator's chat): mask the WHOLE text, then cut to `max`, then drop a half-cut tail.
   * `alreadyCut` = an earlier step (the hub's 200 characters) already cut it. Otherwise the text is returned
   * untouched (the caller still applies its own length limit).
   */
  maskForProject(slug, text, { max = Infinity, alreadyCut = false } = {}) {
    const slugs = slug ? this.shielded().filter((s) => s === slug) : this.shielded();
    if (slugs.length === 0) return text;
    const masked = this.#mask(slugs, "text", text);
    const cut = masked.length > max;
    const out = cut ? masked.slice(0, max) : masked;
    return cut || alreadyCut ? dropCutTail(out) : out;
  }

  /** For a channel that has one fixed operator chat and no project context (the OS-notification push). */
  applyToOperator(channel, text) {
    const slugs = this.shielded();
    return slugs.length === 0 ? text : this.#mask(slugs, channel, text);
  }

  #mask(slugs, channel, text) {
    const { text: masked, counts } = redactPii(text);
    if (totalCount(counts) > 0) for (const slug of slugs) this.#audit(slug, channel, counts);
    return masked;
  }

  #audit(slug, channel, counts) {
    if (!PROJECT_SLUG_RE.test(slug)) return;
    try {
      const file = path.join(this.projectsDir, slug, AUDIT_FILE);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify({ ts: this.now(), project: slug, kind: "pii_redacted", channel, ...counts })}\n`);
      if (fs.statSync(file).size > AUDIT_MAX_BYTES) {
        const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
        fs.writeFileSync(file, `${lines.slice(-AUDIT_KEEP_LINES).join("\n")}\n`);
      }
    } catch {
      // the audit is housekeeping; failing to write it must neither block nor un-mask the message
    }
  }

  /** Newest first; a torn line is skipped. */
  readAudit(slug, limit = 100) {
    if (!PROJECT_SLUG_RE.test(slug)) return [];
    let text;
    try {
      text = fs.readFileSync(path.join(this.projectsDir, slug, AUDIT_FILE), "utf8");
    } catch {
      return [];
    }
    const rows = [];
    for (const line of text.split("\n").reverse()) {
      if (rows.length >= limit) break;
      if (!line) continue;
      try {
        rows.push(JSON.parse(line));
      } catch {
        // skip
      }
    }
    return rows;
  }
}

/** Total of all masked values in an audit (for a summary). */
export function sumAudit(rows) {
  const out = emptyCounts();
  for (const r of rows) for (const k of Object.keys(out)) out[k] += Number(r[k]) || 0;
  return out;
}

// One shared guard for modules that have no project context (notifier.js's Telegram push).
const shared = new Map();
export function sharedGuard(projectsDir = process.env.AGENT_OFFICE_PROJECTS_DIR || DEFAULT_PROJECTS_DIR) {
  if (!shared.has(projectsDir)) shared.set(projectsDir, new PiiGuard({ projectsDir }));
  return shared.get(projectsDir);
}
