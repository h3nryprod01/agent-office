import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { GeminiTailer } from "../src/gemini-tailer.js";

const SID = "9efa18e9-0761-4d8d-93bd-8667266e4464";
const PROJECT_ROOT = "/Users/u/Projects/demo";

function makeRoot() {
  const tmpRoot = mkdtempSync(path.join(os.tmpdir(), "gemini-tailer-test-"));
  const projectDir = path.join(tmpRoot, "demo");
  mkdirSync(path.join(projectDir, "chats"), { recursive: true });
  writeFileSync(path.join(projectDir, ".project_root"), `${PROJECT_ROOT}\n`);
  return {
    tmpRoot,
    filePath: path.join(projectDir, "chats", `session-2026-07-09T18-53-${SID.slice(0, 8)}.json`),
  };
}

function writeSession(filePath, messages) {
  writeFileSync(filePath, JSON.stringify({ sessionId: SID, messages }, null, 2));
}

function userMessage(id) {
  return { id, timestamp: "2026-07-09T18:53:55.140Z", type: "user", content: [{ text: "hi" }] };
}

function geminiMessage(id, toolCalls = []) {
  return { id, timestamp: "2026-07-09T18:53:56.000Z", type: "gemini", content: "", toolCalls };
}

function toolCall(id) {
  return {
    id,
    name: "list_directory",
    args: { dir_path: PROJECT_ROOT },
    status: "success",
    timestamp: "2026-07-09T18:53:57.000Z",
    resultDisplay: "Listed 1 item(s).",
  };
}

function collect(tailer) {
  const messages = [];
  tailer.on("message", (m) => messages.push(m));
  return messages;
}

/** Force a distinct mtime so the tailer sees the rewrite. */
function touch(filePath, secondsFromNow = 0) {
  const when = Date.now() / 1000 + secondsFromNow;
  utimesSync(filePath, when, when);
}

test("a recently-written session is replayed, with cwd from .project_root", async () => {
  const { tmpRoot, filePath } = makeRoot();
  writeSession(filePath, [userMessage("u1"), geminiMessage("g1", [toolCall("a")])]);

  const tailer = new GeminiTailer({ tmpRoot, backfillMaxAgeMs: 5 * 60 * 1000 });
  const messages = collect(tailer);
  await tailer._tick();

  assert.equal(messages.length, 2);
  assert.equal(messages[0].sessionId, SID);
  assert.equal(messages[0].cwd, PROJECT_ROOT, ".project_root supplies the cwd");
  assert.equal(messages[0].toolCallOffset, 0);
  assert.equal(messages[1].message.id, "g1");

  rmSync(tmpRoot, { recursive: true, force: true });
});

test("long-idle file on first sight: history skipped, later writes tailed", async () => {
  const { tmpRoot, filePath } = makeRoot();
  writeSession(filePath, [userMessage("u1"), geminiMessage("g1")]);
  touch(filePath, -60 * 60); // idle 1h

  const tailer = new GeminiTailer({ tmpRoot, backfillMaxAgeMs: 5 * 60 * 1000 });
  const messages = collect(tailer);
  await tailer._tick();
  assert.equal(messages.length, 0, "history must be skipped");

  writeSession(filePath, [userMessage("u1"), geminiMessage("g1"), geminiMessage("g2")]);
  touch(filePath);
  await tailer._tick();
  assert.equal(messages.length, 1, "only the fresh message is emitted");
  assert.equal(messages[0].message.id, "g2");

  rmSync(tmpRoot, { recursive: true, force: true });
});

test("unchanged mtime is not re-read; new messages emit exactly once", async () => {
  const { tmpRoot, filePath } = makeRoot();
  writeSession(filePath, [userMessage("u1")]);

  const tailer = new GeminiTailer({ tmpRoot, backfillMaxAgeMs: 5 * 60 * 1000 });
  const messages = collect(tailer);
  await tailer._tick();
  await tailer._tick();
  assert.equal(messages.length, 1, "a second tick over an unchanged file emits nothing");

  writeSession(filePath, [userMessage("u1"), geminiMessage("g1")]);
  touch(filePath);
  await tailer._tick();
  assert.deepEqual(
    messages.map((m) => m.message.id),
    ["u1", "g1"]
  );

  rmSync(tmpRoot, { recursive: true, force: true });
});

test("tool calls appended to the trailing message re-emit it with an offset", async () => {
  // gemini-cli's recordToolCalls() pushes into the last `gemini` message
  // instead of creating a new one — the message mutates after we forwarded it.
  const { tmpRoot, filePath } = makeRoot();
  writeSession(filePath, [geminiMessage("g1", [toolCall("a")])]);

  const tailer = new GeminiTailer({ tmpRoot, backfillMaxAgeMs: 5 * 60 * 1000 });
  const messages = collect(tailer);
  await tailer._tick();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].toolCallOffset, 0);

  writeSession(filePath, [geminiMessage("g1", [toolCall("a"), toolCall("b")])]);
  touch(filePath);
  await tailer._tick();

  assert.equal(messages.length, 2, "the grown message is re-emitted");
  assert.equal(messages[1].message.id, "g1");
  assert.equal(messages[1].toolCallOffset, 1, "only tool call 'b' is new");

  rmSync(tmpRoot, { recursive: true, force: true });
});

test("a truncated document (chat rewind) replays from the top", async () => {
  const { tmpRoot, filePath } = makeRoot();
  writeSession(filePath, [userMessage("u1"), geminiMessage("g1"), geminiMessage("g2")]);

  const tailer = new GeminiTailer({ tmpRoot, backfillMaxAgeMs: 5 * 60 * 1000 });
  const messages = collect(tailer);
  await tailer._tick();
  assert.equal(messages.length, 3);

  writeSession(filePath, [userMessage("u1")]);
  touch(filePath);
  await tailer._tick();
  assert.equal(messages.length, 4, "stable event ids make the replay a renderer-side no-op");
  assert.equal(messages[3].message.id, "u1");

  rmSync(tmpRoot, { recursive: true, force: true });
});

test("a half-written file is skipped and retried on the next tick", async () => {
  const { tmpRoot, filePath } = makeRoot();
  writeFileSync(filePath, '{"sessionId": "9efa18e9", "messa'); // torn rewrite

  const tailer = new GeminiTailer({ tmpRoot, backfillMaxAgeMs: 5 * 60 * 1000 });
  const errors = [];
  tailer.on("error", (e) => errors.push(e));
  const messages = collect(tailer);
  await tailer._tick();
  assert.deepEqual([messages.length, errors.length], [0, 0], "torn reads are silent, not errors");

  writeSession(filePath, [userMessage("u1")]);
  touch(filePath);
  await tailer._tick();
  assert.equal(messages.length, 1, "the retry picks the message up");

  rmSync(tmpRoot, { recursive: true, force: true });
});

test("a missing gemini tmp root is not an error", async () => {
  const tailer = new GeminiTailer({ tmpRoot: path.join(os.tmpdir(), "gemini-does-not-exist") });
  const errors = [];
  tailer.on("error", (e) => errors.push(e));
  const messages = collect(tailer);
  await tailer._tick();
  assert.deepEqual([messages.length, errors.length], [0, 0]);
});
