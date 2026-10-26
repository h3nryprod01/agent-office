import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { laneOfModel, resolveClaudeRoots } from "../src/worker-lanes.js";

test("laneOfModel: worker model ids map to their lane", () => {
  assert.equal(laneOfModel("deepseek-flash[1m]"), "deepseek");
  assert.equal(laneOfModel("deepseek-v4-pro"), "deepseek");
  assert.equal(laneOfModel("mimo-v2.6-pro"), "mimo");
  assert.equal(laneOfModel("glm-5.2"), "glm");
  assert.equal(laneOfModel("k3[1m]"), "kimi"); // Kimi's id never contains "kimi"
  assert.equal(laneOfModel("kimi-k2"), "kimi");
});

test("laneOfModel: other vendor ids fall back to a readable slug, Anthropic/synthetic to null", () => {
  assert.equal(laneOfModel("openai/gpt-oss-20b"), "gpt-oss");
  assert.equal(laneOfModel("claude-sonnet-5-5"), null);
  assert.equal(laneOfModel("<synthetic>"), null);
  assert.equal(laneOfModel(undefined), null);
  assert.equal(laneOfModel(""), null);
});

function home() {
  return mkdtempSync(path.join(os.tmpdir(), "ao-roots-"));
}

test("resolveClaudeRoots: default is the main root, plus the worker root only when it exists", () => {
  const h = home();
  const main = path.join(h, ".claude", "projects");
  assert.deepEqual(resolveClaudeRoots({ homeDir: h, env: {} }), [{ root: main, harness: "claude-code" }]);

  mkdirSync(path.join(h, ".claude-worker", "projects"), { recursive: true });
  assert.deepEqual(resolveClaudeRoots({ homeDir: h, env: {} }), [
    { root: main, harness: "claude-code" },
    { root: path.join(h, ".claude-worker", "projects"), harness: "claude-worker" },
  ]);
  rmSync(h, { recursive: true, force: true });
});

test("resolveClaudeRoots: EXEC_CONFIG_DIR moves the default worker root", () => {
  const h = home();
  const alt = path.join(h, "alt-worker");
  mkdirSync(path.join(alt, "projects"), { recursive: true });
  const roots = resolveClaudeRoots({ homeDir: h, env: { EXEC_CONFIG_DIR: alt } });
  assert.equal(roots[1].root, path.join(alt, "projects"));
  assert.equal(roots[1].harness, "claude-worker");
  rmSync(h, { recursive: true, force: true });
});

test("resolveClaudeRoots: AGENT_OFFICE_CLAUDE_ROOTS adds roots (workers by default, claude= for plain), dedupes", () => {
  const h = home();
  const a = path.join(h, "a");
  const b = path.join(h, "b");
  mkdirSync(a);
  mkdirSync(b);
  const env = { AGENT_OFFICE_CLAUDE_ROOTS: [a, `claude=${b}`, a].join(path.delimiter) };
  const roots = resolveClaudeRoots({ homeDir: h, env });
  assert.deepEqual(
    roots.map((r) => [path.basename(r.root), r.harness]),
    [["projects", "claude-code"], ["a", "claude-worker"], ["b", "claude-code"]],
  );
  rmSync(h, { recursive: true, force: true });
});

test("resolveClaudeRoots: CLAUDE_PROJECTS_ROOT overrides the main root", () => {
  const h = home();
  const roots = resolveClaudeRoots({ homeDir: h, env: { CLAUDE_PROJECTS_ROOT: "/x/projects" } });
  assert.deepEqual(roots[0], { root: "/x/projects", harness: "claude-code" });
  rmSync(h, { recursive: true, force: true });
});

test("resolveClaudeRoots: a symlinked alias of an already-listed root is not tailed twice", async () => {
  const { symlinkSync } = await import("node:fs");
  const h = home();
  const real = path.join(h, "real");
  mkdirSync(real);
  symlinkSync(real, path.join(h, "alias"));
  const roots = resolveClaudeRoots({
    homeDir: h,
    env: { CLAUDE_PROJECTS_ROOT: real, AGENT_OFFICE_CLAUDE_ROOTS: `claude=${path.join(h, "alias")}` },
  });
  assert.equal(roots.length, 1);
  rmSync(h, { recursive: true, force: true });
});
