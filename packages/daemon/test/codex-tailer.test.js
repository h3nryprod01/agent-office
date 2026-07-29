import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodexTailer } from "../src/codex-tailer.js";

const SID = "019f32a1-5afa-7b60-9a40-02a7ff1dc28e";
const LINE = JSON.stringify({ timestamp: "2026-07-05T14:15:11.767Z", type: "event_msg", payload: { type: "agent_message", message: "hi" } }) + "\n";

function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "codex-tailer-test-"));
  const day = path.join(root, "2026", "07", "05");
  mkdirSync(day, { recursive: true });
  return { root, filePath: path.join(day, `rollout-2026-07-05T14-14-23-${SID}.jsonl`) };
}

function collect(tailer) {
  const lines = [];
  tailer.on("line", (l) => lines.push(l));
  return lines;
}

test("long-idle file on first sight: history skipped, new appends tailed", async () => {
  const { root, filePath } = makeRoot();
  writeFileSync(filePath, LINE.repeat(3));
  const old = (Date.now() - 60 * 60 * 1000) / 1000; // idle 1h
  utimesSync(filePath, old, old);

  const tailer = new CodexTailer({ sessionsRoot: root, backfillMaxAgeMs: 5 * 60 * 1000 });
  const lines = collect(tailer);
  await tailer._tick();
  assert.equal(lines.length, 0, "history must be skipped");

  appendFileSync(filePath, LINE);
  await tailer._tick();
  assert.equal(lines.length, 1, "fresh append after skip must be emitted");
  assert.equal(lines[0].sessionId, SID);

  rmSync(root, { recursive: true, force: true });
});

test("recently-active file is fully replayed", async () => {
  const { root, filePath } = makeRoot();
  writeFileSync(filePath, LINE.repeat(3)); // mtime = now

  const tailer = new CodexTailer({ sessionsRoot: root, backfillMaxAgeMs: 5 * 60 * 1000 });
  const lines = collect(tailer);
  await tailer._tick();
  assert.equal(lines.length, 3);

  rmSync(root, { recursive: true, force: true });
});
