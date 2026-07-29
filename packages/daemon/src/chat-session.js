// PM chat — talk to a PM character (1 chatbox message = 1 real Claude turn).
//
// POST /chat {text, repo?, targetSessionId?} spawns `claude -p <text> --resume
// <id> --output-format stream-json --verbose` as a child process and
// broadcasts the reply over the existing WS pipeline as ADDITIVE v1 events of
// type "chat_message" (meta: {role, text, targetSessionId, done, error};
// top-level `repo` routes the line to the right tab's transcript).
//
// Round 5: one PM PER REPO. State file .claude/memory/pm-session.json is a
// map {version: 2, repos: {"<repoName>": {sessionId, cwd, updatedAt}}} — the
// old single {sessionId} format is migrated on first read as the default
// repo's PM. A repo's PM is spawned only when the user first chats into that
// repo (never pre-spawned), with cwd = that repo's real root: the daemon's
// own repo for the default, else the root recorded by deriveRepo() from
// events already seen (or the cwd persisted in the state file). A repo the
// daemon has never seen → friendly error, no spawn.
//
// NOTE: `-p --resume` forks a NEW session id per turn, so the map entry is
// rewritten after every turn — the conversation is continuous, the id is not.
//
// Honest boundary: this chat CANNOT approve permission prompts of any
// session — waiting_permission alerts are still handled in the real app.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { makeEvent } from "./event-schema.js";
import { cliSpawnOptions } from "./platform.js";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // PM reads registry/git before answering

export const PM_SYSTEM_PROMPT =
  "Bạn là PM của Agent Office, đang trả lời qua chatbox trong văn phòng. " +
  "Hành xử như PM stateless theo docs/company-protocol.md và skill company-pm " +
  "(~/.claude/skills/company-pm/SKILL.md): trước khi trả lời về trạng thái công việc, " +
  "đọc .claude/memory/work-items.json + .claude/memory/activeContext.md + git log. " +
  "LUÔN trả lời bằng đúng ngôn ngữ user dùng trong tin nhắn: user viết tiếng Việt thì " +
  "trả lời tiếng Việt, user viết tiếng Anh thì trả lời tiếng Anh. Ngắn gọn như tin nhắn chat. " +
  "Bạn KHÔNG thể duyệt permission cho session khác — nếu được nhờ, nói rõ phải duyệt ở app gốc.";

// PMs of other repos: those repos have no work-items.json / company-protocol —
// keep the prompt generic instead of forcing the registry ritual on them.
export const GENERIC_PM_SYSTEM_PROMPT =
  "Bạn là PM điều phối repo này, đang trả lời qua chatbox của Agent Office. " +
  "Trước khi trả lời về trạng thái công việc, đọc git log / git status và " +
  "trạng thái các session đang chạy trong repo. " +
  "LUÔN trả lời bằng đúng ngôn ngữ user dùng trong tin nhắn: user viết tiếng Việt thì " +
  "trả lời tiếng Việt, user viết tiếng Anh thì trả lời tiếng Anh. Ngắn gọn như tin nhắn chat. " +
  "Bạn KHÔNG thể duyệt permission cho session khác — nếu được nhờ, nói rõ phải duyệt ở app gốc.";

export class ChatSessionManager {
  /**
   * @param {Object} opts
   * @param {string} opts.stateFile   path to pm-session.json
   * @param {string} opts.cwd        default repo root — cwd for the default PM
   * @param {(event: object) => void} opts.broadcast  WS broadcast sink
   * @param {string} [opts.defaultRepo]  repo name the daemon itself lives in
   * @param {(repo: string) => string|null} [opts.resolveRepoRoot]  repo name →
   *   root path, from repos the daemon has seen events for
   * @param {typeof spawn} [opts.spawnFn]  injectable for tests
   * @param {number} [opts.timeoutMs]
   * @param {string} [opts.claudeBin]
   * @param {string} [opts.systemPrompt]
   * @param {string} [opts.genericSystemPrompt]
   */
  constructor({
    stateFile,
    cwd,
    broadcast,
    defaultRepo = path.basename(cwd),
    resolveRepoRoot = () => null,
    spawnFn = spawn,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    claudeBin = "claude",
    systemPrompt = PM_SYSTEM_PROMPT,
    genericSystemPrompt = GENERIC_PM_SYSTEM_PROMPT,
  }) {
    this.stateFile = stateFile;
    this.cwd = cwd;
    this.broadcast = broadcast;
    this.defaultRepo = defaultRepo;
    this.resolveRepoRoot = resolveRepoRoot;
    this.spawnFn = spawnFn;
    this.timeoutMs = timeoutMs;
    this.claudeBin = claudeBin;
    this.systemPrompt = systemPrompt;
    this.genericSystemPrompt = genericSystemPrompt;
    // ponytail: one in-flight turn globally (across all repo PMs); per-repo
    // queues when parallel PM chats become a real need.
    this.busy = false;
    this.seq = 0;
    /** in-flight turn: {repo, cwd, emit, timer, stopRequested, timedOut} | null */
    this.current = null;
    /**
     * repo → warm PM process kept alive so only the first reply pays cold start:
     * {child, repo, cwd, sessionId, buf, stderrTail, idleTimer}. Killed on idle,
     * stop, crash, or a repo cwd change; respawned (resuming the saved session)
     * on the next message.
     */
    this.warm = new Map();
    /** kill an idle warm process after this long so it doesn't sit forever */
    this.warmIdleMs = 10 * 60 * 1000;
  }

  /**
   * Stop the in-flight PM turn (wi-pm-ux ⏹): SIGTERM, escalate to SIGKILL
   * after 3s. The child's exit handler emits the final "(đã dừng…)" frame.
   * Honest scope: this only stops the PM chat turn spawned by this daemon —
   * it cannot stop the user's other Claude sessions.
   * @param {string|null} [repo]  only stop if the running turn is this repo's
   * @returns {{stopped: boolean, reason?: string}}
   */
  stop(repo = null) {
    const cur = this.current;
    if (!this.busy || !cur) return { stopped: false, reason: "idle" };
    if (repo && repo !== cur.repo) return { stopped: false, reason: "other_repo" };
    if (cur.stopRequested) return { stopped: false, reason: "already_stopping" };
    cur.stopRequested = true;
    // Killing the process ends the turn; for a warm PM process this also drops
    // the warm state, so the next message respawns (resuming the saved session).
    cur.child?.kill("SIGTERM");
    cur.killTimer = setTimeout(() => cur.child?.kill("SIGKILL"), 3000);
    cur.killTimer.unref?.();
    return { stopped: true };
  }

  /** Kill all warm PM processes (+ any in-flight one-shot) so they don't outlive
   *  the daemon. Wired to the daemon's SIGTERM/SIGINT shutdown. */
  dispose() {
    if (this.current?.killTimer) clearTimeout(this.current.killTimer);
    if (this.current?.timer) clearTimeout(this.current.timer);
    for (const proc of this.warm.values()) {
      clearTimeout(proc.idleTimer);
      proc.dead = true;
      try { proc.child.kill("SIGKILL"); } catch { /* already gone */ }
    }
    this.warm.clear();
    try { this.current?.child?.kill("SIGKILL"); } catch { /* already gone */ }
    this.current = null;
    this.busy = false;
  }

  /**
   * @returns {Record<string, {sessionId: string, cwd: string|null, updatedAt: string|null}>}
   *   per-repo PM sessions; migrates the pre-Round-5 single-PM file shape.
   */
  loadRepos() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      if (parsed && typeof parsed.repos === "object" && parsed.repos !== null) {
        return parsed.repos;
      }
      if (typeof parsed?.sessionId === "string" && parsed.sessionId) {
        // v1 file {sessionId, updatedAt}: that was the default repo's PM
        return {
          [this.defaultRepo]: {
            sessionId: parsed.sessionId,
            cwd: this.cwd,
            updatedAt: parsed.updatedAt ?? null,
          },
        };
      }
    } catch {
      // missing or corrupt file — start empty
    }
    return {};
  }

  #saveRepoSession(repo, sessionId, cwd) {
    try {
      const repos = this.loadRepos();
      repos[repo] = { sessionId, cwd, updatedAt: new Date().toISOString() };
      fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
      fs.writeFileSync(this.stateFile, JSON.stringify({ version: 2, repos }, null, 2) + "\n");
    } catch (error) {
      console.error("[chat] cannot persist pm session map:", error.message);
    }
  }

  /** Drop a repo's stored session so the next turn starts fresh (stale-resume recovery). */
  #clearRepoSession(repo) {
    try {
      const repos = this.loadRepos();
      if (!repos[repo]) return;
      delete repos[repo];
      fs.writeFileSync(this.stateFile, JSON.stringify({ version: 2, repos }, null, 2) + "\n");
    } catch (error) {
      console.error("[chat] cannot clear pm session:", error.message);
    }
  }

  #emit({ role, text, repo, cwd, targetSessionId, done, error = false }) {
    const sessionId = targetSessionId ?? "pm-pending";
    this.broadcast(
      makeEvent({
        id: `chat:${sessionId}:${this.seq++}`,
        type: "chat_message",
        sessionId,
        agentId: sessionId,
        cwd,
        repo,
        status: error ? "error" : done ? "ok" : "start",
        detail: text.slice(0, 200),
        meta: { role, text, targetSessionId, done, error },
      })
    );
  }

  /**
   * Fire one chat turn. Non-blocking: reply streams out via broadcast.
   * @param {string} text
   * @param {Object} [opts]
   * @param {string|null} [opts.repo]  repo whose PM to talk to; null = default
   * @param {string|null} [opts.targetSessionId]  explicit session to talk to
   * @returns {{accepted: boolean, repo?: string, targetSessionId?: string|null, reason?: string, message?: string}}
   */
  send(text, { repo = null, targetSessionId = null } = {}) {
    if (this.busy) return { accepted: false, reason: "busy" };

    const repoName = repo ?? this.defaultRepo;
    const repos = this.loadRepos();
    const entry = repos[repoName];
    const cwd =
      repoName === this.defaultRepo
        ? this.cwd
        : (entry?.cwd ?? this.resolveRepoRoot(repoName));
    if (!cwd) {
      return {
        accepted: false,
        reason: "unknown_repo",
        message:
          `Chưa biết repo "${repoName}" nằm ở đâu — daemon chưa thấy session nào chạy trong repo đó. ` +
          "Mở một session Claude trong repo trước, hoặc chat từ tab Acme Web.",
      };
    }

    const isPmTarget = targetSessionId === null;
    const resumeId = targetSessionId ?? entry?.sessionId ?? null;

    this.busy = true;
    const emit = (fields) => this.#emit({ repo: repoName, cwd, ...fields });
    emit({ role: "user", text, targetSessionId: resumeId, done: true });

    // PM chat (targetSessionId null) reuses a warm, long-lived claude process so
    // only the FIRST message pays the ~11s cold start; later ones are ~2-3s.
    // Talking to a specific session (targetSessionId) stays one-shot — a warm
    // process is bound to one session, targeted chats hop between sessions.
    if (isPmTarget) return this.#sendWarm(repoName, cwd, text, emit);
    return this.#sendOneShot(repoName, cwd, resumeId, text, emit);
  }

  /** The office approval MCP config — one line, so both paths agree exactly. */
  #officeMcpConfig() {
    // `process.execPath`, not "node": the daemon (launchd/systemd) has a bare PATH
    // that doesn't include nvm/homebrew node, so a "node" command here ENOENTs when
    // claude spawns the office MCP server → the permission tool never starts → the
    // turn dies with a bare `is_error`. The daemon IS node, so its own binary is
    // the guaranteed-present absolute path — same reason claudeBin is absolute.
    const approvalMcp = fileURLToPath(new URL("../hooks/approval-mcp.mjs", import.meta.url));
    return JSON.stringify({ mcpServers: { office: { command: process.execPath, args: [approvalMcp] } } });
  }

  /** Flags shared by both paths. `--setting-sources project,local` skips the USER
   *  source (~35 plugins + hooks + LSP, ~6s of cold start the PM doesn't need);
   *  auth is in the Keychain, not a settings source, so login survives. */
  #commonArgs() {
    return [
      "--verbose",
      "--model", process.env.AGENT_OFFICE_PM_MODEL || "claude-sonnet-5",
      "--permission-prompt-tool", "mcp__office__approval_prompt",
      "--mcp-config", this.#officeMcpConfig(),
      "--strict-mcp-config",
      "--setting-sources", "project,local",
    ];
  }

  // ── one-shot: spawn a claude per turn (targeted / non-PM chats) ─────────────
  #sendOneShot(repoName, cwd, resumeId, text, emit) {
    // R14 security: the prompt goes on STDIN, never argv (a .cmd shim on Windows
    // + shell:true would treat `&`/`|`/`"` in the message as command injection).
    const args = ["-p", "--output-format", "stream-json", ...this.#commonArgs()];
    if (resumeId) args.push("--resume", resumeId);

    let child;
    try {
      child = this.spawnFn(this.claudeBin, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        ...cliSpawnOptions(process.platform),
      });
    } catch (error) {
      this.busy = false;
      emit({ role: "system", text: `Không chạy được claude CLI: ${error.message}`, targetSessionId: resumeId, done: true, error: true });
      return { accepted: false, reason: error.message };
    }

    this.current = { child, repo: repoName, cwd, emit, stopRequested: false, killTimer: null };
    child.stdin?.on("error", () => {});
    child.stdin?.end(text);

    let liveSessionId = resumeId;
    let stderrTail = "";
    let finished = false;
    const finish = (fn) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (this.current?.killTimer) clearTimeout(this.current.killTimer);
      this.current = null;
      this.busy = false;
      fn?.();
    };
    const timer = setTimeout(() => {
      finish(() => {
        child.kill("SIGKILL");
        emit({ role: "system", text: `PM không phản hồi sau ${Math.round(this.timeoutMs / 1000)}s — turn đã bị hủy, thử lại sau.`, targetSessionId: liveSessionId, done: true, error: true });
      });
    }, this.timeoutMs);

    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === "assistant") {
          const textOut = (msg.message?.content ?? [])
            .filter((b) => b.type === "text" && typeof b.text === "string")
            .map((b) => b.text).join("\n").trim();
          if (textOut) emit({ role: "assistant", text: textOut, targetSessionId: liveSessionId, done: false });
        } else if (msg.type === "result") {
          finish(() => {
            const isErr = msg.is_error === true;
            emit({ role: isErr ? "system" : "assistant", text: isErr ? `PM gặp lỗi: ${typeof msg.result === "string" ? msg.result.slice(0, 300) : "unknown"}` : "", targetSessionId: liveSessionId, done: true, error: isErr });
          });
        }
      }
    });
    child.stderr.on("data", (chunk) => { stderrTail = (stderrTail + chunk).slice(-500); });
    child.on("error", (error) => {
      finish(() => emit({ role: "system", text: `Không chạy được claude CLI: ${error.message}`, targetSessionId: liveSessionId, done: true, error: true }));
    });
    child.on("exit", (code) => {
      if (finished) return;
      const stopped = this.current?.stopRequested === true;
      finish(() => {
        emit({
          role: "system",
          text: stopped ? "(đã dừng theo yêu cầu)" : code === 0 ? "" : `PM turn kết thúc bất thường (exit ${code}). ${stderrTail.trim().slice(0, 200)}`.trim(),
          targetSessionId: liveSessionId,
          done: true,
          error: !stopped && code !== 0,
        });
      });
    });
    return { accepted: true, repo: repoName, targetSessionId: resumeId };
  }

  // ── warm PM process: one long-lived claude per repo, streamed messages ──────
  #spawnWarm(repoName, cwd) {
    const saved = this.loadRepos()[repoName]?.sessionId ?? null;
    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json",
      ...this.#commonArgs(),
      "--append-system-prompt",
      repoName === this.defaultRepo ? this.systemPrompt : this.genericSystemPrompt,
    ];
    if (saved) args.push("--resume", saved);
    let child;
    try {
      child = this.spawnFn(this.claudeBin, args, {
        cwd,
        stdio: ["pipe", "pipe", "pipe"],
        ...cliSpawnOptions(process.platform),
      });
    } catch {
      return null;
    }
    const proc = { child, repo: repoName, cwd, sessionId: saved, buf: "", stderrTail: "", idleTimer: null, dead: false };
    child.stdin?.on("error", () => {});
    child.stdout.on("data", (chunk) => this.#onWarmData(proc, chunk));
    child.stderr.on("data", (chunk) => { proc.stderrTail = (proc.stderrTail + chunk).slice(-500); });
    child.on("exit", (code) => this.#onWarmExit(proc, code));
    child.on("error", () => this.#onWarmExit(proc, -1));
    this.warm.set(repoName, proc);
    return proc;
  }

  #onWarmData(proc, chunk) {
    proc.buf += chunk;
    let idx;
    while ((idx = proc.buf.indexOf("\n")) >= 0) {
      const line = proc.buf.slice(0, idx).trim();
      proc.buf = proc.buf.slice(idx + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.type === "system" && msg.subtype === "init" && typeof msg.session_id === "string") {
        proc.sessionId = msg.session_id;
        this.#saveRepoSession(proc.repo, msg.session_id, proc.cwd);
      } else if (msg.type === "assistant") {
        const cur = this.current;
        if (!cur || cur.repo !== proc.repo) continue;
        const textOut = (msg.message?.content ?? [])
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text).join("\n").trim();
        if (textOut) cur.emit({ role: "assistant", text: textOut, targetSessionId: proc.sessionId, done: false });
      } else if (msg.type === "result") {
        this.#settleWarmResult(proc, msg);
      }
    }
  }

  /** A turn's `result` arrived — the warm process STAYS ALIVE for the next one. */
  #settleWarmResult(proc, msg) {
    const cur = this.current;
    if (!cur || cur.repo !== proc.repo) return;
    if (typeof msg.session_id === "string" && msg.session_id) {
      proc.sessionId = msg.session_id;
      this.#saveRepoSession(proc.repo, msg.session_id, proc.cwd);
    }
    clearTimeout(cur.timer);
    this.current = null;
    this.busy = false;
    const isErr = msg.is_error === true;
    const errText = `${proc.stderrTail} ${Array.isArray(msg.errors) ? msg.errors.join(" ") : ""} ${typeof msg.result === "string" ? msg.result : ""}`;
    const staleSession = isErr && /No conversation found with session ID/i.test(errText);
    if (staleSession) {
      // Resumed a session that no longer exists — drop the id and the (dead) warm
      // process so the next message spawns a fresh one.
      this.#clearRepoSession(proc.repo);
      this.#killWarm(proc);
      cur.emit({ role: "system", text: "Phiên PM cũ không còn — đã reset. Gửi lại tin để PM bắt đầu phiên mới.", targetSessionId: null, done: true, error: true });
      return;
    }
    cur.emit({ role: isErr ? "system" : "assistant", text: isErr ? `PM gặp lỗi: ${typeof msg.result === "string" ? msg.result.slice(0, 300) : "unknown"}` : "", targetSessionId: proc.sessionId, done: true, error: isErr });
    this.#armWarmIdle(proc);
  }

  #onWarmExit(proc, code) {
    proc.dead = true;
    clearTimeout(proc.idleTimer);
    if (this.warm.get(proc.repo) === proc) this.warm.delete(proc.repo);
    const cur = this.current;
    if (!cur || cur.repo !== proc.repo) return; // died while idle — next msg respawns
    clearTimeout(cur.timer);
    this.current = null;
    this.busy = false;
    cur.emit({
      role: "system",
      text: cur.stopRequested
        ? "(đã dừng theo yêu cầu)"
        : cur.timedOut
          ? `PM không phản hồi sau ${Math.round(this.timeoutMs / 1000)}s — turn đã bị hủy, thử lại sau.`
          : `PM turn kết thúc bất thường (exit ${code}). ${proc.stderrTail.trim().slice(0, 200)}`.trim(),
      targetSessionId: proc.sessionId,
      done: true,
      error: !cur.stopRequested,
    });
  }

  #armWarmIdle(proc) {
    clearTimeout(proc.idleTimer);
    proc.idleTimer = setTimeout(() => this.#killWarm(proc), this.warmIdleMs);
    proc.idleTimer.unref?.();
  }

  #killWarm(proc) {
    if (this.warm.get(proc.repo) === proc) this.warm.delete(proc.repo);
    clearTimeout(proc.idleTimer);
    if (proc.dead) return;
    proc.dead = true;
    try { proc.child.kill("SIGKILL"); } catch { /* already gone */ }
  }

  #sendWarm(repoName, cwd, text, emit) {
    let proc = this.warm.get(repoName);
    if (proc && (proc.dead || proc.cwd !== cwd)) { this.#killWarm(proc); proc = null; }
    if (!proc) proc = this.#spawnWarm(repoName, cwd);
    if (!proc) {
      this.busy = false;
      emit({ role: "system", text: "Không chạy được claude CLI.", targetSessionId: null, done: true, error: true });
      return { accepted: false, reason: "spawn_failed" };
    }
    clearTimeout(proc.idleTimer);
    const timer = setTimeout(() => {
      if (this.current) this.current.timedOut = true;
      this.#killWarm(proc); // → #onWarmExit settles the turn as a timeout
    }, this.timeoutMs);
    timer.unref?.();
    this.current = { child: proc.child, repo: repoName, cwd, emit, stopRequested: false, timedOut: false, timer, killTimer: null };
    try {
      proc.child.stdin.write(
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } }) + "\n",
      );
    } catch {
      clearTimeout(timer);
      this.current = null;
      this.busy = false;
      this.#killWarm(proc);
      emit({ role: "system", text: "PM chat lỗi ghi stdin — thử lại.", targetSessionId: null, done: true, error: true });
      return { accepted: false, reason: "stdin_error" };
    }
    return { accepted: true, repo: repoName, targetSessionId: proc.sessionId };
  }
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

/**
 * HTTP route for the broadcast server's extraHttp hook.
 * Returns true when the request was handled (/chat or /chat/stop).
 * GET /chat → {ok, defaultRepo, repos} (repo labels + per-repo PM sessionId/cwd
 * for the 🔗 "tiếp tục trong Claude" hand-over);
 * POST /chat {text, repo?, targetSessionId?} → fire a turn;
 * POST /chat/stop {repo?} → stop the in-flight PM turn (wi-pm-ux ⏹).
 * @param {ChatSessionManager} manager
 */
export function createChatHttpHandler(manager) {
  return (req, res, url) => {
    if (url.pathname !== "/chat" && url.pathname !== "/chat/stop") return false;

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return true;
    }

    if (url.pathname === "/chat/stop") {
      if (req.method !== "POST") {
        res.writeHead(405, CORS_HEADERS);
        res.end();
        return true;
      }
      let stopBody = "";
      req.on("data", (chunk) => {
        stopBody += chunk;
        if (stopBody.length > 4096) req.destroy();
      });
      req.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(stopBody);
        } catch {
          parsed = null;
        }
        const repo = typeof parsed?.repo === "string" && parsed.repo ? parsed.repo : null;
        const result = manager.stop(repo);
        res.writeHead(200, { ...CORS_HEADERS, "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...result }));
      });
      return true;
    }

    if (req.method === "GET") {
      res.writeHead(200, { ...CORS_HEADERS, "content-type": "application/json" });
      res.end(
        JSON.stringify({ ok: true, defaultRepo: manager.defaultRepo, repos: manager.loadRepos() })
      );
      return true;
    }
    if (req.method !== "POST") {
      res.writeHead(405, CORS_HEADERS);
      res.end();
      return true;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 65536) req.destroy(); // localhost chat, not a file upload
    });
    req.on("end", () => {
      const respond = (statusCode, payload) => {
        res.writeHead(statusCode, { ...CORS_HEADERS, "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      const text = typeof parsed?.text === "string" ? parsed.text.trim() : "";
      const repo = typeof parsed?.repo === "string" && parsed.repo ? parsed.repo : null;
      const target =
        typeof parsed?.targetSessionId === "string" && parsed.targetSessionId
          ? parsed.targetSessionId
          : null;
      if (!text) {
        respond(400, { ok: false, error: "text (chuỗi không rỗng) là bắt buộc" });
        return;
      }

      const result = manager.send(text, { repo, targetSessionId: target });
      if (!result.accepted) {
        if (result.reason === "unknown_repo") {
          respond(404, { ok: false, error: result.message });
          return;
        }
        respond(429, {
          ok: false,
          error:
            result.reason === "busy"
              ? "PM đang trả lời tin nhắn trước — chờ chút rồi gửi lại."
              : result.reason,
        });
        return;
      }
      respond(202, { ok: true, repo: result.repo, targetSessionId: result.targetSessionId });
    });
    return true;
  };
}
