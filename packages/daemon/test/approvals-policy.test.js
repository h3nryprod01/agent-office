import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventBroadcastServer } from "../src/ws-server.js";
import { makeEvent } from "../src/event-schema.js";
import { ApprovalBroker, createApprovalHttpHandler } from "../src/approvals.js";
import { PolicyEngine } from "../src/policy-engine.js";
import { PolicyStore } from "../src/policy-store.js";
import { handleMessage } from "../hooks/approval-mcp.mjs";

const GATEWAY = fileURLToPath(new URL("../hooks/approve-gateway.mjs", import.meta.url));
const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));

let tmp;
let projectsDir;
let repo;

function mkProject(slug, cwd, policy) {
  const dir = path.join(projectsDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "project.json"),
    JSON.stringify({ version: 1, slug, name: slug, template: "coding", cwd, createdAt: "2026-01-01T00:00:00Z", ...(policy ? { policy } : {}) }),
  );
}

function mk({ policy, hasClients = () => true, overBudget = false } = {}) {
  const store = new PolicyStore({ projectsDir, cacheMs: 0 });
  const broadcasts = [];
  const broker = new ApprovalBroker({
    broadcast: (e) => broadcasts.push(e),
    hasClients,
    makeEvent,
    ttlMs: 300,
    policy: new PolicyEngine({ store, isOverBudget: () => overBudget }),
  });
  return { broker, broadcasts, store };
}
const req = (over = {}) => ({ sessionId: "s1", tool: "Bash", toolInput: { command: "npm test" }, cwd: repo, ...over });

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ao-approvals-policy-")));
  projectsDir = path.join(tmp, "projects");
  repo = path.join(tmp, "work", "acme-web");
  fs.mkdirSync(repo, { recursive: true });
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

// ── broker ─────────────────────────────────────────────────────────────────
test("auto: answered at once — no pending item, even with no office open — and announced as a policy decision", async () => {
  mkProject("acme-web", repo, { approval: { mode: "auto" } });
  const { broker, broadcasts } = mk({ hasClients: () => false });
  const result = await broker.request(req());
  assert.equal(result.decision, "allow");
  assert.equal(result.source, "policy");
  assert.equal(broker.list().length, 0);
  assert.equal(broadcasts.length, 1);
  assert.equal(broadcasts[0].type, "approval_resolved");
  assert.equal(broadcasts[0].meta.source, "policy");
  assert.equal(broadcasts[0].meta.decision, "allow");
  assert.equal(broadcasts[0].meta.policy.mode, "auto");
});

test("read-only: write is denied with a message the agent will see", async () => {
  mkProject("acme-web", repo, { approval: { mode: "read-only" } });
  const { broker } = mk();
  const result = await broker.request(req());
  assert.equal(result.decision, "deny");
  assert.match(result.message, /read-only/);
});

test("auto + dangerous: becomes a normal pending approval carrying the reasons", async () => {
  mkProject("acme-web", repo, { approval: { mode: "auto" } });
  const { broker, broadcasts } = mk();
  const p = broker.request(req({ toolInput: { command: "git push --force" } }));
  const [item] = broker.list();
  assert.equal(item.policy.forced, "danger");
  assert.deepEqual(item.policy.reasons, ["force-push"]);
  assert.equal(broadcasts[0].type, "approval_pending");
  assert.deepEqual(broadcasts[0].meta.policy.reasons, ["force-push"]);
  broker.respond(item.id, "deny");
  assert.equal((await p).decision, "deny");
});

test("auto + dangerous + no office open → 'none' like before (the terminal dialog decides)", async () => {
  mkProject("acme-web", repo, { approval: { mode: "auto" } });
  const { broker } = mk({ hasClients: () => false });
  const result = await broker.request(req({ toolInput: { command: "rm -rf build" } }));
  assert.equal(result.decision, "none");
});

test("project without policy / cwd in no project → exactly the old flow", async () => {
  mkProject("acme-web", repo);
  const { broker } = mk();
  const p = broker.request(req());
  assert.equal(broker.list().length, 1);
  broker.respond(broker.list()[0].id, "allow");
  assert.equal((await p).decision, "allow");
  const q = broker.request(req({ cwd: path.join(tmp, "elsewhere") }));
  assert.equal(broker.list().length, 1);
  broker.respond(broker.list()[0].id, "deny");
  assert.equal((await q).decision, "deny");
});

test("an engine that throws never auto-answers: falls back to asking", async () => {
  const broker = new ApprovalBroker({
    broadcast: () => {},
    hasClients: () => true,
    makeEvent,
    ttlMs: 200,
    policy: { evaluate: () => { throw new Error("boom"); } },
  });
  const p = broker.request(req());
  assert.equal(broker.list().length, 1);
  assert.equal((await p).decision, "none"); // ttl
});

// ── HTTP: the same path the hook and the MCP tool use ──────────────────────
async function startServer(broker) {
  const srv = new EventBroadcastServer({ port: 0, extraHttp: createApprovalHttpHandler(broker) });
  await srv.start();
  return { srv, base: `http://127.0.0.1:${srv.server.address().port}` };
}
const post = (base, body) =>
  fetch(`${base}/approval-request`, { method: "POST", body: JSON.stringify(body) }).then((r) => r.json());

test("HTTP: toolInput/cwd/harness/lane/role reach the engine; policy answers come back with source+message", async () => {
  mkProject("acme-web", repo, { approval: { mode: "ask", roles: { qa: "read-only" }, tools: { Read: "auto" } } });
  const { broker, store } = mk();
  const { srv, base } = await startServer(broker);
  try {
    const denied = await post(base, { sessionId: "s1", tool: "Bash", toolInput: { command: "ls" }, cwd: repo, role: "qa", harness: "claude-worker", lane: "deepseek" });
    assert.equal(denied.decision, "deny");
    assert.equal(denied.source, "policy");
    assert.match(denied.message, /read-only/);
    const allowed = await post(base, { sessionId: "s1", tool: "Read", toolInput: { file_path: "src/a.ts" }, cwd: repo });
    assert.equal(allowed.decision, "allow");
    const rows = store.readAudit("acme-web");
    assert.equal(rows.length, 2);
    assert.equal(rows[1].harness, "claude-worker");
    assert.equal(rows[1].lane, "deepseek");
    assert.equal(rows[1].role, "qa");
  } finally {
    await srv.stop();
  }
});

test("HTTP: junk harness/lane/role values are dropped, not trusted", async () => {
  mkProject("acme-web", repo, { approval: { mode: "ask", roles: { qa: "read-only" } } });
  const { broker, store } = mk();
  const { srv, base } = await startServer(broker);
  try {
    await post(base, { tool: "Bash", toolInput: { command: "ls" }, cwd: repo, role: "qa", harness: "<script>", lane: "x".repeat(500) });
    const [row] = store.readAudit("acme-web");
    assert.equal(row.harness, "claude");
    assert.equal(row.lane, null);
  } finally {
    await srv.stop();
  }
});

// ── the REAL hook output format (see fixtures/permission-request-decisions.json) ─
function runGateway(stdinPayload, env) {
  return new Promise((resolve) => {
    const child = execFile(process.execPath, [GATEWAY], { env: { ...process.env, ...env }, timeout: 10_000 }, (error, stdout) =>
      resolve({ code: error?.code ?? 0, stdout }),
    );
    child.stdin.end(JSON.stringify(stdinPayload));
  });
}

async function stubDaemon(answer) {
  const seen = [];
  const stub = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push(JSON.parse(body));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(answer));
    });
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  return { stub, seen, port: String(stub.address().port) };
}

test("gateway: a policy deny prints exactly the verified deny+message document", async () => {
  const { stub, port } = await stubDaemon({ id: "x", decision: "deny", source: "policy", message: "denied by AO policy test" });
  try {
    const { stdout } = await runGateway(fixture("permission-request-bash.json"), { AGENT_OFFICE_PORT: port });
    assert.deepEqual(JSON.parse(stdout), fixture("permission-request-decisions.json").denyWithMessage);
  } finally {
    stub.close();
  }
});

test("gateway: a policy allow prints exactly the verified allow document", async () => {
  const { stub, port } = await stubDaemon({ id: "x", decision: "allow", source: "policy" });
  try {
    const { stdout } = await runGateway(fixture("permission-request-write.json"), { AGENT_OFFICE_PORT: port });
    assert.deepEqual(JSON.parse(stdout), fixture("permission-request-decisions.json").allow);
  } finally {
    stub.close();
  }
});

test("gateway: a human deny (no message) still prints a plain deny; 'none' prints nothing", async () => {
  const human = await stubDaemon({ id: "x", decision: "deny" });
  const none = await stubDaemon({ id: null, decision: "none" });
  try {
    const a = await runGateway(fixture("permission-request-bash.json"), { AGENT_OFFICE_PORT: human.port });
    assert.deepEqual(JSON.parse(a.stdout).hookSpecificOutput.decision, { behavior: "deny" });
    const b = await runGateway(fixture("permission-request-bash.json"), { AGENT_OFFICE_PORT: none.port });
    assert.equal(b.stdout, "");
  } finally {
    human.stub.close();
    none.stub.close();
  }
});

test("gateway: forwards the real payload fields (cwd, full command, harness/lane/role from env) and flags truncation", async () => {
  const { stub, seen, port } = await stubDaemon({ id: null, decision: "none" });
  try {
    const long = { ...fixture("permission-request-bash.json"), tool_input: { command: `echo ok # ${"x".repeat(9000)}` } };
    await runGateway(long, { AGENT_OFFICE_PORT: port, AGENT_OFFICE_HARNESS: "claude-worker", AGENT_OFFICE_LANE: "deepseek", AGENT_OFFICE_ROLE: "dev" });
    const body = seen[0];
    assert.equal(body.cwd, "/work/demo-app");
    assert.equal(body.tool, "Bash");
    assert.equal(body.harness, "claude-worker");
    assert.equal(body.lane, "deepseek");
    assert.equal(body.role, "dev");
    assert.equal(body.toolInput._truncated, true); // too long to inspect → daemon treats it as dangerous
    assert.ok(body.toolInput.command.length <= 8000);

    seen.length = 0;
    await runGateway(fixture("permission-request-bash.json"), { AGENT_OFFICE_PORT: port });
    assert.equal(seen[0].toolInput._truncated, undefined);
    assert.equal(seen[0].toolInput.command, "touch marker.txt");
    assert.equal(seen[0].harness, "claude"); // default when the env is unset
  } finally {
    stub.close();
  }
});

// ── MCP permission tool (the PM chat path) ─────────────────────────────────
test("MCP tool: a policy deny reaches the agent with its message; allow passes the input through", async () => {
  const call = (approve) =>
    handleMessage(
      { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "approval_prompt", arguments: { tool_name: "Bash", input: { command: "ls" } } } },
      approve,
    ).then((r) => JSON.parse(r.result.content[0].text));
  const denied = await call(async () => ({ decision: "deny", message: "Denied by Agent Office policy (read-only): Bash can run commands." }));
  assert.deepEqual(denied, { behavior: "deny", message: "Denied by Agent Office policy (read-only): Bash can run commands." });
  const allowed = await call(async () => ({ decision: "allow" }));
  assert.deepEqual(allowed, { behavior: "allow", updatedInput: { command: "ls" } });
  const legacy = await call(async () => "deny"); // old string contract still works
  assert.equal(legacy.behavior, "deny");
});
