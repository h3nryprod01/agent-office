import { test } from "node:test";
import assert from "node:assert/strict";
import { Notifier, attachNotifier, composeNotification, buildOfficeUrl, deliverNotification } from "../src/notifier.js";

const THRESHOLD_MS = 30; // tiny threshold so tests run fast (same idiom as reconciler tests)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function evt(overrides = {}) {
  return {
    v: 1,
    id: "e-1",
    type: "hook_signal",
    sessionId: "sess-1",
    agentId: "sess-1",
    parentId: null,
    cwd: "/repo",
    repo: "repo",
    harness: "claude-code",
    ts: 1000,
    agent: "repo",
    tool: "Bash",
    status: "start",
    detail: "chờ phê duyệt: Bash",
    meta: { state: "waiting_permission" },
    ...overrides,
  };
}

function working(overrides = {}) {
  return evt({ status: "ok", detail: "Bash đã chạy tiếp", meta: { state: "working" }, ...overrides });
}

function makeNotifier(overrides = {}) {
  const sent = [];
  const notifier = new Notifier({
    thresholdMs: THRESHOLD_MS,
    enabled: true,
    officeUrl: "http://localhost:5173",
    deliver: (n) => sent.push(n),
    ...overrides,
  });
  return { notifier, sent };
}

test("agent stuck past the threshold fires exactly one notification", async () => {
  const { notifier, sent } = makeNotifier();
  notifier.onEvent(evt());
  assert.equal(sent.length, 0); // not yet — inside the threshold
  await sleep(THRESHOLD_MS * 2);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].title, "Agent Office");
  assert.equal(sent[0].subtitle, "repo · repo");
  assert.match(sent[0].message, /Chờ phê duyệt/);
  assert.equal(sent[0].url, "http://localhost:5173/?focus=sess-1");
});

test("agent unstuck before the threshold never notifies", async () => {
  const { notifier, sent } = makeNotifier();
  notifier.onEvent(evt());
  notifier.onEvent(working());
  await sleep(THRESHOLD_MS * 2);
  assert.equal(sent.length, 0);
});

test("one stuck episode = one notification even if the wait signal repeats", async () => {
  const { notifier, sent } = makeNotifier();
  notifier.onEvent(evt());
  await sleep(THRESHOLD_MS * 2);
  notifier.onEvent(evt({ ts: 2000 })); // still stuck, signal re-fires
  await sleep(THRESHOLD_MS * 2);
  assert.equal(sent.length, 1);
});

test("unstuck then stuck again is a new episode and notifies again", async () => {
  const { notifier, sent } = makeNotifier();
  notifier.onEvent(evt());
  await sleep(THRESHOLD_MS * 2);
  notifier.onEvent(working()); // episode over
  notifier.onEvent(evt({ ts: 3000 })); // stuck again
  await sleep(THRESHOLD_MS * 2);
  assert.equal(sent.length, 2);
});

test("error event held past the threshold notifies with the error label", async () => {
  const { notifier, sent } = makeNotifier();
  notifier.onEvent(evt({ type: "tool_call", status: "error", detail: "exit code 1", meta: null }));
  await sleep(THRESHOLD_MS * 2);
  assert.equal(sent.length, 1);
  assert.match(sent[0].message, /Lỗi/);
});

test("any later transcript activity clears an error before the threshold", async () => {
  const { notifier, sent } = makeNotifier();
  notifier.onEvent(evt({ type: "tool_call", status: "error", detail: "exit code 1", meta: null }));
  notifier.onEvent(evt({ type: "tool_call", status: "ok", detail: "ran fine", meta: null }));
  await sleep(THRESHOLD_MS * 2);
  assert.equal(sent.length, 0);
});

test("session_end clears a pending stuck timer", async () => {
  const { notifier, sent } = makeNotifier();
  notifier.onEvent(evt());
  notifier.onEvent(evt({ type: "session_end", status: "ok", meta: null }));
  await sleep(THRESHOLD_MS * 2);
  assert.equal(sent.length, 0);
});

test("agents are tracked independently", async () => {
  const { notifier, sent } = makeNotifier();
  notifier.onEvent(evt({ agentId: "a" }));
  notifier.onEvent(evt({ agentId: "b", agent: "other", repo: "other" }));
  notifier.onEvent(working({ agentId: "b" })); // b recovers, a stays stuck
  await sleep(THRESHOLD_MS * 2);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].subtitle, "repo · repo");
});

test("AGENT_OFFICE_NOTIFY=0 disables notifications", async () => {
  const prev = process.env.AGENT_OFFICE_NOTIFY;
  process.env.AGENT_OFFICE_NOTIFY = "0";
  try {
    const sent = [];
    const notifier = new Notifier({ thresholdMs: THRESHOLD_MS, deliver: (n) => sent.push(n) });
    notifier.onEvent(evt());
    await sleep(THRESHOLD_MS * 2);
    assert.equal(sent.length, 0);
  } finally {
    if (prev === undefined) delete process.env.AGENT_OFFICE_NOTIFY;
    else process.env.AGENT_OFFICE_NOTIFY = prev;
  }
});

test("buildOfficeUrl appends the focus param", () => {
  assert.equal(buildOfficeUrl("http://localhost:5199", "sess-1"), "http://localhost:5199/?focus=sess-1");
});

test("buildOfficeUrl without an agentId returns the office URL untouched", () => {
  assert.equal(buildOfficeUrl("http://localhost:5199", null), "http://localhost:5199");
  assert.equal(buildOfficeUrl("http://localhost:5199", undefined), "http://localhost:5199");
});

test("buildOfficeUrl merges with an existing query and encodes the agentId", () => {
  assert.equal(
    buildOfficeUrl("http://localhost:5199/?mock=1", "a b/c"),
    "http://localhost:5199/?mock=1&focus=a+b%2Fc"
  );
});

test("notification URL deep-links to the stuck agent", () => {
  const n = composeNotification(evt({ agentId: "sess-9" }), "http://localhost:5199");
  assert.equal(n.url, "http://localhost:5199/?focus=sess-9");
});

test("denied errors get the blocked label", () => {
  const n = composeNotification(
    evt({ status: "error", detail: "Bash has been denied", meta: null }),
    "http://x"
  );
  assert.match(n.message, /Bị chặn/);
});

test("attachNotifier observes broadcasts without breaking delivery", async () => {
  const delivered = [];
  const server = { broadcast: (e) => delivered.push(e) };
  const sent = [];
  attachNotifier(server, {
    thresholdMs: THRESHOLD_MS,
    enabled: true,
    deliver: (n) => sent.push(n),
  });
  server.broadcast(evt());
  assert.equal(delivered.length, 1); // original broadcast still ran
  await sleep(THRESHOLD_MS * 2);
  assert.equal(sent.length, 1);
});

test("a throwing notifier never blocks broadcast", () => {
  const delivered = [];
  const server = { broadcast: (e) => delivered.push(e) };
  const notifier = attachNotifier(server, { thresholdMs: THRESHOLD_MS, enabled: true });
  notifier.onEvent = () => {
    throw new Error("boom");
  };
  server.broadcast(evt());
  assert.equal(delivered.length, 1);
});

test("deliverNotification: win32 → powershell balloon; an exec error degrades (warn, no throw)", () => {
  const calls = [];
  deliverNotification(
    { title: "Agent Office", subtitle: "s", message: "stuck", url: "http://x" },
    { platform: "win32", execFileFn: (cmd, args, cb) => { calls.push({ cmd, args }); cb(null); } },
  );
  assert.equal(calls.length, 1);
  assert.match(calls[0].cmd, /powershell/i);
  assert.equal(calls[0].args[0], "-NoProfile");
  // a failing balloon must not throw — the daemon keeps running
  assert.doesNotThrow(() =>
    deliverNotification(
      { title: "x", subtitle: "y", message: "z", url: "u" },
      { platform: "win32", execFileFn: (_c, _a, cb) => cb(new Error("boom")) },
    ),
  );
});

test("deliverNotification: darwin → terminal-notifier (macOS path unchanged)", () => {
  const calls = [];
  deliverNotification(
    { title: "T", subtitle: "S", message: "M", url: "http://x" },
    { platform: "darwin", execFileFn: (cmd, args, cb) => { calls.push({ cmd, args }); cb(null); } },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "terminal-notifier"); // first candidate, cb(null) → no ENOENT recursion
});

test("deliverNotification: linux → notify-send, no -A; an exec error degrades (error log, no throw)", () => {
  const calls = [];
  deliverNotification(
    { title: "Agent Office", subtitle: "s", message: "stuck", url: "http://x" },
    { platform: "linux", execFileFn: (cmd, args, cb) => { calls.push({ cmd, args }); cb(null); } },
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    cmd: "notify-send",
    args: ["-a", "Agent Office", "Agent Office", "stuck"],
  });
  assert.ok(!calls[0].args.includes("-A")); // -A implies --wait, would hang execFile
  assert.doesNotThrow(() =>
    deliverNotification(
      { title: "x", subtitle: "y", message: "z", url: "u" },
      { platform: "linux", execFileFn: (_c, _a, cb) => cb(new Error("boom")) },
    ),
  );
});

test("deliverNotification: also fires the Telegram secondary channel (B11) alongside the OS notification, with the same content", () => {
  const telegramCalls = [];
  deliverNotification(
    { title: "Agent Office", subtitle: "repo · agent", message: "Chờ phê duyệt >30s", url: "http://x/?focus=a" },
    {
      platform: "linux",
      execFileFn: (_cmd, _args, cb) => cb(null),
      sendTelegram: (text) => telegramCalls.push(text),
    },
  );
  assert.equal(telegramCalls.length, 1);
  assert.match(telegramCalls[0], /Agent Office/);
  assert.match(telegramCalls[0], /Chờ phê duyệt >30s/);
  assert.match(telegramCalls[0], /http:\/\/x\/\?focus=a/);
});

test("deliverNotification: a throwing sendTelegram must not stop the OS notification from firing", () => {
  const calls = [];
  assert.doesNotThrow(() =>
    deliverNotification(
      { title: "T", subtitle: "S", message: "M", url: "http://x" },
      {
        platform: "linux",
        execFileFn: (cmd, args, cb) => { calls.push({ cmd, args }); cb(null); },
        sendTelegram: () => { throw new Error("telegram boom"); },
      },
    ),
  );
  assert.equal(calls.length, 1); // notify-send still ran
});

test("deliverNotification: a rejecting sendTelegram promise must not become an unhandled rejection (fatal on Node >=15)", async () => {
  const calls = [];
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    deliverNotification(
      { title: "T", subtitle: "S", message: "M", url: "http://x" },
      {
        platform: "linux",
        execFileFn: (cmd, args, cb) => { calls.push({ cmd, args }); cb(null); },
        sendTelegram: () => Promise.reject(new Error("telegram network down")),
      },
    );
    assert.equal(calls.length, 1); // notify-send still ran, synchronously, before the rejection is even observed
    // let the rejected promise's microtask settle
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(unhandled.length, 0);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
