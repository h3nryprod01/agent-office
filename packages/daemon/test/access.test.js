// lane L1: LAN access control. Loopback keeps the old no-auth behaviour; everything
// else needs a token, and a viewer token can never write. The denial paths get as
// much coverage as the happy paths.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import WebSocket from "ws";
import {
  ROLES,
  roleAtLeast,
  roleOf,
  generateToken,
  hashToken,
  AccessStore,
  createAccessGuard,
  combineGuards,
  resolveBindHost,
  isLoopbackRequest,
  watchRevocations,
} from "../src/access.js";
import { createOriginGuard } from "../src/origin-guard.js";
import { EventBroadcastServer } from "../src/ws-server.js";

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-access-"));
  return path.join(dir, "access.json");
}

function fakeReq({ method = "GET", url = "/", headers = {}, remote = "192.0.2.50" } = {}) {
  const listeners = {};
  return {
    method,
    url,
    headers: { host: "192.0.2.10:8787", ...headers },
    socket: { remoteAddress: remote },
    on: (event, fn) => (listeners[event] = fn),
    emitData: (chunk) => listeners.data?.(chunk),
    destroyed: false,
    destroy() {
      this.destroyed = true;
    },
  };
}

function fakeRes() {
  const res = {
    status: undefined,
    headers: {},
    body: "",
    writeHead(status, headers = {}) {
      this.status = status;
      Object.assign(this.headers, Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])));
    },
    end(body = "") {
      this.body += body;
    },
  };
  return res;
}

function setup(roleByName = {}, guardOpts = {}) {
  const store = new AccessStore({ file: tmpFile() });
  const tokens = {};
  for (const [name, role] of Object.entries(roleByName)) tokens[name] = store.addToken({ label: name, role }).token;
  return { store, tokens, guard: createAccessGuard({ store, publicWebhookEnabled: () => false, ...guardOpts }) };
}

// ---- tokens & store ------------------------------------------------------

test("roles are ordered viewer < manager < owner", () => {
  assert.deepEqual(ROLES, ["viewer", "manager", "owner"]);
  assert.equal(roleAtLeast("owner", "manager"), true);
  assert.equal(roleAtLeast("viewer", "manager"), false);
  assert.equal(roleAtLeast(null, "viewer"), false);
});

test("generateToken: ao_ prefix, 256 bits, unique; hashToken is stable and not the token", () => {
  const a = generateToken();
  const b = generateToken();
  assert.match(a, /^ao_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  assert.equal(hashToken(a), hashToken(a));
  assert.ok(!hashToken(a).includes(a.slice(3, 20)));
});

test("store: addToken returns the plaintext once; the file keeps only a hash", () => {
  const file = tmpFile();
  const store = new AccessStore({ file });
  const { token, id } = store.addToken({ label: "Mai", role: "viewer" });
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(!raw.includes(token), "plaintext token must not be stored");
  assert.deepEqual(
    store.list().map((t) => ({ id: t.id, label: t.label, role: t.role })),
    [{ id, label: "Mai", role: "viewer" }],
  );
  assert.ok(!JSON.stringify(store.list()).includes("hash"), "list() must not expose hashes");
  assert.equal(store.verify(token).role, "viewer");
  assert.equal(store.verify(`${token}x`), null);
  assert.equal(store.verify(""), null);
  assert.equal(store.verify(undefined), null);
});

test("store: access.json is written 0600 inside a 0700 directory (POSIX)", { skip: process.platform === "win32" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-access-perm-"));
  const file = path.join(dir, "home", "access.json");
  const store = new AccessStore({ file });
  store.addToken({ label: "o", role: "owner" });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  store.addToken({ label: "p", role: "viewer" }); // a rewrite keeps the mode
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("store: revoke by id or label kills the token immediately; unknown → false", () => {
  const { store, tokens } = setup({ mai: "viewer", an: "manager" });
  assert.equal(store.revoke("mai"), true);
  assert.equal(store.verify(tokens.mai), null);
  assert.equal(store.verify(tokens.an).role, "manager");
  assert.equal(store.revoke("nobody"), false);
});

test("store: rejects an unknown role and an empty label", () => {
  const store = new AccessStore({ file: tmpFile() });
  assert.throws(() => store.addToken({ label: "x", role: "admin" }), /role/);
  assert.throws(() => store.addToken({ label: "  ", role: "viewer" }), /label/);
});

test("store: a corrupt or hostile file fails closed (no tokens), never throws", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{not json");
  const store = new AccessStore({ file });
  assert.equal(store.verify("anything"), null);
  assert.deepEqual(store.list(), []);
  assert.equal(store.lanEnabled(), false);
  fs.writeFileSync(file, JSON.stringify({ version: 1, tokens: [{ id: "a", label: "x", role: "god", hash: "00" }, "junk", null] }));
  const store2 = new AccessStore({ file });
  assert.deepEqual(store2.list(), [], "entries with an invalid role are dropped");
});

test("store: a file with some unreadable entries keeps the good tokens working but is never rewritten", () => {
  const file = tmpFile();
  const good = new AccessStore({ file });
  const { token } = good.addToken({ label: "good", role: "viewer" });
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.tokens.push({ id: "x", label: "from-the-future", role: "superuser", hash: "A".repeat(64) });
  fs.writeFileSync(file, JSON.stringify(raw));
  const store = new AccessStore({ file });
  assert.equal(store.verify(token).role, "viewer");
  assert.throws(() => store.addToken({ label: "y", role: "viewer" }), /cannot read/);
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).tokens.length, 2, "nothing was dropped");
});

test("store: edits made by another process (the CLI) are picked up without a restart", () => {
  const file = tmpFile();
  const daemonSide = new AccessStore({ file });
  assert.equal(daemonSide.verify("x"), null);
  const cliSide = new AccessStore({ file });
  const { token } = cliSide.addToken({ label: "late", role: "manager" });
  assert.equal(daemonSide.verify(token).role, "manager");
  cliSide.revoke("late");
  assert.equal(daemonSide.verify(token), null);
});

test("store: LAN flag persists; resolveBindHost follows it unless DAEMON_WS_HOST is set", () => {
  const file = tmpFile();
  const store = new AccessStore({ file });
  assert.equal(resolveBindHost(store, {}), "127.0.0.1");
  store.setLan(true);
  assert.equal(new AccessStore({ file }).lanEnabled(), true);
  assert.equal(resolveBindHost(new AccessStore({ file }), {}), "0.0.0.0");
  assert.equal(resolveBindHost(new AccessStore({ file }), { DAEMON_WS_HOST: "127.0.0.1" }), "127.0.0.1");
  store.setLan(false);
  assert.equal(resolveBindHost(new AccessStore({ file }), {}), "127.0.0.1");
});

// ---- loopback ------------------------------------------------------------

test("isLoopbackRequest: 127/8, ::1, v4-mapped; a proxy header means it is NOT the local user", () => {
  for (const remote of ["127.0.0.1", "127.1.2.3", "::1", "::ffff:127.0.0.1"]) {
    assert.equal(isLoopbackRequest(fakeReq({ remote })), true, remote);
  }
  for (const remote of ["192.0.2.50", "::ffff:192.0.2.50", "2001:db8::1", undefined]) {
    assert.equal(isLoopbackRequest(fakeReq({ remote })), false, String(remote));
  }
  // a tunnel / reverse proxy running on this machine makes remote traffic arrive from 127.0.0.1
  for (const h of ["x-forwarded-for", "forwarded", "x-real-ip", "cf-connecting-ip", "x-forwarded-host"]) {
    assert.equal(isLoopbackRequest(fakeReq({ remote: "127.0.0.1", headers: { [h]: "198.51.100.7" } })), false, h);
  }
});

test("loopback keeps the old behaviour: no token, full owner, even for writes", () => {
  const { guard } = setup();
  const req = fakeReq({ method: "POST", url: "/templates/apply", remote: "127.0.0.1" });
  const res = fakeRes();
  assert.equal(guard.http(req, res), true);
  assert.equal(res.status, undefined);
  assert.equal(roleOf(req), "owner");
});

// ---- remote, http --------------------------------------------------------

test("remote without a token → 401, handler never runs, roleOf is null", () => {
  const { guard } = setup({ o: "owner" });
  const req = fakeReq({ url: "/work-items" });
  const res = fakeRes();
  assert.equal(guard.http(req, res), false);
  assert.equal(res.status, 401);
  assert.equal(roleOf(req), null);
  assert.match(res.body, /unauthorized/i);
});

test("remote with a wrong token → 401 on every channel", () => {
  const { guard } = setup({ o: "owner" });
  const bad = generateToken();
  for (const headers of [
    { authorization: `Bearer ${bad}` },
    { "x-ao-token": bad },
    { cookie: `ao_session=${bad}` },
  ]) {
    const res = fakeRes();
    assert.equal(guard.http(fakeReq({ headers }), res), false);
    assert.equal(res.status, 401);
  }
});

test("remote with a valid token via Bearer, x-ao-token or cookie → allowed with that role", () => {
  const { guard, tokens } = setup({ m: "manager" });
  for (const headers of [
    { authorization: `Bearer ${tokens.m}` },
    { "x-ao-token": tokens.m },
    { cookie: `theme=dark; ao_session=${tokens.m}; other=1` },
  ]) {
    const req = fakeReq({ headers });
    const res = fakeRes();
    assert.equal(guard.http(req, res), true);
    assert.equal(res.status, undefined);
    assert.equal(roleOf(req), "manager");
  }
});

test("browser navigation without a token gets a readable 401 page, not JSON", () => {
  const { guard } = setup();
  const res = fakeRes();
  guard.http(fakeReq({ url: "/", headers: { accept: "text/html,application/xhtml+xml" } }), res);
  assert.equal(res.status, 401);
  assert.match(res.headers["content-type"], /text\/html/);
  assert.match(res.body, /access link/i);
});

test("one-time link: sets an HttpOnly SameSite=Strict cookie and navigates to the URL without the token", () => {
  const { guard, tokens } = setup({ v: "viewer" });
  const res = fakeRes();
  const req = fakeReq({ url: `/?tab=costs&ao_token=${tokens.v}` });
  assert.equal(guard.http(req, res), false, "the request is answered here, not passed on");
  // 200 + client redirect, not 302: a cross-site click would not send a Strict cookie on a redirect
  assert.equal(res.status, 200);
  assert.match(res.body, /location\.replace\("\/\?tab=costs"\)/);
  assert.ok(!res.body.includes(tokens.v), "the token must not be echoed into the page");
  const cookie = res.headers["set-cookie"];
  assert.match(cookie, new RegExp(`^ao_session=${tokens.v}`));
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Path=\//);
  assert.ok(!/Secure/.test(cookie), "plain http LAN: Secure would make the browser drop the cookie");
  assert.equal(res.headers["referrer-policy"], "no-referrer");
});

test("one-time link cannot be turned into an open redirect or script injection", () => {
  const { guard, tokens } = setup({ v: "viewer" });
  const res = fakeRes();
  guard.http(fakeReq({ url: `//evil.example/x?ao_token=${tokens.v}` }), res);
  assert.match(res.body, /location\.replace\("\/x"\)/, "stays on this origin");
  assert.ok(!res.body.includes("evil.example"));
  const xss = fakeRes();
  guard.http(fakeReq({ url: `/"</script><script>alert(1)</script>?ao_token=${tokens.v}` }), xss);
  assert.ok(!xss.body.includes("<script>alert(1)"), "path characters are escaped");
});

test("one-time link: Secure is added when the request came over https", () => {
  const { guard, tokens } = setup({ v: "viewer" });
  const res = fakeRes();
  guard.http(fakeReq({ url: `/?ao_token=${tokens.v}`, headers: { "x-forwarded-proto": "https" } }), res);
  assert.match(res.headers["set-cookie"], /Secure/);
});

test("one-time link with a bad token → 401, no cookie", () => {
  const { guard } = setup({ v: "viewer" });
  const res = fakeRes();
  assert.equal(guard.http(fakeReq({ url: `/?ao_token=${generateToken()}` }), res), false);
  assert.equal(res.status, 401);
  assert.equal(res.headers["set-cookie"], undefined);
});

test("a token in the URL is only honoured on GET navigation, never on a POST", () => {
  const { guard, tokens } = setup({ m: "manager" });
  const res = fakeRes();
  assert.equal(guard.http(fakeReq({ method: "POST", url: `/chat?ao_token=${tokens.m}` }), res), false);
  assert.equal(res.status, 401);
});

// ---- roles ---------------------------------------------------------------

test("viewer can read but every write method is 403", () => {
  const { guard, tokens } = setup({ v: "viewer" });
  const headers = { authorization: `Bearer ${tokens.v}` };
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    const res = fakeRes();
    assert.equal(guard.http(fakeReq({ method, url: "/costs", headers }), res), true, method);
  }
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const res = fakeRes();
    assert.equal(guard.http(fakeReq({ method, url: "/approval-response", headers }), res), false, method);
    assert.equal(res.status, 403, method);
  }
});

test("viewer cannot trigger the CLI probe (a GET that spends tokens); manager can", () => {
  const { guard, tokens } = setup({ v: "viewer", m: "manager" });
  const url = "/harnesses?probe=claude";
  const v = fakeRes();
  assert.equal(guard.http(fakeReq({ url, headers: { authorization: `Bearer ${tokens.v}` } }), v), false);
  assert.equal(v.status, 403);
  assert.equal(guard.http(fakeReq({ url: "/harnesses", headers: { authorization: `Bearer ${tokens.v}` } }), fakeRes()), true);
  assert.equal(guard.http(fakeReq({ url, headers: { authorization: `Bearer ${tokens.m}` } }), fakeRes()), true);
});

test("manager may write, but POST /open (acts on the host's desktop) is owner-only", () => {
  const { guard, tokens } = setup({ m: "manager", o: "owner" });
  const post = (url, token) =>
    guard.http(fakeReq({ method: "POST", url, headers: { authorization: `Bearer ${token}` } }), fakeRes());
  assert.equal(post("/chat", tokens.m), true);
  assert.equal(post("/approval-response", tokens.m), true);
  const res = fakeRes();
  assert.equal(guard.http(fakeReq({ method: "POST", url: "/open", headers: { authorization: `Bearer ${tokens.m}` } }), res), false);
  assert.equal(res.status, 403);
  assert.equal(post("/open", tokens.o), true);
});

test("paths are judged after normalisation, the way the router sees them (no ../ or encoded-dot bypass)", () => {
  const { guard, tokens } = setup({ v: "viewer", m: "manager" });
  const as = (token, method, url) =>
    guard.http(fakeReq({ method, url, headers: { authorization: `Bearer ${token}` } }), fakeRes());
  for (const url of ["/x/../open", "/./open", "/%2e/open", "/x/%2e%2e/open", "/x/%2E%2E/open"]) {
    assert.equal(as(tokens.m, "POST", url), false, `manager must not reach /open via ${url}`);
  }
  for (const url of ["/./harnesses?probe=claude", "/x/../harnesses?probe=claude", "/%2e/harnesses?probe=claude"]) {
    assert.equal(as(tokens.v, "GET", url), false, `viewer must not probe via ${url}`);
  }
  // and a token-less request cannot borrow the public webhook path to reach another route
  assert.equal(guard.http(fakeReq({ method: "POST", url: "/zalo/webhook/../chat" }), fakeRes()), false);
  assert.equal(guard.http(fakeReq({ method: "POST", url: "/zalo/webhook/../../chat" }), fakeRes()), false);
  // a malformed target is refused, not thrown on
  const res = fakeRes();
  assert.equal(guard.http(fakeReq({ url: "http://[bad" }), res), false);
  assert.equal(res.status, 400);
});

test("POST /zalo/webhook is public ONLY while Zalo is configured, and only for that exact path", () => {
  const off = setup({}, { publicWebhookEnabled: () => false }).guard;
  assert.equal(off.http(fakeReq({ method: "POST", url: "/zalo/webhook" }), fakeRes()), false, "Zalo not configured → needs a token");
  const { guard } = setup({}, { publicWebhookEnabled: () => true });
  assert.equal(guard.http(fakeReq({ method: "POST", url: "/zalo/webhook" }), fakeRes()), true);
  assert.equal(guard.http(fakeReq({ method: "GET", url: "/zalo/webhook" }), fakeRes()), false);
  assert.equal(guard.http(fakeReq({ method: "POST", url: "/zalo/webhook/../chat" }), fakeRes()), false);
});

test("the public webhook door caps how much a stranger can make the daemon buffer", () => {
  const { guard } = setup({}, { publicWebhookEnabled: () => true });
  const req = fakeReq({ method: "POST", url: "/zalo/webhook" });
  assert.equal(guard.http(req, fakeRes()), true);
  req.emitData(Buffer.alloc(40 * 1024));
  assert.equal(req.destroyed, false);
  req.emitData(Buffer.alloc(40 * 1024));
  assert.equal(req.destroyed, true);
});

test("a request whose Host header the router cannot parse is refused here instead of crashing the daemon", () => {
  const { guard, tokens } = setup({ v: "viewer" }, { publicWebhookEnabled: () => true });
  for (const host of ["", "a b", "a%", "[::1", "a:99999"]) {
    for (const [method, url] of [["POST", "/zalo/webhook"], ["GET", "/costs"]]) {
      const res = fakeRes();
      const req = fakeReq({ method, url, headers: { host, authorization: `Bearer ${tokens.v}` } });
      assert.equal(guard.http(req, res), false, `${JSON.stringify(host)} ${method}`);
      assert.equal(res.status, 400);
    }
  }
});

test("store: a corrupt access.json is never overwritten (that would silently drop every token)", () => {
  const file = tmpFile();
  fs.writeFileSync(file, "{broken");
  const store = new AccessStore({ file });
  assert.throws(() => store.addToken({ label: "x", role: "viewer" }), /unreadable/);
  assert.throws(() => store.setLan(true), /unreadable/);
  assert.equal(fs.readFileSync(file, "utf8"), "{broken");
});

test("watchRevocations closes a live socket once its token is revoked, leaves others alone", async () => {
  const { store, tokens } = setup({ gone: "viewer", kept: "viewer" });
  const guard = createAccessGuard({ store, isLoopback: () => false });
  const srv = new EventBroadcastServer({ port: 0, originGuard: guard });
  await srv.start();
  const stop = watchRevocations({ store, wss: srv.wss, intervalMs: 50 });
  const { port } = srv.server.address();
  try {
    const open = (token) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { authorization: `Bearer ${token}` } });
        ws.on("open", () => resolve(ws));
        ws.on("error", reject);
      });
    const gone = await open(tokens.gone);
    const kept = await open(tokens.kept);
    const closed = new Promise((resolve) => gone.on("close", (code) => resolve(code)));
    store.revoke("gone");
    assert.equal(await closed, 4401);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(kept.readyState, WebSocket.OPEN);
    kept.close();
  } finally {
    stop();
    await srv.stop();
  }
});

// ---- websocket ------------------------------------------------------------

test("ws verifyClient: loopback ok, remote needs a token, wrong token refused", () => {
  const { guard, tokens } = setup({ v: "viewer" });
  const info = (req) => ({ origin: undefined, req });
  assert.equal(guard.ws(info(fakeReq({ remote: "127.0.0.1" }))), true);
  assert.equal(guard.ws(info(fakeReq({}))), false);
  assert.equal(guard.ws(info(fakeReq({ headers: { cookie: `ao_session=${generateToken()}` } }))), false);
  const ok = fakeReq({ headers: { cookie: `ao_session=${tokens.v}` } });
  assert.equal(guard.ws(info(ok)), true);
  assert.equal(roleOf(ok), "viewer");
});

test("combineGuards: all must agree, in order (origin check first)", () => {
  const calls = [];
  const a = { http: () => (calls.push("a"), false), ws: () => (calls.push("a"), false) };
  const b = { http: () => (calls.push("b"), true), ws: () => (calls.push("b"), true) };
  const both = combineGuards(a, b);
  assert.equal(both.http({}, {}), false);
  assert.equal(both.ws({}), false);
  assert.deepEqual(calls, ["a", "a"], "second guard is not consulted once the first refuses");
  assert.equal(combineGuards(b, b).http({}, {}), true);
});

test("roleOf with no guard installed: loopback → owner, anything else → null (safe default)", () => {
  assert.equal(roleOf(fakeReq({ remote: "127.0.0.1" })), "owner");
  assert.equal(roleOf(fakeReq({})), null);
});

// ---- end to end through the real server ----------------------------------

async function withServer(fn) {
  const { store, tokens } = setup({ owner: "owner", viewer: "viewer" });
  const guard = combineGuards(
    createOriginGuard(),
    // every real connection here is loopback; pretend it is a LAN peer
    createAccessGuard({ store, isLoopback: () => false }),
  );
  const seen = [];
  const srv = new EventBroadcastServer({
    port: 0,
    originGuard: guard,
    extraHttp: (req, res, url) => {
      if (url.pathname === "/echo-role") {
        seen.push(roleOf(req));
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ role: roleOf(req), method: req.method }));
        return true;
      }
      return false;
    },
  });
  await srv.start();
  const { port } = srv.server.address();
  try {
    await fn({ base: `http://127.0.0.1:${port}`, port, tokens, srv, seen });
  } finally {
    await srv.stop();
  }
}

test("e2e http: no token 401 / bearer ok / viewer POST 403, and the origin guard still blocks a foreign Origin", async () => {
  await withServer(async ({ base, tokens }) => {
    assert.equal((await fetch(`${base}/transcript`)).status, 401);
    assert.equal((await fetch(`${base}/transcript`, { headers: { authorization: `Bearer ${tokens.viewer}` } })).status, 200);
    const echo = await fetch(`${base}/echo-role`, { headers: { authorization: `Bearer ${tokens.owner}` } });
    assert.deepEqual(await echo.json(), { role: "owner", method: "GET" });
    const post = await fetch(`${base}/echo-role`, { method: "POST", headers: { authorization: `Bearer ${tokens.viewer}` } });
    assert.equal(post.status, 403);
    // a valid token does not excuse a remote web page: the origin guard runs first
    const evil = await fetch(`${base}/transcript`, {
      headers: { authorization: `Bearer ${tokens.owner}`, origin: "https://evil.example" },
    });
    assert.equal(evil.status, 403);
  });
});

test("e2e ws: upgrade is refused without a token and accepted with a cookie", async () => {
  await withServer(async ({ port, tokens, srv }) => {
    const refused = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      ws.on("unexpected-response", (_req, res) => resolve(res.statusCode));
      ws.on("open", () => resolve("open"));
      ws.on("error", () => {});
    });
    assert.equal(refused, 401);

    srv.broadcast({ v: 1, id: "e1", type: "tool_call", sessionId: "s", ts: 1, detail: "hi" });
    const got = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { cookie: `ao_session=${tokens.viewer}` } });
      ws.on("message", (m) => {
        ws.close();
        resolve(JSON.parse(String(m)));
      });
      ws.on("error", reject);
    });
    assert.equal(got.id, "e1");
  });
});

test("e2e: an empty Host header gets 400 and the daemon keeps serving (it used to throw inside the router)", async () => {
  await withServer(async ({ port, base, tokens }) => {
    const raw = await new Promise((resolve) => {
      const c = net.connect(port, "127.0.0.1", () =>
        c.write(`GET /transcript HTTP/1.1\r\nHost:\r\nAuthorization: Bearer ${tokens.viewer}\r\nConnection: close\r\n\r\n`),
      );
      let out = "";
      c.on("data", (d) => (out += d));
      c.on("close", () => resolve(out));
    });
    assert.match(raw, /^HTTP\/1\.1 400/);
    assert.equal((await fetch(`${base}/transcript`, { headers: { authorization: `Bearer ${tokens.viewer}` } })).status, 200);
  });
});
