// End to end through the real pieces: raw transcript lines → normalizers →
// broadcast server → radar / metrics → WebSocket + HTTP.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { EventBroadcastServer } from "../src/ws-server.js";
import { SessionNormalizer } from "../src/normalize.js";
import { CodexSessionNormalizer } from "../src/codex-normalize.js";
import { GeminiSessionNormalizer } from "../src/gemini-normalize.js";
import { attachRadar, createRadarHttpHandler } from "../src/radar.js";
import { attachInterventionMetrics, createMetricsHttpHandler } from "../src/intervention-metrics.js";

const nowIso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

function claudeEdit(cwd, file, id) {
  return {
    type: "assistant",
    uuid: `u-${id}`,
    cwd,
    timestamp: nowIso(),
    message: { content: [{ type: "tool_use", id: `tu-${id}`, name: "Edit", input: { file_path: file, old_string: "a", new_string: "b" } }] },
  };
}

test("normalizers attach meta.paths to write-tool start events, and only those", () => {
  const claude = new SessionNormalizer("s1", {});
  const [, start] = claude.normalizeLine(claudeEdit("/w/demo-app", "/w/demo-app/a.ts", 1));
  assert.deepEqual(start.meta.paths, ["/w/demo-app/a.ts"]);
  const read = new SessionNormalizer("s2", {}).normalizeLine({
    type: "assistant", uuid: "r", cwd: "/w", timestamp: nowIso(),
    message: { content: [{ type: "tool_use", id: "t", name: "Read", input: { file_path: "/w/a.ts" } }] },
  });
  assert.equal(read.at(-1).meta.paths, undefined);

  const codex = new CodexSessionNormalizer("thread-1");
  codex.normalizeLine({ timestamp: nowIso(), type: "session_meta", payload: { cwd: "/w/p" } });
  const cEvents = codex.normalizeLine({
    timestamp: nowIso(), type: "response_item",
    payload: { type: "custom_tool_call", call_id: "c1", name: "apply_patch", input: "*** Begin Patch\n*** Update File: src/z.ts\n@@\n+x\n*** End Patch" },
  });
  assert.deepEqual(cEvents[0].meta.paths, ["/w/p/src/z.ts"]);

  const gemini = new GeminiSessionNormalizer("g1");
  const gEvents = gemini.normalizeMessage(
    { id: "m1", type: "gemini", timestamp: nowIso(), content: "", toolCalls: [{ id: "tc1", name: "write_file", args: { file_path: "/w/g.md", content: "x" }, status: "success", timestamp: nowIso() }] },
    { cwd: "/w" },
  );
  assert.deepEqual(gEvents.find((e) => e.id === "tc1:start").meta.paths, ["/w/g.md"]);
});

test("daemon wiring: two sessions edit one file → ONE collision_alert reaches a WS client; /radar and /radar/touching agree; metrics endpoint answers", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ao-l4-"));
  let radarHttp;
  let metricsHttp;
  const srv = new EventBroadcastServer({
    port: 0,
    extraHttp: (req, res, url) => radarHttp(req, res, url) || metricsHttp(req, res, url),
  });
  await srv.start();
  const radar = attachRadar(srv, { notify: () => {}, checkout: () => null, checkoutDir: () => null });
  const metrics = attachInterventionMetrics(srv, { dir, flushMs: 0, projectOf: () => null });
  radarHttp = createRadarHttpHandler(radar);
  metricsHttp = createMetricsHttpHandler(metrics);

  const { port } = srv.server.address();
  const seen = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  ws.on("message", (m) => seen.push(JSON.parse(String(m))));
  await new Promise((r) => ws.on("open", r));

  const feed = (sessionId, raw) => {
    for (const e of new SessionNormalizer(sessionId, {}).normalizeLine(raw)) srv.broadcast(e);
  };
  feed("sess-a", claudeEdit("/w/demo-app", "/w/demo-app/src/x.ts", "a1"));
  feed("sess-b", claudeEdit("/w/demo-app", "/w/demo-app/src/x.ts", "b1"));
  feed("sess-b", claudeEdit("/w/demo-app", "/w/demo-app/src/x.ts", "b2"));
  await new Promise((r) => setTimeout(r, 100));

  const alerts = seen.filter((e) => e.type === "collision_alert");
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].sessionId, "sess-b");
  assert.equal(alerts[0].meta.kind, "file");

  const base = `http://127.0.0.1:${port}`;
  const list = await (await fetch(`${base}/radar`)).json();
  assert.equal(list.alerts.length, 1);
  assert.equal(list.alerts[0].alertId, alerts[0].meta.alertId);

  const who = await (await fetch(`${base}/radar/touching?path=${encodeURIComponent("src/x.ts")}&cwd=${encodeURIComponent("/w/demo-app")}&exclude=sess-b`)).json();
  assert.deepEqual(who.touching.map((t) => t.sessionId), ["sess-a"]);
  assert.equal((await fetch(`${base}/radar/touching`)).status, 400);

  const m = await (await fetch(`${base}/metrics/intervention?days=1`)).json();
  assert.equal(m.total.count, 0);

  ws.close();
  radar.stop();
  metrics.stop();
  await srv.stop();
});
