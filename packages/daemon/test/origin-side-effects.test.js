// A request with NO Origin header (an <img> tag, a top-level navigation, a link click on a
// foreign page) passes the origin guard. Any GET route with a side effect must therefore
// also refuse requests the browser marks cross-site (Sec-Fetch-Site). The only GET route
// with a side effect today is /harnesses?probe=<key> (spawns the harness CLI).
// The server runs in-process on port 0 and the CLI spawn is faked — no real CLI, no :8787.
import test from "node:test";
import assert from "node:assert/strict";
import { EventBroadcastServer } from "../src/ws-server.js";
import { createOriginGuard } from "../src/origin-guard.js";
import { createHarnessHttpHandler } from "../src/harness-probe.js";

async function withServer(fn) {
  const probes = [];
  const handler = createHarnessHttpHandler({
    probeFn: async ({ bin }) => {
      probes.push(bin);
      return { loggedIn: true };
    },
    checkInstalledFn: () => ({ installed: true, path: "/fake/bin" }),
  });
  const server = new EventBroadcastServer({ port: 0, host: "127.0.0.1", originGuard: createOriginGuard(), extraHttp: handler });
  await server.start();
  const { port } = server.server.address();
  try {
    await fn({ base: `http://127.0.0.1:${port}`, probes });
  } finally {
    server.server.closeAllConnections(); // fetch keeps sockets alive; stop() would wait on them
    await server.stop();
  }
}

test("probe with no Origin but Sec-Fetch-Site: cross-site (img tag / link click) does NOT spawn", async () => {
  await withServer(async ({ base, probes }) => {
    for (const site of ["cross-site", "same-site"]) {
      const res = await fetch(`${base}/harnesses?probe=gemini`, { headers: { "sec-fetch-site": site } });
      assert.equal(res.status, 403, site);
    }
    assert.deepEqual(probes, []);
  });
});

test("probe still works for the served app (same-origin), curl (no header) and the address bar (none)", async () => {
  await withServer(async ({ base, probes }) => {
    for (const site of ["same-origin", "none", undefined]) {
      const res = await fetch(`${base}/harnesses?probe=claude`, { headers: site ? { "sec-fetch-site": site } : {} });
      assert.equal(res.status, 200, String(site));
    }
    assert.equal(probes.length, 3);
  });
});

test("the cheap list GET /harnesses (no probe) is unaffected by Sec-Fetch-Site", async () => {
  await withServer(async ({ base }) => {
    const res = await fetch(`${base}/harnesses`, { headers: { "sec-fetch-site": "cross-site" } });
    assert.equal(res.status, 200);
  });
});
