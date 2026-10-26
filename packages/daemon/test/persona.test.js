// lane L6: persona + SOP schema, member kit loading, prompt composition.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseRoster } from "../src/roster.js";
import {
  buildMemberPrompt,
  loadMemberKit,
  parseSop,
  validateCompany,
} from "../src/persona.js";

const GOOD_SOP = `---
title: Developer
role: Implements one ticket
inputs:
  - A ticket with acceptance criteria
  - The file areas you may touch
steps:
  - Read the ticket and restate it in one sentence
  - "Write the failing test first: RED"
  - Make it pass with the smallest diff
done:
  - Tests green, output pasted in the report
  - Diff only touches the allowed file areas
handoff:
  - code-reviewer: PR link and the test output
  - human: anything that needs a product decision
escalate:
  - The ticket contradicts the existing behaviour
  - You need to touch a file outside your area
---
## Notes

Free markdown below the frontmatter.
`;

test("parseSop reads every required section", () => {
  const { sop, errors } = parseSop(GOOD_SOP);
  assert.deepEqual(errors, []);
  assert.equal(sop.title, "Developer");
  assert.equal(sop.inputs.length, 2);
  assert.equal(sop.steps[1], "Write the failing test first: RED"); // quotes stripped, colon kept
  assert.deepEqual(sop.handoff[0], { to: "code-reviewer", what: "PR link and the test output" });
  assert.equal(sop.escalate.length, 2);
  assert.match(sop.body, /Free markdown/);
});

test("parseSop reports each missing or empty section by name", () => {
  const { errors } = parseSop("---\ntitle: X\nsteps:\n  - only one\n---\n");
  for (const key of ["inputs", "done", "handoff", "escalate"]) {
    assert.ok(errors.some((e) => e.includes(key)), `expected an error mentioning ${key}: ${errors}`);
  }
  assert.ok(errors.some((e) => e.includes("steps")), "a single step is not a procedure");
});

test("parseSop flags unknown keys (typo guard) and missing frontmatter", () => {
  assert.ok(parseSop(GOOD_SOP.replace("steps:", "step:")).errors.some((e) => e.includes("step")));
  assert.ok(parseSop("# no frontmatter").errors.length > 0);
});

test("parseSop rejects a handoff item that is not `target: what`", () => {
  const bad = GOOD_SOP.replace("  - code-reviewer: PR link and the test output", "  - just a sentence");
  assert.ok(parseSop(bad).errors.some((e) => e.includes("handoff")));
});

function makeDir(files) {
  const dir = mkdtempSync(path.join(tmpdir(), "ao-l6-persona-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}

const ROSTER = `version: 1
departments:
  eng:
    members:
      - name: developer
        source: builtin
        role: Implements tickets
        sop: sops/developer.md
        persona:
          name: Linh
          role: Developer
          avatar: engineer
          voice: Plain and brief
          tone: calm
          prompt_file: personas/linh.md
      - name: code-reviewer
        source: "~/.claude/agents"
        persona:
          name: Sam
          role: Reviewer
          avatar: reviewer
          voice: Direct
          tone: strict
          prompt: "You review the diff, not the person."
        sop: sops/reviewer.md
      - { name: legacy, source: "~/.claude/agents", role: "No persona, no sop" }
`;

test("loadMemberKit loads persona, prompt_file and the SOP; legacy members get an empty kit", () => {
  const dir = makeDir({ "sops/developer.md": GOOD_SOP, "personas/linh.md": "You are Linh.\n" });
  const members = parseRoster(ROSTER).departments[0].members;
  const kit = loadMemberKit({ baseDir: dir, member: members[0] });
  assert.equal(kit.persona.name, "Linh");
  assert.equal(kit.persona.prompt, "You are Linh.");
  assert.equal(kit.sop.title, "Developer");
  assert.deepEqual(kit.problems, []);

  const legacy = loadMemberKit({ baseDir: dir, member: members[2] });
  assert.equal(legacy.persona, null);
  assert.equal(legacy.sop, null);
  assert.deepEqual(legacy.problems, []);
  rmSync(dir, { recursive: true });
});

test("loadMemberKit never throws: a missing SOP file is a problem, the persona still loads", () => {
  const dir = makeDir({});
  const [, reviewer] = parseRoster(ROSTER).departments[0].members;
  const kit = loadMemberKit({ baseDir: dir, member: reviewer });
  assert.equal(kit.persona.name, "Sam");
  assert.equal(kit.sop, null);
  assert.ok(kit.problems.some((p) => p.includes("sops/reviewer.md")));
  rmSync(dir, { recursive: true });
});

test("asset paths: only flat sops/*.md or personas/*.md, no traversal, no symlink escape", () => {
  const outside = makeDir({ "secret.md": "TOP SECRET" });
  const dir = makeDir({});
  mkdirSync(path.join(dir, "sops"));
  symlinkSync(path.join(outside, "secret.md"), path.join(dir, "sops", "leak.md"));
  for (const sop of ["../secret.md", "/etc/passwd", "sops/../../x.md", "sops/a/b.md", "other/x.md", "sops/x.txt", "sops\\x.md", "leak.md", "sops/leak.md"]) {
    const kit = loadMemberKit({ baseDir: dir, member: { name: "m", sop } });
    assert.equal(kit.sop, null, sop);
    assert.ok(kit.problems.length > 0, `no problem reported for ${sop}`);
  }
  rmSync(dir, { recursive: true });
  rmSync(outside, { recursive: true });
});

test("buildMemberPrompt carries persona, SOP sections, the task and the step contract", () => {
  const dir = makeDir({ "sops/developer.md": GOOD_SOP, "personas/linh.md": "You are Linh." });
  const member = parseRoster(ROSTER).departments[0].members[0];
  const kit = loadMemberKit({ baseDir: dir, member });
  const prompt = buildMemberPrompt({
    member,
    kit,
    task: { id: "it-1", title: "Add rate limiting to /login", brief: "Max 5 tries per minute per IP." },
  });
  assert.match(prompt, /You are Linh/);
  assert.match(prompt, /Developer/);
  assert.match(prompt, /1\. Read the ticket/);
  assert.match(prompt, /Write the failing test first: RED/);
  assert.match(prompt, /A ticket with acceptance criteria/);
  assert.match(prompt, /code-reviewer/);
  assert.match(prompt, /Escalate to a human/i);
  assert.match(prompt, /Add rate limiting to \/login/);
  assert.match(prompt, /Max 5 tries per minute/);
  assert.match(prompt, /sopStep/);
  assert.match(prompt, /it-1/);
  rmSync(dir, { recursive: true });
});

test("buildMemberPrompt works for a legacy member (task only, no persona/SOP)", () => {
  const member = { name: "legacy", role: "Old style" };
  const prompt = buildMemberPrompt({
    member,
    kit: { persona: null, sop: null, problems: [] },
    task: { id: "it-2", title: "Do the thing" },
  });
  assert.match(prompt, /legacy/);
  assert.match(prompt, /Do the thing/);
  assert.doesNotMatch(prompt, /sopStep/); // nothing to track without an SOP
});

test("validateCompany: strict check of a whole company directory", () => {
  const ok = makeDir({ "roster.yaml": ROSTER, "sops/developer.md": GOOD_SOP, "sops/reviewer.md": GOOD_SOP, "personas/linh.md": "x" });
  assert.deepEqual(validateCompany({ baseDir: ok }), []);

  // dangling handoff target + missing persona field + missing sop file
  const broken = makeDir({
    "roster.yaml": ROSTER.replace("avatar: engineer\n", "").replace("sops/reviewer.md", "sops/nope.md"),
    "sops/developer.md": GOOD_SOP.replace("code-reviewer:", "ghost-member:"),
    "personas/linh.md": "x",
  });
  const problems = validateCompany({ baseDir: broken }).join("\n");
  assert.match(problems, /avatar/);
  assert.match(problems, /nope\.md/);
  assert.match(problems, /ghost-member/);
  rmSync(ok, { recursive: true });
  rmSync(broken, { recursive: true });
});
