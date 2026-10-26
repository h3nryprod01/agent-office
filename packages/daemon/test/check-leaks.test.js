// lane L1: the leak gate. A "clean" verdict only counts if the same scanner
// demonstrably catches a planted leak, so every rule has a positive-control case
// here. The fake leaks are assembled at runtime from fragments so this file
// itself never contains a string the scanner would flag.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scanTree, scanText, loadDenylist, runSelfTest } from "../../../scripts/check-leaks.mjs";

const SCRIPT = fileURLToPath(new URL("../../../scripts/check-leaks.mjs", import.meta.url));

function tmpTree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ao-leaks-"));
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return root;
}

// fragments, joined at runtime
const HOME_MAC = ["", "Users", "someperson", "Projects", "x"].join("/");
const HOME_LINUX = ["", "home", "someperson", ".config"].join("/");
const HOME_WIN = ["C:", "Users", "someperson", "AppData"].join("\\");
const IP_192 = ["192", "168", "1", "20"].join(".");
const IP_10 = ["10", "4", "0", "7"].join(".");
const IP_172 = ["172", "20", "1", "9"].join(".");
const IP_TS = ["100", "101", "5", "6"].join(".");
const ANTHROPIC = ["sk", "ant", "api03", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"].join("-");
const GITHUB = ["ghp", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");
const AWS = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
const PRIVKEY = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");
const TELEGRAM = ["123456789", "AAE1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q"].join(":");
const AO_TOKEN = ["ao", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0UvW"].join("_");
const MDNS = ["someones-macbook", "local"].join(".");
const ASSIGN = `api_key = "${["Zx9", "Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0"].join("")}"`;

const POSITIVE = {
  "home-path": [HOME_MAC, HOME_LINUX, HOME_WIN, ["c:", "users", "someperson", "x"].join("\\")],
  "private-ip": [IP_192, IP_10, IP_172, IP_TS],
  "private-ipv6": [["fd", "12:3456:789a::1"].join(""), ["fe", "80::1c2d:3e4f"].join("")],
  "hostname-local": [MDNS],
  "token-anthropic": [ANTHROPIC],
  "token-github": [GITHUB],
  "token-aws": [AWS],
  "private-key": [PRIVKEY],
  "token-telegram": [TELEGRAM],
  "token-agent-office": [AO_TOKEN],
  "secret-assignment": [ASSIGN],
};

for (const [rule, samples] of Object.entries(POSITIVE)) {
  for (const sample of samples) {
    test(`positive control: rule ${rule} catches a planted leak`, () => {
      const hits = scanText(`const x = "${sample}";\n`, "fixture.js");
      assert.ok(
        hits.some((h) => h.rule === rule),
        `expected rule ${rule} to fire on its planted sample, got: ${JSON.stringify(hits.map((h) => h.rule))}`,
      );
    });
  }
}

test("planted leak in a temp tree is found; the CLI exits 1 and never prints the secret", () => {
  const root = tmpTree({ "src/a.js": `// fine\nconst k = "${GITHUB}";\n`, "docs/b.md": "clean\n" });
  const findings = scanTree(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, path.join("src", "a.js"));
  assert.equal(findings[0].line, 2);

  const res = spawnSync(process.execPath, [SCRIPT, "--root", root, "--no-denylist"], { encoding: "utf8" });
  assert.equal(res.status, 1);
  assert.ok(!res.stdout.includes(GITHUB) && !res.stderr.includes(GITHUB), "the secret must be redacted in output");
});

test("a clean tree exits 0", () => {
  const root = tmpTree({ "a.js": "export const a = 1;\n", "b.md": "see /Users/<you>/code and 127.0.0.1 and 0.0.0.0\n" });
  const res = spawnSync(process.execPath, [SCRIPT, "--root", root, "--no-denylist"], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stdout + res.stderr);
});

test("placeholders and documentation ranges are not leaks", () => {
  const ok = [
    "cd /Users/you/code",
    "cd /Users/<name>/code",
    "cwd: /Users/u/Projects/demo and C:\\Users\\k\\AppData",
    "/home/runner/work/x",
    "C:\\Users\\Public\\x",
    "http://192.0.2.10:8787",
    "bind 0.0.0.0 or 127.0.0.1",
    "ANTHROPIC_API_KEY=your-key-here",
    'token: "<paste-token-here>"',
    "version 10.0.1 and 1.2.3.4.5",
  ];
  for (const line of ok) assert.deepEqual(scanText(`${line}\n`, "doc.md"), [], `false positive on: ${line}`);
});

test("leak-ok on the line suppresses a finding", () => {
  assert.deepEqual(scanText(`const ip = "${IP_192}"; // leak-ok: documented fixture\n`, "x.js"), []);
});

test("denylist: literal terms and re: patterns, case-insensitive, comments ignored, term never echoed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-deny-"));
  const file = path.join(dir, "leak-denylist.txt");
  const term = ["Acme", "Secret", "Corp"].join("");
  fs.writeFileSync(file, `# my private names\n\n${term}\nre:proj-\\d{3}\n`);
  const deny = loadDenylist(file);
  assert.equal(deny.length, 2);

  const hits = scanText(`we ship for ${term.toLowerCase()} and proj-123 today\n`, "notes.md", deny);
  assert.deepEqual(hits.map((h) => h.rule).sort(), ["denylist", "denylist"]);
  for (const h of hits) {
    assert.ok(!JSON.stringify(h).toLowerCase().includes(term.toLowerCase()), "denylist term must not be echoed");
  }
});

test("a missing denylist file is fine (CI has none)", () => {
  assert.deepEqual(loadDenylist(path.join(os.tmpdir(), "does-not-exist-ao.txt")), []);
});

test("binary files and oversized files are skipped, not crashed on", () => {
  const root = tmpTree({ "ok.txt": "fine\n" });
  fs.writeFileSync(path.join(root, "blob.bin"), Buffer.concat([Buffer.from([0, 1, 2, 0]), Buffer.from(GITHUB)]));
  assert.deepEqual(scanTree(root), []);
});

test("--self-test: every rule fires on its planted sample (this is what CI runs before the real scan)", () => {
  const result = runSelfTest();
  assert.deepEqual(result.missed, []);
  assert.ok(result.rules.length >= 10);
});

test("--range scans added lines and commit messages of a git range", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ao-range-"));
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(root, "a.txt"), "hello\n");
  git("add", ".");
  git("commit", "-qm", "init");
  const base = git("rev-parse", "HEAD").stdout.trim();
  fs.writeFileSync(path.join(root, "a.txt"), `hello\nip ${IP_192}\n`);
  git("add", ".");
  git("commit", "-qm", `leaks ${IP_10} in the message`);

  const res = spawnSync(process.execPath, [SCRIPT, "--root", root, "--range", `${base}..HEAD`, "--no-denylist"], {
    encoding: "utf8",
  });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /a\.txt/);
  assert.match(res.stdout, /commit message/);

  const clean = spawnSync(process.execPath, [SCRIPT, "--root", root, "--range", `${base}..${base}`, "--no-denylist"], {
    encoding: "utf8",
  });
  assert.equal(clean.status, 0, clean.stdout + clean.stderr);
});

test("--range: an added line that looks like a diff header cannot hide the lines after it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ao-range-evade-"));
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  fs.writeFileSync(path.join(root, "a.txt"), "hello\n");
  git("add", ".");
  git("commit", "-qm", "init");
  const base = git("rev-parse", "HEAD").stdout.trim();
  // "++ b/other" is stored as "+++ b/other" in the diff; "@@ -1 +1 @@" likewise as "+@@ ..."
  fs.writeFileSync(path.join(root, "a.txt"), `hello\n++ b/other\n@@ -1 +1 @@\nip ${IP_192}\n`);
  git("add", ".");
  git("commit", "-qm", "sneaky");
  const res = spawnSync(process.execPath, [SCRIPT, "--root", root, "--range", `${base}..HEAD`, "--no-denylist"], {
    encoding: "utf8",
  });
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /a\.txt:4:/);
});

function gitRepo(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ao-${prefix}-`));
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  return { root, git };
}
const runRange = (root, range, extra = []) =>
  spawnSync(process.execPath, [SCRIPT, "--root", root, "--range", range, "--no-denylist", ...extra], { encoding: "utf8" });

test("--range: a secret added in one commit and removed in the next is still caught", () => {
  const { root, git } = gitRepo("range-undo");
  fs.writeFileSync(path.join(root, "a.txt"), "hello\n");
  git("add", ".");
  git("commit", "-qm", "init");
  const base = git("rev-parse", "HEAD").stdout.trim();
  fs.writeFileSync(path.join(root, "a.txt"), `hello\n${GITHUB}\n`);
  git("commit", "-qam", "oops");
  fs.writeFileSync(path.join(root, "a.txt"), "hello\n");
  git("commit", "-qam", "remove it");
  const res = runRange(root, `${base}..HEAD`);
  assert.equal(res.status, 1, res.stdout + res.stderr);
  assert.match(res.stdout, /token-github/);
  assert.ok(!res.stdout.includes(GITHUB));
});

test("--range: .gitattributes '-diff' / binary cannot blind the scan", () => {
  const { root, git } = gitRepo("range-attr");
  fs.writeFileSync(path.join(root, "a.txt"), "hello\n");
  git("add", ".");
  git("commit", "-qm", "init");
  const base = git("rev-parse", "HEAD").stdout.trim();
  fs.writeFileSync(path.join(root, ".gitattributes"), "*.txt -diff\n");
  fs.writeFileSync(path.join(root, "a.txt"), `hello\nip ${IP_192}\n`);
  git("add", ".");
  git("commit", "-qm", "hide it");
  assert.equal(runRange(root, `${base}..HEAD`).status, 1);
});

test("--range: author identity and file names are scanned too", () => {
  const { root, git } = gitRepo("range-meta");
  fs.writeFileSync(path.join(root, "a.txt"), "hello\n");
  git("add", ".");
  git("commit", "-qm", "init");
  const base = git("rev-parse", "HEAD").stdout.trim();
  const dir = path.join(root, "clients-acmecorp-private");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "notes.txt"), "x\n");
  git("add", ".");
  git("-c", "user.name=someone.private", "commit", "-qm", "add");
  const deny = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ao-deny-")), "d.txt");
  fs.writeFileSync(deny, "acmecorp\nsomeone.private\n");
  const res = spawnSync(process.execPath, [SCRIPT, "--root", root, "--range", `${base}..HEAD`, "--denylist", deny], { encoding: "utf8" });
  assert.equal(res.status, 1);
  assert.ok(!res.stdout.toLowerCase().includes("acmecorp"), "the matched term is never printed");
  assert.ok(!res.stdout.includes("clients-acmecorp-private"), "nor the path that contained it");
  assert.match(res.stdout, /commit message/);
  assert.match(res.stdout, /\(a file name\)/);
});

test("output never echoes the line: a secret NEXT to a match is not printed either", () => {
  const neighbour = ["wJalrXUtnFEMI", "K7MDENGbPxRfiCYEXAMPLEKEY"].join("/");
  const root = tmpTree({ "cfg.ini": `aws_access_key_id=${AWS} aws_secret_access_key=${neighbour}\n` });
  const res = spawnSync(process.execPath, [SCRIPT, "--root", root, "--no-denylist"], { encoding: "utf8" });
  assert.equal(res.status, 1);
  assert.ok(!res.stdout.includes(neighbour) && !res.stdout.includes(AWS));
  assert.match(res.stdout, /cfg\.ini:1:/);
});
