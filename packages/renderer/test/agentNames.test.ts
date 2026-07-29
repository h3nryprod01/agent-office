import { describe, expect, it } from "vitest";
import { friendlyName, roleOf } from "../src/sim/agentNames";

describe("roleOf", () => {
  it("defaults to 'coder' — most agent work is code", () => {
    expect(roleOf("demo-app", null)).toBe("coder");
    expect(roleOf("agent-office", null)).toBe("coder");
    expect(roleOf("other", null)).toBe("coder");
  });

  it("infers a role from repo keywords", () => {
    expect(roleOf("acme-marketing", null)).toBe("marketing");
    expect(roleOf("q3-campaign", null)).toBe("marketing");
    expect(roleOf("content-studio", null)).toBe("content");
    expect(roleOf("blog-writer", null)).toBe("content");
    expect(roleOf("product-planning", null)).toBe("planner");
    expect(roleOf("brand-design", null)).toBe("designer");
  });

  it("uses an explicit role over the keyword guess, slugified", () => {
    expect(roleOf("demo-app", "Code Reviewer")).toBe("code-reviewer");
    expect(roleOf("acme-marketing", "planner")).toBe("planner");
    expect(roleOf("x", "  ")).toBe("agent"); // empty after slug → safe fallback
  });
});

describe("friendlyName", () => {
  it("zero-pads a 1-based sequence onto the role", () => {
    expect(friendlyName("coder", 1)).toBe("coder-01");
    expect(friendlyName("marketing", 12)).toBe("marketing-12");
  });
});
