import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, appendFileSync, utimesSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TranscriptTailer } from "../src/tailer.js";

const SID = "daa17420-977b-449f-9a3d-7570a5720c9d";
const LINE =
  JSON.stringify({ type: "user", message: { role: "user", content: "hi" }, timestamp: "2026-07-08T09:00:00.000Z" }) +
  "\n";

function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "tailer-test-"));
  const project = path.join(root, "-Users-x-proj");
  const filePath = path.join(project, `${SID}.jsonl`);
  return { root, project, filePath };
}

function collect(tailer) {
  const lines = [];
  tailer.on("line", (l) => lines.push(l));
  return lines;
}

test("long-idle transcript on first sight: history skipped, new appends tailed", async () => {
  const { root, project, filePath } = makeRoot();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(project, { recursive: true });
  writeFileSync(filePath, LINE.repeat(3));
  const old = (Date.now() - 60 * 60 * 1000) / 1000; // idle 1h
  utimesSync(filePath, old, old);

  const tailer = new TranscriptTailer({ projectsRoot: root, backfillMaxAgeMs: 5 * 60 * 1000 });
  const lines = collect(tailer);
  await tailer._tick();
  assert.equal(lines.length, 0, "history must be skipped, not read into memory");

  appendFileSync(filePath, LINE);
  await tailer._tick();
  assert.equal(lines.length, 1, "fresh append after skip must be emitted");
  assert.equal(lines[0].sessionId, SID);

  rmSync(root, { recursive: true, force: true });
});

test("recently-active transcript is fully replayed", async () => {
  const { root, project, filePath } = makeRoot();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(project, { recursive: true });
  writeFileSync(filePath, LINE.repeat(3)); // mtime = now

  const tailer = new TranscriptTailer({ projectsRoot: root, backfillMaxAgeMs: 5 * 60 * 1000 });
  const lines = collect(tailer);
  await tailer._tick();
  assert.equal(lines.length, 3);

  rmSync(root, { recursive: true, force: true });
});

test("ticks never overlap: a tick started while one is in flight is a no-op", async () => {
  const { root, project, filePath } = makeRoot();
  const { mkdirSync } = await import("node:fs");
  mkdirSync(project, { recursive: true });
  writeFileSync(filePath, LINE);

  const tailer = new TranscriptTailer({ projectsRoot: root });
  let inFlight = 0;
  let maxInFlight = 0;
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const original = tailer._readNewBytes.bind(tailer);
  tailer._readNewBytes = async (...args) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await gate; // hold the first tick open, as a slow backfill read would
    try {
      return await original(...args);
    } finally {
      inFlight--;
    }
  };

  const first = tailer._tick();
  const second = tailer._tick(); // what setInterval does 1s later in production
  release();
  await Promise.all([first, second]);
  assert.equal(maxInFlight, 1, "overlapping ticks re-read un-offset files and pile up memory");

  rmSync(root, { recursive: true, force: true });
});
