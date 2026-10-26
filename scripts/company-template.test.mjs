import { test } from "node:test";
import assert from "node:assert/strict";
import { extractMemberNames, missingSkills } from "./company-template-lib.mjs";

// A realistic 3-department roster exercising flow form, block form, and quoted names.
const SAMPLE_ROSTER = `version: 1
departments:
  media:
    members:
      - { name: hyperframes, source: "~/.claude/skills", role: "video HTML/GSAP" }
      - { name: canvas-design, source: "~/.claude/skills", role: "thumbnail" }
      - { name: "fal:ai-media", source: "~/.claude/skills", role: "gen media" }
  marketing:
    members:
      - name: content-engine
        source: "~/.claude/skills"
        role: "content engine"
      - name: youtube-seo
        source: "~/.claude/skills"
        role: "youtube SEO"
  research:
    members:
      - { name: deep-research, source: "~/.claude/skills" }
`;

test("extractMemberNames pulls names across departments, flow + block + quoted", () => {
  const names = extractMemberNames(SAMPLE_ROSTER);
  assert.deepEqual(names, [
    "hyperframes",
    "canvas-design",
    "fal:ai-media",
    "content-engine",
    "youtube-seo",
    "deep-research",
  ]);
});

test("extractMemberNames ignores non-member lines (departments/keys/roles)", () => {
  const names = extractMemberNames(SAMPLE_ROSTER);
  // role text and dept names must never leak in as a "name"
  assert.ok(!names.includes("video HTML/GSAP"));
  assert.ok(!names.includes("media"));
  assert.ok(!names.includes("role"));
});

test("extractMemberNames returns [] for text with no member entries", () => {
  assert.deepEqual(extractMemberNames("version: 1\nupdated: today\n"), []);
  assert.deepEqual(extractMemberNames(""), []);
});

test("extractMemberNames handles single-quoted names too", () => {
  const names = extractMemberNames("  - { name: 'weird name', source: x }");
  assert.deepEqual(names, ["weird name"]);
});

test("missingSkills returns only names not in installed set", () => {
  const names = ["hyperframes", "canvas-design", "deep-research"];
  const installed = new Set(["hyperframes", "deep-research"]);
  assert.deepEqual(missingSkills(names, installed), ["canvas-design"]);
});

test("missingSkills returns [] when everything is installed", () => {
  const names = ["a", "b"];
  assert.deepEqual(missingSkills(names, new Set(["a", "b", "c"])), []);
});

test("missingSkills returns all when nothing is installed", () => {
  const names = ["a", "b"];
  assert.deepEqual(missingSkills(names, new Set([])), ["a", "b"]);
});

// lane L6: `apply` into a throwaway company dir leaves persona + SOP files next to the roster.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { copyCompanyAssets, pluginMemberNames } from "./company-template-lib.mjs";

const CLI = fileURLToPath(new URL("./company-template.mjs", import.meta.url));

test("CLI: apply <template> --company-dir <tmp> writes roster, sops and reports them", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ao-l6-cli-"));
  try {
    const companyDir = path.join(root, "company");
    const out = execFileSync("node", [CLI, "apply", "coding", "--company-dir", companyDir, "--home", path.join(root, "home")], { encoding: "utf8" });
    assert.ok(fs.existsSync(path.join(companyDir, "roster.yaml")));
    assert.ok(fs.existsSync(path.join(companyDir, "sops", "developer.md")));
    assert.match(out, /persona/i);
    assert.match(out, /SOP/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("CLI: apply refuses --company-dir without a value", () => {
  assert.throws(() => execFileSync("node", [CLI, "apply", "coding", "--company-dir"], { stdio: "pipe" }));
});

test("copyCompanyAssets: a template without sops/ copies nothing and returns zero counts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ao-l6-assets-"));
  try {
    fs.mkdirSync(path.join(root, "tpl"));
    assert.deepEqual(copyCompanyAssets(path.join(root, "tpl"), path.join(root, "dest")), { sops: 0, personas: 0 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pluginMemberNames: flow plugin, block plugin and builtin are uncheckable; plain skills are not", () => {
  const text = `  - { name: a, source: "plugin x" }
  - name: b
    source: "plugin y"
    persona:
      name: Not A Member
  - name: c
    source: builtin
  - name: d
    source: "~/.claude/skills"
`;
  assert.deepEqual([...pluginMemberNames(text)].sort(), ["a", "b", "c"]);
});
