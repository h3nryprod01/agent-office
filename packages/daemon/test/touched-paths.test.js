import { test } from "node:test";
import assert from "node:assert/strict";
import { touchedPaths } from "../src/touched-paths.js";

test("claude: Edit / Write / MultiEdit use file_path", () => {
  for (const tool of ["Edit", "Write", "MultiEdit"]) {
    assert.deepEqual(touchedPaths({ tool, input: { file_path: "/w/demo-app/src/a.ts" } }), ["/w/demo-app/src/a.ts"]);
  }
});

test("claude: NotebookEdit uses notebook_path; read-only tools touch nothing", () => {
  assert.deepEqual(touchedPaths({ tool: "NotebookEdit", input: { notebook_path: "/w/n.ipynb" } }), ["/w/n.ipynb"]);
  assert.deepEqual(touchedPaths({ tool: "Read", input: { file_path: "/w/a.ts" } }), []);
  assert.deepEqual(touchedPaths({ tool: "Bash", input: { command: "echo > /w/a.ts" } }), []);
});

test("relative paths resolve against cwd", () => {
  assert.deepEqual(touchedPaths({ tool: "Edit", input: { file_path: "src/a.ts" }, cwd: "/w/demo-app" }), [
    "/w/demo-app/src/a.ts",
  ]);
});

test("gemini: write_file / replace use args.file_path", () => {
  assert.deepEqual(touchedPaths({ tool: "write_file", input: { file_path: "/w/g.md", content: "x" } }), ["/w/g.md"]);
  assert.deepEqual(touchedPaths({ tool: "replace", input: { file_path: "/w/g.md", old_string: "a" } }), ["/w/g.md"]);
  assert.deepEqual(touchedPaths({ tool: "read_file", input: { file_path: "/w/g.md" } }), []);
});

const PATCH =
  "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-old\n+new\n*** Add File: docs/b.md\n+hi\n*** Delete File: old.txt\n*** End Patch\n";

test("codex: apply_patch body (custom_tool_call input string)", () => {
  assert.deepEqual(touchedPaths({ tool: "apply_patch", input: PATCH, cwd: "/w/demo-app" }), [
    "/w/demo-app/src/a.ts",
    "/w/demo-app/docs/b.md",
    "/w/demo-app/old.txt",
  ]);
});

test("codex: *** Move to: counts as a touch of the destination too", () => {
  const patch = "*** Begin Patch\n*** Update File: a.ts\n*** Move to: b.ts\n@@\n+x\n*** End Patch";
  assert.deepEqual(touchedPaths({ tool: "apply_patch", input: patch, cwd: "/w" }), ["/w/a.ts", "/w/b.ts"]);
});

test("codex: patch embedded in the exec tool's JS source (escaped newlines)", () => {
  const js = 'text(await tools.apply_patch("*** Begin Patch\\n*** Add File: videos/x/BRIEF.md\\n+# Title\\n*** End Patch"))';
  assert.deepEqual(touchedPaths({ tool: "exec", input: js, cwd: "/w/p" }), ["/w/p/videos/x/BRIEF.md"]);
});

test("codex: patch embedded in a shell function_call (JSON arguments string)", () => {
  const args = JSON.stringify({ cmd: `apply_patch <<'EOF'\n${PATCH}EOF`, workdir: "/w/demo-app" });
  assert.deepEqual(touchedPaths({ tool: "exec_command", input: args, cwd: "/w/demo-app" }), [
    "/w/demo-app/src/a.ts",
    "/w/demo-app/docs/b.md",
    "/w/demo-app/old.txt",
  ]);
});

test("codex: text without a patch header is ignored (no false positives)", () => {
  assert.deepEqual(touchedPaths({ tool: "exec", input: "echo '*** Update File: nope'", cwd: "/w" }), []);
});

test("duplicates collapse, junk input is safe", () => {
  assert.deepEqual(
    touchedPaths({ tool: "apply_patch", input: "*** Begin Patch\n*** Update File: a\n*** Update File: a\n", cwd: "/w" }),
    ["/w/a"],
  );
  assert.deepEqual(touchedPaths({ tool: "Edit", input: null }), []);
  assert.deepEqual(touchedPaths({ tool: "Edit", input: { file_path: 42 } }), []);
  assert.deepEqual(touchedPaths({}), []);
});
