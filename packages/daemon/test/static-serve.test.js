import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { createStaticHttpHandler } from "../src/static-serve.js";

/** Build a temp distDir with an index + a hashed asset + an svg. */
function makeDist() {
  const root = mkdtempSync(path.join(os.tmpdir(), "static-serve-test-"));
  mkdirSync(path.join(root, "assets"), { recursive: true });
  writeFileSync(path.join(root, "index.html"), "<!doctype html><body>APP ROOT</body>");
  writeFileSync(path.join(root, "assets", "app.js"), 'console.log("app");');
  writeFileSync(path.join(root, "favicon.svg"), "<svg/>");
  return root;
}

/**
 * Drive the handler the same way ws-server's extraHttp does. res is a
 * PassThrough so createReadStream().pipe(res) works; collect status/headers/body.
 */
function call(handler, { method = "GET", raw = "/" } = {}) {
  return new Promise((resolve) => {
    const req = { method, url: raw };
    const res = new PassThrough();
    res.status = null;
    res.headers = {};
    res.headersSent = false;
    res.writeHead = (status, headers) => {
      res.status = status;
      res.headers = { ...res.headers, ...headers };
      res.headersSent = true;
    };
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () =>
      resolve({ handled: true, status: res.status, headers: res.headers, body: Buffer.concat(chunks).toString() })
    );
    const handled = handler(req, res, new URL(`http://x${raw}`));
    if (!handled) resolve({ handled: false });
  });
}

test("GET / → 200 text/html with index body", async () => {
  const dist = makeDist();
  const handler = createStaticHttpHandler({ distDir: dist });
  const r = await call(handler, { raw: "/" });
  assert.equal(r.handled, true);
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /^text\/html/);
  assert.equal(r.body, "<!doctype html><body>APP ROOT</body>");
  assert.equal(r.headers["cache-control"], "no-cache");
  rmSync(dist, { recursive: true, force: true });
});

test("GET /assets/app.js → 200 text/javascript", async () => {
  const dist = makeDist();
  const handler = createStaticHttpHandler({ distDir: dist });
  const r = await call(handler, { raw: "/assets/app.js" });
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /^text\/javascript/);
  assert.equal(r.body, 'console.log("app");');
  assert.equal(r.headers["cache-control"], "public, max-age=3600");
  rmSync(dist, { recursive: true, force: true });
});

test("GET /khong-ton-tai → 200 SPA fallback to index.html", async () => {
  const dist = makeDist();
  const handler = createStaticHttpHandler({ distDir: dist });
  const r = await call(handler, { raw: "/khong-ton-tai" });
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /^text\/html/);
  assert.equal(r.body, "<!doctype html><body>APP ROOT</body>");
  rmSync(dist, { recursive: true, force: true });
});

test("traversal attempts → 403, never reads outside distDir", async () => {
  const dist = makeDist();
  const handler = createStaticHttpHandler({ distDir: dist });
  for (const raw of [
    "/../../etc/passwd", // literal dot-dot
    "/%2e%2e/%2e%2e/etc/passwd", // encoded dots
    "/..%2f..%2fetc/passwd", // encoded slash (survives URL parse)
    "/%2e%2e/", // encoded dot at root
  ]) {
    const r = await call(handler, { raw });
    assert.equal(r.handled, true, `${raw} should be handled`);
    assert.equal(r.status, 403, `${raw} → 403`);
    assert.equal(r.body, "403 forbidden");
  }
  rmSync(dist, { recursive: true, force: true });
});

test("POST / → not handled (don't swallow API POST routes)", async () => {
  const dist = makeDist();
  const handler = createStaticHttpHandler({ distDir: dist });
  const r = await call(handler, { method: "POST", raw: "/" });
  assert.equal(r.handled, false);
  rmSync(dist, { recursive: true, force: true });
});

test("devMode:true → every request yields false", async () => {
  const dist = makeDist();
  const handler = createStaticHttpHandler({ distDir: dist, devMode: true });
  assert.equal((await call(handler, { raw: "/" })).handled, false);
  assert.equal((await call(handler, { raw: "/assets/app.js" })).handled, false);
  rmSync(dist, { recursive: true, force: true });
});

test("distDir missing → false (no build yet, fall through to 404)", async () => {
  const handler = createStaticHttpHandler({ distDir: path.join(os.tmpdir(), "does-not-exist-xyz") });
  assert.equal((await call(handler, { raw: "/" })).handled, false);
});

test("HEAD / → 200, headers set, empty body", async () => {
  const dist = makeDist();
  const handler = createStaticHttpHandler({ distDir: dist });
  const r = await call(handler, { method: "HEAD", raw: "/" });
  assert.equal(r.status, 200);
  assert.match(r.headers["content-type"], /^text\/html/);
  assert.equal(Number(r.headers["content-length"]), "<!doctype html><body>APP ROOT</body>".length);
  assert.equal(r.body, "");
  rmSync(dist, { recursive: true, force: true });
});
