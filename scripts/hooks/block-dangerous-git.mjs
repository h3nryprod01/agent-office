#!/usr/bin/env node
// PreToolUse hook: refuse the git commands that destroy work you cannot get back.
//
// Written rather than installed. mattpocock/skills ships an equivalent
// (misc/git-guardrails-claude-code) but it greps the raw command string, so
// `git -C /path push --force` slips through while a heredoc merely *mentioning*
// "git push" gets blocked. It also forbids every push, which would stop the
// chips from ever opening a PR. This one parses the command and only blocks the
// forcing variant, so the safe spelling of each command still works.
//
// Exit 2 = deny (Claude Code shows stderr to the agent); exit 0 = allow.

import { pathToFileURL } from "node:url";

/** Split on shell operators. A quoted `;` splits too — that fails closed, which is the right way to fail. */
const SEGMENTS = /(?:&&|\|\||[;\n|])/;

/** `-C <path>` and `-c <k=v>` consume the token after them; miss that and the subcommand looks like a flag. */
const GLOBAL_OPTS_WITH_VALUE = new Set(["-C", "-c", "--namespace"]);

/** `-Dr`, `-fd` — one dash, letters bundled together. */
const isShortCluster = (tok) => /^-[a-zA-Z]+$/.test(tok);
const clusterHas = (tok, letter) => isShortCluster(tok) && tok.includes(letter);

/** The subcommand and its arguments, with git's own global options stripped. Null if this isn't a git call. */
function parseGit(segment) {
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  // ponytail: only a leading `git` counts. `env FOO=1 git push -f` slips through —
  // add a prefix-skipping loop if that ever shows up in a real transcript.
  if (tokens.length === 0 || tokens[0].split("/").pop() !== "git") return null;

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i];
    if (GLOBAL_OPTS_WITH_VALUE.has(tok)) i++;
    else if (tok.startsWith("-")) continue;
    else return { subcommand: tok, args: tokens.slice(i + 1) };
  }
  return null; // `git` with no subcommand
}

const RULES = {
  branch: (args) =>
    args.some((a) => a === "--force" || clusterHas(a, "D")) &&
    "`git branch -D` deletes a branch even when it was never merged. Use `git branch -d` — it refuses unless the work is safely merged. If you truly need -D, do it yourself outside the agent.",

  push: (args) =>
    args.some((a) => a === "--force" || a === "-f" || clusterHas(a, "f") || a.startsWith("+")) &&
    "A force push overwrites commits on the remote that nobody has a copy of. Use `git push --force-with-lease`, which aborts if the remote moved since you last fetched.",

  reset: (args) => args.includes("--hard") && "`git reset --hard` throws away every uncommitted change with no reflog entry. Use `git stash` first, or `git reset` (mixed) to keep the working tree.",

  clean: (args) =>
    args.some((a) => a === "--force" || clusterHas(a, "f")) &&
    "`git clean -f` permanently deletes untracked files, including ones git never knew about. Run `git clean -n` first and read the list.",

  checkout: (args) => args.includes(".") && "`git checkout .` discards every unstaged edit in the tree. Name the file you meant, or stash.",
  restore: (args) => args.includes(".") && "`git restore .` discards every unstaged edit in the tree. Name the file you meant, or stash.",
};

/**
 * @param {string} command a full shell command line, operators and all
 * @returns {{segment: string, reason: string}|null} null when nothing in it is destructive
 */
export function checkCommand(command) {
  for (const segment of String(command ?? "").split(SEGMENTS)) {
    const git = parseGit(segment);
    if (!git) continue;
    const reason = RULES[git.subcommand]?.(git.args);
    if (reason) return { segment: segment.trim(), reason };
  }
  return null;
}

// Hook entry point. Skipped when this file is imported by the test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);

  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    process.exit(0); // a hook that cannot read its input must not block the agent
  }

  if (input.tool_name !== "Bash") process.exit(0);

  const hit = checkCommand(input.tool_input?.command);
  if (hit) {
    process.stderr.write(`BLOCKED: ${hit.segment}\n\n${hit.reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}
