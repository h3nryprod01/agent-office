import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EventBroadcastServer } from "../src/ws-server.js";

async function getWorkItems(srv) {
  const { port } = srv.server.address();
  const res = await fetch(`http://127.0.0.1:${port}/work-items`);
  return { status: res.status, body: await res.json() };
}

async function withServer(workItemsPath, fn) {
  const srv = new EventBroadcastServer({ port: 0, workItemsPath });
  await srv.start();
  try {
    await fn(srv);
  } finally {
    await srv.stop();
  }
}

test("GET /work-items serves the registry file as-is", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wi-"));
  const file = path.join(dir, "work-items.json");
  const registry = {
    version: 1,
    items: [{ id: "wi-x", title: "X", status: "in_progress", pr: null }],
  };
  writeFileSync(file, JSON.stringify(registry));
  try {
    await withServer(file, async (srv) => {
      const { status, body } = await getWorkItems(srv);
      assert.equal(status, 200);
      assert.deepEqual(body, registry);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("GET /work-items with a missing file returns an empty registry", async () => {
  await withServer("/nonexistent/work-items.json", async (srv) => {
    const { status, body } = await getWorkItems(srv);
    assert.equal(status, 200);
    assert.deepEqual(body, { version: 1, items: [] });
  });
});

test("GET /work-items with a corrupt file returns an empty registry", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wi-"));
  const file = path.join(dir, "work-items.json");
  try {
    writeFileSync(file, "{ not json");
    await withServer(file, async (srv) => {
      assert.deepEqual((await getWorkItems(srv)).body, { version: 1, items: [] });
    });
    // valid JSON but wrong shape → also degrades, never a 500
    writeFileSync(file, JSON.stringify({ version: 1 }));
    await withServer(file, async (srv) => {
      assert.deepEqual((await getWorkItems(srv)).body, { version: 1, items: [] });
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
