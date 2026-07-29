import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChatSessionManager } from "../src/chat-session.js";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    // R14: the prompt is written to stdin now (not argv). Capture what's written.
    this.stdin = { written: "", write(s) { this.written += s; }, end(s) { if (s) this.written += s; }, on() {} };
    this.killedWith = null;
  }
  kill(signal) {
    this.killedWith = signal;
    // a real process exits when killed → the manager settles the turn on "exit".
    // Emit ASYNC (like a real exit) so a stop() call still leaves a "tearing down"
    // window before teardown completes, and emit once.
    if (this._exited) return;
    this._exited = true;
    queueMicrotask(() => this.emit("exit", null));
  }
  line(obj) {
    this.stdout.emit("data", JSON.stringify(obj) + "\n");
  }
}

function setup({
  timeoutMs = 5000,
  existingSessionId = null,
  stateFileContent = null,
  resolveRepoRoot,
} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-test-"));
  const stateFile = path.join(dir, "pm-session.json");
  if (existingSessionId) {
    // pre-Round-5 single-PM file shape (migration input)
    fs.writeFileSync(stateFile, JSON.stringify({ sessionId: existingSessionId }));
  } else if (stateFileContent) {
    fs.writeFileSync(stateFile, JSON.stringify(stateFileContent));
  }
  const events = [];
  const spawns = [];
  const child = new FakeChild();
  const manager = new ChatSessionManager({
    stateFile,
    cwd: dir,
    defaultRepo: "acme-web",
    ...(resolveRepoRoot ? { resolveRepoRoot } : {}),
    broadcast: (event) => events.push(event),
    spawnFn: (bin, args, opts) => {
      spawns.push({ bin, args, opts });
      return child;
    },
    timeoutMs,
  });
  return { manager, events, spawns, child, stateFile, dir };
}

const savedRepos = (stateFile) => JSON.parse(fs.readFileSync(stateFile, "utf8")).repos;

const chatMeta = (event) => event.meta;

test("first PM message: spawns fresh session with system prompt, saves session id from init", () => {
  const { manager, events, spawns, child, stateFile } = setup();

  const result = manager.send("trạng thái các work item?");
  assert.equal(result.accepted, true);
  assert.equal(spawns.length, 1);

  const { args } = spawns[0];
  assert.ok(args.includes("-p"));
  // R14 security: the message goes on stdin, NOT argv (no cmd.exe injection on Windows).
  assert.ok(!args.includes("trạng thái các work item?"), "message must not be in argv");
  // PM chat uses a warm streaming process: the message is a stream-json line on stdin.
  assert.deepEqual(JSON.parse(child.stdin.written.trim()), {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "trạng thái các work item?" }] },
  });
  assert.ok(args.includes("--input-format") && args.includes("--output-format") && args.includes("stream-json"));
  assert.ok(
    args.includes("--permission-prompt-tool") && args.includes("mcp__office__approval_prompt"),
    "PM permission prompts route to the office (-p)",
  );
  assert.ok(!args.includes("--resume"), "no resume on first-ever message");
  assert.ok(args.includes("--append-system-prompt"), "PM system prompt on fresh session");

  // user echo event broadcast immediately
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "chat_message");
  assert.equal(chatMeta(events[0]).role, "user");

  child.line({ type: "system", subtype: "init", session_id: "sess-new-1" });
  assert.equal(savedRepos(stateFile)["acme-web"].sessionId, "sess-new-1");

  child.line({ type: "assistant", message: { content: [{ type: "text", text: "Đang đọc registry..." }] } });
  const assistantEvents = events.filter((e) => chatMeta(e).role === "assistant");
  assert.equal(assistantEvents.length, 1);
  assert.equal(chatMeta(assistantEvents[0]).text, "Đang đọc registry...");
  assert.equal(chatMeta(assistantEvents[0]).done, false);
  assert.equal(assistantEvents[0].sessionId, "sess-new-1");

  child.line({ type: "result", is_error: false, result: "xong", session_id: "sess-new-1" });
  const doneEvent = events.at(-1);
  assert.equal(chatMeta(doneEvent).done, true);
  assert.equal(chatMeta(doneEvent).error, false);
  assert.equal(manager.busy, false, "turn released after result");
});

test("warm process: the second PM message reuses the same process (this is the speedup)", () => {
  const { manager, spawns, child } = setup();
  manager.send("tin một");
  assert.equal(spawns.length, 1);
  child.line({ type: "system", subtype: "init", session_id: "s1" });
  child.line({ type: "result", is_error: false, result: "ok", session_id: "s1" });
  assert.equal(manager.busy, false);

  const before = child.stdin.written.length;
  const second = manager.send("tin hai");
  assert.equal(second.accepted, true);
  assert.equal(spawns.length, 1, "warm process reused — no cold-start respawn");
  assert.ok(child.stdin.written.length > before, "second message streamed to the live stdin");
  assert.ok(child.stdin.written.includes("tin hai"));
  child.line({ type: "result", is_error: false, result: "ok2", session_id: "s1" });
  assert.equal(manager.busy, false);
});

test("dispose kills the warm process so it does not outlive the daemon", () => {
  const { manager, child } = setup();
  manager.send("tin");
  child.line({ type: "result", is_error: false, result: "ok", session_id: "s1" });
  manager.dispose();
  assert.equal(child.killedWith, "SIGKILL");
  assert.equal(manager.busy, false);
});

test("later PM message: resumes persisted session, re-saves forked session id from result", () => {
  const { manager, spawns, child, stateFile } = setup({ existingSessionId: "sess-old" });

  manager.send("tiếp tục");
  const { args } = spawns[0];
  assert.ok(args.includes("--resume"));
  assert.equal(args[args.indexOf("--resume") + 1], "sess-old");
  assert.ok(args.includes("--append-system-prompt"), "wi-pm-ux: prompt re-appended every PM turn (resumed sessions must get prompt fixes)");

  // -p --resume forks a new session id; the manager must persist the new one
  child.line({ type: "system", subtype: "init", session_id: "sess-forked" });
  child.line({ type: "result", is_error: false, result: "ok", session_id: "sess-forked" });
  const repos = savedRepos(stateFile);
  assert.equal(repos["acme-web"].sessionId, "sess-forked", "old flat file migrated into the repos map");
  assert.ok(repos["acme-web"].cwd, "migrated entry keeps a cwd for daemon restarts");
});

test("explicit targetSessionId: resumes that session and does NOT touch the PM state file", () => {
  const { manager, spawns, child, stateFile } = setup({ existingSessionId: "sess-pm" });

  manager.send("hello khác", { targetSessionId: "sess-other" });
  const { args } = spawns[0];
  assert.equal(args[args.indexOf("--resume") + 1], "sess-other");

  child.line({ type: "system", subtype: "init", session_id: "sess-other-forked" });
  child.line({ type: "result", is_error: false, result: "ok", session_id: "sess-other-forked" });
  assert.equal(
    JSON.parse(fs.readFileSync(stateFile, "utf8")).sessionId,
    "sess-pm",
    "PM session file must be untouched by non-PM chats"
  );
});

test("per-repo PM: repo option spawns in that repo's root with the generic prompt, saves under that repo", () => {
  const { manager, spawns, child, stateFile } = setup({
    existingSessionId: "sess-gang",
    resolveRepoRoot: (repo) => (repo === "demo-app" ? "/tmp/demo-app-root" : null),
  });

  const result = manager.send("repo này đang có gì?", { repo: "demo-app" });
  assert.equal(result.accepted, true);
  assert.equal(result.repo, "demo-app");

  const { args, opts } = spawns[0];
  assert.equal(opts.cwd, "/tmp/demo-app-root", "PM của repo khác chạy ở root repo đó");
  assert.ok(!args.includes("--resume"), "first chat into this repo — fresh PM");
  const prompt = args[args.indexOf("--append-system-prompt") + 1];
  assert.ok(!prompt.includes("work-items.json"), "generic prompt — no registry ritual for other repos");

  child.line({ type: "system", subtype: "init", session_id: "sess-demo-app-1" });
  child.line({ type: "result", is_error: false, result: "ok", session_id: "sess-demo-app-1" });
  const repos = savedRepos(stateFile);
  assert.equal(repos["demo-app"].sessionId, "sess-demo-app-1");
  assert.equal(repos["demo-app"].cwd, "/tmp/demo-app-root");
  assert.equal(repos["acme-web"].sessionId, "sess-gang", "default repo entry untouched");
});

test("per-repo PM: persisted cwd wins after daemon restart (resolver knows nothing)", () => {
  const { manager, spawns } = setup({
    stateFileContent: {
      version: 2,
      repos: { "demo-app": { sessionId: "sess-demo-app-old", cwd: "/tmp/demo-app-root", updatedAt: null } },
    },
  });

  manager.send("tiếp", { repo: "demo-app" });
  const { args, opts } = spawns[0];
  assert.equal(opts.cwd, "/tmp/demo-app-root");
  assert.equal(args[args.indexOf("--resume") + 1], "sess-demo-app-old");
  assert.ok(args.includes("--append-system-prompt"), "wi-pm-ux: prompt re-appended on resumed PM turns too");
});

test("unknown repo: friendly refusal, no spawn, not busy", () => {
  const { manager, spawns } = setup();
  const result = manager.send("hello", { repo: "never-seen" });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "unknown_repo");
  assert.match(result.message, /never-seen/);
  assert.equal(spawns.length, 0);
  assert.equal(manager.busy, false);
});

test("chat events carry the repo so the renderer can route transcripts", () => {
  const { manager, events, child } = setup({
    resolveRepoRoot: () => "/tmp/demo-app-root",
  });
  manager.send("hi", { repo: "demo-app" });
  assert.equal(events[0].repo, "demo-app");
  child.line({ type: "system", subtype: "init", session_id: "s1" });
  child.line({ type: "assistant", message: { content: [{ type: "text", text: "chào" }] } });
  assert.equal(events.at(-1).repo, "demo-app");
});

test("timeout: kills the child, emits friendly error event, releases the turn", async () => {
  const { manager, events, child } = setup({ timeoutMs: 20 });

  manager.send("câu hỏi khó");
  assert.equal(manager.busy, true);

  await new Promise((resolve) => setTimeout(resolve, 60));

  assert.equal(child.killedWith, "SIGKILL");
  const last = events.at(-1);
  assert.equal(chatMeta(last).role, "system");
  assert.equal(chatMeta(last).error, true);
  assert.equal(chatMeta(last).done, true);
  assert.match(chatMeta(last).text, /không phản hồi/);
  assert.equal(manager.busy, false, "next message can be sent after a timeout");
});

test("busy: second send while a turn is in flight is rejected", () => {
  const { manager } = setup();
  assert.equal(manager.send("một").accepted, true);
  const second = manager.send("hai");
  assert.equal(second.accepted, false);
  assert.equal(second.reason, "busy");
});

test("child exit with non-zero code before result → error event, turn released", () => {
  const { manager, events, child } = setup();
  manager.send("hi");
  child.stderr.emit("data", "boom");
  child.emit("exit", 1);
  const last = events.at(-1);
  assert.equal(chatMeta(last).error, true);
  assert.match(chatMeta(last).text, /exit 1/);
  assert.equal(manager.busy, false);
});

// ── wi-pm-ux: ⏹ stop the in-flight PM turn ────────────────────────────────

test("stop while a turn runs: SIGTERM, exit → '(đã dừng theo yêu cầu)' done event, turn released", () => {
  const { manager, events, child } = setup();
  manager.send("câu dài");
  const result = manager.stop();
  assert.equal(result.stopped, true);
  assert.equal(child.killedWith, "SIGTERM");

  child.emit("exit", null); // SIGTERM exit has no code
  const last = events.at(-1);
  assert.equal(chatMeta(last).role, "system");
  assert.equal(chatMeta(last).text, "(đã dừng theo yêu cầu)");
  assert.equal(chatMeta(last).done, true);
  assert.equal(chatMeta(last).error, false);
  assert.equal(manager.busy, false, "next message can be sent after a stop");
});

test("stop with nothing running → stopped:false", () => {
  const { manager } = setup();
  assert.deepEqual(manager.stop(), { stopped: false, reason: "idle" });
});

test("double stop: second call is a no-op while the first is still tearing down", () => {
  const { manager, child } = setup();
  manager.send("hi");
  assert.equal(manager.stop().stopped, true);
  const second = manager.stop();
  assert.equal(second.stopped, false);
  assert.equal(second.reason, "already_stopping");
  child.emit("exit", null);
  assert.equal(manager.stop().stopped, false, "after teardown it is just idle");
});

test("stop scoped to another repo does not kill the running turn", () => {
  const { manager, child } = setup();
  manager.send("hi"); // runs as default repo "acme-web"
  const result = manager.stop("demo-app");
  assert.equal(result.stopped, false);
  assert.equal(result.reason, "other_repo");
  assert.equal(child.killedWith, null);
  assert.equal(manager.busy, true);
  manager.stop(); // cleanup so the 3s SIGKILL timer does not outlive the test
  child.emit("exit", null);
});

test("stale --resume (No conversation found) clears the repo session so the next turn is fresh", () => {
  const { manager, child, stateFile } = setup({ existingSessionId: "sess-gone" });
  manager.send("chào"); // resumes the persisted (now non-existent) session
  // claude -p aborts because the session it was told to --resume no longer exists.
  // Without the auto-heal this id survives and EVERY later turn fails the same way
  // — PM chat bricks for the repo. The result handler must drop the stale id.
  child.line({
    type: "result",
    is_error: true,
    subtype: "error_during_execution",
    session_id: "sess-gone",
    errors: ["No conversation found with session ID: sess-gone"],
  });
  assert.equal(savedRepos(stateFile)["acme-web"], undefined, "stale session cleared");
});
