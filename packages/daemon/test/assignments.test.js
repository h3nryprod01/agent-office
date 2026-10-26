// lane L6: GET /roster-members, GET /sop, POST /assign — persona + SOP over HTTP.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventBroadcastServer } from "../src/ws-server.js";
import { createAssignmentsHttpHandler } from "../src/assignments.js";
import { createProject, readItems } from "../src/projects.js";

const SOP = `---
title: Developer
inputs:
  - A ticket
steps:
  - Write the failing test
  - Make it pass
done:
  - Tests green
handoff:
  - reviewer: the PR link
escalate:
  - The ticket contradicts the code
---
`;

const ROSTER = `version: 1
departments:
  eng:
    members:
      - name: developer
        source: builtin
        sop: sops/developer.md
        persona:
          name: Linh
          role: Developer
          avatar: engineer
          voice: Plain
          tone: calm
          prompt: "You are Linh."
      - { name: reviewer, source: "~/.claude/agents", role: "Reviews" }
`;

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ao-assign-"));
  const dirs = {
    templatesDir: path.join(root, "templates"),
    projectsDir: path.join(root, "projects"),
    companyDir: path.join(root, "home", ".claude", "company"),
    homeDir: path.join(root, "home"),
  };
  const tpl = path.join(dirs.templatesDir, "coding");
  fs.mkdirSync(path.join(tpl, "sops"), { recursive: true });
  fs.writeFileSync(path.join(tpl, "roster.yaml"), ROSTER);
  fs.writeFileSync(path.join(tpl, "goals.md"), "# Goals\n\nShip demo-app.\n");
  fs.writeFileSync(path.join(tpl, "sops", "developer.md"), SOP);
  const cwd = path.join(dirs.homeDir, "demo-app");
  fs.mkdirSync(cwd, { recursive: true });
  createProject({ ...dirs, name: "Demo App", template: "coding", cwd });
  return { root, ...dirs };
}

async function withServer(fx, fn) {
  const srv = new EventBroadcastServer({
    port: 0,
    extraHttp: createAssignmentsHttpHandler({
      templatesDir: fx.templatesDir,
      projectsDir: fx.projectsDir,
      companyDir: fx.companyDir,
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

const post = (base, route, body) =>
  fetch(`${base}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

test("GET /roster-members serves a template's or a project's roster with persona + sop", async () => {
  const fx = sandbox();
  try {
    await withServer(fx, async (base) => {
      for (const q of ["source=template&name=coding", "source=project&name=demo-app"]) {
        const res = await fetch(`${base}/roster-members?${q}`);
        assert.equal(res.status, 200, q);
        const [dev, rev] = (await res.json()).departments[0].members;
        assert.equal(dev.persona.name, "Linh");
        assert.equal(dev.sop, "sops/developer.md");
        assert.equal("persona" in rev, false);
      }
    });
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("GET /roster-members and /sop reject traversal and unknown sources", async () => {
  const fx = sandbox();
  try {
    await withServer(fx, async (base) => {
      for (const q of ["source=template&name=../x", "source=project&name=..%2Fx", "source=nope", "source=template"]) {
        assert.equal((await fetch(`${base}/roster-members?${q}`)).status, 400, q);
      }
      assert.equal((await fetch(`${base}/sop?source=template&name=coding&member=ghost`)).status, 404);
    });
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("GET /sop returns the parsed SOP of a member (404 for a member without one)", async () => {
  const fx = sandbox();
  try {
    await withServer(fx, async (base) => {
      const res = await fetch(`${base}/sop?source=project&name=demo-app&member=developer`);
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.path, "sops/developer.md");
      assert.equal(body.sop.title, "Developer");
      assert.deepEqual(body.sop.handoff, [{ to: "reviewer", what: "the PR link" }]);
      assert.deepEqual(body.problems, []);
      assert.equal((await fetch(`${base}/sop?source=project&name=demo-app&member=reviewer`)).status, 404);
    });
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("POST /assign creates an item for the member at SOP step 1 and returns the prompt", async () => {
  const fx = sandbox();
  try {
    await withServer(fx, async (base) => {
      const res = await post(base, "/assign", { project: "demo-app", member: "developer", title: "Add rate limiting", brief: "5 tries/min" });
      assert.equal(res.status, 201);
      const { item, prompt, problems } = await res.json();
      assert.equal(item.assignee, "developer");
      assert.equal(item.sopStep, 1);
      assert.equal(item.source, "agent");
      assert.equal(item.status, "doing");
      assert.deepEqual(problems, []);
      assert.match(prompt, /You are Linh/);
      assert.match(prompt, /1\. Write the failing test/);
      assert.match(prompt, /Add rate limiting/);
      assert.match(prompt, /Ship demo-app/); // project goals ride along
      assert.match(prompt, new RegExp(item.id));
      assert.equal(readItems({ projectsDir: fx.projectsDir, slug: "demo-app" }).length, 1);
    });
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("POST /assign: a member with no SOP gets sopStep null; parentItemId must exist; unknown member is 404", async () => {
  const fx = sandbox();
  try {
    await withServer(fx, async (base) => {
      const parent = await (await post(base, "/assign", { project: "demo-app", member: "developer", title: "Epic" })).json();
      const ok = await post(base, "/assign", { project: "demo-app", member: "reviewer", title: "Review it", parentItemId: parent.item.id });
      assert.equal(ok.status, 201);
      const { item, prompt } = await ok.json();
      assert.equal(item.sopStep, null);
      assert.equal(item.parentItemId, parent.item.id);
      assert.doesNotMatch(prompt, /sopStep/);

      assert.equal((await post(base, "/assign", { project: "demo-app", member: "reviewer", title: "x", parentItemId: "it-nope" })).status, 400);
      assert.equal((await post(base, "/assign", { project: "demo-app", member: "ghost", title: "x" })).status, 404);
      assert.equal((await post(base, "/assign", { project: "nope", member: "reviewer", title: "x" })).status, 404);
      assert.equal((await post(base, "/assign", { project: "demo-app", member: "reviewer", title: "" })).status, 400);
      // a failed assign must not leave an item behind
      assert.equal(readItems({ projectsDir: fx.projectsDir, slug: "demo-app" }).length, 2);
    });
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("POST /assign still works when the SOP file is broken: persona prompt, problems reported", async () => {
  const fx = sandbox();
  try {
    fs.rmSync(path.join(fx.projectsDir, "demo-app", "sops", "developer.md"));
    await withServer(fx, async (base) => {
      const res = await post(base, "/assign", { project: "demo-app", member: "developer", title: "Do it" });
      assert.equal(res.status, 201);
      const { item, prompt, problems } = await res.json();
      assert.equal(item.sopStep, null);
      assert.match(prompt, /You are Linh/);
      assert.ok(problems.length > 0);
    });
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("POST /assign: a missing member is 400, an oversized body is 413", async () => {
  const fx = sandbox();
  try {
    await withServer(fx, async (base) => {
      assert.equal((await post(base, "/assign", { project: "demo-app", title: "x" })).status, 400);
      const big = await post(base, "/assign", { project: "demo-app", member: "developer", title: "x", brief: "y".repeat(9000) });
      assert.equal(big.status, 413);
      assert.equal(readItems({ projectsDir: fx.projectsDir, slug: "demo-app" }).length, 0);
    });
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});
