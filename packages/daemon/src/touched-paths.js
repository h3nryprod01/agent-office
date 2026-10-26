// Which files does one tool call intend to write? Pure — no I/O. Feeds the
// radar (radar.js) via `meta.paths` on the normalizers' tool_call start events.
//
// Three tool vocabularies, one per harness:
//   Claude  Edit / Write / MultiEdit {file_path}, NotebookEdit {notebook_path}
//   Gemini  write_file / replace {file_path}
//   Codex   an apply_patch body ("*** Update File: p"). Codex has shipped it as
//           a custom_tool_call, a heredoc inside a shell call, and (codex-cli
//           0.14x) as `tools.apply_patch("...")` inside the `exec` tool's JS
//           source — so the patch is searched for in ANY tool input text.

import path from "node:path";

const PATH_ARG_BY_TOOL = {
  Edit: "file_path",
  Write: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
  write_file: "file_path",
  replace: "file_path",
};

// A patch path ends at a real newline, a quote, or the two characters `\n`
// when the patch sits inside a JS string literal — but only if what follows
// looks like patch syntax, so a Windows path like `src\new.txt` survives.
// ponytail: a Windows path segment that begins `\n` AND is followed by a patch
// marker char is misread; patches never name files like that in practice.
const PATCH_FILE_RE =
  /\*\*\* (?:Add File|Update File|Delete File|Move to): ([^\r\n"'`]+?)(?=\\n(?=\*\*\*|[+@ -]|$)|\r?\n|["'`]|$)/g;

function inputText(input) {
  if (typeof input === "string") return input;
  return null;
}

/**
 * @param {Object} call
 * @param {string} [call.tool]
 * @param {Object|string|null} [call.input] parsed tool input (Claude/Gemini object) or raw text (Codex)
 * @param {string|null} [call.cwd] relative paths resolve against this
 * @returns {string[]} unique absolute paths, in order of appearance
 */
export function touchedPaths({ tool, input, cwd } = {}) {
  const found = [];
  const argName = PATH_ARG_BY_TOOL[tool];
  if (argName && input && typeof input === "object" && typeof input[argName] === "string") {
    found.push(input[argName]);
  }
  const text = inputText(input) ?? (input && typeof input === "object" && typeof input.cmd === "string" ? input.cmd : null);
  if (text && text.includes("*** Begin Patch")) {
    for (const m of text.matchAll(PATCH_FILE_RE)) found.push(m[1].trim());
  }

  const out = [];
  for (const p of found) {
    if (!p) continue;
    let abs;
    if (path.isAbsolute(p)) abs = path.normalize(p);
    else if (cwd) abs = path.resolve(cwd, p);
    else continue; // relative with no cwd: cannot be compared with anything
    if (!out.includes(abs)) out.push(abs);
  }
  return out;
}
