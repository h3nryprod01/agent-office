#!/usr/bin/env node
// Leak gate for a PUBLIC repository: fail when a tracked file (or a commit about
// to be pushed) contains something that identifies a person, a machine or a
// customer — absolute home paths, private-network IPs, machine hostnames, and
// anything shaped like a token or key.
//
// Names that are sensitive to ONE person (a customer, a private project) must not
// be written into this public repo, so they cannot live here. They go in a local
// file, ~/.agent-office/leak-denylist.txt (one term per line, `#` comments,
// `re:<regex>` for a pattern). The script reads it when present; CI has none and
// relies on the generic rules. A denylist hit never prints the term itself.
//
// Usage:
//   node scripts/check-leaks.mjs                    scan the whole working tree
//   node scripts/check-leaks.mjs --range A..B       scan added lines + commit messages (pre-push)
//   node scripts/check-leaks.mjs --self-test        prove every rule fires on a planted leak
//   options: --root DIR  --denylist FILE  --no-denylist
//
// A "clean" result is only worth something if the scanner is known to catch a leak,
// so CI runs --self-test first. Exit codes: 0 clean, 1 findings, 2 usage error.
// A line carrying `leak-ok` is ignored (use it with a reason, on documented fixtures).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", "dist"]);

// Names that appear in docs and CI as stand-ins for a real account.
const PLACEHOLDER_USERS = new Set([
  "you", "your", "yourname", "your-name", "youruser", "your_user", "user", "username", "name", "me",
  "example", "demo", "test", "runner", "public", "shared", "default", "all", "foo", "bar", "ubuntu",
  "node", "someone", "alice", "bob", "xxx",
]);
const PLACEHOLDER_WORDS = /x{3,}|your|example|placeholder|changeme|dummy|sample|<|\$\{|\{\{|redacted|\.\.\./i;

const OCTET = "(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)";
const PRIVATE_IP = new RegExp(
  `(?<![\\d.])(?:10\\.${OCTET}|192\\.168|172\\.(?:1[6-9]|2\\d|3[01])|100\\.(?:6[4-9]|[7-9]\\d|1[01]\\d|12[0-7])|169\\.254)\\.${OCTET}\\.${OCTET}(?!\\d)(?!\\.\\d)`,
  "g",
);

function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

/**
 * Each rule: a global regex plus an optional `accept(match)` veto. `match` is the
 * RegExpExecArray; the finding spans match[0].
 */
const RULES = [
  {
    name: "home-path",
    re: /(?:\/(?:Users|home)\/|[A-Za-z]:\\{1,2}Users\\{1,2})([A-Za-z0-9][A-Za-z0-9._-]*)/g,
    // 1-2 character names (`/Users/u`, `C:\\Users\\k`) are the fixtures' stand-ins, not accounts
    accept: (m) => m[1].length > 2 && !PLACEHOLDER_USERS.has(m[1].toLowerCase()),
  },
  { name: "private-ip", re: PRIVATE_IP },
  {
    name: "hostname-local",
    re: /(?<![\w.-])(?:[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\.local|[A-Za-z0-9-]+\.[A-Za-z0-9-]+\.ts\.net)(?![\w-]|\.\w)/g,
  },
  { name: "token-anthropic", re: /sk-ant-[A-Za-z0-9_-]{20,}/g },
  { name: "token-openai", re: /(?<![A-Za-z0-9])sk-(?:proj-)?[A-Za-z0-9_-]{32,}/g },
  { name: "token-github", re: /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,})/g },
  { name: "token-aws", re: /(?<![A-Z0-9])AKIA[0-9A-Z]{16}(?![A-Z0-9])/g },
  { name: "token-google", re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: "token-slack", re: /xox[abprs]-[A-Za-z0-9-]{10,}/g },
  { name: "token-telegram", re: /(?<![\d])\d{8,10}:[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g },
  { name: "token-jwt", re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  // Agent Office's own access tokens (see packages/daemon/src/access.js): ao_ + 32 random bytes.
  { name: "token-agent-office", re: /(?<![A-Za-z0-9_])ao_[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g },
  { name: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    // `api_key = "…"`, `PASSWORD: '…'`, `TOKEN=…` with a long, random-looking value.
    name: "secret-assignment",
    re: /(?:token|secret|api[_-]?key|passw(?:or)?d|credential)\w*["']?\s*[:=]\s*(["']?)([A-Za-z0-9_\-/+=]{24,})\1/gi,
    accept: (m) => {
      const value = m[2];
      if (PLACEHOLDER_WORDS.test(value)) return false;
      if (!/\d/.test(value) || !/[A-Za-z]/.test(value)) return false;
      return entropy(value) >= (m[1] ? 3.5 : 3.8);
    },
  },
];

// ---------------------------------------------------------------------------

function redactLine(line, start, end, rule) {
  const out = `${line.slice(0, start)}[REDACTED:${rule}]${line.slice(end)}`.trim();
  return out.length > 160 ? `${out.slice(0, 157)}...` : out;
}

/**
 * Scan text. Returns findings with 1-based line numbers; `excerpt` has the match
 * replaced so the output of this tool can be pasted into a public CI log.
 * @param {string} text
 * @param {string} file label only
 * @param {{re: RegExp, label: string}[]} [denylist]
 */
export function scanText(text, file, denylist = []) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.includes("leak-ok")) return;
    for (const rule of RULES) {
      rule.re.lastIndex = 0;
      for (const m of line.matchAll(rule.re)) {
        if (rule.accept && !rule.accept(m)) continue;
        findings.push({
          file,
          line: i + 1,
          col: m.index + 1,
          rule: rule.name,
          excerpt: redactLine(line, m.index, m.index + m[0].length, rule.name),
        });
      }
    }
    for (const entry of denylist) {
      const m = entry.re.exec(line);
      if (!m) continue;
      findings.push({
        file,
        line: i + 1,
        col: m.index + 1,
        rule: "denylist",
        excerpt: `(matches ${entry.label} in your local denylist)`,
      });
    }
  });
  return findings;
}

/** `~/.agent-office/leak-denylist.txt`, honouring AGENT_OFFICE_HOME. Missing file → empty. */
export function defaultDenylistPath(env = process.env) {
  return path.join(env.AGENT_OFFICE_HOME ?? path.join(os.homedir(), ".agent-office"), "leak-denylist.txt");
}

export function loadDenylist(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const entries = [];
  raw.split(/\r?\n/).forEach((line, i) => {
    const term = line.trim();
    if (!term || term.startsWith("#")) return;
    try {
      const re = term.startsWith("re:")
        ? new RegExp(term.slice(3), "i")
        : new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      entries.push({ re, label: `line ${i + 1}` });
    } catch {
      console.error(`check-leaks: ignoring invalid pattern at ${file}:${i + 1}`);
    }
  });
  return entries;
}

function readScannable(abs) {
  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_BYTES) return null;
  const buf = fs.readFileSync(abs);
  if (buf.subarray(0, 8192).includes(0)) return null; // binary
  return buf.toString("utf8");
}

function git(root, args) {
  return spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

function listFiles(root) {
  const inGit = fs.existsSync(path.join(root, ".git")) && git(root, ["rev-parse", "--git-dir"]).status === 0;
  if (inGit) {
    const res = git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
    if (res.status === 0) return res.stdout.split("\0").filter(Boolean);
  }
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(path.relative(root, abs));
    }
  };
  walk(root);
  return out;
}

/** Whole-tree scan: tracked + untracked-not-ignored files (or a plain walk outside git). */
export function scanTree(root, denylist = []) {
  const findings = [];
  for (const rel of listFiles(root)) {
    const text = readScannable(path.join(root, rel));
    if (text === null) continue;
    findings.push(...scanText(text, rel, denylist));
  }
  return findings;
}

/** Added lines of `git diff <range>` plus every commit message in the range. */
export function scanRange(root, range, denylist = []) {
  const findings = [];
  const diff = git(root, ["diff", "--unified=0", "--no-color", "--no-renames", range]);
  if (diff.status !== 0) throw new Error(`git diff ${range} failed: ${diff.stderr.trim()}`);
  // Walk the diff by hunk line counts, not by prefix: an ADDED line "++ b/x" shows up
  // as "+++ b/x" and must not be mistaken for a file header (that would let a
  // commit hide what follows it).
  let file = "(unparsed path)";
  let lineNo = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const raw of diff.stdout.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (raw.startsWith("+")) {
        newLeft -= 1;
        lineNo += 1;
        for (const f of scanText(raw.slice(1), file, denylist)) findings.push({ ...f, line: lineNo });
      } else if (raw.startsWith("-")) {
        oldLeft -= 1;
      } else if (raw.startsWith(" ")) {
        oldLeft -= 1;
        newLeft -= 1;
        lineNo += 1;
      } // "\ No newline at end of file" consumes nothing
    } else if (raw.startsWith("+++ ")) {
      file = raw.startsWith("+++ b/") ? raw.slice(6) : "(unparsed path)";
    } else if (raw.startsWith("@@")) {
      const m = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
      if (!m) continue;
      oldLeft = m[1] === undefined ? 1 : Number(m[1]);
      newLeft = m[3] === undefined ? 1 : Number(m[3]);
      lineNo = Number(m[2]) - 1;
    }
  }
  const log = git(root, ["log", "--format=%h%x1f%B%x1e", range]);
  if (log.status !== 0) throw new Error(`git log ${range} failed: ${log.stderr.trim()}`);
  for (const record of log.stdout.split("\x1e")) {
    const [sha, ...body] = record.replace(/^\n/, "").split("\x1f");
    if (!sha) continue;
    findings.push(...scanText(body.join("\x1f"), `commit message ${sha.trim()}`, denylist));
  }
  return findings;
}

// Planted leaks for --self-test, assembled from fragments so this file never contains one.
const j = (...p) => p.join("");
export const SELF_TEST_SAMPLES = {
  "home-path": ["/", "Users/", "someperson/code"].join(""),
  "private-ip": j("192", ".168", ".1", ".20"),
  "hostname-local": j("someones-macbook", ".local"),
  "token-anthropic": j("sk-ant-", "api03-", "A1b2C3d4E5f6G7h8I9j0K1l2M3"),
  "token-openai": j("sk-", "proj-", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7"),
  "token-github": j("ghp", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"),
  "token-aws": j("AKIA", "ABCDEFGHIJKLMNOP"),
  "token-google": j("AIza", "SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"),
  "token-slack": j("xoxb", "-1234567890-", "abcdefghij"),
  "token-telegram": j("123456789", ":", "AAE1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"),
  "token-jwt": j("eyJ", "hbGciOiJIUzI1NiJ9", ".eyJ", "zdWIiOiIxMjM0NTY3ODkwIn0", ".", "abcdefghij1234567890"),
  "token-agent-office": j("ao", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0UvW"),
  "private-key": j("-----BEGIN ", "OPENSSH PRIVATE KEY-----"),
  "secret-assignment": j('api_key = "', "Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0", '"'),
};

/** Plant one leak per rule; `missed` lists rules that failed to fire. */
export function runSelfTest() {
  const missed = [];
  for (const rule of RULES) {
    const sample = SELF_TEST_SAMPLES[rule.name];
    const hit = sample && scanText(`const x = '${sample}';\n`, "self-test").some((f) => f.rule === rule.name);
    if (!hit) missed.push(rule.name);
  }
  const deny = [{ re: /planted-term/i, label: "line 1" }];
  if (!scanText("a planted-term here\n", "self-test", deny).some((f) => f.rule === "denylist")) missed.push("denylist");
  return { rules: [...RULES.map((r) => r.name), "denylist"], missed };
}

// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { root: null, range: null, denylist: undefined, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--root") opts.root = argv[++i];
    else if (a === "--range") opts.range = argv[++i];
    else if (a === "--denylist") opts.denylist = argv[++i];
    else if (a === "--no-denylist") opts.denylist = null;
    else if (a === "--self-test") opts.selfTest = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`check-leaks: ${error.message}`);
    return 2;
  }

  if (opts.selfTest) {
    const { rules, missed } = runSelfTest();
    if (missed.length) {
      console.error(`check-leaks self-test FAILED: no detection for ${missed.join(", ")}`);
      return 1;
    }
    console.log(`check-leaks self-test ok: ${rules.length} rules each caught a planted leak`);
    return 0;
  }

  const root = path.resolve(opts.root ?? fileURLToPath(new URL("..", import.meta.url)));
  const denyFile = opts.denylist === undefined ? defaultDenylistPath() : opts.denylist;
  const denylist = denyFile ? loadDenylist(denyFile) : [];

  let findings;
  try {
    findings = opts.range ? scanRange(root, opts.range, denylist) : scanTree(root, denylist);
  } catch (error) {
    console.error(`check-leaks: ${error.message}`);
    return 2;
  }

  const scope = opts.range ? `range ${opts.range}` : "working tree";
  if (findings.length === 0) {
    console.log(`check-leaks: clean (${scope}; ${RULES.length} rules${denylist.length ? ` + ${denylist.length} local denylist terms` : ", no local denylist"})`);
    return 0;
  }
  for (const f of findings) {
    console.log(`${f.file}:${f.line}:${f.col}  ${f.rule}  ${f.excerpt}`);
  }
  console.log(`\ncheck-leaks: ${findings.length} finding(s) in ${scope}. Fix them, or mark a documented fixture line with "leak-ok: <reason>".`);
  return 1;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
