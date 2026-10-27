import test from "node:test";
import assert from "node:assert/strict";
import { SessionNormalizer } from "../src/normalize.js";

const SID = "wk-session-1";
const CWD = "/tmp/demo-app/.claude/worktrees/w";
const user = { type: "user", cwd: CWD, timestamp: "2026-10-26T10:00:00Z", message: { role: "user", content: "go" } };
const assistant = (model) => ({
  type: "assistant",
  uuid: "u1",
  cwd: CWD,
  timestamp: "2026-10-26T10:00:05Z",
  message: { model, content: [{ type: "text", text: "on it" }] },
});

test("main root: a known non-Anthropic model still gets a lane (harness stays claude-code); unknown ids and Claude do not", () => {
  const mimo = new SessionNormalizer(SID);
  const ev = mimo.normalizeLine(assistant("mimo-v2.6-pro"));
  assert.ok(ev.length > 0 && ev.every((e) => e.harness === "claude-code" && e.lane === "mimo"));
  const odd = new SessionNormalizer(SID);
  assert.ok(odd.normalizeLine(assistant("openai/gpt-oss-20b")).every((e) => e.lane === null), "strict in the main root: no stray slug lanes");
});

test("default normalizer is unchanged: harness claude-code, no lane", () => {
  const n = new SessionNormalizer(SID);
  const events = [...n.normalizeLine(user), ...n.normalizeLine(assistant("claude-sonnet-5-5"))];
  assert.ok(events.every((e) => e.harness === "claude-code" && e.lane === null));
});

test("worker normalizer tags harness; lane appears once the model is known and sticks", () => {
  const n = new SessionNormalizer(SID, { harness: "claude-worker" });
  const first = n.normalizeLine(user); // no model on a user line yet
  assert.equal(first[0].type, "session_start");
  assert.equal(first[0].harness, "claude-worker");
  assert.equal(first[0].lane, null);

  const second = n.normalizeLine(assistant("deepseek-flash[1m]"));
  assert.ok(second.length > 0);
  assert.ok(second.every((e) => e.harness === "claude-worker" && e.lane === "deepseek"));

  // a later synthetic placeholder must not erase the lane
  const third = n.normalizeLine({ ...assistant("<synthetic>"), uuid: "u2" });
  assert.ok(third.every((e) => e.lane === "deepseek"));
});

test("worker session whose model is Anthropic keeps lane null", () => {
  const n = new SessionNormalizer(SID, { harness: "claude-worker" });
  const events = n.normalizeLine(assistant("claude-haiku-4-5"));
  assert.ok(events.every((e) => e.harness === "claude-worker" && e.lane === null));
});
