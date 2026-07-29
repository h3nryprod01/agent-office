import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./migrate-work-items.mjs", import.meta.url));
const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));

const run = (projectsDir, extra = [], workItems) =>
  spawnSync("node", [SCRIPT, "--projects-dir", projectsDir, "--repo-root", REPO_ROOT, ...(workItems ? ["--work-items", workItems] : []), ...extra], {
    encoding: "utf8",
  });

const archiveCount = (projectsDir) =>
  JSON.parse(fs.readFileSync(path.join(projectsDir, "agent-office", "items-archive.json"), "utf8")).items.length;

test("chạy lần 2 không --force → exit 1, archive không nhân đôi", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-migrate-"));
  assert.equal(run(dir).status, 0);
  const before = archiveCount(dir);

  const second = run(dir);
  assert.equal(second.status, 1);
  assert.match(second.stderr, /đã tồn tại/);
  assert.equal(archiveCount(dir), before);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("--force ghi đè được", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-migrate-"));
  assert.equal(run(dir).status, 0);
  const forced = run(dir, ["--force"]);
  assert.equal(forced.status, 0);
  assert.match(forced.stdout, /archived=36 board=1/);
  assert.equal(archiveCount(dir), 36);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('work-items.json thiếu "items" → exit 1, không tạo thư mục', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-migrate-"));
  const bad = path.join(dir, "bad.json");
  fs.writeFileSync(bad, JSON.stringify({ version: 1 }));
  const projectsDir = path.join(dir, "projects");

  const res = run(projectsDir, [], bad);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /thiếu mảng "items"/);
  assert.equal(fs.existsSync(projectsDir), false);

  fs.rmSync(dir, { recursive: true, force: true });
});

test("--force từ chối khi bảng đã có ý tưởng do người viết", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-migrate-"));
  const projectsDir = path.join(dir, "projects");
  assert.equal(run(projectsDir).status, 0);

  // Người dùng gõ một ý tưởng vào bảng. Đó là bản duy nhất của nó.
  const itemsFile = path.join(projectsDir, "agent-office", "items.json");
  const board = JSON.parse(fs.readFileSync(itemsFile, "utf8"));
  board.items.push({ id: "it-mine", title: "ý tưởng của tôi", source: "human", status: "idea" });
  fs.writeFileSync(itemsFile, JSON.stringify(board));

  const res = run(projectsDir, ["--force"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /ý tưởng do người viết/);
  assert.ok(JSON.parse(fs.readFileSync(itemsFile, "utf8")).items.some((i) => i.id === "it-mine"));

  fs.rmSync(dir, { recursive: true, force: true });
});
