import test from "node:test";
import assert from "node:assert/strict";
import { isAllowedOrigin, createOriginGuard } from "../src/origin-guard.js";

const HOST = "127.0.0.1:8787";

test("isAllowedOrigin: no Origin, self, and any loopback pass; a remote site never does", () => {
  // curl / top-level nav / same-origin simple GET send no Origin
  assert.equal(isAllowedOrigin(undefined, { host: HOST }), true);
  assert.equal(isAllowedOrigin("", { host: HOST }), true);

  // the served app fetching itself
  assert.equal(isAllowedOrigin("http://127.0.0.1:8787", { host: HOST }), true);

  // any loopback origin is the user's own machine — allowed unconditionally.
  // The Vite dev server (:5199) is the case that made this necessary.
  assert.equal(isAllowedOrigin("http://localhost:5199", { host: HOST }), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:5199", { host: HOST }), true);
  assert.equal(isAllowedOrigin("http://[::1]:9000", { host: HOST }), true);

  // a remote website — the whole point — is refused
  assert.equal(isAllowedOrigin("https://evil.com", { host: HOST }), false);

  // an origin that looks loopback-ish but isn't (subdomain trick) is refused
  assert.equal(isAllowedOrigin("http://127.0.0.1.evil.com", { host: HOST }), false);
  assert.equal(isAllowedOrigin("http://localhost.evil.com", { host: HOST }), false);

  // garbage Origin → not trusted
  assert.equal(isAllowedOrigin("not-a-url", { host: HOST }), false);
});

test("createOriginGuard.http: allowed → true (no write); rejected → 403 + false", () => {
  const guard = createOriginGuard();

  const okRes = fakeRes();
  assert.equal(guard.http({ headers: { host: HOST } }, okRes), true); // no Origin
  assert.equal(okRes.status, undefined); // nothing written

  const badRes = fakeRes();
  assert.equal(guard.http({ headers: { host: HOST, origin: "https://evil.com" } }, badRes), false);
  assert.equal(badRes.status, 403);
});

test("createOriginGuard.ws: verifyClient allows loopback + no-Origin, refuses remote", () => {
  const guard = createOriginGuard();
  assert.equal(guard.ws({ origin: "http://localhost:5199", req: { headers: { host: HOST } } }), true);
  assert.equal(guard.ws({ origin: undefined, req: { headers: { host: HOST } } }), true);
  assert.equal(guard.ws({ origin: "https://evil.com", req: { headers: { host: HOST } } }), false);
});

function fakeRes() {
  return {
    status: undefined,
    writeHead(status) {
      this.status = status;
    },
    end() {},
  };
}
