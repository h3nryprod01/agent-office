// The daemon binds 127.0.0.1, but any web page the user opens can still fetch it
// and open a WebSocket to it. CORS only governs whether JS may *read* a response
// — a simple GET like /harnesses?probe= still reaches the daemon and runs its
// side effect (spawns `claude -p`, spends a token); POST /templates/apply still
// overwrites the roster. So decide on the Origin header BEFORE processing:
//
//   - No Origin        → allow. curl, a top-level navigation, and same-origin
//                        simple GETs send none.
//   - Origin == self   → allow. The served app (http://<host>) fetching itself.
//   - Loopback origin  → allow ONLY in dev (AGENT_OFFICE_DEV=1), so Vite on
//                        another localhost port can reach the daemon. A remote
//                        site's Origin is never loopback.
//   - anything else    → reject 403.
//
// This is the request-level defense. The per-route CORS `*` headers stay: in dev
// they let the (now allowed) Vite origin read the response; in prod the app is
// same-origin so they're ignored. A rejected origin never reaches a handler.

/**
 * The threat is a REMOTE web page (evil.com) whose JS fetches/opens a WS to the
 * daemon — the browser sets its Origin to the remote site and JS cannot forge a
 * loopback Origin. So any loopback origin is the user's own machine (their Vite
 * dev server on :5199, the served app on :8787, a local tool) and is allowed;
 * only a real remote Origin is refused. This keeps the single-user desktop dev
 * loop working without a flag while still blocking the actual CSRF vector.
 *
 * @param {string|undefined} origin  the request's Origin header
 * @param {{host?: string}} opts  host = the daemon's own host:port (kept for API symmetry)
 * @returns {boolean} true if the request may proceed
 */
export function isAllowedOrigin(origin, { host } = {}) {
  if (!origin) return true; // curl, top-level navigation, same-origin simple GET
  if (host && (origin === `http://${host}` || origin === `https://${host}`)) return true;
  let hostname;
  try {
    ({ hostname } = new URL(origin));
  } catch {
    return false; // an unparseable Origin is not something we trust
  }
  const h = hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets: [::1] → ::1
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

/**
 * Build the guard used at the daemon's single HTTP+WS chokepoint.
 * @returns {{http: (req, res) => boolean, ws: (info) => boolean}}
 *   http: true if allowed; writes 403 and returns false otherwise.
 *   ws:   verifyClient predicate (info = {origin, req}) for the WS upgrade.
 */
export function createOriginGuard() {
  const http = (req, res) => {
    if (isAllowedOrigin(req.headers.origin, { host: req.headers.host })) return true;
    res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    res.end("403 forbidden origin");
    return false;
  };
  const ws = (info) => isAllowedOrigin(info.origin, { host: info.req?.headers?.host });
  return { http, ws };
}
