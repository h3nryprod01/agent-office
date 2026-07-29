import test from "node:test";
import assert from "node:assert/strict";
import { checkCommand } from "./block-dangerous-git.mjs";

const denied = (cmd) => checkCommand(cmd) !== null;

test("the incident: a chained delete runs even when the merge before it failed", () => {
  // What actually happened on PR #26: `gh pr merge` hit a conflict, the branch
  // was deleted anyway, and the only reason it was recoverable was refs/pull.
  assert.ok(denied("gh pr merge 26 --squash; git branch -D feat/costs"));
  assert.ok(denied("gh pr merge 26 --squash && git branch -D feat/costs"));
  // `-d` refuses to delete an unmerged branch — that is the whole point.
  assert.ok(!denied("gh pr merge 26 --squash && git branch -d feat/costs"));
});

test("force delete: every spelling, including bundled short flags", () => {
  for (const cmd of ["git branch -D x", "git branch --delete --force x", "git branch -Dr origin/x", "git branch -fD x"]) {
    assert.ok(denied(cmd), cmd);
  }
  assert.ok(!denied("git branch -d x"));
  assert.ok(!denied("git branch --list"));
});

test("force push: --force-with-lease is the safe one and must survive", () => {
  assert.ok(denied("git push --force origin main"));
  assert.ok(denied("git push -f"));
  assert.ok(denied("git push origin +main")); // refspec force
  assert.ok(!denied("git push --force-with-lease origin main"));
  assert.ok(!denied("git push -u origin feat/x")); // the everyday push must not break
});

test("hard reset, force clean, wholesale checkout", () => {
  assert.ok(denied("git reset --hard HEAD~1"));
  assert.ok(!denied("git reset HEAD~1")); // soft/mixed reset keeps the worktree
  assert.ok(denied("git clean -fd"));
  assert.ok(denied("git clean -df"));
  assert.ok(!denied("git clean -n")); // dry run
  assert.ok(denied("git checkout ."));
  assert.ok(denied("git restore ."));
  assert.ok(!denied("git checkout main"));
});

test("global options must not hide the subcommand", () => {
  // `-C <path>` takes a value; a naive `argv[1]` reader sees "-C" and gives up.
  assert.ok(denied("git -C /tmp/repo reset --hard"));
  assert.ok(denied("git -c user.name=x -C /tmp/repo branch -D y"));
  assert.ok(denied("git --git-dir=/tmp/.git clean -fd"));
});

test("a `git` that is not the git binary is not our business", () => {
  assert.ok(!denied("echo git reset --hard"));
  assert.ok(!denied("grep -rn 'git push --force' docs/"));
  assert.ok(!denied("npm test"));
});

test("the reason names the safe alternative, so the agent can retry", () => {
  assert.match(checkCommand("git branch -D x").reason, /-d\b/);
  assert.match(checkCommand("git push --force").reason, /--force-with-lease/);
});
