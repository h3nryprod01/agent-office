import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkoutOf } from "../src/checkout.js";

function tmp() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ao-checkout-")));
}

test("plain checkout: root is the dir holding .git, repoId is that .git dir", () => {
  const base = tmp();
  fs.mkdirSync(path.join(base, "demo-app", ".git"), { recursive: true });
  const c = checkoutOf(path.join(base, "demo-app", "src", "new", "a.ts"));
  assert.equal(c.root, path.join(base, "demo-app"));
  assert.equal(c.repoId, path.join(base, "demo-app", ".git"));
  assert.equal(c.rel, path.join("src", "new", "a.ts"));
});

test("linked worktree: same repoId as the main checkout, different root", () => {
  const base = tmp();
  fs.mkdirSync(path.join(base, "demo-app", ".git", "worktrees", "wt1"), { recursive: true });
  fs.mkdirSync(path.join(base, "demo-app", ".claude", "worktrees", "wt1"), { recursive: true });
  const wt = path.join(base, "demo-app", ".claude", "worktrees", "wt1");
  fs.writeFileSync(path.join(wt, ".git"), `gitdir: ${path.join(base, "demo-app", ".git", "worktrees", "wt1")}\n`);

  const main = checkoutOf(path.join(base, "demo-app", "src", "a.ts"));
  const linked = checkoutOf(path.join(wt, "src", "a.ts"));
  assert.equal(linked.root, wt);
  assert.equal(linked.repoId, main.repoId);
  assert.notEqual(linked.root, main.root);
  assert.equal(linked.rel, main.rel);
});

test("outside any git checkout → null", () => {
  assert.equal(checkoutOf(path.join(tmp(), "loose", "a.ts")), null);
});

test("results are memoized per directory (second call does no new fs walk)", () => {
  const base = tmp();
  fs.mkdirSync(path.join(base, "r", ".git"), { recursive: true });
  const a = checkoutOf(path.join(base, "r", "x.ts"));
  fs.rmSync(path.join(base, "r", ".git"), { recursive: true });
  const b = checkoutOf(path.join(base, "r", "y.ts"));
  assert.equal(b.root, a.root);
});
