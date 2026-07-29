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
