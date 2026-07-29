import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventBroadcastServer } from "../src/ws-server.js";
import { createTemplatesHttpHandler, listTemplates } from "../src/templates.js";

// Every test runs against a throwaway templates/ + HOME. The real
// ~/.claude/company/roster.yaml must never be touched by `npm test`.

const ROSTER = `version: 1
updated: 2026-07-10
departments:
  media:
    budget_usd_per_day: 100
    members:
      - { name: hyperframes, source: "~/.claude/skills", role: "video" }
      - { name: chua-cai-bao-gio, source: "~/.claude/skills", role: "thiếu" }
  ops:
    members:
      - { name: forge, source: "plugin forge", role: "plugin — không check được" }
`;

/** templates/<name>/roster.yaml (+goals.md), and a HOME with `installed` skills. */
function makeFixture({ installed = ["hyperframes"], goals = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "templates-"));
  const templatesDir = path.join(root, "templates");
  const tpl = path.join(templatesDir, "studio");
  mkdirSync(tpl, { recursive: true });
  writeFileSync(path.join(tpl, "roster.yaml"), ROSTER);
  if (goals) writeFileSync(path.join(tpl, "goals.md"), "# Goals\n\n- bán được 1 hợp đồng\n");

  const homeDir = path.join(root, "home");
  for (const name of installed) mkdirSync(path.join(homeDir, ".claude", "skills", name), { recursive: true });
  mkdirSync(path.join(homeDir, ".claude", "skills"), { recursive: true });

  const companyDir = path.join(homeDir, ".claude", "company");
  return { root, templatesDir, homeDir, companyDir, rosterPath: path.join(companyDir, "roster.yaml") };
}

test("listTemplates summarizes departments, members, goals and missing skills", () => {
  const fx = makeFixture();
  try {
    const [tpl] = listTemplates({ templatesDir: fx.templatesDir, homeDir: fx.homeDir });
    assert.equal(tpl.name, "studio");
    assert.deepEqual(tpl.departments, [
      { name: "media", memberCount: 2 },
      { name: "ops", memberCount: 1 },
    ]);
    assert.equal(tpl.memberTotal, 3);
    assert.equal(tpl.hasGoals, true);
    // `forge` is a plugin member (uncheckable → assumed installed); hyperframes is on disk.
    assert.deepEqual(tpl.missingSkills, ["chua-cai-bao-gio"]);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("listTemplates degrades to [] when templates/ is missing, and skips a broken template", () => {
  assert.deepEqual(listTemplates({ templatesDir: "/khong/ton/tai", homeDir: tmpdir() }), []);

  const fx = makeFixture();
  try {
    mkdirSync(path.join(fx.templatesDir, "rong")); // no roster.yaml → skipped, not fatal
    const names = listTemplates({ templatesDir: fx.templatesDir, homeDir: fx.homeDir }).map((t) => t.name);
    assert.deepEqual(names, ["studio"]);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

async function withServer(fx, fn) {
  const srv = new EventBroadcastServer({
    port: 0,
    extraHttp: createTemplatesHttpHandler({
      templatesDir: fx.templatesDir,
      companyDir: fx.companyDir,
      homeDir: fx.homeDir,
    }),
  });
  await srv.start();
  const { port } = srv.server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await srv.stop();
  }
}

const postApply = (base, body) =>
  fetch(`${base}/templates/apply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("GET /templates serves the summaries", async () => {
  const fx = makeFixture();
  try {
    await withServer(fx, async (base) => {
      const res = await fetch(`${base}/templates`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.length, 1);
      assert.equal(body[0].name, "studio");
      assert.equal(body[0].memberTotal, 3);
    });
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("POST /templates/apply writes the roster and reports missing skills + goals", async () => {
  const fx = makeFixture();
  try {
    await withServer(fx, async (base) => {
      const res = await postApply(base, { name: "studio" });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.backupPath, null); // no roster existed yet
      assert.deepEqual(body.missingSkills, ["chua-cai-bao-gio"]);
      assert.match(body.goals, /bán được 1 hợp đồng/);
      assert.equal(readFileSync(fx.rosterPath, "utf8"), ROSTER);
    });
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("POST /templates/apply backs the existing roster up before overwriting it", async () => {
  const fx = makeFixture();
  try {
    mkdirSync(fx.companyDir, { recursive: true });
    writeFileSync(fx.rosterPath, "version: 1\n# roster cũ của user\n");
    await withServer(fx, async (base) => {
      const body = await (await postApply(base, { name: "studio" })).json();
      assert.ok(body.backupPath, "phải có backupPath");
      assert.match(readFileSync(body.backupPath, "utf8"), /roster cũ của user/);
      assert.equal(readFileSync(fx.rosterPath, "utf8"), ROSTER);
    });
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("POST /templates/apply rejects traversal and unknown names with 400, leaving the roster alone", async () => {
  const fx = makeFixture();
  try {
    mkdirSync(fx.companyDir, { recursive: true });
    writeFileSync(fx.rosterPath, "khong-duoc-dung-vao\n");
    await withServer(fx, async (base) => {
      for (const name of ["../studio", "abc/def", "/etc/passwd", "Studio", "", null, 42, undefined]) {
        const res = await postApply(base, { name });
        assert.equal(res.status, 400, `name=${JSON.stringify(name)} phải bị từ chối`);
      }
      // a well-formed name that isn't a real template is also 400
      assert.equal((await postApply(base, { name: "khong-co-that" })).status, 400);
      assert.equal(readFileSync(fx.rosterPath, "utf8"), "khong-duoc-dung-vao\n");
    });
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});

test("/templates rejects the wrong method and answers CORS preflight", async () => {
  const fx = makeFixture();
  try {
    await withServer(fx, async (base) => {
      assert.equal((await fetch(`${base}/templates`, { method: "POST" })).status, 405);
      assert.equal((await fetch(`${base}/templates/apply`)).status, 405);
      const pre = await fetch(`${base}/templates/apply`, { method: "OPTIONS" });
      assert.equal(pre.status, 204);
      assert.equal(pre.headers.get("access-control-allow-origin"), "*");
    });
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
});
