// test/fixtures/gemini-session.json is a REAL chat session recorded by
// gemini-cli 0.29.5 on this machine (user prompt -> 4 tool calls -> "DONE"),
// with the project path replaced and tool result payloads trimmed. Field
// names, nesting, ids, timestamps and statuses are verbatim.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GeminiSessionNormalizer } from "../src/gemini-normalize.js";

const CWD = "/Users/u/Projects/demo";
const SID = "9efa18e9-0761-4d8d-93bd-8667266e4464";
const TS = "2026-07-09T18:53:55.140Z";

const fixture = JSON.parse(
  readFileSync(new URL("./fixtures/gemini-session.json", import.meta.url), "utf8")
);

function replay(messages, cwd = CWD) {
  const normalizer = new GeminiSessionNormalizer(fixture.sessionId ?? SID);
  return messages.flatMap((message) => normalizer.normalizeMessage(message, { cwd }));
}

function geminiMessage(fields) {
  return { id: "msg-1", timestamp: TS, type: "gemini", content: "", ...fields };
}

test("first user message opens the character with harness gemini", () => {
  const n = new GeminiSessionNormalizer(SID);
  const events = n.normalizeMessage(
    { id: "u1", timestamp: TS, type: "user", content: [{ text: "hi" }] },
    { cwd: CWD }
  );

  assert.equal(events.length, 1, "a user prompt opens the session but says nothing");
  const [event] = events;
  assert.equal(event.type, "session_start");
  assert.equal(event.harness, "gemini");
  assert.equal(event.sessionId, SID);
  assert.equal(event.agentId, SID);
  assert.equal(event.parentId, null, "gemini-cli records no parent/child link");
  assert.equal(event.cwd, CWD);
  assert.equal(event.agent, "demo");
  assert.equal(event.v, 1);
});

test("session_start is emitted once, on the first user-or-gemini message", () => {
  const n = new GeminiSessionNormalizer(SID);
  n.normalizeMessage({ id: "u1", timestamp: TS, type: "user", content: [] }, { cwd: CWD });
  const later = n.normalizeMessage(geminiMessage({ content: "hello" }), { cwd: CWD });
  assert.deepEqual(
    later.map((e) => e.type),
    ["speak"]
  );
});

test("info/error messages are CLI bookkeeping: no events, no character", () => {
  const n = new GeminiSessionNormalizer(SID);
  const info = n.normalizeMessage({ id: "i1", timestamp: TS, type: "info", content: "Searching…" });
  const error = n.normalizeMessage({ id: "e1", timestamp: TS, type: "error", content: "Usage: …" });
  assert.deepEqual([...info, ...error], []);
  assert.equal(n.sessionStarted, false);
});

test("gemini text becomes speak, latest thought becomes a thinking bubble", () => {
  const n = new GeminiSessionNormalizer(SID);
  n.sessionStarted = true;
  const events = n.normalizeMessage(
    geminiMessage({
      content: "DONE",
      model: "gemini-2.5-flash",
      thoughts: [
        { subject: "Listing Files", description: "…" },
        { subject: "Exploring Directory Contents", description: "…" },
      ],
    }),
    { cwd: CWD }
  );

  assert.deepEqual(
    events.map((e) => [e.type, e.meta.kind]),
    [
      ["speak", "thinking"],
      ["speak", "text"],
    ]
  );
  assert.equal(events[0].detail, "Exploring Directory Contents", "the latest thought wins");
  assert.equal(events[1].detail, "DONE");
  assert.equal(events[1].meta.model, "gemini-2.5-flash");
});

test("a tool call expands into a start/end pair with real timestamps", () => {
  const n = new GeminiSessionNormalizer(SID);
  n.sessionStarted = true;
  const events = n.normalizeMessage(
    geminiMessage({
      toolCalls: [
        {
          id: "list_directory_1783623239753_0",
          name: "list_directory",
          args: { dir_path: CWD },
          status: "success",
          timestamp: "2026-07-09T18:53:59.999Z",
          resultDisplay: "Listed 3 item(s).",
        },
      ],
    }),
    { cwd: CWD }
  );

  assert.equal(events.length, 2);
  const [start, end] = events;
  assert.equal(start.type, "tool_call");
  assert.equal(start.status, "start");
  assert.equal(start.tool, "list_directory");
  assert.equal(start.id, "list_directory_1783623239753_0:start");
  assert.equal(start.detail, `list_directory: ${CWD}`);
  assert.equal(start.ts, Date.parse(TS), "start uses the message timestamp");

  assert.equal(end.status, "ok");
  assert.equal(end.id, "list_directory_1783623239753_0:end");
  assert.equal(end.detail, "Listed 3 item(s).");
  assert.equal(end.ts, Date.parse("2026-07-09T18:53:59.999Z"), "end uses the call's timestamp");
});

test("an empty resultDisplay falls back to restating the call", () => {
  // read_file records resultDisplay: "" on success — "read_file" alone is a
  // useless speech bubble, "read_file: a.txt" is not.
  const n = new GeminiSessionNormalizer(SID);
  n.sessionStarted = true;
  const events = n.normalizeMessage(
    geminiMessage({
      toolCalls: [
        { id: "r1", name: "read_file", args: { file_path: "a.txt" }, status: "success", resultDisplay: "" },
      ],
    }),
    { cwd: CWD }
  );
  assert.equal(events[1].detail, "read_file: a.txt");
});

test("non-success tool statuses map to error", () => {
  for (const status of ["error", "cancelled"]) {
    const n = new GeminiSessionNormalizer(SID);
    n.sessionStarted = true;
    const events = n.normalizeMessage(
      geminiMessage({
        toolCalls: [
          { id: `c-${status}`, name: "list_directory", args: {}, status, resultDisplay: "nope" },
        ],
      }),
      { cwd: CWD }
    );
    assert.equal(events[1].status, "error", `${status} must surface as error`);
    assert.equal(events[1].meta.geminiStatus, status);
  }
});

test("toolCallOffset re-emits only the tool calls appended to a known message", () => {
  // recordToolCalls() appends into the trailing gemini message rather than
  // pushing a new one — the tailer replays that message with an offset.
  const n = new GeminiSessionNormalizer(SID);
  n.sessionStarted = true;
  const message = geminiMessage({
    content: "working",
    thoughts: [{ subject: "Thinking" }],
    toolCalls: [
      { id: "a", name: "glob", args: { pattern: "*.md" }, status: "success", resultDisplay: "1" },
      { id: "b", name: "read_file", args: { file_path: "a.txt" }, status: "success", resultDisplay: "2" },
    ],
  });

  const events = n.normalizeMessage(message, { cwd: CWD, toolCallOffset: 1 });
  assert.deepEqual(
    events.map((e) => e.id),
    ["b:start", "b:end"],
    "speak/thinking must not repeat, and tool call 'a' must not replay"
  );
});

test("replaying the real session fixture yields a well-formed event stream", () => {
  const events = replay(fixture.messages);

  assert.deepEqual(
    events.map((e) => e.type),
    [
      "session_start",
      "speak", // thinking
      "tool_call", "tool_call", // list_directory
      "tool_call", "tool_call", // read_file a.txt
      "tool_call", "tool_call", // read_file b.txt
      "tool_call", "tool_call", // glob *.md
      "speak", // "DONE"
    ]
  );

  assert.equal(new Set(events.map((e) => e.id)).size, events.length, "event ids are unique");
  for (const event of events) {
    assert.equal(event.v, 1);
    assert.equal(event.harness, "gemini");
    assert.equal(event.sessionId, fixture.sessionId);
    assert.equal(event.parentId, null);
    assert.equal(event.repo, "other", "the sanitized fixture cwd is outside any git repo");
    assert.ok(Number.isFinite(event.ts), "every event carries a parsed timestamp");
    assert.ok(event.detail.length <= 140);
  }

  const toolEvents = events.filter((e) => e.type === "tool_call");
  assert.equal(toolEvents.filter((e) => e.status === "start").length, 4);
  assert.equal(toolEvents.filter((e) => e.status === "ok").length, 4);
  assert.deepEqual(
    [...new Set(toolEvents.map((e) => e.tool))],
    ["list_directory", "read_file", "glob"]
  );
  assert.equal(events.at(-1).detail, "DONE");
});
