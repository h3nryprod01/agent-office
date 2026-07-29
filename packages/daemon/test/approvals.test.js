import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { EventBroadcastServer } from "../src/ws-server.js";
import { makeEvent } from "../src/event-schema.js";
import { ApprovalBroker, createApprovalHttpHandler, previewToolInput } from "../src/approvals.js";

const GATEWAY = fileURLToPath(new URL("../hooks/approve-gateway.mjs", import.meta.url));

function mkBroker(overrides = {}) {
  const broadcasts = [];
  const broker = new ApprovalBroker({
    broadcast: (e) => broadcasts.push(e),
    hasClients: () => true,
    makeEvent,
    ttlMs: 200,
    ...overrides,
  });
  return { broker, broadcasts };
}

// ── broker ────────────────────────────────────────────────────────────────

test("no office client connected → immediate none, no pending, no broadcast", async () => {
  const { broker, broadcasts } = mkBroker({ hasClients: () => false });
  const result = await broker.request({ sessionId: "s1", tool: "Bash" });
  assert.deepEqual(result, { id: null, decision: "none" });
  assert.equal(broker.list().length, 0);
  assert.equal(broadcasts.length, 0);
});

test("request tags budgetExceeded=true when isOverBudget()", async () => {
  const { broker } = mkBroker({ isOverBudget: () => true });
  const p = broker.request({ sessionId: "s1", tool: "Bash" });
  assert.equal(broker.list()[0].budgetExceeded, true);
  broker.respond(broker.list()[0].id, "deny");
  await p;
});

test("budgetExceeded=false by default (no isOverBudget injected)", async () => {
  const { broker } = mkBroker();
  const p = broker.request({ sessionId: "s1", tool: "Bash" });
  assert.equal(broker.list()[0].budgetExceeded, false);
  broker.respond(broker.list()[0].id, "deny");
  await p;
});

test("request → office responds allow → resolves allow + broadcasts pending/resolved", async () => {
  const { broker, broadcasts } = mkBroker();
  const promise = broker.request({ sessionId: "s1", tool: "Bash", preview: "rm -rf x" });
  assert.equal(broker.list().length, 1);
  const { id } = broker.list()[0];

  const respondResult = broker.respond(id, "allow");
  assert.equal(respondResult.ok, true);
  const result = await promise;
  assert.deepEqual(result, { id, decision: "allow" });
  assert.equal(broker.list().length, 0);
  assert.deepEqual(
    broadcasts.map((e) => e.type),
    ["approval_pending", "approval_resolved"]
  );
  assert.equal(broadcasts[0].meta.preview, "rm -rf x");
  assert.equal(broadcasts[1].meta.decision, "allow");
  assert.equal(broadcasts[1].meta.source, "office");
});

test("TTL expiry → none + resolved(expired); late respond is rejected", async () => {
  const { broker, broadcasts } = mkBroker({ ttlMs: 50 });
  const promise = broker.request({ sessionId: "s1", tool: "Write" });
  const { id } = broker.list()[0];
  const result = await promise; // resolves via TTL timer
  assert.equal(result.decision, "none");
  assert.equal(broadcasts[1].meta.source, "expired");

  const late = broker.respond(id, "allow");
  assert.equal(late.ok, false);
});

test("respond: unknown id and garbage decision are rejected", () => {
  const { broker } = mkBroker();
  assert.equal(broker.respond("nope", "allow").ok, false);
  const p = broker.request({ sessionId: "s1", tool: "Bash" });
  const { id } = broker.list()[0];
  assert.equal(broker.respond(id, "ALLOW-ALL").ok, false); // still pending
  assert.equal(broker.list().length, 1);
  broker.respond(id, "deny");
  return p;
});

test("previewToolInput: command, file_path, fallback json", () => {
  assert.equal(previewToolInput("Bash", { command: "ls -la" }), "ls -la");
  assert.equal(previewToolInput("Edit", { file_path: "/a/b.ts" }), "/a/b.ts");
  assert.equal(previewToolInput("X", null), "");
  assert.ok(previewToolInput("X", { foo: 1 }).includes("foo"));
});

// ── HTTP endpoints (real server, extraHttp wiring same as index.js) ──────

async function startServer(broker) {
  const srv = new EventBroadcastServer({
    port: 0,
    extraHttp: createApprovalHttpHandler(broker),
  });
  await srv.start();
  const { port } = srv.server.address();
  return { srv, base: `http://127.0.0.1:${port}` };
}

test("HTTP: request long-polls until response endpoint decides", async () => {
  const { broker } = mkBroker({ ttlMs: 5000 });
  const { srv, base } = await startServer(broker);
  try {
    const requestPromise = fetch(`${base}/approval-request`, {
      method: "POST",
      body: JSON.stringify({ sessionId: "s1", tool: "Bash", toolInput: { command: "make deploy" } }),
    }).then((r) => r.json());

    // wait until pending shows up in GET /approvals, then answer it
    let items = [];
    for (let i = 0; i < 50 && items.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      items = (await (await fetch(`${base}/approvals`)).json()).items;
    }
    assert.equal(items.length, 1);
    assert.equal(items[0].preview, "make deploy");

    const respondJson = await (
      await fetch(`${base}/approval-response`, {
        method: "POST",
        body: JSON.stringify({ id: items[0].id, decision: "deny" }),
      })
    ).json();
    assert.equal(respondJson.ok, true);

    const result = await requestPromise;
    assert.equal(result.decision, "deny");
  } finally {
    await srv.stop();
  }
});

test("HTTP: garbage bodies → 400 / decision none, never a crash", async () => {
  const { broker } = mkBroker();
  const { srv, base } = await startServer(broker);
  try {
    const bad = await fetch(`${base}/approval-request`, { method: "POST", body: "{{{" });
    assert.equal((await bad.json()).decision, "none");
    const badResp = await fetch(`${base}/approval-response`, { method: "POST", body: "junk" });
    assert.equal(badResp.status, 400);
  } finally {
    await srv.stop();
  }
});

// ── gateway script fail-open (spawn the real hook as a child process) ─────

function runGateway(stdinPayload, env = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [GATEWAY],
      { env: { ...process.env, ...env }, timeout: 10_000 },
      (error, stdout) => resolve({ code: error?.code ?? 0, stdout })
    );
    child.stdin.end(typeof stdinPayload === "string" ? stdinPayload : JSON.stringify(stdinPayload));
  });
}

const PAYLOAD = {
  session_id: "sess-1",
  tool_name: "Bash",
  tool_input: { command: "touch /tmp/x" },
  cwd: "/tmp",
  permission_mode: "default",
  hook_event_name: "PermissionRequest",
};

test("gateway: daemon down → silence, exit 0", async () => {
  const { code, stdout } = await runGateway(PAYLOAD, { AGENT_OFFICE_PORT: "1" }); // nothing listens on port 1
  assert.equal(code, 0);
  assert.equal(stdout, "");
});

test("gateway: garbage stdin → silence, exit 0", async () => {
  const { code, stdout } = await runGateway("not json {{{");
  assert.equal(code, 0);
  assert.equal(stdout, "");
});

test("gateway: daemon returns garbage / non-decision → silence, exit 0", async () => {
  const stub = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end("this is not json");
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const { port } = stub.address();
  try {
    const { code, stdout } = await runGateway(PAYLOAD, { AGENT_OFFICE_PORT: String(port) });
    assert.equal(code, 0);
    assert.equal(stdout, "");
  } finally {
    stub.close();
  }
});

test("gateway: daemon hangs → abort at APPROVE_GATEWAY_TIMEOUT_MS, silence, exit 0", async () => {
  const stub = createServer(() => {
    /* never respond */
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const { port } = stub.address();
  try {
    const t0 = Date.now();
    const { code, stdout } = await runGateway(PAYLOAD, {
      AGENT_OFFICE_PORT: String(port),
      APPROVE_GATEWAY_TIMEOUT_MS: "300",
    });
    assert.equal(code, 0);
    assert.equal(stdout, "");
    assert.ok(Date.now() - t0 < 5000, "must give up right after the fetch abort");
  } finally {
    stub.close();
  }
});

test("gateway: decision allow/deny → prints exact PermissionRequest JSON", async () => {
  for (const decision of ["allow", "deny"]) {
    const stub = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "a-1", decision }));
    });
    await new Promise((r) => stub.listen(0, "127.0.0.1", r));
    const { port } = stub.address();
    try {
      const { code, stdout } = await runGateway(PAYLOAD, { AGENT_OFFICE_PORT: String(port) });
      assert.equal(code, 0);
      assert.deepEqual(JSON.parse(stdout), {
        hookSpecificOutput: {
          hookEventName: "PermissionRequest",
          decision: { behavior: decision },
        },
      });
    } finally {
      stub.close();
    }
  }
});

test("gateway: never converts none into a decision", async () => {
  const stub = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: null, decision: "none" }));
  });
  await new Promise((r) => stub.listen(0, "127.0.0.1", r));
  const { port } = stub.address();
  try {
    const { stdout } = await runGateway(PAYLOAD, { AGENT_OFFICE_PORT: String(port) });
    assert.equal(stdout, "");
  } finally {
    stub.close();
  }
});
