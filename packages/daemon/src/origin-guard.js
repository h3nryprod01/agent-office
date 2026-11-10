// The daemon binds 127.0.0.1, but any web page the user opens can still fetch it
// and open a WebSocket to it. CORS only governs whether JS may *read* a response,
// so the request itself still arrives. The guard decides on the Origin header
// BEFORE any route runs:
//
//   - No Origin        → allow. curl, a top-level navigation, an <img> tag and
//                        same-origin simple GETs send none.
//   - Origin == self   → allow. The served app (http://<host>) fetching itself.
//   - Loopback origin  → allow. Any loopback origin is the user's own machine (the
//                        Vite dev server on another port, a local tool); a remote
//                        site's Origin is never loopback.
//   - anything else    → reject 403.
//
// KNOWN GAP: "no Origin → allow" means a foreign page can still reach a GET route
// with an <img>/<link>/navigation, and CORS cannot stop it. So a GET route that has a
// side effect must also call isCrossSiteRequest() and refuse (the only one today is
// /harnesses?probe=, which spawns the harness CLI). Routes that only read are left
// alone: a foreign page cannot read the response. State-changing routes use POST,
// which a browser sends with an Origin (or as a preflighted request).
// A rejected origin never reaches a handler.

/**
 * Browsers that implement Fetch Metadata (all current ones) label every request with
 * Sec-Fetch-Site. "cross-site" / "same-site" means a page on another site caused it
 * (an <img>, a link click, a form). "same-origin" is the served app, "none" is the
 * address bar, a missing header is curl or a script. Only the first two are refused.
 * A very old browser without the header looks like curl and is not caught.
 *
 * @param {{headers?: Record<string, string|string[]|undefined>}} req
 * @returns {boolean} true if a page on another site triggered this request
 */
export function isCrossSiteRequest(req) {
  const site = req.headers?.["sec-fetch-site"];
  return site === "cross-site" || site === "same-site";
}

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
