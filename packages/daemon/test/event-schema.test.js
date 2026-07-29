import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveRepo, makeEvent } from "../src/event-schema.js";

// deriveRepo memoizes per cwd, so every test uses fresh unique paths.

test("deriveRepo: cwd inside a regular repo resolves to the repo root name", () => {
  const base = mkdtempSync(join(tmpdir(), "ao-repo-"));
  try {
    const root = join(base, "my-project");
    mkdirSync(join(root, ".git"), { recursive: true });
    mkdirSync(join(root, "packages", "daemon"), { recursive: true });
    assert.equal(deriveRepo(root), "my-project");
    assert.equal(deriveRepo(join(root, "packages", "daemon")), "my-project");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("deriveRepo: cwd in .claude/worktrees/<x> resolves to the ROOT repo, not the worktree", () => {
  // pure string rule — no .git needed on disk
  assert.equal(
    deriveRepo("/Users/x/Projects/Acme Web/.claude/worktrees/multi-office"),
    "Acme Web",
  );
  assert.equal(
    deriveRepo("/Users/x/Projects/Acme Web/.claude/worktrees/deeplinks/packages/renderer"),
    "Acme Web",
  );
});

test("deriveRepo: Windows backslash worktree path resolves via the normalized rule", () => {
  // The worktree string rule short-circuits before any fs call, so a Windows-style
  // path is testable on macOS. Before the fix this returned "featx" (the .git-file
  // fallback) because indexOf("/.claude/worktrees/") never matched backslashes.
  assert.equal(
    deriveRepo("C:\\Users\\k\\root-repo\\.claude\\worktrees\\featx\\packages\\daemon"),
    "root-repo",
  );
});

test("deriveRepo: worktree with a .git file (not dir) still resolves via the string rule", () => {
  const base = mkdtempSync(join(tmpdir(), "ao-wt-"));
  try {
    const wt = join(base, "root-repo", ".claude", "worktrees", "featx");
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, ".git"), "gitdir: elsewhere\n");
    assert.equal(deriveRepo(wt), "root-repo");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('deriveRepo: cwd outside any repo -> "other"', () => {
  const base = mkdtempSync(join(tmpdir(), "ao-norepo-"));
  try {
    const dir = join(base, "scratch");
    mkdirSync(dir, { recursive: true });
    assert.equal(deriveRepo(dir), "other");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('deriveRepo: null/empty cwd -> "other"', () => {
  assert.equal(deriveRepo(null), "other");
  assert.equal(deriveRepo(undefined), "other");
  assert.equal(deriveRepo(""), "other");
});

test("makeEvent: stamps repo from cwd (additive field, explicit repo wins)", () => {
  const e = makeEvent({
    id: "x",
    type: "speak",
    sessionId: "s",
    cwd: "/Users/x/Projects/Acme Web/.claude/worktrees/multi-office",
    ts: 1,
  });
  assert.equal(e.repo, "Acme Web");
  const e2 = makeEvent({ id: "y", type: "speak", sessionId: "s", cwd: null, ts: 1, repo: "forced" });
  assert.equal(e2.repo, "forced");
});
