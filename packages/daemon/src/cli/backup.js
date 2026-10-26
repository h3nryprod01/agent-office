// lane L1: backup / restore of the agent-office home (projects, access.json, …).
// Uses the system `tar` (macOS, Linux, and Windows 10+ all ship one) so the daemon
// keeps `ws` as its only dependency.
//
// Restore never deletes: the current home is moved aside to <home>.pre-restore-<ts>.
// The archive is validated from its listing BEFORE anything is extracted, because
// a restore runs with the user's own permissions on a file somebody may have sent.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

function pad(n) {
  return String(n).padStart(2, "0");
}

export function timestamp(d = new Date()) {
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

export function defaultBackupDir() {
  return path.join(os.homedir(), "agent-office-backups");
}

function tar(args, opts = {}) {
  const res = spawnSync("tar", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, COPYFILE_DISABLE: "1" }, // macOS: no ._AppleDouble files
    ...opts,
  });
  if (res.error) throw new Error(`could not run tar (${res.error.message}) — install it or use a recent OS`);
  return res;
}

/**
 * @param {{home: string, outDir?: string, now?: Date}} opts
 * @returns {{archive: string}}
 */
export function createBackup({ home, outDir = defaultBackupDir(), now = new Date() }) {
  if (!fs.existsSync(home)) throw new Error(`nothing to back up: ${home} does not exist yet`);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const archive = path.join(outDir, `agent-office-backup-${timestamp(now)}.tar.gz`);
  const res = tar(["-czf", archive, "-C", path.dirname(home), path.basename(home)]);
  if (res.status !== 0) {
    fs.rmSync(archive, { force: true });
    throw new Error(`tar failed: ${res.stderr.trim()}`);
  }
  try {
    fs.chmodSync(archive, 0o600); // it holds access.json
  } catch {
    // Windows
  }
  return { archive };
}

/**
 * Pure: decide from a `tar -t` / `tar -tv` listing whether extracting is safe.
 * @param {{names: string[], verbose: string[]}} listing
 * @returns {{root: string, count: number}}
 */
export function validateArchiveListing({ names, verbose }) {
  const unsafe = (why) => new Error(`unsafe archive: ${why}`);
  const entries = names.filter((n) => n !== "");
  if (entries.length === 0) throw new Error("archive is empty");
  for (const line of verbose) {
    if (/^[lh]/.test(line)) throw unsafe("contains a link");
  }
  let root = null;
  for (const raw of entries) {
    if (raw.startsWith("/") || /^[A-Za-z]:/.test(raw) || raw.includes("\\")) throw unsafe(`absolute or odd path ${JSON.stringify(raw)}`);
    const segments = raw.replace(/\/+$/, "").split("/");
    if (segments.includes("..") || segments.includes("")) throw unsafe(`path escapes the archive root: ${JSON.stringify(raw)}`);
    if (segments[0] === ".") throw unsafe(`unexpected ./ prefix: ${JSON.stringify(raw)}`);
    root ??= segments[0];
    if (segments[0] !== root) throw unsafe("more than one top-level entry — this is not an Agent Office backup");
  }
  return { root, count: entries.length };
}

/**
 * @param {{archive: string, home: string, now?: Date}} opts
 * @returns {{aside: string | null, entries: number}} aside = where the previous home went
 */
export function restoreBackup({ archive, home, now = new Date() }) {
  if (!fs.existsSync(archive)) throw new Error(`archive not found: ${archive}`);
  const listed = tar(["-tzf", archive]);
  const verbose = tar(["-tvzf", archive]);
  if (listed.status !== 0 || verbose.status !== 0) throw new Error(`not a readable tar.gz archive: ${archive}`);
  const { root, count } = validateArchiveListing({
    names: listed.stdout.split("\n"),
    verbose: verbose.stdout.split("\n").filter(Boolean),
  });

  const parent = path.dirname(home);
  fs.mkdirSync(parent, { recursive: true });
  // extract next to the target, then rename: a failed extract can never leave a half-restored home
  const staging = fs.mkdtempSync(path.join(parent, ".ao-restore-"));
  try {
    const res = tar(["-xzf", archive, "-C", staging]);
    if (res.status !== 0) throw new Error(`tar failed: ${res.stderr.trim()}`);
    let aside = null;
    if (fs.existsSync(home)) {
      aside = `${home}.pre-restore-${timestamp(now)}`;
      fs.renameSync(home, aside);
    }
    try {
      fs.renameSync(path.join(staging, root), home);
    } catch (error) {
      if (aside) fs.renameSync(aside, home); // put the original back
      throw error;
    }
    return { aside, entries: count };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
