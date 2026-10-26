// lane L1: backup / restore of ~/.agent-office. Restore is the dangerous half, so
// the hostile-archive cases (traversal, symlink, wrong shape) get their own tests.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createBackup, restoreBackup, validateArchiveListing } from "../src/cli/backup.js";

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `ao-${prefix}-`));
}

function seedHome() {
  const home = path.join(tmp("home"), ".agent-office");
  fs.mkdirSync(path.join(home, "projects", "demo-app"), { recursive: true });
  fs.writeFileSync(path.join(home, "projects", "demo-app", "project.json"), '{"name":"demo-app"}\n');
  fs.writeFileSync(path.join(home, "access.json"), '{"version":1,"lan":false,"tokens":[]}\n', { mode: 0o600 });
  return home;
}

// minimal ustar writer, to build archives `tar` itself would refuse to create
function mkTarGz(entries) {
  const blocks = [];
  for (const { name, type = "0", linkname = "", data = "" } of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, "utf8");
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write(`${Buffer.byteLength(data).toString(8).padStart(11, "0")}\0`, 124);
    header.write("00000000000\0", 136);
    header.write("        ", 148);
    header.write(type, 156);
    header.write(linkname, 157);
    header.write("ustar\0" + "00", 257);
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
    blocks.push(header);
    if (data) {
      const body = Buffer.alloc(Math.ceil(Buffer.byteLength(data) / 512) * 512);
      body.write(data);
      blocks.push(body);
    }
  }
  blocks.push(Buffer.alloc(1024));
  const file = path.join(tmp("evil"), "evil.tar.gz");
  fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(blocks)));
  return file;
}

test("backup → restore round-trips every file and keeps access.json private", () => {
  const home = seedHome();
  const out = tmp("out");
  const { archive } = createBackup({ home, outDir: out, now: new Date("2026-10-27T10:20:30Z") });
  assert.match(path.basename(archive), /^agent-office-backup-20261027-\d{6}\.tar\.gz$/);
  if (process.platform !== "win32") assert.equal(fs.statSync(archive).mode & 0o777, 0o600);

  const target = path.join(tmp("restore"), ".agent-office");
  const result = restoreBackup({ archive, home: target });
  assert.equal(result.aside, null);
  assert.equal(fs.readFileSync(path.join(target, "projects", "demo-app", "project.json"), "utf8"), '{"name":"demo-app"}\n');
  assert.ok(fs.existsSync(path.join(target, "access.json")));
});

test("restore over an existing home moves it aside, never deletes it", () => {
  const home = seedHome();
  const { archive } = createBackup({ home, outDir: tmp("out") });
  fs.writeFileSync(path.join(home, "projects", "demo-app", "project.json"), '{"name":"changed"}\n');
  fs.writeFileSync(path.join(home, "newer.txt"), "made after the backup\n");

  const result = restoreBackup({ archive, home });
  assert.ok(result.aside, "an aside path is reported");
  assert.equal(fs.readFileSync(path.join(home, "projects", "demo-app", "project.json"), "utf8"), '{"name":"demo-app"}\n');
  assert.ok(!fs.existsSync(path.join(home, "newer.txt")));
  assert.equal(fs.readFileSync(path.join(result.aside, "newer.txt"), "utf8"), "made after the backup\n");
});

test("backup of a missing home is a clear error, not an empty archive", () => {
  assert.throws(() => createBackup({ home: path.join(tmp("none"), ".agent-office"), outDir: tmp("out") }), /nothing to back up/i);
});

test("restore refuses path traversal, absolute paths, symlinks and multi-root archives — and touches nothing", () => {
  const cases = {
    traversal: [{ name: ".agent-office/" , type: "5" }, { name: ".agent-office/../../evil.txt", data: "x" }],
    absolute: [{ name: "/tmp/evil.txt", data: "x" }],
    symlink: [{ name: ".agent-office/", type: "5" }, { name: ".agent-office/link", type: "2", linkname: "/etc" }],
    hardlink: [{ name: ".agent-office/", type: "5" }, { name: ".agent-office/h", type: "1", linkname: "/etc/passwd" }],
    "two roots": [{ name: ".agent-office/a", data: "1" }, { name: "other/b", data: "2" }],
    empty: [],
  };
  for (const [label, entries] of Object.entries(cases)) {
    const home = seedHome();
    const before = fs.readFileSync(path.join(home, "access.json"), "utf8");
    assert.throws(() => restoreBackup({ archive: mkTarGz(entries), home }), /unsafe|not a agent office|empty|archive/i, label);
    assert.equal(fs.readFileSync(path.join(home, "access.json"), "utf8"), before, `${label}: live data untouched`);
    assert.deepEqual(fs.readdirSync(path.dirname(home)).sort(), [".agent-office"], `${label}: no stray files`);
  }
});

test("restore of something that is not a tar.gz fails before touching the live home", () => {
  const home = seedHome();
  const junk = path.join(tmp("junk"), "x.tar.gz");
  fs.writeFileSync(junk, "not an archive");
  assert.throws(() => restoreBackup({ archive: junk, home }), /archive/i);
  assert.ok(fs.existsSync(path.join(home, "access.json")));
});

test("validateArchiveListing: pure checks", () => {
  assert.equal(validateArchiveListing({ names: [".agent-office/", ".agent-office/a"], verbose: ["drwx", "-rw-"] }).root, ".agent-office");
  assert.throws(() => validateArchiveListing({ names: ["a/../../b"], verbose: ["-rw"] }), /unsafe/);
  assert.throws(() => validateArchiveListing({ names: [".ao/a"], verbose: ["lrwx"] }), /unsafe/);
});
