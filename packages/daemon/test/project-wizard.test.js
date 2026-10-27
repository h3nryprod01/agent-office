import assert from "node:assert/strict";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createProjectWizardHandler, fillGoals, parseGoalsFields } from "../src/project-wizard.js";

const GOALS = `# Goals — Demo Studio

- 3 posts for \`<PRODUCT>\` in \`<AREA>\`, brand voice \`<BRAND/TONE>\`.
- Target \`<LEADS PER MONTH>\` leads.
- Report for <AREA> again; a plain <b>tag</b> and a <br> are not fields.

## Blanks

| Blank | Meaning | Example |
|---|---|---|
| \`<PRODUCT>\` | what we sell | "apartments" |
| \`<AREA>\` | where | "Riverside district" |
| \`<BRAND/TONE>\` | voice | friendly |
`;

function sandbox({ goals = GOALS } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ao-wizard-"));
  const homeDir = path.join(root, "home");
  const cwd = path.join(homeDir, "demo-app");
  const projectsDir = path.join(root, "projects");
  const templatesDir = path.join(root, "templates");
  fs.mkdirSync(cwd, { recursive: true });
  for (const name of ["demo-studio", "plain"]) {
    fs.mkdirSync(path.join(templatesDir, name), { recursive: true });
    fs.writeFileSync(path.join(templatesDir, name, "roster.yaml"), "version: 1\n");
  }
  fs.writeFileSync(path.join(templatesDir, "demo-studio", "goals.md"), goals);
  fs.writeFileSync(path.join(templatesDir, "plain", "goals.md"), "# Goals\n\n- Ship it.\n");
  return { root, homeDir, cwd, projectsDir, templatesDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

async function withWizard(s, opts, run) {
  const handler = createProjectWizardHandler({
    projectsDir: s.projectsDir,
    templatesDir: s.templatesDir,
    homeDir: s.homeDir,
    ...opts,
  });
  const server = createServer((req, res) => {
    if (!handler(req, res, new URL(req.url, "http://127.0.0.1"))) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body) =>
    fetch(`${base}/wizard/create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    await run({ base, post });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("parseGoalsFields: upper-case <PLACEHOLDERS> in order, hints from the table, html tags ignored", () => {
  const fields = parseGoalsFields(GOALS);
  assert.deepEqual(
    fields.map((f) => f.key),
    ["PRODUCT", "AREA", "BRAND/TONE", "LEADS PER MONTH"],
  );
  const product = fields.find((f) => f.key === "PRODUCT");
  assert.equal(product.hint, "what we sell");
  assert.equal(product.example, "apartments");
  assert.equal(fields.find((f) => f.key === "LEADS PER MONTH").hint, null);
  // an unquoted third cell is not an example: it joins the hint instead of becoming a wrong placeholder
  const tone = fields.find((f) => f.key === "BRAND/TONE");
  assert.equal(tone.hint, "voice — friendly");
  assert.equal(tone.example, null);
});

test("parseGoalsFields: Vietnamese capitals (Đ, Ơ, accents) are fields too", () => {
  const fields = parseGoalsFields("`<TÊN ĐƠN VỊ>` và `<SỐ LEAD/THÁNG>` và `<HÀNG THÁNG/QUÝ>`");
  assert.deepEqual(fields.map((f) => f.key), ["TÊN ĐƠN VỊ", "SỐ LEAD/THÁNG", "HÀNG THÁNG/QUÝ"]);
});

test("fillGoals: replaces everywhere except the blanks table, then appends a Brief and notes", () => {
  const out = fillGoals(GOALS, { PRODUCT: "apartments", AREA: "Riverside", "BRAND/TONE": "" }, ["Weekly recap on Fridays"]);
  assert.match(out, /3 posts for `apartments` in `Riverside`/);
  assert.match(out, /Report for Riverside again/);
  assert.match(out, /\| `<PRODUCT>` \| what we sell/); // the table row stays a definition
  assert.match(out, /`<BRAND\/TONE>`/); // left blank → stays a visible blank for the PM
  assert.match(out, /## Brief[\s\S]*PRODUCT: apartments/);
  assert.match(out, /Weekly recap on Fridays/);
  assert.doesNotMatch(out.split("## Brief")[1], /BRAND\/TONE/); // blank answers are not listed
});

test("fillGoals: a value containing $& or $1 is inserted literally", () => {
  const out = fillGoals("a `<PRODUCT>` b", { PRODUCT: "$& $1 $$" }, []);
  assert.match(out, /a `\$& \$1 \$\$` b/);
});

test("GET /wizard/template: fields for a template, empty for one with no blanks, 404 for unknown", async () => {
  const s = sandbox();
  await withWizard(s, {}, async ({ base }) => {
    const ok = await (await fetch(`${base}/wizard/template?name=demo-studio`)).json();
    assert.equal(ok.name, "demo-studio");
    assert.equal(ok.fields.length, 4);
    const plain = await (await fetch(`${base}/wizard/template?name=plain`)).json();
    assert.deepEqual(plain.fields, []);
    assert.equal((await fetch(`${base}/wizard/template?name=nope`)).status, 404);
    assert.equal((await fetch(`${base}/wizard/template?name=..%2F..%2Fetc`)).status, 400);
  });
  s.cleanup();
});

test("POST /wizard/create: makes the project and writes the filled goals.md", async () => {
  const s = sandbox();
  await withWizard(s, {}, async ({ post }) => {
    const res = await post({
      name: "Demo Studio",
      template: "demo-studio",
      cwd: s.cwd,
      fields: { PRODUCT: "townhouses", AREA: "Old Town", "LEADS PER MONTH": "80" },
      notes: "Friday recap\n\nMonday plan",
    });
    assert.equal(res.status, 201);
    const project = await res.json();
    assert.equal(project.slug, "demo-studio");
    const goals = fs.readFileSync(path.join(s.projectsDir, "demo-studio", "goals.md"), "utf8");
    assert.match(goals, /3 posts for `townhouses` in `Old Town`/);
    assert.match(goals, /Target `80` leads/);
    assert.match(goals, /- Friday recap/);
    assert.match(goals, /- Monday plan/);
    assert.deepEqual(fs.readdirSync(path.join(s.projectsDir, "demo-studio")).filter((n) => n.includes("tmp")), []);
  });
  s.cleanup();
});

test("POST /wizard/create: a template with no blanks still takes notes", async () => {
  const s = sandbox();
  await withWizard(s, {}, async ({ post }) => {
    const res = await post({ name: "Plain", template: "plain", cwd: s.cwd, notes: "Also write docs" });
    assert.equal(res.status, 201);
    assert.match(fs.readFileSync(path.join(s.projectsDir, "plain", "goals.md"), "utf8"), /- Also write docs/);
  });
  s.cleanup();
});

test("POST /wizard/create: bad input never leaves a half-made project behind", async () => {
  const s = sandbox();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "ao-wizard-out-"));
  await withWizard(s, {}, async ({ post }) => {
    assert.equal((await post({ name: "../evil", template: "plain", cwd: s.cwd })).status, 400);
    assert.equal((await post({ name: "X", template: "../../etc", cwd: s.cwd })).status, 400);
    assert.equal((await post({ name: "X", template: "plain", cwd: outside })).status, 400);
    assert.equal((await post({ name: "X", template: "plain", cwd: s.cwd, fields: "nope" })).status, 400);
    assert.equal((await post({ name: "X", template: "plain", cwd: s.cwd, fields: { A: { b: 1 } } })).status, 400);
  });
  assert.equal(fs.existsSync(path.join(s.projectsDir)), false);
  fs.rmSync(outside, { recursive: true, force: true });
  s.cleanup();
});

test("POST /wizard/create: duplicate name → 409; viewer and no-role → 403", async () => {
  const s = sandbox();
  await withWizard(s, {}, async ({ post }) => {
    assert.equal((await post({ name: "Dup", template: "plain", cwd: s.cwd })).status, 201);
    assert.equal((await post({ name: "Dup", template: "plain", cwd: s.cwd })).status, 409);
  });
  for (const role of ["viewer", null]) {
    await withWizard(s, { roleOf: () => role }, async ({ post }) => {
      assert.equal((await post({ name: "Other", template: "plain", cwd: s.cwd })).status, 403);
    });
  }
  assert.equal(fs.existsSync(path.join(s.projectsDir, "other")), false);
  s.cleanup();
});

test("values are single-line and clipped: a newline in an answer cannot add a goal bullet", async () => {
  const s = sandbox();
  await withWizard(s, {}, async ({ post }) => {
    const res = await post({
      name: "Clip",
      template: "demo-studio",
      cwd: s.cwd,
      fields: { PRODUCT: "villas\n- injected goal", AREA: "x".repeat(500) },
    });
    assert.equal(res.status, 201);
    const goals = fs.readFileSync(path.join(s.projectsDir, "clip", "goals.md"), "utf8");
    assert.doesNotMatch(goals, /\n- injected goal/);
    assert.match(goals, /villas - injected goal/);
    assert.doesNotMatch(goals, /x{201}/);
  });
  s.cleanup();
});

test("POST /wizard/create: no cwd → <home>/AgentOffice/<slug> is created and used; a rejected request creates no folder", async () => {
  const s = sandbox();
  await withWizard(s, {}, async ({ post }) => {
    assert.equal((await post({ name: "Bad", template: "nope-template" })).status, 404);
    assert.equal(fs.existsSync(path.join(s.homeDir, "AgentOffice")), false);

    const res = await post({ name: "No Repo Client", template: "plain" });
    assert.equal(res.status, 201);
    const project = await res.json();
    assert.equal(project.cwd, fs.realpathSync(path.join(s.homeDir, "AgentOffice", "no-repo-client")));
    assert.ok(fs.statSync(project.cwd).isDirectory());
  });
  s.cleanup();
});

test("POST /wizard/create: an existing project is refused BEFORE any folder is made; a hidden folder is refused", async () => {
  const s = sandbox();
  fs.mkdirSync(path.join(s.projectsDir, "taken"), { recursive: true });
  const hidden = path.join(s.homeDir, ".claude");
  fs.mkdirSync(hidden);
  await withWizard(s, {}, async ({ post }) => {
    assert.equal((await post({ name: "Taken", template: "plain" })).status, 409);
    assert.equal(fs.existsSync(path.join(s.homeDir, "AgentOffice", "taken")), false);
    assert.equal((await post({ name: "Sneaky", template: "plain", cwd: hidden })).status, 403);
  });
  assert.equal(fs.existsSync(path.join(s.projectsDir, "sneaky")), false);
  s.cleanup();
});

test("fillGoals: an answer that contains another blank is not substituted a second time", () => {
  const out = fillGoals("a `<PRODUCT>` b `<AREA>`", { PRODUCT: "x <AREA> y", AREA: "Old Town" }, []);
  assert.match(out, /a `x <AREA> y` b `Old Town`/);
});
