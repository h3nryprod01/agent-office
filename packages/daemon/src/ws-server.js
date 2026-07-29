// Local WebSocket broadcast server. Every connected client receives every
// normalized event as JSON, in order, as soon as it's produced. No auth,
// no rooms — this is a localhost-only PoC for a single-user desktop app.

import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
// `npm --prefix packages/daemon start` runs with cwd = packages/daemon, so a
// bare process.cwd() misses the repo's .claude/memory. Walk up from cwd to the
// nearest directory that actually has the registry; fall back to the repo this
// package lives in.
function findWorkItemsPath() {
  if (process.env.WORK_ITEMS_PATH) return process.env.WORK_ITEMS_PATH;
  const rel = path.join(".claude", "memory", "work-items.json");
  let dir = process.cwd();
  for (;;) {
    const candidate = path.join(dir, rel);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..", rel);
}
const DEFAULT_WORK_ITEMS_PATH = findWorkItemsPath();
const EMPTY_WORK_ITEMS = { version: 1, items: [] };

export class EventBroadcastServer {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.port]
   * @param {string} [opts.host]
   * @param {number} [opts.perSessionLimit] events kept per session/agent
   * @param {number} [opts.maxSessions] distinct sessions tracked before LRU eviction
   * @param {string} [opts.workItemsPath] work registry file served by GET /work-items
   * @param {(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, url: URL) => boolean} [opts.extraHttp]
   *   extension point for additional HTTP routes (e.g. POST /chat) — return
   *   true when the request was handled, false to fall through to 404.
   */
  constructor({
    port = DEFAULT_PORT,
    host = DEFAULT_HOST,
    perSessionLimit = 100,
    maxSessions = 50,
    workItemsPath = DEFAULT_WORK_ITEMS_PATH,
    extraHttp = null,
    originGuard = null,
  } = {}) {
    this.port = port;
    this.host = host;
    this.perSessionLimit = perSessionLimit;
    this.maxSessions = maxSessions;
    this.workItemsPath = workItemsPath;
    this.extraHttp = extraHttp;
    // originGuard (from origin-guard.js) rejects cross-origin requests before any
    // route runs — covers /transcript, /work-items, every extraHttp route, and the
    // WS upgrade. null → allow all (the default keeps existing tests unchanged).
    this.originGuard = originGuard;
    this.server = null;
    this.wss = null;
    /**
     * sessionId -> that session's own ring buffer (array, cap perSessionLimit).
     * A Map re-inserted on update (delete then set) tracks LRU-by-last-update
     * for free: the first key is always the least-recently-updated session,
     * so eviction is just `.keys().next().value`.
     * @type {Map<string, import("./event-schema.js").NormalizedEvent[]>}
     */
    this.sessionBuffers = new Map();
  }

  start() {
    // Same port serves both the WS upgrade and a small HTTP API (currently
    // just GET /transcript) — one process, one port, no new dependency.
    this.server = createServer((req, res) => this.#handleHttp(req, res));
    this.wss = new WebSocketServer({
      server: this.server,
      ...(this.originGuard ? { verifyClient: this.originGuard.ws } : {}),
    });

    this.wss.on("connection", (socket) => {
      // New clients get a small backlog so a renderer opening mid-session
      // isn't staring at an empty office — union of every tracked session's
      // buffer, in time order.
      for (const event of this.#mergedEventsByTs()) {
        socket.send(JSON.stringify(event));
      }
    });

    this.wss.on("error", (error) => {
      // eslint-disable-next-line no-console
      console.error("[ws-server] error:", error.message);
    });

    return new Promise((resolve) => {
      this.server.listen(this.port, this.host, resolve);
    });
  }

  stop() {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.wss.close(() => this.server.close(() => resolve()));
    });
  }

  /**
   * All tracked sessions' buffers merged and sorted by ts ascending.
   * ponytail: naive concat + sort, fine since total size is bounded by
   * maxSessions * perSessionLimit (a few thousand events, worst case).
   */
  #mergedEventsByTs() {
    const merged = [];
    for (const bucket of this.sessionBuffers.values()) {
      merged.push(...bucket);
    }
    merged.sort((a, b) => a.ts - b.ts);
    return merged;
  }

  /**
   * GET /transcript?sessionId=<id>&limit=20 — last N normalized events for
   * one session/agent, from the in-memory replay buffer (no re-reading
   * transcript files from disk). For the Mission Control side panel.
   *
   * With sessionId: reads only that session's own buffer, so a quiet
   * session reliably gets up to `limit` of its own events regardless of
   * how noisy other sessions are. Without sessionId: last `limit` events
   * across all sessions, same as before.
   */
  #handleHttp(req, res) {
    // Cross-origin gate first: a remote page must not read /work-items or trip a
    // side-effect route (e.g. /harnesses?probe= spawns claude -p). 403 and stop.
    if (this.originGuard && !this.originGuard.http(req, res)) return;
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/transcript") {
      const sessionId = url.searchParams.get("sessionId");
      const limit = Number(url.searchParams.get("limit")) || 20;
      const source = sessionId
        ? this.sessionBuffers.get(sessionId) ?? []
        : this.#mergedEventsByTs();
      const lines = source.slice(-limit).map((event) => ({
        ts: event.ts,
        role: event.type === "speak" ? "assistant" : "tool",
        text: event.detail,
        tool: event.tool ?? undefined,
      }));
      // CORS: the renderer is served from a different origin (localhost:5199
      // vs this 127.0.0.1:8787), so the browser needs this to read the body.
      // localhost-only PoC — wildcard is fine here.
      res.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      });
      res.end(JSON.stringify(lines));
      return;
    }
    if (req.method === "GET" && url.pathname === "/work-items") {
      res.writeHead(200, {
        "content-type": "application/json",
        "access-control-allow-origin": "*",
      });
      res.end(JSON.stringify(this.#readWorkItems()));
      return;
    }
    if (this.extraHttp && this.extraHttp(req, res, url)) return;
    res.writeHead(404);
    res.end();
  }

  /**
   * Work registry (company-protocol.md §2), read from disk on every request —
   * no cache, the file is tiny and the coordinator/agents rewrite it out of
   * band. Missing or corrupt file degrades to an empty registry, never a 500.
   */
  #readWorkItems() {
    try {
      const parsed = JSON.parse(readFileSync(this.workItemsPath, "utf8"));
      if (!parsed || !Array.isArray(parsed.items)) {
        console.warn(`[ws-server] work-items file has no items array: ${this.workItemsPath}`);
        return EMPTY_WORK_ITEMS;
      }
      return parsed;
    } catch (error) {
      console.warn(`[ws-server] work-items unreadable (${error.message}): ${this.workItemsPath}`);
      return EMPTY_WORK_ITEMS;
    }
  }

  /**
   * @param {import("./event-schema.js").NormalizedEvent} event
   */
  broadcast(event) {
    // ponytail: events without a sessionId all land in one "" bucket rather
    // than being dropped — matches the old buffer's behavior of never
    // discarding an event based on shape.
    const sessionId = event.sessionId ?? "";
    let bucket = this.sessionBuffers.get(sessionId);
    if (bucket) {
      // Re-insert to mark this session as most-recently-updated.
      this.sessionBuffers.delete(sessionId);
    } else {
      if (this.sessionBuffers.size >= this.maxSessions) {
        const lruSessionId = this.sessionBuffers.keys().next().value;
        this.sessionBuffers.delete(lruSessionId);
      }
      bucket = [];
    }
    bucket.push(event);
    if (bucket.length > this.perSessionLimit) {
      bucket.shift();
    }
    this.sessionBuffers.set(sessionId, bucket);

    const payload = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client.readyState === client.OPEN) {
        client.send(payload);
      }
    }
  }

  get clientCount() {
    return this.wss ? this.wss.clients.size : 0;
  }
}
