// lane L2: HTTP for the policy panel.
//   GET  /policy                 every project's policy (+ the repo name the office tabs use)
//   GET  /policy?project=<slug>  one project
//   POST /policy {project, policy}   replace a project's policy
//   GET  /policy/audit[?project=<slug>][&limit=N]   automatic decisions, newest first
// Same extraHttp contract as the other routes: return true once handled.

import { deriveRepo } from "./event-schema.js";
import { PROJECT_SLUG_RE } from "./projects.js";
import { normalizePolicy, requiredRole, validatePolicy } from "./policy.js";

// No wildcard CORS here (unlike the older routes): the app calls these same-origin, and the
// policy can hand out `auto`, so no foreign page should ever be able to read or drive them.
const CORS_HEADERS = {};
const ROUTES = ["/policy", "/policy/audit"];
const STATUS_BY_CODE = { INVALID: 400, NOT_FOUND: 404 };
const BODY_MAX = 8192;
const RANK = { viewer: 1, manager: 2, owner: 3 };

/**
 * L1 JOIN POINT. Until L1's `roleOf(req)` (access.json) is wired in, the only
 * caller we can vouch for is a direct loopback connection: that is the person
 * sitting at this machine, i.e. the owner. Anything else — another host, or a
 * request that arrived through a proxy (x-forwarded-for) — has no role and is
 * refused. The coordinator replaces this default with the real `roleOf` via
 * `createPolicyHttpHandler({ roleOf })` in index.js.
 */
export function loopbackRole(req) {
  const addr = req?.socket?.remoteAddress ?? "";
  const direct = addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
  const proxied = req?.headers?.["x-forwarded-for"] || req?.headers?.forwarded;
  // DNS rebinding: a hostile name that resolves to 127.0.0.1 still arrives with ITS name in Host.
  const host = String(req?.headers?.host ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  const loopbackHost = host === "" || host === "localhost" || host === "127.0.0.1" || host === "::1";
  return direct && !proxied && loopbackHost ? "owner" : null;
}

const summary = (p) => ({
  slug: p.slug,
  name: p.name,
  cwd: p.cwd,
  repo: deriveRepo(p.cwd),
  hasPolicy: p.hasPolicy,
  policy: p.policy,
});

/**
 * @param {Object} opts
 * @param {import("./policy-store.js").PolicyStore} opts.store
 * @param {(req: import("node:http").IncomingMessage) => ("owner"|"manager"|"viewer"|null)} [opts.roleOf]
 */
export function createPolicyHttpHandler({ store, roleOf = loopbackRole }) {
  return (req, res, url) => {
    if (!ROUTES.includes(url.pathname)) return false;

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS); // no allow-* headers: a cross-origin preflight fails
      res.end();
      return true;
    }
    const respond = (statusCode, payload) => {
      res.writeHead(statusCode, { ...CORS_HEADERS, "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    const guard = (fn) => {
      try {
        fn();
      } catch (error) {
        const status = STATUS_BY_CODE[error.code];
        if (status) return respond(status, { error: error.message });
        console.error("[policy] error:", error);
        respond(500, { error: "server error" });
      }
    };

    const role = roleOf(req);
    if (!role || !RANK[role]) {
      respond(403, { error: "no access" });
      return true;
    }

    if (req.method === "GET") {
      const slug = url.searchParams.get("project");
      guard(() => {
        if (url.pathname === "/policy/audit") {
          const limit = Math.min(Math.max(Number(url.searchParams.get("limit")) || 100, 1), 500);
          if (slug) {
            store.getPolicy(slug); // 404/400 for an unknown or malformed slug
            return respond(200, { items: store.readAudit(slug, limit) });
          }
          const merged = store
            .projects()
            .flatMap((p) => store.readAudit(p.slug, limit))
            .sort((a, b) => b.ts - a.ts)
            .slice(0, limit);
          return respond(200, { items: merged });
        }
        if (slug) return respond(200, summary(store.getPolicy(slug)));
        respond(200, { projects: store.projects().map(summary) });
      });
      return true;
    }

    if (req.method !== "POST" || url.pathname !== "/policy") {
      respond(405, { error: "method not allowed" });
      return true;
    }

    // a JSON content type forces a CORS preflight on any cross-origin page, which the missing allow-* headers fail
    if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
      respond(415, { error: "content-type must be application/json" });
      return true;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > BODY_MAX) req.destroy();
    });
    req.on("end", () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        // falls through to the 400 below
      }
      guard(() => {
        const slug = parsed?.project;
        if (typeof slug !== "string" || !PROJECT_SLUG_RE.test(slug)) {
          const err = new Error("missing or invalid project");
          err.code = "INVALID";
          throw err;
        }
        const next = validatePolicy(parsed.policy); // 400 before any permission talk
        const current = store.getPolicy(slug); // 404 for an unknown project
        const needs = requiredRole(current.policy, next);
        if (RANK[role] < RANK[needs]) {
          return respond(403, { error: `changing this needs the ${needs} role (you are ${role})` });
        }
        respond(200, { slug, policy: store.setPolicy(slug, normalizePolicy(next)) });
      });
    });
    return true;
  };
}
