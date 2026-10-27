// Where does a file live in git terms? Used by the radar to tell "same repo,
// different worktree" apart from "same checkout": two linked worktrees share
// one repoId (the main .git directory) but have different roots.
//
// Pure fs reads, memoized per directory — a touched path may not exist yet
// (Write of a new file), so the walk starts at the nearest directory and
// climbs; missing directories simply have no `.git` entry.

import fs from "node:fs";
import path from "node:path";

/** dir → {root, repoId} | null. ponytail: never invalidated; a daemon restart refreshes it. */
const memo = new Map();

function repoIdOf(gitEntry) {
  let st;
  try {
    st = fs.statSync(gitEntry);
  } catch {
    return null;
  }
  if (st.isDirectory()) return gitEntry;
  try {
    // linked worktree: ".git" is a file "gitdir: <main>/.git/worktrees/<name>"
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(gitEntry, "utf8"));
    if (!m) return null;
    const gitdir = path.resolve(path.dirname(gitEntry), m[1]);
    const idx = gitdir.split(path.sep).lastIndexOf("worktrees");
    return idx > 0 ? gitdir.split(path.sep).slice(0, idx).join(path.sep) || path.sep : gitdir;
  } catch {
    return null;
  }
}

function lookupDir(dir) {
  if (memo.has(dir)) return memo.get(dir);
  let result = null;
  const gitEntry = path.join(dir, ".git");
  if (fs.existsSync(gitEntry)) {
    const repoId = repoIdOf(gitEntry);
    result = repoId ? { root: dir, repoId } : null;
  } else {
    const parent = path.dirname(dir);
    if (parent !== dir) result = lookupDir(parent);
  }
  memo.set(dir, result);
  return result;
}

/**
 * @param {string} absPath absolute file path (need not exist)
 * @returns {{root: string, repoId: string, rel: string}|null}
 */
export function checkoutOf(absPath) {
  const found = lookupDir(path.dirname(absPath));
  return found ? { root: found.root, repoId: found.repoId, rel: path.relative(found.root, absPath) } : null;
}

/** Same lookup for a directory (an agent's cwd). */
export function checkoutOfDir(dir) {
  return lookupDir(dir);
}
