import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PolicyEngine, redact } from "../src/policy-engine.js";
import { PolicyStore } from "../src/policy-store.js";

let tmp;
let projectsDir;
let repo;
let store;

function mkProject(slug, cwd, policy) {
  const dir = path.join(projectsDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "project.json"),
    JSON.stringify({ version: 1, slug, name: slug, template: "coding", cwd, createdAt: "2026-01-01T00:00:00Z", ...(policy ? { policy } : {}) }),
  );
}
const engine = (opts = {}) => new PolicyEngine({ store, now: () => 1_700_000_000_000, ...opts });
const req = (over = {}) => ({
  sessionId: "s-1",
  tool: "Bash",
  toolInput: { command: "npm test" },
  cwd: repo,
  ...over,
});

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ao-policy-engine-")));
  projectsDir = path.join(tmp, "projects");
  repo = path.join(tmp, "work", "acme-web");
  fs.mkdirSync(repo, { recursive: true });
  store = new PolicyStore({ projectsDir, cacheMs: 0 });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("cwd outside every project → null (caller keeps today's flow)", () => {
  mkProject("acme-web", repo, { approval: { mode: "auto" } });
  assert.equal(engine().evaluate(req({ cwd: path.join(tmp, "other") })), null);
  assert.equal(engine().evaluate(req({ cwd: null })), null);
});

test("project without policy → ask, and nothing is audited", () => {
  mkProject("acme-web", repo);
  const v = engine().evaluate(req());
  assert.equal(v.decision, "ask");
  assert.deepEqual(store.readAudit("acme-web"), []);
});

test("mode ask → ask, not audited (a human decides, nothing automatic happened)", () => {
  mkProject("acme-web", repo, { approval: { mode: "ask" } });
  assert.equal(engine().evaluate(req({ toolInput: { command: "rm -rf x" } })).decision, "ask");
  assert.deepEqual(store.readAudit("acme-web"), []);
});

test("auto allow is audited with who/what/where/when/which mode", () => {
  mkProject("acme-web", repo, { approval: { mode: "auto" } });
  const v = engine().evaluate(req({ harness: "claude-worker", lane: "deepseek", role: "dev" }));
  assert.equal(v.decision, "allow");
  assert.equal(v.project, "acme-web");
  const [row] = store.readAudit("acme-web");
  assert.deepEqual(
    { ...row, preview: undefined },
    {
      ts: 1_700_000_000_000,
      project: "acme-web",
      sessionId: "s-1",
      agent: "acme-web",
      harness: "claude-worker",
      lane: "deepseek",
      role: "dev",
      tool: "Bash",
      preview: undefined,
      mode: "auto",
      modeSource: "project",
      decision: "allow",
      reasons: [],
      forced: null,
    },
  );
  assert.equal(row.preview, "npm test");
});

test("auto + dangerous → ask, and the forced ask is audited so the UI can say why", () => {
  mkProject("acme-web", repo, { approval: { mode: "auto" } });
  const v = engine().evaluate(req({ toolInput: { command: "git push --force" } }));
  assert.equal(v.decision, "ask");
  assert.equal(v.forced, "danger");
  const [row] = store.readAudit("acme-web");
  assert.equal(row.decision, "ask");
  assert.equal(row.forced, "danger");
  assert.deepEqual(row.reasons, ["force-push"]);
});

test("over budget forces auto → ask (budget flag comes from the injected probe)", () => {
  mkProject("acme-web", repo, { approval: { mode: "auto" } });
  const v = engine({ isOverBudget: () => true }).evaluate(req());
  assert.equal(v.decision, "ask");
  assert.equal(v.forced, "budget");
});

test("read-only denial is audited and carries a message for the agent", () => {
  mkProject("acme-web", repo, { approval: { mode: "read-only" } });
  const v = engine().evaluate(req());
  assert.equal(v.decision, "deny");
  assert.match(v.message, /read-only/);
  assert.equal(store.readAudit("acme-web")[0].decision, "deny");
});

test("role override picks the member's mode", () => {
  mkProject("acme-web", repo, { approval: { mode: "ask", roles: { qa: "read-only", pm: "auto" } } });
  assert.equal(engine().evaluate(req({ role: "qa" })).decision, "deny");
  assert.equal(engine().evaluate(req({ role: "pm" })).decision, "allow");
  assert.equal(engine().evaluate(req({ role: "other" })).decision, "ask");
});

test("sessions in a sub-directory of the project resolve to it; writes are judged against the PROJECT root", () => {
  mkProject("acme-web", repo, { approval: { mode: "auto" } });
  const sub = path.join(repo, "packages", "api");
  fs.mkdirSync(sub, { recursive: true });
  const ok = engine().evaluate(req({ cwd: sub, tool: "Write", toolInput: { file_path: path.join(repo, "README.md") } }));
  assert.equal(ok.decision, "allow");
  const out = engine().evaluate(req({ cwd: sub, tool: "Write", toolInput: { file_path: path.join(tmp, "x.txt") } }));
  assert.equal(out.decision, "ask");
});

test("audit rows never contain credentials typed on a command line", () => {
  mkProject("acme-web", repo, { approval: { mode: "auto" } });
  engine().evaluate(req({ toolInput: { command: 'curl -H "Authorization: Bearer abcDEF1234567890xyz" https://example.com/api' } }));
  engine().evaluate(req({ toolInput: { command: "API_KEY=sk-live-1234567890abcdef node run.js" } })); // leak-ok: invented fixture value
  const text = fs.readFileSync(path.join(projectsDir, "acme-web", "policy-audit.jsonl"), "utf8");
  assert.ok(!text.includes("abcDEF1234567890xyz"));
  assert.ok(!text.includes("sk-live-1234567890abcdef"));
  assert.ok(text.includes("***"));
});

test("redact: bearer tokens, key=value secrets, long preview truncated", () => {
  assert.equal(redact("echo hi"), "echo hi");
  assert.ok(!redact("TOKEN=abc123def456 run").includes("abc123def456"));
  assert.ok(!redact("password: hunter22hunter").includes("hunter22"));
  assert.ok(redact("x".repeat(500)).length <= 200);
});

test("redact: URL credentials and password flags", () => {
  for (const [input, leak] of [
    ["git clone https://user:hunter2xx@example.com/r.git", "hunter2xx"],
    ["psql postgres://app:s3cretpw@db/prod", "s3cretpw"],
    ["mysql --password hunter2xx -h db", "hunter2xx"],
    ["curl -u admin:hunter2xx https://x.example", "hunter2xx"],
    ["mysql -phunter2xx db", "hunter2xx"],
    ["echo github_pat_11ABCDEFG0123456789abcdef", "ABCDEFG0123456789"], // leak-ok: invented fixture value
  ]) assert.ok(!redact(input).includes(leak), `${input} -> ${redact(input)}`);
  assert.equal(redact("npm run build -p 4"), "npm run build -p 4"); // short flag values stay readable
});

test("an audit-write failure never changes the verdict", () => {
  mkProject("acme-web", repo, { approval: { mode: "auto" } });
  store.appendAudit = () => {
    throw new Error("disk full");
  };
  assert.equal(engine().evaluate(req()).decision, "allow");
});
