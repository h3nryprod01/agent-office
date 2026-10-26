import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { HermesTailer } from "../src/hermes-tailer.js";
import { hasSqlite, makeHermesDb, toolCalls } from "./hermes-fixture.js";

const opts = { skip: !hasSqlite && "node:sqlite unavailable" };

const nowS = () => Date.now() / 1000;

function collect(tailer) {
  const out = { messages: [], errors: [], unavailable: [] };
  tailer.on("message", (m) => out.messages.push(m));
  tailer.on("error", (e) => out.errors.push(e));
  tailer.on("unavailable", (e) => out.unavailable.push(e));
  return out;
}

test("replays recent history on first sight, skips old messages, then tails only new rows", opts, async () => {
  const f = await makeHermesDb();
  f.addSession({ id: "s1", started_at: nowS() - 7200, model: "demo-model", cwd: "/tmp/demo-app" });
  f.addMessage({ session_id: "s1", role: "user", content: "ancient", timestamp: nowS() - 7200 });
  f.addMessage({ session_id: "s1", role: "user", content: "recent", timestamp: nowS() - 10 });
  f.addMessage({ session_id: "s1", role: "assistant", content: null, tool_calls: toolCalls(["c1", "terminal", { command: "ls" }]), timestamp: nowS() - 5 });

  const tailer = new HermesTailer({ dbPath: f.dbPath });
  const out = collect(tailer);
  await tailer._tick();
  assert.deepEqual(out.messages.map((m) => m.message.content ?? "(tools)"), ["recent", "(tools)"]);
  assert.equal(out.messages[0].sessionId, "s1");
  assert.equal(out.messages[0].session.cwd, "/tmp/demo-app");
  assert.equal(out.messages[1].message.toolCalls[0].function.name, "terminal");
  assert.equal(out.messages[1].message.ts > 1e12, true, "ts is converted to ms");

  await tailer._tick();
  assert.equal(out.messages.length, 2, "nothing new → nothing emitted");

  f.addMessage({ session_id: "s1", role: "tool", content: "ok", tool_call_id: "c1", tool_name: "terminal", timestamp: nowS() });
  await tailer._tick();
  assert.equal(out.messages.length, 3);
  assert.equal(out.messages[2].message.toolCallId, "c1");
  assert.deepEqual(out.errors, []);
  f.db.close();
  rmSync(f.dir, { recursive: true, force: true });
});

test("a missing state.db is not an error (Hermes not installed)", opts, async () => {
  const f = await makeHermesDb();
  const tailer = new HermesTailer({ dbPath: f.dbPath + ".nope" });
  const out = collect(tailer);
  await tailer._tick();
  assert.deepEqual([out.messages, out.errors], [[], []]);
  f.db.close();
  rmSync(f.dir, { recursive: true, force: true });
});

test("a schema without the expected columns reports one error and does not throw", opts, async () => {
  const f = await makeHermesDb();
  f.db.exec("DROP TABLE messages; CREATE TABLE messages (id INTEGER PRIMARY KEY, other TEXT);");
  const tailer = new HermesTailer({ dbPath: f.dbPath });
  const out = collect(tailer);
  await tailer._tick();
  assert.equal(out.errors.length, 1);
  f.db.close();
  rmSync(f.dir, { recursive: true, force: true });
});

test("a row that makes the listener throw costs that row only; the rest of the batch still arrives", opts, async () => {
  const f = await makeHermesDb();
  f.addSession({ id: "s1", started_at: nowS() - 60 });
  for (const c of ["one", "boom", "three"]) f.addMessage({ session_id: "s1", role: "user", content: c, timestamp: nowS() - 5 });
  const tailer = new HermesTailer({ dbPath: f.dbPath });
  const got = [];
  tailer.on("message", ({ message }) => {
    if (message.content === "boom") throw new Error("listener blew up");
    got.push(message.content);
  });
  const errors = [];
  tailer.on("error", (e) => errors.push(e));
  await tailer._tick();
  assert.deepEqual(got, ["one", "three"]);
  assert.equal(errors.length, 1);
  await tailer._tick();
  assert.equal(got.length, 2, "the failed row is not retried forever");
  f.db.close();
  rmSync(f.dir, { recursive: true, force: true });
});

test("malformed rows (null tool_call entry, BLOB content) are normalized instead of throwing", opts, async () => {
  const f = await makeHermesDb();
  f.addSession({ id: "s1", started_at: nowS() - 60 });
  f.addMessage({ session_id: "s1", role: "assistant", tool_calls: JSON.stringify([null, { id: "c", function: { name: "x", arguments: "{}" } }]), timestamp: nowS() - 5 });
  f.addMessage({ session_id: "s1", role: "assistant", content: new Uint8Array([1, 2, 3]), timestamp: nowS() - 4 });
  const tailer = new HermesTailer({ dbPath: f.dbPath });
  const out = collect(tailer);
  await tailer._tick();
  assert.equal(out.messages.length, 2);
  assert.equal(out.messages[0].message.toolCalls.length, 1);
  assert.equal(out.messages[1].message.content, null);
  assert.deepEqual(out.errors, []);
  f.db.close();
  rmSync(f.dir, { recursive: true, force: true });
});
