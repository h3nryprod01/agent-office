import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  addItem,
  createProject,
  createProjectsHttpHandler,
  listProjects,
  readItems,
  updateItem,
} from "../src/projects.js";

const NOW = "2026-07-10T00:00:00.000Z";

/** A sandbox: fake projectsDir, fake HOME, fake templates/ with one template. */
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ao-projects-"));
  const projectsDir = path.join(root, "projects");
  const templatesDir = path.join(root, "templates");
  const homeDir = path.join(root, "home");
  const cwd = path.join(homeDir, "repo");
  fs.mkdirSync(path.join(templatesDir, "coding"), { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(path.join(templatesDir, "coding", "roster.yaml"), "version: 1\n");
  fs.writeFileSync(path.join(templatesDir, "coding", "goals.md"), "# goals\n");
  const make = (over = {}) =>
    createProject({ projectsDir, templatesDir, homeDir, name: "Agent Office", template: "coding", cwd, now: NOW, ...over });
  return { root, projectsDir, templatesDir, homeDir, cwd, make, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("createProject sinh đủ 4 file và slug hoá tên", () => {
  const s = sandbox();
  const project = s.make();
  assert.equal(project.slug, "agent-office");
  const dir = path.join(s.projectsDir, "agent-office");
  for (const f of ["project.json", "roster.yaml", "goals.md", "items.json"]) {
    assert.ok(fs.existsSync(path.join(dir, f)), `thiếu ${f}`);
  }
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "project.json"), "utf8")).slug, "agent-office");
  s.cleanup();
});

test("createProject với cwd ngoài homeDir → INVALID", () => {
  const s = sandbox();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ao-outside-"));
  assert.throws(() => s.make({ cwd: outside }), (e) => e.code === "INVALID");
  assert.equal(listProjects({ projectsDir: s.projectsDir }).length, 0);
  fs.rmSync(outside, { recursive: true, force: true });
  s.cleanup();
});

test('createProject với template "../../etc" → INVALID, không tạo thư mục', () => {
  const s = sandbox();
  assert.throws(() => s.make({ template: "../../etc" }), (e) => e.code === "INVALID");
  assert.equal(fs.existsSync(s.projectsDir), false);
  s.cleanup();
});

test("createProject lần 2 cùng tên → EXISTS, file cũ không bị đè", () => {
  const s = sandbox();
  s.make();
  const itemsFile = path.join(s.projectsDir, "agent-office", "items.json");
  fs.writeFileSync(itemsFile, JSON.stringify({ version: 1, items: ["dấu vết"] }));
  assert.throws(() => s.make(), (e) => e.code === "EXISTS");
  assert.deepEqual(JSON.parse(fs.readFileSync(itemsFile, "utf8")).items, ["dấu vết"]);
  s.cleanup();
});

test("addItem mặc định: human → idea, agent → doing", () => {
  const s = sandbox();
  s.make();
  const base = { projectsDir: s.projectsDir, slug: "agent-office", now: NOW };
  assert.equal(addItem({ ...base, title: "ý tưởng", source: "human" }).status, "idea");
  assert.equal(addItem({ ...base, title: "việc", source: "agent" }).status, "doing");
  s.cleanup();
});

test("addItem với status lạ → INVALID", () => {
  const s = sandbox();
  s.make();
  assert.throws(
    () => addItem({ projectsDir: s.projectsDir, slug: "agent-office", title: "x", source: "agent", status: "wip", now: NOW }),
    (e) => e.code === "INVALID",
  );
  s.cleanup();
});

test("links: javascript: URL, trường lạ → INVALID; http/https đi qua", () => {
  const s = sandbox();
  s.make();
  const base = { projectsDir: s.projectsDir, slug: "agent-office", title: "x", source: "agent", now: NOW };
  const bad = (links) => assert.throws(() => addItem({ ...base, links }), (e) => e.code === "INVALID");

  bad({ pr: "javascript:alert(1)" });
  bad({ plane: "data:text/html,<script>" });
  bad({ evil: "x" });
  bad({ pr: "x".repeat(501) });

  const ok = addItem({ ...base, links: { pr: "https://github.com/a/b/pull/1", branch: "feat/x" } });
  assert.equal(ok.links.pr, "https://github.com/a/b/pull/1");
  assert.equal(ok.links.branch, "feat/x");
  assert.equal(ok.links.obsidian, null);

  assert.throws(
    () => updateItem({ projectsDir: s.projectsDir, slug: "agent-office", id: ok.id, patch: { links: { pr: "javascript:0" } } }),
    (e) => e.code === "INVALID",
  );
  s.cleanup();
});

test("readItems rút outbox: dòng tốt vào bảng, gọi lần 2 không nhân đôi", () => {
  const s = sandbox();
  s.make();
  const outbox = path.join(s.projectsDir, "agent-office", "items-outbox.jsonl");
  const line = (title) => JSON.stringify({ title, source: "agent", createdAt: NOW });
  fs.writeFileSync(outbox, `${line("một")}\n{rách\n${line("hai")}\n`);

  const items = readItems({ projectsDir: s.projectsDir, slug: "agent-office" });
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.title), ["một", "hai"]);
  assert.equal(fs.existsSync(outbox), false); // đã đổi tên rồi rút, không còn gì để rút lại
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.projectsDir, "agent-office", "items.json"), "utf8")).items.length, 2);
  assert.equal(readItems({ projectsDir: s.projectsDir, slug: "agent-office" }).length, 2);
  s.cleanup();
});

test("readItems: dòng hỏng được GIỮ vào items-outbox.corrupt, không bốc hơi", () => {
  const s = sandbox();
  s.make();
  const dir = path.join(s.projectsDir, "agent-office");
  const outbox = path.join(dir, "items-outbox.jsonl");
  fs.writeFileSync(outbox, "{rách rồi\n{cũng hỏng\n");

  assert.deepEqual(readItems({ projectsDir: s.projectsDir, slug: "agent-office" }), []);
  const kept = fs.readFileSync(path.join(dir, "items-outbox.corrupt"), "utf8");
  assert.match(kept, /rách rồi/);
  assert.match(kept, /cũng hỏng/);
  s.cleanup();
});

test("readItems: dòng chip ghi TRONG lúc drain không bị nuốt", () => {
  const s = sandbox();
  s.make();
  const dir = path.join(s.projectsDir, "agent-office");
  const outbox = path.join(dir, "items-outbox.jsonl");
  const line = (title) => JSON.stringify({ title, source: "agent", createdAt: NOW });

  // Mô phỏng sự cố: daemon chết SAU khi đổi tên, TRƯỚC khi ghi items.json.
  fs.writeFileSync(`${outbox}.draining`, `${line("đang rút")}\n`);
  // Trong lúc đó chip vẫn ghi tiếp vào outbox mới.
  fs.writeFileSync(outbox, `${line("chip ghi thêm")}\n`);

  const first = readItems({ projectsDir: s.projectsDir, slug: "agent-office" });
  assert.deepEqual(first.map((i) => i.title), ["đang rút"]); // rút file dở trước
  const second = readItems({ projectsDir: s.projectsDir, slug: "agent-office" });
  assert.deepEqual(second.map((i) => i.title), ["đang rút", "chip ghi thêm"]); // rồi mới tới file mới
  s.cleanup();
});

test("updateItem: patch links.pr KHÔNG được xoá plane/branch/obsidian", () => {
  const s = sandbox();
  s.make();
  const base = { projectsDir: s.projectsDir, slug: "agent-office" };
  const item = addItem({
    ...base,
    title: "việc",
    source: "agent",
    now: NOW,
    links: { pr: "https://gh/1", plane: "https://plane/9", branch: "feat/x", obsidian: "note.md" },
  });

  const after = updateItem({ ...base, id: item.id, patch: { links: { pr: "https://gh/2" } }, now: NOW });
  assert.equal(after.links.pr, "https://gh/2");
  assert.equal(after.links.plane, "https://plane/9");
  assert.equal(after.links.branch, "feat/x");
  assert.equal(after.links.obsidian, "note.md");

  // gửi null tường minh thì vẫn xoá được — đó là ý người gọi
  const cleared = updateItem({ ...base, id: item.id, patch: { links: { plane: null } }, now: NOW });
  assert.equal(cleared.links.plane, null);
  assert.equal(cleared.links.pr, "https://gh/2");
  s.cleanup();
});

test("updateItem: id lạ → NOT_FOUND; sửa status → updatedAt đổi", () => {
  const s = sandbox();
  s.make();
  const base = { projectsDir: s.projectsDir, slug: "agent-office" };
  assert.throws(() => updateItem({ ...base, id: "it-xxxx", patch: { status: "done" } }), (e) => e.code === "NOT_FOUND");

  const item = addItem({ ...base, title: "việc", source: "agent", now: NOW });
  const later = "2026-07-11T00:00:00.000Z";
  const updated = updateItem({ ...base, id: item.id, patch: { status: "done" }, now: later });
  assert.equal(updated.status, "done");
  assert.equal(updated.updatedAt, later);
  assert.equal(updated.createdAt, NOW);
  s.cleanup();
});

test("listProjects trên thư mục trống → []", () => {
  const s = sandbox();
  assert.deepEqual(listProjects({ projectsDir: s.projectsDir }), []);
  s.cleanup();
});

// ── HTTP handler ────────────────────────────────────────────────────────────

/** Fake req/res, same shape as usage-costs.test.js — no real server. */
function caller(s) {
  const handler = createProjectsHttpHandler({
    projectsDir: s.projectsDir,
    templatesDir: s.templatesDir,
    homeDir: s.homeDir,
  });
  return (method, pathname, { search = "", body } = {}) =>
    new Promise((resolve) => {
      const req = method === "POST" ? new EventEmitter() : {};
      req.method = method;
      req.destroy = () => {};
      const res = {
        writeHead(status) {
          this.status = status;
        },
        end(payload) {
          resolve({ status: this.status, body: payload && JSON.parse(payload) });
        },
      };
      const handled = handler(req, res, new URL(`http://x${pathname}${search}`));
      if (!handled) return resolve({ handled: false });
      if (method === "POST") {
        req.emit("data", JSON.stringify(body ?? {}));
        req.emit("end");
      }
    });
}

test("http: đường dẫn lạ → handler trả false", async () => {
  const s = sandbox();
  assert.deepEqual(await caller(s)("GET", "/nope"), { handled: false });
  s.cleanup();
});

test('http: POST /projects với cwd "/etc" → 400, không tạo thư mục', async () => {
  const s = sandbox();
  const res = await caller(s)("POST", "/projects", { body: { name: "X", template: "coding", cwd: "/etc" } });
  assert.equal(res.status, 400);
  assert.equal(fs.existsSync(s.projectsDir), false);
  s.cleanup();
});

test("http: body KHÔNG ghi đè được homeDir/projectsDir của server", async () => {
  const s = sandbox();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ao-outside-"));
  const stolen = fs.mkdtempSync(path.join(os.tmpdir(), "ao-stolen-"));
  const call = caller(s);

  // Trang web bất kỳ POST được vào 127.0.0.1:8787. Nếu body tự khai homeDir thì
  // ràng buộc "cwd phải nằm trong HOME" chỉ còn là trang trí.
  const a = await call("POST", "/projects", {
    body: { name: "pwned", template: "coding", cwd: outside, homeDir: os.tmpdir() },
  });
  assert.equal(a.status, 400);
  assert.equal(fs.existsSync(path.join(s.projectsDir, "pwned")), false);

  // Và projectsDir của body không được làm file rơi ra ngoài kho dự án.
  const b = await call("POST", "/projects", {
    body: { name: "esc", template: "coding", cwd: s.cwd, projectsDir: stolen, homeDir: os.tmpdir() },
  });
  assert.equal(b.status, 201);
  assert.equal(fs.existsSync(path.join(stolen, "esc")), false);
  assert.equal(fs.existsSync(path.join(s.projectsDir, "esc", "project.json")), true);

  const c = await call("POST", "/items", {
    body: { project: "esc", title: "x", source: "human", projectsDir: stolen },
  });
  assert.equal(c.status, 201);
  assert.equal(fs.existsSync(path.join(stolen, "esc")), false);

  for (const d of [outside, stolen]) fs.rmSync(d, { recursive: true, force: true });
  s.cleanup();
});

test('http: POST /projects với name "../evil" → 400', async () => {
  const s = sandbox();
  const res = await caller(s)("POST", "/projects", { body: { name: "../evil", template: "coding", cwd: s.cwd } });
  assert.equal(res.status, 400);
  assert.equal(fs.existsSync(s.projectsDir), false);
  s.cleanup();
});

test("http: POST /items title rỗng hoặc dài 201 ký tự → 400", async () => {
  const s = sandbox();
  s.make();
  const call = caller(s);
  const base = { project: "agent-office", source: "human" };
  assert.equal((await call("POST", "/items", { body: { ...base, title: "   " } })).status, 400);
  assert.equal((await call("POST", "/items", { body: { ...base, title: "x".repeat(201) } })).status, 400);
  s.cleanup();
});

test("http: POST /items hợp lệ → 201; GET /items?source=human chỉ trả item đó", async () => {
  const s = sandbox();
  s.make();
  const call = caller(s);
  const created = await call("POST", "/items", { body: { project: "agent-office", title: "ý tưởng", source: "human" } });
  assert.equal(created.status, 201);
  await call("POST", "/items", { body: { project: "agent-office", title: "việc", source: "agent" } });

  const listed = await call("GET", "/items", { search: "?project=agent-office&source=human" });
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.items.map((i) => i.id), [created.body.id]);
  s.cleanup();
});

test("http: POST /items/update id lạ → 404", async () => {
  const s = sandbox();
  s.make();
  const res = await caller(s)("POST", "/items/update", {
    body: { project: "agent-office", id: "it-xxxx", patch: { status: "done" } },
  });
  assert.equal(res.status, 404);
  s.cleanup();
});

test("http: GET /items thiếu ?project= → 400", async () => {
  const s = sandbox();
  assert.equal((await caller(s)("GET", "/items")).status, 400);
  s.cleanup();
});
