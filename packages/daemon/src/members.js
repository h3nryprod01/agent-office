// lane L5: who may do what in a project. `project.json` → members: [{ id, name, role,
// telegram?: { userId }, zalo?: { userId } }]. Roles:
//   owner   — everything (members, pairing codes, chat, approvals)
//   manager — chat with the PM and approve, nothing about who is a member
//   viewer  — read-only: status and items
// A member is added either by an owner in the UI or by redeeming a one-time pairing code
// (PairingStore) from a chat channel. Codes live in memory only: a daemon restart
// invalidates them, which is the safe direction.

import { randomInt, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { DEFAULT_PROJECTS_DIR, PROJECT_SLUG_RE, readProject } from "./projects.js";

export const ROLES = ["owner", "manager", "viewer"];
export const CHANNELS = ["telegram", "zalo"];
const NAME_MAX = 60;
// no 0/O/1/I/L — a code read off a screen and typed into a phone must not be ambiguous
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export const canChat = (role) => role === "owner" || role === "manager";
export const canApprove = (role) => role === "owner" || role === "manager";
export const canManageMembers = (role) => role === "owner";

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}
const invalid = (m) => fail("INVALID", m);

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function projectFile(projectsDir, slug) {
  if (!PROJECT_SLUG_RE.test(slug)) throw invalid(`invalid slug: ${JSON.stringify(slug)}`);
  return path.join(projectsDir, slug, "project.json");
}

/** Read-modify-write project.json via `fn(project) → project`; keys this lane does not own pass through. */
function mutateProject(projectsDir, slug, fn) {
  const project = readProject({ projectsDir, slug }); // NOT_FOUND → "no such project"
  const next = fn(project);
  writeJsonAtomic(projectFile(projectsDir, slug), next);
  return next;
}

function mutateMembers(projectsDir, slug, fn) {
  return mutateProject(projectsDir, slug, (project) => ({
    ...project,
    members: fn(Array.isArray(project.members) ? project.members : []),
  })).members;
}

export function listMembers({ projectsDir = DEFAULT_PROJECTS_DIR, slug }) {
  const project = readProject({ projectsDir, slug });
  return Array.isArray(project.members) ? project.members : [];
}

const identityOf = (member, channel) => (member?.[channel]?.userId != null ? String(member[channel].userId) : null);

/** Normalize `{ telegram: {userId}, zalo: {userId} }` input to stored shape (ids as strings). */
function cleanIdentities(input) {
  const out = {};
  for (const channel of CHANNELS) {
    const id = input?.[channel]?.userId;
    if (id === undefined || id === null || id === "") continue;
    out[channel] = { userId: String(id) };
  }
  return out;
}

export function addMember({ projectsDir = DEFAULT_PROJECTS_DIR, slug, name, role, telegram, zalo }) {
  if (!ROLES.includes(role)) throw invalid(`role must be one of ${ROLES.join("|")}`);
  const clean = typeof name === "string" ? name.trim() : "";
  if (!clean || clean.length > NAME_MAX) throw invalid(`name must be 1–${NAME_MAX} characters`);
  const identities = cleanIdentities({ telegram, zalo });
  const member = { id: `m-${randomUUID().slice(0, 8)}`, name: clean, role, ...identities };
  mutateMembers(projectsDir, slug, (members) => {
    for (const channel of CHANNELS) {
      const id = identities[channel]?.userId;
      if (id && members.some((m) => identityOf(m, channel) === id)) {
        throw fail("EXISTS", `that ${channel} account is already a member of "${slug}"`);
      }
    }
    return [...members, member];
  });
  return member;
}

export function removeMember({ projectsDir = DEFAULT_PROJECTS_DIR, slug, id }) {
  mutateMembers(projectsDir, slug, (members) => {
    const target = members.find((m) => m.id === id);
    if (!target) throw fail("NOT_FOUND", `no such member "${id}"`);
    if (target.role === "owner" && members.filter((m) => m.role === "owner").length === 1) {
      throw invalid("cannot remove the last owner");
    }
    return members.filter((m) => m.id !== id);
  });
}

/** Slugs of every project directory — cheaper than listProjects(), which also reads each items.json. */
export function projectSlugs(projectsDir = DEFAULT_PROJECTS_DIR) {
  try {
    return fs
      .readdirSync(projectsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && PROJECT_SLUG_RE.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Every project a channel identity belongs to: [{ slug, member }]. */
export function findMemberByIdentity({ projectsDir = DEFAULT_PROJECTS_DIR, channel, userId }) {
  const wanted = String(userId);
  const out = [];
  for (const slug of projectSlugs(projectsDir)) {
    try {
      const member = listMembers({ projectsDir, slug }).find((m) => identityOf(m, channel) === wanted);
      if (member) out.push({ slug, member });
    } catch {
      // a directory without a readable project.json is not a project
    }
  }
  return out;
}

/** Role of a channel identity in one project, or null for a stranger. */
export function roleIn({ projectsDir = DEFAULT_PROJECTS_DIR, slug, channel, userId }) {
  if (userId === undefined || userId === null) return null;
  try {
    const wanted = String(userId);
    return listMembers({ projectsDir, slug }).find((m) => identityOf(m, channel) === wanted)?.role ?? null;
  } catch {
    return null;
  }
}

/**
 * One-time pairing codes: the owner mints one in the UI, the other person sends it to the
 * bot. `AO-` + 8 chars from a 31-symbol alphabet (~40 bits); the router additionally rate
 * limits failed attempts per person, so guessing is not a practical route in.
 */
export class PairingStore {
  constructor({ projectsDir = DEFAULT_PROJECTS_DIR, ttlMs = 15 * 60_000, now = Date.now } = {}) {
    this.projectsDir = projectsDir;
    this.ttlMs = ttlMs;
    this.now = now;
    /** @type {Map<string, {slug: string, role: string, createdBy: string, expiresAt: number}>} */
    this.codes = new Map();
  }

  create({ slug, role, createdBy }) {
    if (!ROLES.includes(role)) throw invalid(`role must be one of ${ROLES.join("|")}`);
    readProject({ projectsDir: this.projectsDir, slug }); // NOT_FOUND for an unknown project
    this.#sweep();
    let code;
    do {
      code = "AO-" + Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
    } while (this.codes.has(code));
    const expiresAt = this.now() + this.ttlMs;
    this.codes.set(code, { slug, role, createdBy: String(createdBy ?? ""), expiresAt });
    return { code, slug, role, expiresAt };
  }

  /** @returns {{ok: true, slug, member} | {ok: false, reason: "invalid_or_expired"|"already_member"}} */
  redeem(rawCode, { channel, userId, name }) {
    this.#sweep();
    const code = String(rawCode ?? "").trim().toUpperCase();
    const entry = this.codes.get(code);
    if (!entry) return { ok: false, reason: "invalid_or_expired" };
    if (roleIn({ projectsDir: this.projectsDir, slug: entry.slug, channel, userId })) {
      return { ok: false, reason: "already_member" }; // keep the code: it was not used up
    }
    this.codes.delete(code); // single use, even if adding fails below
    try {
      const member = addMember({
        projectsDir: this.projectsDir,
        slug: entry.slug,
        name: String(name || `${channel}:${userId}`).replace(/\s+/g, " ").trim().slice(0, NAME_MAX) || `${channel}:${userId}`,
        role: entry.role,
        [channel]: { userId },
      });
      return { ok: true, slug: entry.slug, member };
    } catch {
      return { ok: false, reason: "invalid_or_expired" }; // project vanished meanwhile
    }
  }

  /** Live codes, optionally for one project. */
  pending(slug) {
    this.#sweep();
    return [...this.codes]
      .filter(([, v]) => !slug || v.slug === slug)
      .map(([code, v]) => ({ code, ...v }));
  }

  #sweep() {
    const t = this.now();
    for (const [code, v] of this.codes) if (v.expiresAt <= t) this.codes.delete(code);
  }
}

// ── chat bindings: project.json → channels: { telegram: { chatId } } ───────────────────────
// A project talks to ONE group or DM per channel. The binding is data on the project (it
// travels with it), the lookup scans the project folders — a handful of small files.

export function boundChat(project, channel) {
  const id = project?.channels?.[channel]?.chatId;
  return id === undefined || id === null || id === "" ? null : String(id);
}

/** Slug of the project a chat is bound to, or null. */
export function projectForChat({ projectsDir = DEFAULT_PROJECTS_DIR, channel, chatId }) {
  const wanted = String(chatId);
  for (const slug of projectSlugs(projectsDir)) {
    try {
      if (boundChat(readProject({ projectsDir, slug }), channel) === wanted) return slug;
    } catch {
      // not a readable project
    }
  }
  return null;
}

export function bindChat({ projectsDir = DEFAULT_PROJECTS_DIR, slug, channel, chatId }) {
  if (!CHANNELS.includes(channel)) throw invalid(`channel must be one of ${CHANNELS.join("|")}`);
  const other = projectForChat({ projectsDir, channel, chatId });
  if (other && other !== slug) throw fail("EXISTS", `this chat is already bound to "${other}" — unbind it there first`);
  mutateProject(projectsDir, slug, (project) => ({
    ...project,
    channels: { ...(project.channels ?? {}), [channel]: { chatId: String(chatId) } },
  }));
}

export function unbindChat({ projectsDir = DEFAULT_PROJECTS_DIR, slug, channel }) {
  mutateProject(projectsDir, slug, (project) => {
    const { [channel]: _dropped, ...rest } = project.channels ?? {};
    return { ...project, channels: rest };
  });
}
