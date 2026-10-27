import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import http, { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { createProject, readItems } from "../src/projects.js";
import { createDocsHttpHandler, loopbackRole } from "../src/docs-workspace.js";

/**
 * Sandbox: fake HOME holding the project's cwd, a sibling "secret" file that is INSIDE home but
 * outside the project cwd (the interesting escape target), and a fake projectsDir.
 */
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ao-docs-"));
  const homeDir = path.join(root, "home");
  const cwd = path.join(homeDir, "acme-web");
  const projectsDir = path.join(root, "projects");
  const templatesDir = path.join(root, "templates");
  fs.mkdirSync(path.join(templatesDir, "coding"), { recursive: true });
  fs.writeFileSync(path.join(templatesDir, "coding", "roster.yaml"), "version: 1\n");
  fs.writeFileSync(path.join(templatesDir, "coding", "goals.md"), "# goals\n");

  fs.mkdirSync(path.join(cwd, "reports"), { recursive: true });
  fs.mkdirSync(path.join(cwd, "node_modules", "pkg"), { recursive: true });
  fs.mkdirSync(path.join(cwd, ".git"), { recursive: true });
  fs.writeFileSync(path.join(cwd, "README.md"), "# Acme Web\n\nIntro paragraph.\n\n## Plan\n\nStep one.\n");
  fs.writeFileSync(path.join(cwd, "reports", "q3.md"), "# Q3\n\nNumbers.\n");
  fs.writeFileSync(path.join(cwd, "reports", "brief.pdf"), "%PDF-1.4 fake");
  fs.writeFileSync(path.join(cwd, "reports", "hero.png"), "fake-png");
  fs.writeFileSync(path.join(cwd, "reports", "page.html"), "<h1>x</h1><script>alert(1)</script>");
  fs.writeFileSync(path.join(cwd, "reports", "data.csv"), "a,b\n1,2\n");
  fs.writeFileSync(path.join(cwd, "reports", "run.sh"), "echo no");
  fs.writeFileSync(path.join(cwd, "node_modules", "pkg", "README.md"), "# dep");
  fs.writeFileSync(path.join(cwd, ".git", "notes.md"), "# hidden");
  fs.writeFileSync(path.join(cwd, ".secret.md"), "# hidden file");
  fs.writeFileSync(path.join(homeDir, "secret.md"), "# SECRET outside the project\n");

  createProject({ projectsDir, templatesDir, homeDir, name: "Acme Web", template: "coding", cwd });
  return {
    root,
    homeDir,
    cwd,
    projectsDir,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

/** Real HTTP server so the loopback role check and streamed file responses are exercised for real. */
async function withDocs(s, opts, run) {
  const handler = createDocsHttpHandler({ projectsDir: s.projectsDir, homeDir: s.homeDir, ...opts });
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (!handler(req, res, url)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (p, search = {}) =>
    fetch(`${base}${p}?${new URLSearchParams({ project: "acme-web", ...search })}`);
  const post = (p, body) =>
    fetch(`${base}${p}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "acme-web", ...body }),
    });
  try {
    await run({ base, get, post });
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  }
}

const asRole = (role) => ({ roleOf: () => role });

/** Approve exactly what is on disk now (the UI sends the mtime it displayed). */
async function approve(get, post, p, extra = {}) {
  const { mtime } = await (await get("/docs/doc", { path: p })).json();
  return post("/docs/review", { path: p, decision: "approve", baseMtime: mtime, ...extra });
}

test("loopbackRole: loopback socket + loopback Host = owner, anything else = null", () => {
  const req = (remoteAddress, host = "127.0.0.1:8787") => ({ socket: { remoteAddress }, headers: { host } });
  assert.equal(loopbackRole(req("127.0.0.1")), "owner");
  assert.equal(loopbackRole(req("::1", "[::1]:8787")), "owner");
  assert.equal(loopbackRole(req("::ffff:127.0.0.1", "localhost:8797")), "owner");
  assert.equal(loopbackRole(req("192.168.1.20")), null); // leak-ok: invented fixture value
  assert.equal(loopbackRole({ socket: {}, headers: {} }), null);
  // DNS rebinding: the socket is loopback but the page's own hostname is in Host
  assert.equal(loopbackRole(req("127.0.0.1", "evil.example.com:8787")), null);
  assert.equal(loopbackRole(req("127.0.0.1", "")), null);
  assert.equal(loopbackRole({ socket: { remoteAddress: "127.0.0.1" } }), null);
});

test("a planted symlink at a guessable temp name cannot redirect a save", async () => {
  const s = sandbox();
  const victim = path.join(s.homeDir, "victim.txt");
  fs.writeFileSync(victim, "keep me");
  // the old scheme wrote to `<file>.ao-tmp-<pid>`; plant links at that name
  fs.symlinkSync(victim, path.join(s.cwd, `README.md.ao-tmp-${process.pid}`));
  await withDocs(s, {}, async ({ get, post }) => {
    const { mtime } = await (await get("/docs/doc", { path: "README.md" })).json();
    assert.equal((await post("/docs/save", { path: "README.md", content: "# new\n", baseMtime: mtime })).status, 200);
  });
  assert.equal(fs.readFileSync(victim, "utf8"), "keep me");
  assert.equal(fs.readFileSync(path.join(s.cwd, "README.md"), "utf8"), "# new\n");
  s.cleanup();
});

test("unrelated route → handler returns false", async () => {
  const s = sandbox();
  const handler = createDocsHttpHandler({ projectsDir: s.projectsDir, homeDir: s.homeDir });
  assert.equal(handler({ method: "GET" }, {}, new URL("http://x/projects")), false);
  s.cleanup();
});

test("list: documents only, skips hidden / node_modules / unsupported extensions", async () => {
  const s = sandbox();
  await withDocs(s, {}, async ({ get }) => {
    const res = await get("/docs");
    assert.equal(res.status, 200);
    const body = await res.json();
    const paths = body.files.map((f) => f.path).sort();
    assert.deepEqual(paths, [
      "README.md",
      "reports/brief.pdf",
      "reports/data.csv",
      "reports/hero.png",
      "reports/page.html",
      "reports/q3.md",
    ]);
    const kinds = Object.fromEntries(body.files.map((f) => [f.path, f.kind]));
    assert.equal(kinds["README.md"], "markdown");
    assert.equal(kinds["reports/brief.pdf"], "pdf");
    assert.equal(kinds["reports/hero.png"], "image");
    assert.equal(kinds["reports/page.html"], "html");
    assert.equal(kinds["reports/data.csv"], "csv");
    assert.ok(body.files.every((f) => f.status === "draft"));
    assert.equal(body.role, "owner");
  });
  s.cleanup();
});

test("list does not follow a symlinked directory out of the project", async () => {
  const s = sandbox();
  fs.symlinkSync(s.homeDir, path.join(s.cwd, "escape"));
  await withDocs(s, {}, async ({ get }) => {
    const body = await (await get("/docs")).json();
    assert.ok(!body.files.some((f) => f.path.startsWith("escape/") || f.name === "secret.md"));
  });
  s.cleanup();
});

test("read: GET /docs/doc returns the text plus review metadata", async () => {
  const s = sandbox();
  await withDocs(s, {}, async ({ get }) => {
    const res = await get("/docs/doc", { path: "README.md" });
    assert.equal(res.status, 200);
    const doc = await res.json();
    assert.match(doc.content, /Intro paragraph/);
    assert.equal(doc.kind, "markdown");
    assert.equal(doc.status, "draft");
    assert.deepEqual(doc.comments, []);
    assert.equal(typeof doc.mtime, "number");
  });
  s.cleanup();
});

test("read: binary kinds carry no inline content, raw bytes come from /docs/file", async () => {
  const s = sandbox();
  await withDocs(s, {}, async ({ get }) => {
    const doc = await (await get("/docs/doc", { path: "reports/brief.pdf" })).json();
    assert.equal(doc.kind, "pdf");
    assert.equal(doc.content, undefined);
    const raw = await get("/docs/file", { path: "reports/brief.pdf" });
    assert.equal(raw.status, 200);
    assert.equal(raw.headers.get("content-type"), "application/pdf");
    assert.equal(raw.headers.get("x-content-type-options"), "nosniff");
    assert.match(await raw.text(), /%PDF/);
  });
  s.cleanup();
});

test("html is served locked down: CSP sandbox so a script in it cannot touch the daemon origin", async () => {
  const s = sandbox();
  await withDocs(s, {}, async ({ get }) => {
    const raw = await get("/docs/file", { path: "reports/page.html" });
    assert.equal(raw.status, 200);
    assert.match(raw.headers.get("content-security-policy"), /sandbox/);
  });
  s.cleanup();
});

// ---- traversal: negative cases + a positive control for each ---------------------------------

const ESCAPES = [
  "../secret.md",
  "reports/../../secret.md",
  "reports/../README.md", // a `..` segment is refused outright, even when it stays inside
  "..%2Fsecret.md",
  "%2e%2e/secret.md",
  "/etc/hosts",
  "C:/Windows/win.ini",
  "reports\\..\\..\\secret.md",
  "reports/q3.md\0.png",
  ".secret.md",
  ".git/notes.md",
  "reports//q3.md",
];

for (const bad of ESCAPES) {
  test(`traversal: ${JSON.stringify(bad)} is refused on read, raw and write`, async () => {
    const s = sandbox();
    await withDocs(s, {}, async ({ get, post }) => {
      for (const route of ["/docs/doc", "/docs/file"]) {
        const res = await get(route, { path: bad });
        assert.ok([400, 403, 404, 415].includes(res.status), `${route} → ${res.status}`);
        assert.doesNotMatch(await res.text(), /SECRET/);
      }
      const save = await post("/docs/save", { path: bad, content: "pwned" });
      assert.ok([400, 403, 404, 415].includes(save.status), `save → ${save.status}`);
      assert.equal(fs.readFileSync(path.join(s.homeDir, "secret.md"), "utf8"), "# SECRET outside the project\n");
    });
    s.cleanup();
  });
}

test("traversal control: the same shapes pointing at a real in-project file DO work", async () => {
  const s = sandbox();
  await withDocs(s, {}, async ({ get }) => {
    assert.equal((await get("/docs/doc", { path: "reports/q3.md" })).status, 200);
    assert.equal((await get("/docs/doc", { path: "README.md" })).status, 200);
    assert.equal((await get("/docs/file", { path: "reports/hero.png" })).status, 200);
  });
  s.cleanup();
});

test("symlink out of the project is refused (file and directory), in-project symlink still works", async () => {
  const s = sandbox();
  fs.symlinkSync(path.join(s.homeDir, "secret.md"), path.join(s.cwd, "linked-secret.md"));
  fs.symlinkSync(s.homeDir, path.join(s.cwd, "escape"));
  fs.symlinkSync(path.join(s.cwd, "reports", "q3.md"), path.join(s.cwd, "alias.md"));
  fs.symlinkSync(path.join(s.cwd, ".git", "notes.md"), path.join(s.cwd, "to-hidden.md"));
  await withDocs(s, {}, async ({ get, post }) => {
    for (const p of ["linked-secret.md", "escape/secret.md", "to-hidden.md"]) {
      for (const route of ["/docs/doc", "/docs/file"]) {
        const res = await get(route, { path: p });
        assert.equal(res.status, 403, `${route} ${p}`);
        assert.doesNotMatch(await res.text(), /SECRET|# hidden/);
      }
      assert.equal((await post("/docs/save", { path: p, content: "pwned" })).status, 403, `save ${p}`);
    }
    assert.equal(fs.readFileSync(path.join(s.homeDir, "secret.md"), "utf8"), "# SECRET outside the project\n");
    assert.equal((await get("/docs/doc", { path: "alias.md" })).status, 200); // positive control
  });
  s.cleanup();
});

test("a project.json whose cwd was tampered to point outside home is refused", async () => {
  const s = sandbox();
  const file = path.join(s.projectsDir, "acme-web", "project.json");
  const project = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.writeFileSync(file, JSON.stringify({ ...project, cwd: os.tmpdir() }));
  await withDocs(s, {}, async ({ get }) => {
    assert.equal((await get("/docs")).status, 403);
  });
  s.cleanup();
});

test("unknown project → 404, malformed slug → 400", async () => {
  const s = sandbox();
  await withDocs(s, {}, async ({ get }) => {
    assert.equal((await get("/docs", { project: "nope" })).status, 404);
    assert.equal((await get("/docs", { project: "../projects" })).status, 400);
    assert.equal((await get("/docs", { project: "" })).status, 400);
  });
  s.cleanup();
});

// ---- roles -----------------------------------------------------------------------------------

test("no role (non-loopback source) → every route is 403", async () => {
  const s = sandbox();
  await withDocs(s, asRole(null), async ({ get, post }) => {
    assert.equal((await get("/docs")).status, 403);
    assert.equal((await get("/docs/doc", { path: "README.md" })).status, 403);
    assert.equal((await get("/docs/file", { path: "README.md" })).status, 403);
    assert.equal((await post("/docs/save", { path: "README.md", content: "x" })).status, 403);
    assert.equal((await post("/docs/comment", { path: "README.md", text: "x" })).status, 403);
  });
  s.cleanup();
});

test("viewer reads but cannot write, comment, or review", async () => {
  const s = sandbox();
  await withDocs(s, asRole("viewer"), async ({ get, post }) => {
    assert.equal((await get("/docs/doc", { path: "README.md" })).status, 200);
    assert.equal((await post("/docs/save", { path: "README.md", content: "x" })).status, 403);
    assert.equal((await post("/docs/comment", { path: "README.md", text: "x" })).status, 403);
    assert.equal((await post("/docs/review", { path: "README.md", decision: "approve", baseMtime: 0 })).status, 403);
    assert.equal((await post("/docs/status", { path: "README.md", status: "review" })).status, 403);
  });
  assert.match(fs.readFileSync(path.join(s.cwd, "README.md"), "utf8"), /Intro paragraph/);
  s.cleanup();
});

// ---- write -----------------------------------------------------------------------------------

test("save: writes the file, bumps mtime, keeps the previous text as a version", async () => {
  const s = sandbox();
  await withDocs(s, {}, async ({ get, post }) => {
    const before = await (await get("/docs/doc", { path: "reports/q3.md" })).json();
    const res = await post("/docs/save", { path: "reports/q3.md", content: "# Q3\n\nRevised.\n", baseMtime: before.mtime });
    assert.equal(res.status, 200);
    const saved = await res.json();
    assert.equal(saved.ok, true);
    assert.equal(fs.readFileSync(path.join(s.cwd, "reports", "q3.md"), "utf8"), "# Q3\n\nRevised.\n");

    const versions = await (await get("/docs/versions", { path: "reports/q3.md" })).json();
    assert.equal(versions.source, "snapshots");
    const old = versions.versions.find((v) => !v.current);
    assert.ok(old, "previous text should be listed");
    const prev = await (await get("/docs/version", { path: "reports/q3.md", id: old.id })).json();
    assert.equal(prev.content, "# Q3\n\nNumbers.\n");
  });
  assert.deepEqual(fs.readdirSync(path.join(s.cwd, "reports")).filter((n) => n.includes("tmp")), []);
  s.cleanup();
});

test("save: stale baseMtime → 409 and the file is untouched (an agent wrote meanwhile)", async () => {
  const s = sandbox();
  await withDocs(s, {}, async ({ get, post }) => {
    const before = await (await get("/docs/doc", { path: "README.md" })).json();
    fs.writeFileSync(path.join(s.cwd, "README.md"), "# agent wrote this\n");
    fs.utimesSync(path.join(s.cwd, "README.md"), new Date(), new Date(Date.now() + 5000));
    const res = await post("/docs/save", { path: "README.md", content: "# mine\n", baseMtime: before.mtime });
    assert.equal(res.status, 409);
  });
  assert.equal(fs.readFileSync(path.join(s.cwd, "README.md"), "utf8"), "# agent wrote this\n");
  s.cleanup();
});

test("save: only markdown is editable; size and type are validated", async () => {
  const s = sandbox();
  await withDocs(s, {}, async ({ post }) => {
    assert.equal((await post("/docs/save", { path: "reports/data.csv", content: "x" })).status, 415);
    assert.equal((await post("/docs/save", { path: "reports/brief.pdf", content: "x" })).status, 415);
    assert.equal((await post("/docs/save", { path: "README.md", content: 42 })).status, 400);
    assert.equal((await post("/docs/save", { path: "README.md", content: "a".repeat(1_100_000) })).status, 413);
    assert.equal((await post("/docs/save", { path: "reports/new-file.md", content: "x" })).status, 404); // no creating files
  });
  assert.equal(fs.existsSync(path.join(s.cwd, "reports", "new-file.md")), false);
  s.cleanup();
});

// ---- comments / status / review --------------------------------------------------------------

test("comment: stored in docs-meta.json, listed on the doc, resolvable; empty text → 400", async () => {
  const s = sandbox();
  await withDocs(s, asRole("manager"), async ({ get, post }) => {
    const res = await post("/docs/comment", {
      path: "README.md",
      text: "Shorten this section",
      anchor: { heading: "Plan", quote: "Step one." },
      author: "Linh",
    });
    assert.equal(res.status, 201);
    const comment = await res.json();
    assert.equal(comment.anchor.heading, "Plan");
    assert.equal(comment.by, "manager");
    assert.equal(comment.resolved, false);

    assert.equal((await post("/docs/comment", { path: "README.md", text: "   " })).status, 400);

    const doc = await (await get("/docs/doc", { path: "README.md" })).json();
    assert.equal(doc.comments.length, 1);
    assert.equal(doc.comments[0].text, "Shorten this section");

    const done = await post("/docs/comment/resolve", { path: "README.md", id: comment.id, resolved: true });
    assert.equal(done.status, 200);
    const again = await (await get("/docs/doc", { path: "README.md" })).json();
    assert.equal(again.comments[0].resolved, true);
    assert.equal((await post("/docs/comment/resolve", { path: "README.md", id: "c-nope" })).status, 404);
  });
  const meta = JSON.parse(fs.readFileSync(path.join(s.projectsDir, "acme-web", "docs-meta.json"), "utf8"));
  assert.equal(meta.docs["README.md"].comments.length, 1);
  s.cleanup();
});

test("comment on a file that does not exist (or escapes) never creates metadata", async () => {
  const s = sandbox();
  await withDocs(s, {}, async ({ post }) => {
    assert.equal((await post("/docs/comment", { path: "ghost.md", text: "hi" })).status, 404);
    assert.equal((await post("/docs/comment", { path: "../secret.md", text: "hi" })).status, 400);
  });
  assert.equal(fs.existsSync(path.join(s.projectsDir, "acme-web", "docs-meta.json")), false);
  s.cleanup();
});

test("status: draft → review → approve; unknown values rejected; save after approval drops back to draft", async () => {
  const s = sandbox();
  await withDocs(s, {}, async ({ get, post }) => {
    assert.equal((await post("/docs/status", { path: "README.md", status: "review" })).status, 200);
    assert.equal((await post("/docs/status", { path: "README.md", status: "approved" })).status, 400); // approval goes through /docs/review
    assert.equal((await post("/docs/status", { path: "README.md", status: "bogus" })).status, 400);

    let doc = await (await get("/docs/doc", { path: "README.md" })).json();
    assert.equal(doc.status, "review");

    const ok = await approve(get, post, "README.md", { note: "good" });
    assert.equal(ok.status, 200);
    doc = await (await get("/docs/doc", { path: "README.md" })).json();
    assert.equal(doc.status, "approved");
    assert.equal(doc.reviews.at(-1).decision, "approve");
    const listed = (await (await get("/docs")).json()).files.find((f) => f.path === "README.md");
    assert.equal(listed.status, "approved");

    const { mtime } = await (await get("/docs/doc", { path: "README.md" })).json();
    await post("/docs/save", { path: "README.md", content: "# changed after approval\n", baseMtime: mtime });
    doc = await (await get("/docs/doc", { path: "README.md" })).json();
    assert.equal(doc.status, "draft");
  });
  s.cleanup();
});

test("request changes → a source:human item for the PM that links back to the document", async () => {
  const s = sandbox();
  await withDocs(s, asRole("manager"), async ({ get, post }) => {
    assert.equal((await post("/docs/review", { path: "reports/q3.md", decision: "changes" })).status, 400); // a note is required

    const res = await post("/docs/review", {
      path: "reports/q3.md",
      decision: "changes",
      note: "Add the churn numbers\nand a chart",
    });
    assert.equal(res.status, 200);
    const out = await res.json();
    assert.equal(out.status, "draft");
    assert.ok(out.item.id);

    const items = readItems({ projectsDir: s.projectsDir, slug: "acme-web" });
    assert.equal(items.length, 1);
    assert.equal(items[0].source, "human");
    assert.equal(items[0].status, "idea");
    assert.equal(items[0].links.doc, "reports/q3.md");
    assert.match(items[0].title, /reports\/q3\.md/);
    assert.match(items[0].title, /Add the churn numbers/);

    const doc = await (await get("/docs/doc", { path: "reports/q3.md" })).json();
    assert.equal(doc.reviews.at(-1).itemId, items[0].id);
  });
  s.cleanup();
});

test("a very long review note still yields a valid item (title is clipped, full note kept on the review)", async () => {
  const s = sandbox();
  await withDocs(s, {}, async ({ get, post }) => {
    const note = "x".repeat(480);
    const res = await post("/docs/review", { path: "README.md", decision: "changes", note });
    assert.equal(res.status, 200);
    const [item] = readItems({ projectsDir: s.projectsDir, slug: "acme-web" });
    assert.ok(item.title.length <= 200);
    const doc = await (await get("/docs/doc", { path: "README.md" })).json();
    assert.equal(doc.reviews.at(-1).note, note);
  });
  s.cleanup();
});

test("corrupt docs-meta.json is set aside, not silently overwritten", async () => {
  const s = sandbox();
  const metaFile = path.join(s.projectsDir, "acme-web", "docs-meta.json");
  fs.writeFileSync(metaFile, "{ not json");
  await withDocs(s, {}, async ({ post }) => {
    assert.equal((await post("/docs/comment", { path: "README.md", text: "after corruption" })).status, 201);
  });
  const kept = fs.readdirSync(path.join(s.projectsDir, "acme-web")).filter((n) => n.startsWith("docs-meta.corrupt"));
  assert.equal(kept.length, 1);
  assert.equal(fs.readFileSync(path.join(s.projectsDir, "acme-web", kept[0]), "utf8"), "{ not json");
  s.cleanup();
});

// ---- versions via git ------------------------------------------------------------------------

function gitAvailable() {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

test("versions: a file inside a git repo lists its commits and serves an old revision", { skip: !gitAvailable() }, async () => {
  const s = sandbox();
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=Tester", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], {
      cwd: s.cwd,
      stdio: "ignore",
    });
  fs.rmSync(path.join(s.cwd, ".git"), { recursive: true, force: true });
  git("init", "-q");
  git("add", "README.md");
  git("commit", "-q", "-m", "first draft");
  fs.writeFileSync(path.join(s.cwd, "README.md"), "# Acme Web\n\nSecond version.\n");
  git("commit", "-q", "-am", "second draft");

  await withDocs(s, {}, async ({ get }) => {
    const res = await (await get("/docs/versions", { path: "README.md" })).json();
    assert.equal(res.source, "git");
    const commits = res.versions.filter((v) => !v.current);
    assert.deepEqual(commits.map((v) => v.label), ["second draft", "first draft"]);
    const old = await (await get("/docs/version", { path: "README.md", id: commits[1].id })).json();
    assert.match(old.content, /Intro paragraph/);

    // a revision id is validated, never passed through as a git argument
    assert.equal((await get("/docs/version", { path: "README.md", id: "--output=/tmp/x" })).status, 400);
    assert.equal((await get("/docs/version", { path: "README.md", id: "deadbeef" })).status, 404);
  });
  s.cleanup();
});

test("versions: a file with no history still shows its current mtime entry", async () => {
  const s = sandbox();
  await withDocs(s, {}, async ({ get }) => {
    const res = await (await get("/docs/versions", { path: "reports/hero.png" })).json();
    assert.equal(res.source, "snapshots");
    assert.equal(res.versions.length, 1);
    assert.equal(res.versions[0].current, true);
  });
  s.cleanup();
});

// ---- review follow-ups ---------------------------------------------------------------------

/** Raw query strings: URLSearchParams would re-encode %2e / %2f and the server would never see them. */
test("traversal via raw percent-encoded query strings is refused", async () => {
  const s = sandbox();
  await withDocs(s, {}, async ({ base }) => {
    for (const raw of ["..%2Fsecret.md", "%2e%2e%2Fsecret.md", "%2e%2e/secret.md", "reports%2F..%2F..%2Fsecret.md", "%2Fetc%2Fhosts"]) {
      for (const route of ["/docs/doc", "/docs/file"]) {
        const res = await fetch(`${base}${route}?project=acme-web&path=${raw}`);
        assert.ok([400, 403].includes(res.status), `${route} ${raw} → ${res.status}`);
        assert.doesNotMatch(await res.text(), /SECRET/);
      }
    }
  });
  s.cleanup();
});

test("a directory symlink pointing into .git is refused", async () => {
  const s = sandbox();
  fs.symlinkSync(path.join(s.cwd, ".git"), path.join(s.cwd, "gitlink"));
  await withDocs(s, {}, async ({ get }) => {
    assert.equal((await get("/docs/doc", { path: "gitlink/notes.md" })).status, 403);
  });
  s.cleanup();
});

test("a project folder inside a hidden directory (e.g. ~/.claude) is refused", async () => {
  const s = sandbox();
  const hidden = path.join(s.homeDir, ".claude");
  fs.mkdirSync(hidden);
  fs.writeFileSync(path.join(hidden, "CLAUDE.md"), "# agent instructions\n");
  const file = path.join(s.projectsDir, "acme-web", "project.json");
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), cwd: hidden }));
  await withDocs(s, {}, async ({ get, post }) => {
    assert.equal((await get("/docs")).status, 403);
    assert.equal((await post("/docs/save", { path: "CLAUDE.md", content: "pwned", baseMtime: 0 })).status, 403);
  });
  assert.equal(fs.readFileSync(path.join(hidden, "CLAUDE.md"), "utf8"), "# agent instructions\n");
  s.cleanup();
});

test("save: a multibyte character split across request chunks survives", async () => {
  const s = sandbox();
  await withDocs(s, {}, async ({ base, get }) => {
    const { mtime } = await (await get("/docs/doc", { path: "README.md" })).json();
    const text = `# Tiếng Việt\n\n${"Xin chào thế giới. ".repeat(3000)}\n`;
    const bytes = Buffer.from(JSON.stringify({ project: "acme-web", path: "README.md", content: text, baseMtime: mtime }));
    // cut inside a 3-byte character
    const cut = bytes.indexOf(Buffer.from("ế")) + 1;
    await new Promise((resolve, reject) => {
      const req = http.request(`${base}/docs/save`, { method: "POST", headers: { "content-type": "application/json" } }, (res) => {
        res.resume();
        res.on("end", () => (res.statusCode === 200 ? resolve() : reject(new Error(`status ${res.statusCode}`))));
      });
      req.on("error", reject);
      req.write(bytes.subarray(0, cut));
      setTimeout(() => req.end(bytes.subarray(cut)), 30);
    });
  });
  assert.match(fs.readFileSync(path.join(s.cwd, "README.md"), "utf8"), /^# Tiếng Việt/);
  assert.doesNotMatch(fs.readFileSync(path.join(s.cwd, "README.md"), "utf8"), /\uFFFD/);
  s.cleanup();
});

test("save: baseMtime is required", async () => {
  const s = sandbox();
  await withDocs(s, {}, async ({ post }) => {
    assert.equal((await post("/docs/save", { path: "README.md", content: "# x\n" })).status, 400);
  });
  assert.match(fs.readFileSync(path.join(s.cwd, "README.md"), "utf8"), /Intro paragraph/);
  s.cleanup();
});

test("approval does not survive a rewrite of the file behind the app's back", async () => {
  const s = sandbox();
  await withDocs(s, {}, async ({ get, post }) => {
    assert.equal((await approve(get, post, "README.md")).status, 200);
    assert.equal((await (await get("/docs/doc", { path: "README.md" })).json()).status, "approved");
    fs.writeFileSync(path.join(s.cwd, "README.md"), "# an agent rewrote this after approval, with more text\n");
    const doc = await (await get("/docs/doc", { path: "README.md" })).json();
    assert.equal(doc.status, "draft");
    assert.equal(doc.changedSinceApproval, true);
    const listed = (await (await get("/docs")).json()).files.find((f) => f.path === "README.md");
    assert.equal(listed.status, "draft");
  });
  s.cleanup();
});

test("a tampered docs-meta.json cannot delete files, 500 the list, or smuggle a status", async () => {
  const s = sandbox();
  const victim = path.join(s.homeDir, "victim.txt");
  fs.writeFileSync(victim, "keep");
  fs.writeFileSync(
    path.join(s.projectsDir, "acme-web", "docs-meta.json"),
    JSON.stringify({
      version: 1,
      docs: {
        "README.md": { status: 'x" onmouseover="1', comments: "nope", reviews: null, history: [{ id: "../../../victim" }] },
      },
    }),
  );
  await withDocs(s, {}, async ({ get, post }) => {
    const list = await get("/docs");
    assert.equal(list.status, 200);
    const doc = await (await get("/docs/doc", { path: "README.md" })).json();
    assert.equal(doc.status, "draft");
    assert.deepEqual(doc.comments, []);
    const { mtime } = doc;
    assert.equal((await post("/docs/save", { path: "README.md", content: "# a\n", baseMtime: mtime })).status, 200);
  });
  assert.equal(fs.readFileSync(victim, "utf8"), "keep");
  s.cleanup();
});

test("approve: baseMtime is required, and text that changed since it was opened is refused (409)", async () => {
  const s = sandbox();
  await withDocs(s, {}, async ({ get, post }) => {
    assert.equal((await post("/docs/review", { path: "README.md", decision: "approve" })).status, 400);
    const { mtime } = await (await get("/docs/doc", { path: "README.md" })).json();
    fs.writeFileSync(path.join(s.cwd, "README.md"), "# rewritten while the reviewer read the old text\n");
    fs.utimesSync(path.join(s.cwd, "README.md"), new Date(), new Date(Date.now() + 5000));
    assert.equal((await post("/docs/review", { path: "README.md", decision: "approve", baseMtime: mtime })).status, 409);
    assert.equal((await (await get("/docs/doc", { path: "README.md" })).json()).status, "draft");
  });
  s.cleanup();
});

test("snapshots: only the newest 20 are kept, and old ones are removed only after the new text is written", async () => {
  const s = sandbox();
  await withDocs(s, {}, async ({ get, post }) => {
    for (let i = 0; i < 23; i += 1) {
      const { mtime } = await (await get("/docs/doc", { path: "reports/q3.md" })).json();
      assert.equal((await post("/docs/save", { path: "reports/q3.md", content: `# v${i}\n`, baseMtime: mtime })).status, 200);
    }
    const versions = await (await get("/docs/versions", { path: "reports/q3.md" })).json();
    assert.equal(versions.versions.filter((v) => !v.current).length, 20);
  });
  const dir = path.join(s.projectsDir, "acme-web", "docs-history");
  const files = fs.readdirSync(dir).flatMap((d) => fs.readdirSync(path.join(dir, d)));
  assert.equal(files.length, 20); // the 3 oldest files are gone from disk, not just from the list
  s.cleanup();
});

test("a tampered history entry cannot make the prune delete an arbitrary .txt file", async () => {
  const s = sandbox();
  const victim = path.join(s.homeDir, "victim.txt");
  fs.writeFileSync(victim, "keep");
  const history = Array.from({ length: 25 }, (_, i) => ({ id: i === 0 ? "../../../victim" : `v-${i}`, at: "x", by: "owner", size: 1 }));
  fs.writeFileSync(path.join(s.projectsDir, "acme-web", "docs-meta.json"), JSON.stringify({ version: 1, docs: { "README.md": { history } } }));
  await withDocs(s, {}, async ({ get, post }) => {
    const { mtime } = await (await get("/docs/doc", { path: "README.md" })).json();
    assert.equal((await post("/docs/save", { path: "README.md", content: "# a\n", baseMtime: mtime })).status, 200);
  });
  assert.equal(fs.readFileSync(victim, "utf8"), "keep");
  s.cleanup();
});

test("an oversized request body is refused with 413 without being read to the end", async () => {
  const s = sandbox();
  await withDocs(s, {}, async ({ base }) => {
    const res = await fetch(`${base}/docs/comment`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project: "acme-web", path: "README.md", text: "x".repeat(8 * 1024 * 1024) }),
    });
    assert.equal(res.status, 413);
  });
  s.cleanup();
});

test("createProject refuses a folder inside ~/.claude, but not a .claude folder deeper in a repo", () => {
  const s = sandbox();
  const claude = path.join(s.homeDir, ".claude");
  const worktree = path.join(s.homeDir, "repo", ".claude", "worktrees", "wt");
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  const templatesDir = path.join(s.root, "templates");
  const make = (name, cwd) => createProject({ projectsDir: s.projectsDir, templatesDir, homeDir: s.homeDir, name, template: "coding", cwd });
  assert.throws(() => make("Hidden", claude), (e) => e.code === "INVALID");
  assert.equal(make("Nested", worktree).slug, "nested");
  s.cleanup();
});

// a file dragged onto the office lands in <project>/inbox/
const b64 = (text) => Buffer.from(text).toString("base64");

test("upload: a dropped file lands in inbox/, never overwrites, keeps a plain name", async () => {
  const s = sandbox();
  await withDocs(s, asRole("manager"), async ({ post }) => {
    const first = await post("/docs/upload", { name: "brief.pdf", data: b64("%PDF one") });
    assert.equal(first.status, 201);
    assert.equal((await first.json()).path, "inbox/brief.pdf");
    const second = await post("/docs/upload", { name: "brief.pdf", data: b64("%PDF two") });
    assert.equal((await second.json()).path, "inbox/brief (2).pdf");
    assert.equal(fs.readFileSync(path.join(s.cwd, "inbox", "brief.pdf"), "utf8"), "%PDF one");
    for (const name of ["../x.md", "a/b.md", ".env", "..", "", "c:d.md", "invoice\u202Efdp.exe", "a\nb.md", "CON", "nul.txt", "trail.", "a\u2028b.md", "x".repeat(70) + "ệ".repeat(50)]) {
      assert.equal((await post("/docs/upload", { name, data: b64("x") })).status, 400, JSON.stringify(name));
    }
    assert.equal((await post("/docs/upload", { name: "empty.txt", data: "" })).status, 400);
    assert.equal((await post("/docs/upload", { name: "junk.txt", data: "not base64!" })).status, 400);
    assert.equal((await post("/docs/upload", { name: "نامه\u200Cها.txt", data: b64("x") })).status, 201);
    assert.equal((await post("/docs/upload", { name: "big.bin", data: Buffer.alloc(4 * 1024 * 1024 + 1).toString("base64") })).status, 413);
  });
  s.cleanup();
});

test("upload: a viewer cannot drop files, and an inbox link out of the project is refused", async () => {
  const s = sandbox();
  await withDocs(s, asRole("viewer"), async ({ post }) => {
    assert.equal((await post("/docs/upload", { name: "a.txt", data: b64("x") })).status, 403);
  });
  fs.symlinkSync(s.homeDir, path.join(s.cwd, "inbox")); // inbox -> outside the project
  await withDocs(s, asRole("owner"), async ({ post }) => {
    assert.equal((await post("/docs/upload", { name: "pwn.txt", data: b64("x") })).status, 403);
  });
  assert.equal(fs.existsSync(path.join(s.homeDir, "pwn.txt")), false);
  s.cleanup();
});
