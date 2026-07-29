import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { OutputsIndex, createOutputsHttpHandler } from "../src/outputs.js";

function makeFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "outputs-test-"));
  const repoRoot = path.join(root, "repo");
  const media = path.join(repoRoot, "docs", "media", "promo");
  mkdirSync(media, { recursive: true });
  writeFileSync(path.join(media, "video.mp4"), "fake-mp4-bytes");
  // sibling directory that merely shares a string prefix with the whitelisted
  // root ("docs/media" vs "docs/media-evil") — must NOT be treated as inside
  const evilSibling = path.join(repoRoot, "docs", "media-evil");
  mkdirSync(evilSibling, { recursive: true });
  writeFileSync(path.join(evilSibling, "secret.txt"), "nope");
  // a file genuinely outside any whitelist root, for the symlink-escape case
  const outside = path.join(root, "outside-secret.txt");
  writeFileSync(outside, "outside");
  return { root, repoRoot, media, evilSibling, outside };
}

function withServer(handler, run) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (!handler(req, res, url)) {
        res.writeHead(404);
        res.end();
      }
    });
    server.listen(0, "127.0.0.1", async () => {
      const { port } = server.address();
      try {
        await run(`http://127.0.0.1:${port}`);
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

test("list(): finds files under docs/media, sorted newest first, dotfiles excluded", async () => {
  const { root, repoRoot, media } = makeFixture();
  writeFileSync(path.join(media, "older.png"), "x");
  writeFileSync(path.join(media, ".DS_Store"), "junk");
  const index = new OutputsIndex({ repoRoot });
  const files = await index.list();
  const names = files.map((f) => f.name);
  assert.ok(names.includes("video.mp4"));
  assert.ok(names.includes("older.png"));
  const video = files.find((f) => f.name === "video.mp4");
  assert.equal(video.kind, "video");
  assert.equal(video.size, "fake-mp4-bytes".length);
  // "docs/media-evil" (string-prefix sibling) must never appear
  assert.ok(!names.includes("secret.txt"));
  // OS metadata cruft is not a real project output
  assert.ok(!names.includes(".DS_Store"));
  rmSync(root, { recursive: true, force: true });
});

test("list(): work-items pr/obsidianNote local paths become extra entries; URLs and non-paths are ignored", async () => {
  const { root, repoRoot, outside } = makeFixture();
  const workItemsPath = path.join(root, "work-items.json");
  writeFileSync(
    workItemsPath,
    JSON.stringify({
      version: 1,
      items: [
        { id: "a", pr: "https://github.com/x/y/pull/1", obsidianNote: null },
        { id: "b", pr: "17", obsidianNote: "ai-memory/some-note" },
        { id: "c", pr: outside, obsidianNote: null },
      ],
    }),
  );
  const index = new OutputsIndex({ repoRoot, workItemsPath });
  const files = await index.list();
  // list() reports the realpath (same canonicalization whitelistRoots() applies —
  // on macOS os.tmpdir() is under /var, which is itself a symlink to /private/var)
  assert.ok(files.some((f) => f.path === realpathSync(outside)));
  // makeFixture() already seeds docs/media/promo/video.mp4 — the URL, the bare
  // "17", and the vault-relative obsidianNote all fail the isAbsolute+exists
  // check and contribute nothing, so only these two entries show up.
  assert.equal(files.length, 2);
  rmSync(root, { recursive: true, force: true });
});

test("isAllowed(): inside root true, root itself true, string-prefix sibling false, unrelated path false", () => {
  const { root, repoRoot, media, evilSibling, outside } = makeFixture();
  const index = new OutputsIndex({ repoRoot });
  const mediaRoot = index.whitelistRoots()[0];
  // isAllowed()'s contract is "already realpath-resolved input" (POST /open
  // always resolves first) — realpathSync here to call it the same way.
  assert.equal(index.isAllowed(realpathSync(path.join(media, "video.mp4"))), true);
  assert.equal(index.isAllowed(mediaRoot), true);
  assert.equal(index.isAllowed(realpathSync(path.join(evilSibling, "secret.txt"))), false);
  assert.equal(index.isAllowed(realpathSync(outside)), false);
  rmSync(root, { recursive: true, force: true });
});

test("isAllowed(): symlink inside the whitelist pointing outside it resolves to the OUTSIDE realpath and is rejected", () => {
  const { root, repoRoot, media, outside } = makeFixture();
  const escapeLink = path.join(media, "escape.mp4");
  symlinkSync(outside, escapeLink);
  const index = new OutputsIndex({ repoRoot });
  // this is what POST /open does before calling isAllowed(): resolve first
  const real = realpathSync(escapeLink);
  assert.equal(real, realpathSync(outside));
  assert.equal(index.isAllowed(real), false);
  rmSync(root, { recursive: true, force: true });
});

test("POST /open: 400 missing path, 404 nonexistent, 403 outside whitelist, 200 + execFile for an allowed path", async () => {
  const { root, repoRoot, media } = makeFixture();
  const target = path.join(media, "video.mp4");
  const index = new OutputsIndex({ repoRoot });
  const calls = [];
  const handler = createOutputsHttpHandler(index, {
    execFileFn: (cmd, args, cb) => {
      calls.push({ cmd, args });
      cb(null);
    },
  });

  await withServer(handler, async (base) => {
    const missing = await fetch(`${base}/open`, { method: "POST", body: JSON.stringify({}) });
    assert.equal(missing.status, 400);

    const notFound = await fetch(`${base}/open`, {
      method: "POST",
      body: JSON.stringify({ path: path.join(root, "nope.mp4") }),
    });
    assert.equal(notFound.status, 404);

    const outsidePath = path.join(root, "outside-secret.txt");
    const forbidden = await fetch(`${base}/open`, {
      method: "POST",
      body: JSON.stringify({ path: outsidePath }),
    });
    assert.equal(forbidden.status, 403);
    assert.equal(calls.length, 0); // never shells out for a rejected path

    const ok = await fetch(`${base}/open`, {
      method: "POST",
      body: JSON.stringify({ path: target, reveal: true }),
    });
    assert.equal(ok.status, 200);
    assert.equal(calls.length, 1);
    // exact per-platform cmd/args (win32/darwin/linux) are covered by the
    // injected-platform tests below, not tied to whatever OS runs this suite.
  });

  rmSync(root, { recursive: true, force: true });
});

/** Runs POST /open?reveal=true through the real handler with an injected platform. */
async function openWithPlatform(platform) {
  const { root, repoRoot, media } = makeFixture();
  const target = path.join(media, "video.mp4");
  const real = realpathSync(target);
  const index = new OutputsIndex({ repoRoot });
  const calls = [];
  const handler = createOutputsHttpHandler(index, {
    platform,
    execFileFn: (cmd, args, cb) => {
      calls.push({ cmd, args });
      cb(null);
    },
  });
  await withServer(handler, async (base) => {
    const res = await fetch(`${base}/open`, {
      method: "POST",
      body: JSON.stringify({ path: target, reveal: true }),
    });
    assert.equal(res.status, 200);
  });
  rmSync(root, { recursive: true, force: true });
  return { calls, real };
}

test("POST /open: win32 → explorer /select,<real>", async () => {
  const { calls, real } = await openWithPlatform("win32");
  assert.equal(calls[0].cmd, "explorer");
  assert.deepEqual(calls[0].args, [`/select,${real}`]);
});

test("POST /open: darwin → open -R <real>", async () => {
  const { calls, real } = await openWithPlatform("darwin");
  assert.equal(calls[0].cmd, "open");
  assert.deepEqual(calls[0].args, ["-R", real]);
});

test("POST /open: linux → xdg-open <dirname(real)>", async () => {
  const { calls, real } = await openWithPlatform("linux");
  assert.equal(calls[0].cmd, "xdg-open");
  assert.deepEqual(calls[0].args, [path.dirname(real)]);
});

test("GET /outputs: 200 with files array", async () => {
  const { root, repoRoot } = makeFixture();
  const index = new OutputsIndex({ repoRoot });
  const handler = createOutputsHttpHandler(index);
  await withServer(handler, async (base) => {
    const res = await fetch(`${base}/outputs`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(Array.isArray(body.files));
    assert.ok(body.files.some((f) => f.name === "video.mp4"));
  });
  rmSync(root, { recursive: true, force: true });
});
