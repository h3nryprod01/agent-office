// POST /reveal: a folder is opened, a file is only revealed; paths come from what the daemon saw.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRevealHandler, resolveTarget } from "../src/reveal.js";

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ao-reveal-")));

function world() {
  const root = tmp();
  const cwd = path.join(root, "work");
  fs.mkdirSync(cwd);
  const file = path.join(cwd, "app.ts");
  fs.writeFileSync(file, "x");
  const projectsDir = path.join(root, "projects");
  fs.mkdirSync(path.join(projectsDir, "demo-app"), { recursive: true });
  fs.writeFileSync(path.join(projectsDir, "demo-app", "project.json"), JSON.stringify({ slug: "demo-app", cwd }));
  const deps = { agentCwd: (id) => (id === "a1" ? cwd : null), agentLastFile: (id) => (id === "a1" ? file : null), projectsDir };
  return { root, cwd, file, projectsDir, deps };
}

test("an agent's folder is opened, its last file is revealed, a project's folder is opened", () => {
  const w = world();
  assert.deepEqual(resolveTarget({ agentId: "a1" }, w.deps), { path: w.cwd, reveal: false });
  assert.deepEqual(resolveTarget({ agentId: "a1", lastFile: true }, w.deps), { path: w.file, reveal: true });
  assert.deepEqual(resolveTarget({ project: "demo-app" }, w.deps), { path: w.cwd, reveal: false });
});

test("unknown agents, bad slugs and vanished paths are refused; nothing comes from the request", () => {
  const w = world();
  assert.equal(resolveTarget({}, w.deps).status, 400);
  assert.equal(resolveTarget({ agentId: "nope" }, w.deps).status, 404);
  assert.equal(resolveTarget({ agentId: "nope", lastFile: true }, w.deps).status, 404);
  assert.equal(resolveTarget({ project: "../../etc" }, w.deps).status, 404);
  assert.equal(resolveTarget({ project: "missing" }, w.deps).status, 404);
  // a request-supplied path is ignored entirely
  assert.deepEqual(resolveTarget({ agentId: "a1", path: "/etc" }, w.deps), { path: w.cwd, reveal: false });
  fs.rmSync(w.file);
  assert.equal(resolveTarget({ agentId: "a1", lastFile: true }, w.deps).status, 404);
});

test("the handler opens a folder with `open` and reveals a file with `open -R` (macOS)", async () => {
  const w = world();
  const calls = [];
  const handler = createRevealHandler({ ...w.deps, platform: "darwin", execFileFn: (cmd, args, _o, cb) => { calls.push([cmd, ...args]); cb(null); } });
  const post = (body) =>
    new Promise((resolve) => {
      const listeners = {};
      const req = { method: "POST", on: (e, fn) => (listeners[e] = fn), destroy() {} };
      const res = { status: 0, writeHead(s) { this.status = s; }, end(b) { resolve({ status: this.status, body: JSON.parse(b) }); } };
      assert.equal(handler(req, res, new URL("http://x/reveal")), true);
      listeners.data?.(JSON.stringify(body));
      listeners.end?.();
    });
  assert.equal((await post({ agentId: "a1" })).status, 200);
  assert.equal((await post({ agentId: "a1", lastFile: true })).status, 200);
  assert.deepEqual(calls, [["open", w.cwd], ["open", "-R", w.file]]);
  assert.equal((await post({ agentId: "zzz" })).status, 404);
  assert.equal(calls.length, 2); // nothing launched for a refusal
});
