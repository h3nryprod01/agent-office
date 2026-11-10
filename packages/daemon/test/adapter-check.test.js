import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkAdapters } from "../src/cli/adapter-check.js";
import { runChecks } from "../src/cli/doctor.js";
import { hasSqlite, makeHermesDb } from "./hermes-fixture.js";

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), "ao-adapters-"));
const put = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const byId = (r, id) => r.find((x) => x.id === id);
const run = (h, extra = {}) => checkAdapters({ homeDir: h, env: {}, now: () => NOW, ...extra });

const CLAUDE = [
  { type: "user", cwd: "/w/demo", version: "2.1.300", timestamp: "2026-11-10T11:59:00Z", message: { role: "user", content: "go" } },
  { type: "assistant", uuid: "a1", cwd: "/w/demo", version: "2.1.300", timestamp: "2026-11-10T11:59:05Z", message: { model: "claude-x", content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/w/demo/a.txt" } }] } },
]
  .map((l) => JSON.stringify(l))
  .join("\n");

test("claude-code: newest transcript parses into events and reports the version that wrote it", async () => {
  const h = home();
  put(path.join(h, ".claude", "projects", "p1", "s1.jsonl"), CLAUDE + "\n");
  const r = byId(await run(h), "adapter-claude-code");
  assert.equal(r.status, "ok");
  assert.match(r.detail, /2\.1\.300/);
  assert.match(r.detail, /events/);
});

test("claude-code: a transcript whose lines produce nothing is a warning, not silence", async () => {
  const h = home();
  put(path.join(h, ".claude", "projects", "p1", "s1.jsonl"), '{"type":"mystery","x":1}\n{"type":"mystery","x":2}\n');
  const r = byId(await run(h), "adapter-claude-code");
  assert.equal(r.status, "warn");
  assert.match(r.title, /claude-code/);
});

test("claude-code: a torn last line is skipped, not fatal", async () => {
  const h = home();
  put(path.join(h, ".claude", "projects", "p1", "s1.jsonl"), CLAUDE + '\n{"type":"assis');
  assert.equal(byId(await run(h), "adapter-claude-code").status, "ok");
});

test("no transcripts at all for a harness: nothing is reported for it", async () => {
  const ids = (await run(home())).map((r) => r.id);
  assert.deepEqual(ids, []);
});

test("codex: a plain rollout parses; the version comes from session_meta", async () => {
  const h = home();
  const fixture = fs.readFileSync(new URL("./fixtures/codex-rollout.jsonl", import.meta.url), "utf8");
  put(path.join(h, ".codex", "sessions", "2026", "11", "10", "rollout-2026-11-10T10-00-00-019f478d-8ad4-7ab3-b976-f2b58f8a542c.jsonl"), fixture);
  const r = byId(await run(h), "adapter-codex");
  assert.equal(r.status, "ok", r.detail);
});

test("codex: rollouts that exist only as .jsonl.zst are flagged, because the tailer reads plain .jsonl", async () => {
  const h = home();
  put(path.join(h, ".codex", "sessions", "2026", "10", "26", "rollout-2026-10-26T10-00-00-019f478d-8ad4-7ab3-b976-f2b58f8a542c.jsonl.zst"), "not really zstd");
  const r = byId(await run(h), "adapter-codex");
  assert.equal(r.status, "warn");
  assert.match(r.detail, /\.jsonl\.zst/);
});

test("gemini: a chat session parses", async () => {
  const h = home();
  const doc = fs.readFileSync(new URL("./fixtures/gemini-session.json", import.meta.url), "utf8");
  put(path.join(h, ".gemini", "tmp", "demo", "chats", "session-2026-11-10T10-00-abc12345.json"), doc);
  put(path.join(h, ".gemini", "tmp", "demo", ".project_root"), "/w/demo");
  const r = byId(await run(h), "adapter-gemini");
  assert.equal(r.status, "ok", r.detail);
});

test("gemini: unreadable JSON is a warning", async () => {
  const h = home();
  put(path.join(h, ".gemini", "tmp", "demo", "chats", "session-x.json"), "{not json");
  assert.equal(byId(await run(h), "adapter-gemini").status, "warn");
});

test("hermes: reads the newest messages from state.db read-only", { skip: !hasSqlite }, async () => {
  const f = await makeHermesDb();
  f.addSession({ id: "s1", started_at: 1767225600, source: "cli" });
  f.addMessage({ session_id: "s1", role: "user", content: "hi", timestamp: 1767225601 });
  f.addMessage({ session_id: "s1", role: "assistant", content: "hello there", timestamp: 1767225602 });
  f.db.close();
  const h = home();
  fs.mkdirSync(path.join(h, ".hermes"));
  fs.copyFileSync(f.dbPath, path.join(h, ".hermes", "state.db"));
  const before = fs.statSync(path.join(h, ".hermes", "state.db")).mtimeMs;
  const r = byId(await run(h), "adapter-hermes");
  assert.equal(r.status, "ok", r.detail);
  assert.equal(fs.statSync(path.join(h, ".hermes", "state.db")).mtimeMs, before);
});

test("checkAdapters never writes into the home it inspects", async () => {
  const h = home();
  put(path.join(h, ".claude", "projects", "p1", "s1.jsonl"), CLAUDE + "\n");
  const snap = () => fs.readdirSync(h, { recursive: true }).sort().join("|");
  const before = snap();
  await run(h);
  assert.equal(snap(), before);
});

test("doctor: adapter lines appear when the home is known, and not in preflight", async () => {
  const h = home();
  put(path.join(h, ".claude", "projects", "p1", "s1.jsonl"), CLAUDE + "\n");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "ao-doctor-repo-"));
  const base = {
    platform: "linux", nodeVersion: "v22.1.0", env: { HOME: h }, home: path.join(h, ".agent-office"), repo, port: 8787,
    totalmem: 16 * 2 ** 30, which: (b) => ({ installed: true, path: `/usr/bin/${b}` }), probePort: async () => "free", exec: () => ({ status: 0, stdout: "" }),
  };
  assert.equal(byId(await runChecks(base), "adapter-claude-code")?.status, "ok");
  assert.equal(byId(await runChecks({ ...base, preflight: true }), "adapter-claude-code"), undefined);
  assert.equal(byId(await runChecks({ ...base, env: {} }), "adapter-claude-code"), undefined);
});
