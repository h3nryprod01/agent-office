// lane L1: access control for the optional LAN mode.
//
// The daemon was built for one user on one machine: bind 127.0.0.1, no auth. That
// stays exactly as it is for requests that really come from this machine. What is
// new is a way to let other people on the network in without turning the approval
// gateway into an open door:
//
//   - a request from loopback            → owner, no token (unchanged behaviour)
//   - any other request, HTTP or WS      → needs a token, else 401
//   - viewer                              → read-only; manager → may write; owner → everything
//
// Tokens live in <agent-office home>/access.json (mode 0600), stored as SHA-256
// hashes: the file ends up in backups and screenshots, and a token is 256 random
// bits, so a plain hash is enough and the plaintext is shown once, at creation.
// A browser gets a token through a one-time link (?ao_token=…) that swaps itself
// for an HttpOnly SameSite=Strict cookie and a clean URL.
//
// roleOf(req) is the helper other modules use ("owner" | "manager" | "viewer" | null).
// The guard stamps the role on the request before any route runs, so a handler
// that calls roleOf(req) sees what the gate decided.
//
// Residual risk, by design of a plain-HTTP LAN tool: the token crosses the network
// in clear text. Use a VPN / Tailscale / an HTTPS reverse proxy on networks you do
// not trust (docs/onprem.md).

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Ascending privilege. */
export const ROLES = ["viewer", "manager", "owner"];
export const COOKIE_NAME = "ao_session";
export const TOKEN_PARAM = "ao_token";
const COOKIE_MAX_AGE_S = 30 * 24 * 3600;
const ROLE_KEY = "aoRole";
const TOKEN_ID_KEY = "aoTokenId";
const WEBHOOK_MAX_BYTES = 64 * 1024;

/** Routes that act on the HOST machine's desktop; remote managers do not get them. */
const OWNER_ONLY_PATHS = new Set(["/open", "/sessions/open-terminal"]);
/** Zalo's servers call this and cannot carry a token; zalo.js checks the sender itself. Only while Zalo is configured. */
const PUBLIC_POST_PATHS = new Set(["/zalo/webhook"]);
/** Headers a proxy or tunnel adds; their presence means the peer address is not the real client. */
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "forwarded", "x-real-ip", "cf-connecting-ip"];

export function roleAtLeast(role, min) {
  const have = ROLES.indexOf(role);
  return have !== -1 && have >= ROLES.indexOf(min);
}

export function agentOfficeHome(env = process.env) {
  return env.AGENT_OFFICE_HOME ?? path.join(os.homedir(), ".agent-office");
}

export function defaultAccessFile(env = process.env) {
  return path.join(agentOfficeHome(env), "access.json");
}

export function generateToken() {
  return `ao_${crypto.randomBytes(32).toString("base64url")}`;
}

export function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

const HEX64 = /^[0-9a-f]{64}$/;

function sanitize(raw) {
  const out = { version: 1, lan: false, tokens: [], unknown: [], corrupt: false };
  if (!raw || typeof raw !== "object") return out;
  out.lan = raw.lan === true;
  if (!Array.isArray(raw.tokens)) return out;
  for (const t of raw.tokens) {
    if (!t || typeof t !== "object") continue;
    if (!ROLES.includes(t.role) || typeof t.hash !== "string" || !HEX64.test(t.hash)) {
      out.unknown.push(t); // not usable here (newer format, hand edit): never authenticates, but is written back untouched
      continue;
    }
    out.tokens.push({
      id: String(t.id ?? ""),
      label: String(t.label ?? ""),
      role: t.role,
      hash: t.hash,
      createdAt: typeof t.createdAt === "string" ? t.createdAt : "",
    });
  }
  return out;
}

export class AccessStore {
  /** @param {{file?: string}} [opts] */
  constructor({ file = defaultAccessFile() } = {}) {
    this.file = file;
    this.cache = null; // { sig, data }
  }

  /** Re-read when the file changed: the CLI edits it while the daemon runs. */
  #load() {
    let sig;
    try {
      const st = fs.statSync(this.file);
      sig = `${st.mtimeMs}:${st.size}:${st.ino}`;
    } catch {
      this.cache = null;
      return sanitize(null);
    }
    if (this.cache?.sig === sig) return this.cache.data;
    let data;
    try {
      data = sanitize(JSON.parse(fs.readFileSync(this.file, "utf8")));
    } catch {
      data = { ...sanitize(null), corrupt: true }; // unreadable → fail closed: nobody remote gets in
    }
    this.cache = { sig, data };
    return data;
  }

  #save(data) {
    // never overwrite a file we could not read: that would silently drop every token in it
    if (data.corrupt) throw new Error(`${this.file} is unreadable; fix or move it aside first`);
    const { corrupt: _corrupt, unknown, ...clean } = data;
    data = { ...clean, tokens: [...clean.tokens, ...unknown] };
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, this.file);
    try {
      fs.chmodSync(this.file, 0o600);
    } catch {
      // Windows: ACLs, not mode bits
    }
    this.cache = null;
  }

  /** Entries in the file this version cannot use (kept untouched on every write). */
  skippedCount() {
    return this.#load().unknown.length;
  }

  lanEnabled() {
    return this.#load().lan;
  }

  setLan(on) {
    const data = this.#load();
    this.#save({ ...data, lan: Boolean(on) });
  }

  /** Public view of the tokens — never includes hashes. */
  list() {
    return this.#load().tokens.map(({ id, label, role, createdAt }) => ({ id, label, role, createdAt }));
  }

  /** @returns {{token: string, id: string, label: string, role: string}} plaintext token, shown once */
  addToken({ label, role }) {
    if (!ROLES.includes(role)) throw new Error(`role must be one of ${ROLES.join(", ")}`);
    const name = String(label ?? "").trim();
    if (!name) throw new Error("label is required");
    const token = generateToken();
    const entry = {
      id: crypto.randomBytes(4).toString("hex"),
      label: name,
      role,
      hash: hashToken(token),
      createdAt: new Date().toISOString(),
    };
    const data = this.#load();
    this.#save({ ...data, tokens: [...data.tokens, entry] });
    return { token, id: entry.id, label: entry.label, role };
  }

  /** Remove by id, or by label when no id matches. @returns {boolean} whether anything was removed */
  revoke(idOrLabel) {
    const data = this.#load();
    let keep = data.tokens.filter((t) => t.id !== idOrLabel);
    if (keep.length === data.tokens.length) keep = data.tokens.filter((t) => t.label !== idOrLabel);
    if (keep.length === data.tokens.length) return false;
    this.#save({ ...data, tokens: keep });
    return true;
  }

  /** Is a token with this id still valid? (used to drop live sockets after a revoke) */
  hasId(id) {
    return this.#load().tokens.some((t) => t.id === id);
  }

  /** @returns {{id: string, label: string, role: string} | null} */
  verify(token) {
    if (typeof token !== "string" || token.length < 8 || token.length > 256) return null;
    const probe = Buffer.from(hashToken(token), "hex");
    let found = null;
    for (const t of this.#load().tokens) {
      // no early exit: every comparison is constant-time and the loop length is the token count
      if (crypto.timingSafeEqual(probe, Buffer.from(t.hash, "hex")) && !found) found = t;
    }
    return found ? { id: found.id, label: found.label, role: found.role } : null;
  }
}

/** DAEMON_WS_HOST wins; otherwise LAN mode binds every interface, else loopback only. */
export function resolveBindHost(store, env = process.env) {
  return env.DAEMON_WS_HOST ?? (store.lanEnabled() ? "0.0.0.0" : "127.0.0.1");
}

// ---------------------------------------------------------------------------

/**
 * True only for a request from this machine itself. A tunnel or reverse proxy
 * running here connects from 127.0.0.1 on behalf of the whole internet, so the
 * headers they add disqualify the request.
 */
export function isLoopbackRequest(req) {
  const addr = req.socket?.remoteAddress;
  if (!addr) return false;
  if (PROXY_HEADERS.some((h) => req.headers?.[h] !== undefined)) return false;
  if (!(addr === "::1" || addr.startsWith("127.") || addr.startsWith("::ffff:127."))) return false;
  // DNS rebinding: a hostile name that resolves to 127.0.0.1 arrives from loopback but keeps
  // ITS name in Host (and the origin guard lets Origin == Host through). Only a loopback name
  // in Host is the person at this machine; anything else must bring a token like a LAN caller.
  const host = String(req.headers?.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  // 0.0.0.0 is what the daemon prints in LAN mode; an IP literal cannot be rebound. *.localhost is
  // deliberately NOT accepted: a browser that asks the system resolver for it can be rebound.
  return host === "" || host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0";
}

/** True when the guard verified an access token on this request (a LAN or tunnel caller, not loopback). */
export function hasVerifiedToken(req) {
  return Boolean(req?.[TOKEN_ID_KEY]);
}

/** "owner" | "manager" | "viewer" | null. Reads what the guard decided; safe default without a guard. */
export function roleOf(req) {
  if (req[ROLE_KEY] !== undefined) return req[ROLE_KEY];
  return isLoopbackRequest(req) ? "owner" : null;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function extractToken(req) {
  const auth = req.headers?.authorization;
  if (typeof auth === "string" && /^Bearer\s+/i.test(auth)) return auth.replace(/^Bearer\s+/i, "").trim();
  const header = req.headers?.["x-ao-token"];
  if (typeof header === "string" && header) return header.trim();
  return parseCookies(req.headers?.cookie)[COOKIE_NAME] ?? null;
}

const WRITE_FREE = new Set(["GET", "HEAD", "OPTIONS"]);

const DENIED_PAGE =
  '<!doctype html><meta charset="utf-8"><title>Agent Office</title>' +
  "<body style=\"font:16px system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem\">" +
  "<h1>Access link required</h1><p>This Agent Office is shared on a private network. " +
  "Ask the owner for your access link and open it in this browser.</p>";

/**
 * Guard for the daemon's single HTTP+WS chokepoint; same shape as origin-guard.js
 * so the two compose with combineGuards().
 * @param {{store: AccessStore, isLoopback?: (req) => boolean}} opts
 * @returns {{http: (req, res) => boolean, ws: (info) => boolean}}
 */
export function createAccessGuard({
  store,
  isLoopback = isLoopbackRequest,
  // the webhook is only a public door while the Zalo bridge is actually configured; index.js
  // passes the live channel state (L5's zalo-channel.js: token + app id + OA secret, signed)
  publicWebhookEnabled = () => Boolean(process.env.ZALO_OA_TOKEN && process.env.ZALO_APP_ID && process.env.ZALO_OA_SECRET),
}) {
  const resolve = (req) => {
    if (isLoopback(req)) return "owner";
    const entry = store.verify(extractToken(req));
    req[TOKEN_ID_KEY] = entry?.id;
    return entry?.role ?? null;
  };

  const reject = (req, res, status, message) => {
    const wantsHtml = status === 401 && req.method === "GET" && String(req.headers?.accept ?? "").includes("text/html");
    if (wantsHtml) {
      res.writeHead(401, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(DENIED_PAGE);
    } else {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: message }));
    }
    return false;
  };

  const http = (req, res) => {
    const method = req.method ?? "GET";
    // Parse exactly as the router does (ws-server: new URL(req.url, …).pathname) so
    // "/x/../open", "/./open" and "/%2e%2e/open" are judged as the route they reach.
    let parsed;
    try {
      parsed = new URL(String(req.url ?? "/"), "http://localhost");
      // the router parses with the Host header as base and THROWS on a bad one; an
      // unhandled throw there kills the whole daemon, so refuse such requests here
      new URL(String(req.url ?? "/"), `http://${req.headers?.host ?? "localhost"}`);
    } catch {
      return reject(req, res, 400, "bad request");
    }
    const rawPath = parsed.pathname;
    const params = parsed.searchParams;

    // One-time link: GET only (a token in a POST URL would just end up in logs).
    if (params.has(TOKEN_PARAM) && (method === "GET" || method === "HEAD")) {
      const linkToken = params.get(TOKEN_PARAM);
      if (!store.verify(linkToken)) return reject(req, res, 401, "invalid or revoked access link");
      params.delete(TOKEN_PARAM);
      const rest = params.toString();
      // collapse leading slashes: "//host" would be a redirect off-site
      const location = `/${rawPath.replace(/^\/+/, "")}${rest ? `?${rest}` : ""}`;
      const secure = req.socket?.encrypted || req.headers?.["x-forwarded-proto"] === "https";
      // 200 + client-side redirect, not a 302: a click that comes from another site
      // (webmail, a chat web app) is cross-site, so a SameSite=Strict cookie is not sent
      // on the redirected request. The page then navigates same-site and the cookie is.
      const target = JSON.stringify(location).replace(/</g, "\\u003c");
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "set-cookie": `${COOKIE_NAME}=${linkToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE_S}${secure ? "; Secure" : ""}`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      res.end(
        `<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>Agent Office</title>` +
          `<noscript><meta http-equiv="refresh" content="0;url=${location.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></noscript>` +
          `<script>location.replace(${target})</script><p>Signing you in…</p>`,
      );
      return false;
    }

    const role = resolve(req);
    req[ROLE_KEY] = role;
    if (!role) {
      if (method === "POST" && PUBLIC_POST_PATHS.has(rawPath) && publicWebhookEnabled()) {
        // unauthenticated door: cap what it will buffer (zalo.js reads the whole body)
        let seen = 0;
        req.on("data", (chunk) => {
          seen += chunk.length;
          if (seen > WEBHOOK_MAX_BYTES) req.destroy();
        });
        return true;
      }
      return reject(req, res, 401, "unauthorized: access token required");
    }
    if (role === "viewer") {
      if (!WRITE_FREE.has(method)) return reject(req, res, 403, "viewer access is read-only");
      if (rawPath === "/harnesses" && params.has("probe")) return reject(req, res, 403, "viewer access is read-only");
    }
    if (OWNER_ONLY_PATHS.has(rawPath) && role !== "owner" && method !== "OPTIONS") {
      return reject(req, res, 403, "owner access required");
    }
    return true;
  };

  const ws = (info) => {
    const role = resolve(info.req);
    info.req[ROLE_KEY] = role;
    return role !== null;
  };

  return { http, ws };
}

/** All guards must pass, in order; the first refusal has already answered the request. */
export function combineGuards(...guards) {
  return {
    http: (req, res) => guards.every((g) => g.http(req, res)),
    ws: (info) => guards.every((g) => g.ws(info)),
  };
}

/**
 * Close live WebSockets whose token has been revoked. The upgrade is checked once, so
 * without this a revoked viewer would keep receiving the stream until it disconnects.
 * @returns {() => void} stop
 */
export function watchRevocations({ store, wss, intervalMs = 3000 }) {
  const tokenIds = new WeakMap();
  wss.on("connection", (socket, req) => {
    if (req[TOKEN_ID_KEY] !== undefined) tokenIds.set(socket, req[TOKEN_ID_KEY]);
  });
  const timer = setInterval(() => {
    for (const socket of wss.clients) {
      const id = tokenIds.get(socket);
      if (id !== undefined && !store.hasId(id)) socket.close(4401, "access revoked");
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
