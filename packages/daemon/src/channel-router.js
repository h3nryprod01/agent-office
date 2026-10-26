// lane L5: the brain shared by every chat channel (Telegram, Zalo). A transport turns its
// own update format into one message shape and calls `router.handle(msg)`:
//   { channel: "telegram"|"zalo", chatId, userId, name, text, isGroup }
// and the router decides who the person is, what they may do, and what to say back — so a
// role check is written once, not once per channel.
//
// Trust model:
//   - A stranger (not a member of the project this chat is about, not the operator's
//     configured chat) gets NO reply — the only exception is a pairing attempt, which is
//     how a stranger becomes a member, and that is throttled.
//   - Roles: owner = everything, manager = chat + approve, viewer = status/items only.
//   - A group is a project room only after an owner runs /bind there. Until then the bot
//     answers nothing but /help, /whoami, /bind and /pair in it.
//   - "legacy" chats are the operator's own TELEGRAM_CHAT_ID / ZALO_ALLOWED_USER from the
//     environment, trusted as owner everywhere — what the old single-chat bridge did.

import fs from "node:fs";
import os from "node:os";

import { canApprove, canChat, findMemberByIdentity, listMembers, bindChat, unbindChat, projectForChat, boundChat, roleIn, projectSlugs, CHANNELS } from "./members.js";
import { DEFAULT_PROJECTS_DIR, readItems, readProject } from "./projects.js";
import { JsonState } from "./json-state.js";

const MIN_APPROVAL_PREFIX = 4;
const OPEN_ITEM_LIMIT = 15;
const DEFAULT_LIMITS = { anyPerMinute: 30, pmPerMinute: 6, pairFailures: 5, pairWindowMs: 10 * 60_000 };
const CODE_RE = /^AO-[A-Z0-9]{6,12}$/i;
// the only things answered in a group that no owner has bound to a project
const UNBOUND_GROUP_COMMANDS = new Set(["help", "whoami", "bind", "pair", "start"]);

/** Sliding-window counter per key. In memory: a restart forgives everybody, which is fine. */
export class RateLimiter {
  constructor({ now = Date.now } = {}) {
    this.now = now;
    this.hits = new Map();
  }
  #live(key, windowMs) {
    const cutoff = this.now() - windowMs;
    const live = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    this.hits.set(key, live);
    return live;
  }
  /** Record a hit; false when it would exceed `limit` within `windowMs`. */
  hit(key, limit, windowMs) {
    if (this.hits.size > 2000) this.#prune(windowMs);
    const live = this.#live(key, windowMs);
    if (live.length >= limit) return false;
    live.push(this.now());
    return true;
  }
  /** Forget keys with no hit inside the window, so strangers cannot grow this forever. */
  #prune(windowMs) {
    for (const key of [...this.hits.keys()]) if (this.#live(key, windowMs).length === 0) this.hits.delete(key);
  }
  count(key, windowMs) {
    return this.#live(key, windowMs).length;
  }
  /** Record without checking (failed attempts). */
  record(key, windowMs) {
    this.#live(key, windowMs).push(this.now());
  }
}

function parseCommand(text) {
  const m = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text);
  return m ? { cmd: m[1].toLowerCase(), arg: (m[2] ?? "").trim() } : null;
}

/** A display name goes into the PM's prompt: no brackets or line breaks to fake another speaker. */
const safeName = (name) => String(name ?? "").replace(/[\[\]\r\n]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40);

function realOr(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

const inside = (cwd, root) => typeof cwd === "string" && typeof root === "string" && (cwd === root || cwd.startsWith(root.endsWith("/") ? root : `${root}/`));

export class ChannelRouter {
  /**
   * @param {Object} opts
   * @param {string} [opts.projectsDir]
   * @param {import("./pm-hub.js").PmHub} opts.hub
   * @param {import("./approvals.js").ApprovalBroker} opts.broker
   * @param {import("./members.js").PairingStore} opts.pairing
   * @param {(channel: string, chatId: string, text: string) => Promise<void>} opts.send
   * @param {Array<{channel: string, chatId: string}>} [opts.legacy] operator chats from env, trusted as owner
   * @param {(text: string, reply: (t: string) => void) => void} [opts.legacyAsk] plain text from a legacy chat with no project → the old default-repo PM
   * @param {string|null} [opts.stateFile]
   * @param {import("./json-state.js").JsonState} [opts.state] share one instance with other writers of the same file
   * @param {(ctx: {project: object, role: string, approval: object}) => boolean} [opts.policyAllows]
   * @param {Partial<typeof DEFAULT_LIMITS>} [opts.limits]
   * @param {() => number} [opts.now]
   */
  constructor({
    projectsDir = DEFAULT_PROJECTS_DIR,
    hub,
    broker,
    pairing,
    send,
    legacy = [],
    legacyAsk = null,
    stateFile = null,
    state = null,
    policyAllows = defaultPolicyAllows,
    limits = {},
    now = Date.now,
  }) {
    this.projectsDir = projectsDir;
    this.hub = hub;
    this.broker = broker;
    this.pairing = pairing;
    this.legacy = legacy.map((l) => ({ channel: l.channel, chatId: String(l.chatId) }));
    this.legacyAsk = legacyAsk;
    this.state = state ?? new JsonState(stateFile);
    this.policyAllows = policyAllows;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.now = now;
    this.limiter = new RateLimiter({ now });
    this.warnedUntil = new Map();
    this.sendRaw = send;
  }

  async #say(channel, chatId, text) {
    try {
      await this.sendRaw(channel, chatId, text);
    } catch {
      // a dead channel must never break routing (the transport logs its own failures)
    }
  }

  async handle(msg) {
    if (msg?.type === "migrate") return this.#migrate(msg);
    const text = typeof msg?.text === "string" ? msg.text.trim() : "";
    if (!text || msg.userId == null || msg.chatId == null) return;
    const m = { ...msg, text, chatId: String(msg.chatId), userId: String(msg.userId) };
    const parsed = parseCommand(text);
    const say = (t) => this.#say(m.channel, m.chatId, t);

    // 1. pairing is the one door a stranger may knock on
    const pairArg =
      parsed && (parsed.cmd === "pair" || parsed.cmd === "start") && parsed.arg
        ? parsed.arg
        : !parsed && CODE_RE.test(text)
          ? text
          : null;
    if (pairArg) return this.#pair(m, pairArg, say);

    // 2. who is this, and which project is the conversation about?
    // The operator's env chat is trusted as owner only when it is a PRIVATE chat. If it is a
    // group, everyone in it may still talk to the default PM (what the old bridge did) but no
    // commands, approvals or binding: a group's membership is not the operator's identity.
    const legacyChat = this.#isLegacy(m);
    const legacy = legacyChat && !m.isGroup;
    const roomBound = projectForChat({ projectsDir: this.projectsDir, channel: m.channel, chatId: m.chatId });
    if (legacyChat && m.isGroup && !parsed && !roomBound) {
      if (!this.#allow(m, "pm", this.limits.pmPerMinute, say)) return;
      return this.legacyAsk?.(text, (reply) => void say(reply));
    }
    const bound = roomBound;
    const memberships = legacy ? [] : findMemberByIdentity({ projectsDir: this.projectsDir, channel: m.channel, userId: m.userId });
    if (!legacy && memberships.length === 0) return; // stranger: silence

    if (m.isGroup && !bound && !legacy && !(parsed && UNBOUND_GROUP_COMMANDS.has(parsed.cmd))) return;
    if (bound && !legacy && !memberships.some((x) => x.slug === bound)) return; // someone else's project room

    // 3. slow-down guard (members only — strangers never got this far)
    if (!this.#allow(m, "any", this.limits.anyPerMinute, say)) return;

    const ctx = { m, say, legacy, bound, memberships };
    if (parsed) return this.#command(ctx, parsed);
    return this.#talkToPm(ctx, text);
  }

  /** Telegram turns a group into a supergroup with a NEW chat id: move the binding along. */
  #migrate({ channel, from, chatId }) {
    const slug = projectForChat({ projectsDir: this.projectsDir, channel, chatId: from });
    if (!slug) return;
    unbindChat({ projectsDir: this.projectsDir, slug, channel });
    bindChat({ projectsDir: this.projectsDir, slug, channel, chatId });
  }

  // ── identity helpers ─────────────────────────────────────────────────────────────────
  #isLegacy(m) {
    return this.legacy.some((l) => l.channel === m.channel && l.chatId === m.chatId);
  }

  #roleOf(ctx, slug) {
    if (ctx.legacy) return "owner";
    return roleIn({ projectsDir: this.projectsDir, slug, channel: ctx.m.channel, userId: ctx.m.userId });
  }

  #dmKey(m) {
    return `dm:${m.channel}:${m.userId}`;
  }

  /** The project a message is about: explicit arg → the chat's binding → /use choice → the only one. */
  #slugFor(ctx, explicit = null) {
    if (explicit) return explicit;
    if (ctx.bound) return ctx.bound;
    const chosen = this.state.get(this.#dmKey(ctx.m));
    if (chosen && (ctx.legacy || ctx.memberships.some((x) => x.slug === chosen))) return chosen;
    if (!ctx.legacy && ctx.memberships.length === 1) return ctx.memberships[0].slug;
    return null;
  }

  #allow(m, kind, limit, say) {
    const key = `${kind}:${m.channel}:${m.userId}`;
    if (this.limiter.hit(key, limit, 60_000)) return true;
    if ((this.warnedUntil.get(key) ?? 0) <= this.now()) {
      this.warnedUntil.set(key, this.now() + 60_000);
      void say("Slow down a little — too many messages in a minute. Try again shortly.");
    }
    return false;
  }

  // ── pairing ──────────────────────────────────────────────────────────────────────────
  async #pair(m, code, say) {
    const failKey = `pairfail:${m.channel}:${m.userId}`;
    if (this.limiter.count(failKey, this.limits.pairWindowMs) >= this.limits.pairFailures) return; // throttled: silence
    const res = this.pairing.redeem(code, { channel: m.channel, userId: m.userId, name: m.name });
    if (res.ok) {
      this.state.set(this.#dmKey(m), res.slug);
      return say(
        `You are now a ${res.member.role} of "${res.slug}". ` +
          (res.member.role === "viewer" ? "Try /status or /items." : "Send a message to talk to its PM, or try /help."),
      );
    }
    if (res.reason === "already_member") return say("You already belong to that project.");
    this.limiter.record(failKey, this.limits.pairWindowMs);
    return say("That code is invalid or expired. Ask an owner for a new one.");
  }

  // ── commands ─────────────────────────────────────────────────────────────────────────
  async #command(ctx, { cmd, arg }) {
    const { say } = ctx;
    switch (cmd) {
      case "start":
      case "help":
        return say(this.#help(ctx));
      case "whoami":
        return say(this.#whoami(ctx));
      case "projects":
        return say(this.#projects(ctx));
      case "use":
        return this.#use(ctx, arg);
      case "bind":
        return this.#bind(ctx, arg);
      case "unbind":
        return this.#unbind(ctx, arg);
      case "status":
      case "items":
      case "stop": {
        const slug = this.#slugFor(ctx, arg || null);
        if (!slug) return say(this.#needProject(ctx));
        if (ctx.bound && slug !== ctx.bound) return; // a project room talks about its own project only
        const role = this.#roleOf(ctx, slug);
        if (!role) return; // not theirs: silence, same as a stranger
        if (cmd === "status") return say(this.#status(slug, { room: ctx.m.isGroup, showLast: canChat(role) }));
        if (cmd === "items") return say(this.#items(slug));
        if (!canChat(role)) return say(`Your role (${role}) cannot stop the PM.`);
        const r = this.hub.stop(slug);
        return say(r.stopped ? "Stopping the PM's current turn…" : "The PM is not running a turn.");
      }
      case "pending":
        return say(this.#pending(ctx));
      case "approve":
      case "deny":
        return say(this.#decide(ctx, cmd, arg));
      default:
        return say("Unknown command. /help lists what you can do.");
    }
  }

  #help(ctx) {
    const roles = ctx.legacy ? ["owner"] : ctx.memberships.map((x) => x.member.role);
    const lines = ["Agent Office bot", "/projects — your projects", "/status [project] — PM and work summary", "/items [project] — open work items", "/use <project> — pick the project for this chat", "/whoami"];
    if (roles.some(canChat)) lines.push("any other message — goes to the project's PM", "/stop — stop the PM's current turn");
    if (roles.some(canApprove)) lines.push("/pending — open approvals", "/approve <id> · /deny <id>");
    if (roles.includes("owner")) lines.push("/bind <project> — make this chat the project's room (/unbind to undo)");
    return lines.join("\n");
  }

  #whoami(ctx) {
    if (ctx.legacy) return "You are the operator chat configured on this machine (owner of every project).";
    const rows = ctx.memberships.map((x) => `${x.slug} — ${x.member.role}`);
    return `${ctx.m.name || "You"} (${ctx.m.channel} ${ctx.m.userId}):\n${rows.join("\n")}`;
  }

  /** Projects this conversation may see: all of the operator's, the member's own — or just the room's. */
  #visibleSlugs(ctx) {
    if (ctx.bound) return [ctx.bound];
    return ctx.legacy ? projectSlugs(this.projectsDir) : ctx.memberships.map((x) => x.slug);
  }

  #projects(ctx) {
    const rows = [];
    for (const slug of this.#visibleSlugs(ctx)) {
      const role = this.#roleOf(ctx, slug);
      const pm = this.hub.list().find((p) => p.slug === slug);
      rows.push(`${slug} — ${role} — PM ${pm?.state ?? "idle"}${pm?.queued ? ` (+${pm.queued} waiting)` : ""}`);
    }
    return rows.length ? rows.join("\n") : "No projects yet.";
  }

  #needProject(ctx) {
    const slugs = this.#visibleSlugs(ctx);
    return slugs.length
      ? `Which project? Use /use <project> — yours: ${slugs.join(", ")}.`
      : "No project to talk about yet.";
  }

  #use(ctx, arg) {
    const slug = arg;
    if (!slug || !this.#visibleSlugs(ctx).includes(slug)) {
      return ctx.say(`You are not a member of "${slug || "?"}", or there is no such project. /projects lists yours.`);
    }
    this.state.set(this.#dmKey(ctx.m), slug);
    return ctx.say(`OK — this chat now talks about "${slug}".`);
  }

  #bind(ctx, arg) {
    const slug = arg || ctx.bound || this.#slugFor(ctx);
    if (!slug) return ctx.say("Usage: /bind <project>");
    if (this.#roleOf(ctx, slug) !== "owner") return ctx.say("Only an owner of the project can bind a chat to it.");
    try {
      bindChat({ projectsDir: this.projectsDir, slug, channel: ctx.m.channel, chatId: ctx.m.chatId });
    } catch (err) {
      return ctx.say(err.code === "EXISTS" ? `This chat is already bound — /unbind it first. (${err.message})` : `Could not bind: ${err.message}`);
    }
    return ctx.say(`This chat is now the room of "${slug}": messages here go to its PM, approvals and the daily digest are posted here.`);
  }

  #unbind(ctx, arg) {
    const slug = arg || ctx.bound;
    if (!slug) return ctx.say("This chat is not bound to a project.");
    if (this.#roleOf(ctx, slug) !== "owner") return ctx.say("Only an owner of the project can unbind its chat.");
    unbindChat({ projectsDir: this.projectsDir, slug, channel: ctx.m.channel });
    return ctx.say(`"${slug}" is no longer bound to this chat.`);
  }

  #status(slug, { room = false, showLast = false } = {}) {
    const project = readProject({ projectsDir: this.projectsDir, slug });
    const items = readItems({ projectsDir: this.projectsDir, slug });
    const count = (s) => items.filter((i) => i.status === s).length;
    const pm = this.hub.list().find((p) => p.slug === slug);
    const approvals = this.approvalsOf(slug).length;
    const lines = [
      `${slug} — ${project.name} (${project.template})`,
      `PM: ${pm?.state ?? "idle"}${pm?.queued ? `, ${pm.queued} waiting` : ""}`,
      `Items: idea ${count("idea")} · doing ${count("doing")} · review ${count("review")} · done ${count("done")}`,
      `Pending approvals: ${approvals}`,
    ];
    // never in a group: the last reply may have been a private conversation
    if (pm?.lastText && !room && showLast) lines.push(`Last PM reply: ${pm.lastText}`);
    return lines.join("\n");
  }

  #items(slug) {
    const open = readItems({ projectsDir: this.projectsDir, slug }).filter((i) => i.status !== "done" && i.status !== "dropped");
    if (open.length === 0) return `${slug}: nothing open.`;
    const rows = open.slice(0, OPEN_ITEM_LIMIT).map((i) => `${i.id} [${i.status}] ${i.title}`);
    if (open.length > OPEN_ITEM_LIMIT) rows.push(`… and ${open.length - OPEN_ITEM_LIMIT} more`);
    return `${slug} — open items:\n${rows.join("\n")}`;
  }

  // ── approvals ────────────────────────────────────────────────────────────────────────
  /**
   * Slug of the project an approval belongs to: the one whose folder is the MOST SPECIFIC
   * ancestor of the approval's cwd (worktrees included). A folder shared by two projects is
   * ambiguous → null, and a project rooted at the home directory or / is not a catch-all.
   * null = not any project's business: only the operator may answer it.
   */
  #projectOfCwd(cwd) {
    const catchAll = new Set(["/", os.homedir(), realOr(os.homedir())]);
    let best = null;
    let tie = false;
    for (const slug of projectSlugs(this.projectsDir)) {
      let root;
      try {
        root = readProject({ projectsDir: this.projectsDir, slug }).cwd;
      } catch {
        continue; // unreadable project folder
      }
      if (catchAll.has(root) || !inside(cwd, root)) continue;
      if (!best || root.length > best.root.length) {
        best = { slug, root };
        tie = false;
      } else if (root.length === best.root.length) {
        tie = true;
      }
    }
    return best && !tie ? best.slug : null;
  }

  /** Open approvals whose cwd is inside the project. */
  approvalsOf(slug) {
    return this.broker.list().filter((a) => this.#projectOfCwd(a.cwd) === slug);
  }

  #pending(ctx) {
    const rows = [];
    for (const slug of this.#visibleSlugs(ctx)) {
      if (!canApprove(this.#roleOf(ctx, slug))) continue;
      for (const a of this.approvalsOf(slug)) rows.push(`${a.id.slice(0, 8)} — ${slug} — ${a.tool}: ${a.preview.slice(0, 120)}`);
    }
    if (ctx.memberships.length > 0 && !ctx.legacy && !ctx.memberships.some((x) => canApprove(x.member.role))) {
      return "Your role cannot see or answer approvals.";
    }
    return rows.length ? `Open approvals:\n${rows.join("\n")}` : "No approvals waiting.";
  }

  #decide(ctx, cmd, arg) {
    const prefix = arg.split(/\s+/)[0] ?? "";
    if (!prefix) return `Usage: /${cmd} <id> — ids are in /pending.`;
    const none = "No pending approval matches that id (it may have expired).";
    const hits = prefix.length < MIN_APPROVAL_PREFIX ? [] : this.broker.list().filter((a) => a.id.startsWith(prefix.toLowerCase()));
    if (hits.length !== 1) return none;
    const approval = hits[0];
    const slug = this.#projectOfCwd(approval.cwd);
    if (ctx.bound && slug !== ctx.bound) return none; // a project room answers its own project's approvals only
    // an approval outside every project is the operator's business alone
    const role = slug ? this.#roleOf(ctx, slug) : ctx.legacy ? "owner" : null;
    if (!role) return none; // not your project — do not even confirm it exists
    if (!canApprove(role)) return `Your role (${role}) cannot approve or deny — it is read-only.`;
    if (role === "manager" && slug) {
      const project = readProject({ projectsDir: this.projectsDir, slug });
      if (!this.policyAllows({ project, role, approval })) return `The policy of "${slug}" does not let managers answer approvals remotely — ask an owner.`;
    }
    // the id is the identity; a display name is anything a person typed into their profile
    const who = `${ctx.m.channel}:${ctx.m.userId}${safeName(ctx.m.name) ? ` (${safeName(ctx.m.name)})` : ""}`;
    const res = this.broker.respond(approval.id, cmd === "approve" ? "allow" : "deny", who);
    if (!res.ok) return none;
    return cmd === "approve" ? `✓ Approved ${approval.tool}.` : `✗ Denied ${approval.tool}.`;
  }

  /**
   * Tell the people who can answer that something is waiting. Bound chat first; without one,
   * the owners'/managers' own DMs; without a project, the operator's legacy chat.
   * @param {{id: string, tool: string, preview?: string, cwd?: string|null, expiresAt?: number}} approval
   */
  async notifyApproval(approval) {
    const slug = this.#projectOfCwd(approval.cwd);
    const short = approval.id.slice(0, 8);
    const secs = approval.expiresAt ? Math.max(0, Math.round((approval.expiresAt - this.now()) / 1000)) : null;
    const text =
      `⚠ Approval needed${slug ? ` — ${slug}` : ""}\n${approval.tool}${approval.preview ? `: ${approval.preview.slice(0, 300)}` : ""}\n` +
      `/approve ${short}  ·  /deny ${short}${secs !== null ? `  (expires in ${secs}s)` : ""}`;
    const targets = [];
    if (slug) {
      const project = readProject({ projectsDir: this.projectsDir, slug });
      for (const channel of CHANNELS) {
        const chat = boundChat(project, channel);
        if (chat) targets.push([channel, chat]);
      }
      if (targets.length === 0) {
        for (const member of listMembers({ projectsDir: this.projectsDir, slug })) {
          if (!canApprove(member.role)) continue;
          for (const channel of CHANNELS) if (member[channel]?.userId) targets.push([channel, String(member[channel].userId)]);
        }
      }
    }
    // the operator's PRIVATE chat only: a group (Telegram ids are negative) cannot answer anything
    if (targets.length === 0) for (const l of this.legacy) if (!l.chatId.startsWith("-")) targets.push([l.channel, l.chatId]);
    await Promise.all(targets.map(([channel, chatId]) => this.#say(channel, chatId, text)));
  }

  /** Post to the project's bound room(s). False = no room is bound, nothing was sent. */
  async sendToProjectChats(slug, text) {
    const project = readProject({ projectsDir: this.projectsDir, slug });
    const targets = CHANNELS.map((c) => [c, boundChat(project, c)]).filter(([, chat]) => chat);
    await Promise.all(targets.map(([channel, chatId]) => this.#say(channel, chatId, text)));
    return targets.length > 0;
  }

  // ── plain text → the project's PM ────────────────────────────────────────────────────
  async #talkToPm(ctx, text) {
    const { m, say } = ctx;
    const slug = this.#slugFor(ctx);
    if (!slug) {
      if (ctx.legacy && this.legacyAsk) {
        if (!this.#allow(m, "pm", this.limits.pmPerMinute, say)) return;
        return this.legacyAsk(text, (reply) => void say(reply));
      }
      return say(this.#needProject(ctx));
    }
    const role = this.#roleOf(ctx, slug);
    if (!role) return;
    if (!canChat(role)) return say("Your role is read-only: use /status or /items. Ask an owner if you need to talk to the PM.");
    if (!this.#allow(m, "pm", this.limits.pmPerMinute, say)) return;

    const prefix = !ctx.bound && this.#visibleSlugs(ctx).length > 1 ? `[${slug}] ` : "";
    const res = this.hub.ask(slug, text, {
      speaker: `${safeName(m.name) || m.userId} (${role}, ${m.channel})`,
      onReply: (reply) => void say(prefix + reply.text),
    });
    if (!res.accepted) return say(res.message ?? "The PM cannot take that right now.");
    if (res.queued) return say(`The PM is busy — queued (${res.queued} ahead of the next turn).`);
  }
}

/**
 * Default policy seam (lane L2 owns `project.policy`): a manager may not answer approvals
 * remotely when the project's mode is read-only or deny — those modes mean "no tool use gets
 * a human yes". Owners are never blocked. L2 can inject a richer function.
 */
export function defaultPolicyAllows({ project }) {
  const mode = project?.policy?.mode;
  return mode !== "read-only" && mode !== "deny";
}
