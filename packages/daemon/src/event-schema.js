// Normalized event stream schema — version 1.
//
// Design goal: "what does a renderer need to animate a character".
// A renderer needs, per event: WHO (agent/session), WHEN (ts), WHAT KIND of
// thing happened (type), the specific ACTION (tool), whether that action is
// STARTING/FINISHING/FAILING (status, for start->idle animation transitions),
// and a short human-readable line to show in a speech bubble/tooltip (detail).
//
// This is intentionally flatter than the raw transcript: one JSONL line can
// expand into zero or more of these events (e.g. an assistant message with
// three tool_use blocks becomes three "tool_call" events).

import { existsSync } from "node:fs";
import { dirname, join, basename } from "node:path";

export const SCHEMA_VERSION = 1;

/**
 * @typedef {"session_start"|"session_end"|"speak"|"tool_call"|"hook_signal"|"approval_pending"|"approval_resolved"} EventType
 *   "hook_signal" (additive, Round 3): real-time PreToolUse/PostToolUse
 *   signal from the hook log — meta.state is "waiting_permission" (call
 *   unconfirmed past the grace window, likely a permission prompt) or
 *   "working" (a previously-reported wait was confirmed to proceed).
 *   "approval_pending"/"approval_resolved" (additive, R5② spike): a real
 *   PermissionRequest is answerable from the office — meta.approvalId,
 *   meta.preview, meta.expiresAt; resolved adds meta.decision + meta.source.
 * @typedef {"start"|"ok"|"error"} EventStatus
 *
 * @typedef {Object} NormalizedEvent
 * @property {number} v            schema version
 * @property {string} id           stable id for dedup (transcript uuid, or derived)
 * @property {EventType} type      what kind of event this is
 * @property {string} sessionId    Claude Code session id (one per character)
 * @property {string} agentId      character id: sessionId for the root agent,
 *                                 or the real sub-agent id for sub-agent events
 * @property {string|null} parentId  agentId that spawned this agent; null for
 *                                   the root agent, else the spawning agent's id
 *                                   (falls back to sessionId if not yet resolved)
 * @property {string} cwd          project working dir for this session (identifies the "desk")
 * @property {string} repo         repo/project the agent belongs to, derived from cwd
 *                                 (additive, Round 4): project-root basename; a cwd
 *                                 inside <root>/.claude/worktrees/<x> resolves to the
 *                                 root repo; cwd outside any git repo -> "other"
 * @property {string} harness      which CLI produced this agent's transcript
 *                                 ("claude-code" | "codex" | "gemini") — lets the
 *                                 renderer pick a different character skin per harness
 * @property {number} ts           event time, ms since epoch
 * @property {string} agent        display label for the acting agent (cwd-derived project name)
 * @property {string|null} tool    tool name for tool_call events, else null
 * @property {EventStatus|null} status  lifecycle stage of the event
 * @property {string} detail       short human-readable summary for a speech bubble
 * @property {Object|null} meta    extra fields a renderer may use opportunistically
 */

/**
 * Build a normalized event. Central factory so every emitter produces the
 * same shape and callers can't accidentally forget a field.
 * @param {Partial<NormalizedEvent>} fields
 * @returns {NormalizedEvent}
 */
export function makeEvent(fields) {
  return {
    v: SCHEMA_VERSION,
    id: fields.id,
    type: fields.type,
    sessionId: fields.sessionId,
    agentId: fields.agentId ?? fields.sessionId,
    parentId: fields.parentId ?? null,
    cwd: fields.cwd ?? null,
    repo: fields.repo ?? deriveRepo(fields.cwd),
    harness: fields.harness ?? "claude-code",
    ts: fields.ts ?? Date.now(),
    agent: fields.agent ?? deriveAgentLabel(fields.cwd),
    tool: fields.tool ?? null,
    status: fields.status ?? null,
    detail: fields.detail ?? "",
    meta: fields.meta ?? null,
  };
}

/**
 * Derive a short display label from a cwd path, e.g.
 * "/Users/x/Projects/demo-app" -> "demo-app".
 * @param {string|null|undefined} cwd
 * @returns {string}
 */
export function deriveAgentLabel(cwd) {
  if (!cwd) return "unknown";
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/** Memoized deriveRepo results — one fs walk per distinct cwd, ever. */
const repoCache = new Map();

/** repo name -> root path, recorded as a byproduct of deriveRepo walks. */
const repoRoots = new Map();

/**
 * Root path of a repo the daemon has already seen events for (per-repo PM
 * chat spawns `claude` with this as cwd). Unknown repo -> null.
 * @param {string} repo
 * @returns {string|null}
 */
export function getRepoRoot(repo) {
  return repoRoots.get(repo) ?? null;
}

/**
 * Which repo does this cwd belong to? Rules:
 *  - null/empty -> "other"
 *  - <root>/.claude/worktrees/<x>[/...] -> basename(root)  (worktree agents
 *    were previously shown under the worktree name — wrong office)
 *  - otherwise walk up looking for a .git entry (dir or worktree file);
 *    found -> basename of that dir, none all the way to / -> "other"
 * @param {string|null|undefined} cwd
 * @returns {string}
 */
export function deriveRepo(cwd) {
  if (!cwd) return "other";
  const cached = repoCache.get(cwd);
  if (cached) return cached;

  let repo = "other";
  // Normalize separators so the worktree string rule matches on Windows
  // (cwd there is `C:\…\<root>\.claude\worktrees\<x>`), and take the basename
  // from the normalized root so it splits on "/" on any OS (POSIX `basename`
  // doesn't split on "\"). `root` keeps native separators for repoRoots.
  const norm = cwd.replace(/\\/g, "/");
  const wt = norm.indexOf("/.claude/worktrees/");
  if (wt > 0) {
    const root = cwd.slice(0, wt);
    const normRoot = norm.slice(0, wt);
    repo = normRoot.slice(normRoot.lastIndexOf("/") + 1);
    if (!repoRoots.has(repo)) repoRoots.set(repo, root);
  } else {
    for (let dir = cwd; ; dir = dirname(dir)) {
      if (existsSync(join(dir, ".git"))) {
        repo = basename(dir);
        if (!repoRoots.has(repo)) repoRoots.set(repo, dir);
        break;
      }
      if (dirname(dir) === dir) break; // reached filesystem root
    }
  }
  repoCache.set(cwd, repo);
  return repo;
}
