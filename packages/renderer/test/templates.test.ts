import { describe, expect, it } from "vitest";
import {
  applyButtonLabel,
  applyLines,
  armWarning,
  missingLabel,
  nextArm,
  summaryMeta,
  type TemplateSummary,
} from "../src/ui/templates";

const studio: TemplateSummary = {
  name: "content-studio",
  departments: [
    { name: "media", memberCount: 5 },
    { name: "marketing", memberCount: 3 },
  ],
  memberTotal: 8,
  hasGoals: true,
  missingSkills: [],
};

describe("summaryMeta", () => {
  it("counts departments and members, and flags goals.md", () => {
    expect(summaryMeta(studio)).toBe("2 departments · 8 people · has goals.md");
  });

  it("says so when a template has no goals", () => {
    expect(summaryMeta({ ...studio, hasGoals: false })).toContain("no goals.md");
  });

  it("handles an empty template without dividing by zero-ish nonsense", () => {
    expect(summaryMeta({ ...studio, departments: [], memberTotal: 0 })).toBe(
      "0 departments · 0 people · has goals.md",
    );
  });
});

describe("missingLabel", () => {
  it("is null when nothing is missing (no scary warning on a ready template)", () => {
    expect(missingLabel([])).toBeNull();
  });

  it("names the missing skills and points at company-hire", () => {
    const label = missingLabel(["ads-manager", "zalo-poster"])!;
    expect(label).toContain("Missing 2 skill");
    expect(label).toContain("ads-manager, zalo-poster");
    expect(label).toContain("company-hire");
  });
});

describe("two-step confirm", () => {
  it("first click arms, it does not apply", () => {
    expect(nextArm(null, "content-studio")).toEqual({ armed: "content-studio", apply: null });
  });

  it("second click on the SAME template applies and disarms", () => {
    expect(nextArm("content-studio", "content-studio")).toEqual({ armed: null, apply: "content-studio" });
  });

  it("clicking a different template re-arms instead of applying the wrong company", () => {
    expect(nextArm("content-studio", "real-estate-marketing")).toEqual({
      armed: "real-estate-marketing",
      apply: null,
    });
  });

  it("needs two clicks on the new template after switching", () => {
    const first = nextArm("content-studio", "real-estate-marketing");
    expect(nextArm(first.armed, "real-estate-marketing").apply).toBe("real-estate-marketing");
  });

  it("labels the armed button as a destructive overwrite", () => {
    expect(applyButtonLabel(false)).toBe("Apply");
    expect(applyButtonLabel(true)).toContain("OVERWRITE");
  });

  it("warns which file is overwritten and that a backup is taken first", () => {
    const warn = armWarning("content-studio");
    expect(warn).toContain("content-studio");
    expect(warn).toContain("~/.claude/company/roster.yaml");
    expect(warn).toContain("backed up");
  });
});

describe("applyLines", () => {
  it("shows the real backup path the daemon reported", () => {
    const lines = applyLines({
      backupPath: "/Users/x/.claude/company/roster.yaml.2026-07-10T09-00-00-000Z.bak",
      missingSkills: [],
      goals: null,
    });
    expect(lines[0]).toContain("roster.yaml.2026-07-10T09-00-00-000Z.bak");
    expect(lines[1]).toContain("already installed");
  });

  it("says a new roster was created when there was nothing to back up", () => {
    const lines = applyLines({ backupPath: null, missingSkills: [], goals: null });
    expect(lines[0]).toContain("there was no previous one");
  });

  it("surfaces missing skills instead of silently installing them", () => {
    const lines = applyLines({ backupPath: null, missingSkills: ["ads-manager"], goals: null });
    expect(lines[1]).toContain("ads-manager");
    expect(lines[1]).toContain("company-hire");
  });
});
