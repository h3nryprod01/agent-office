import { describe, expect, it } from "vitest";
import { vendorOf, vendorBadgeHtml } from "../src/ui/vendor";

describe("vendorOf", () => {
  it("maps each harness to a stable key, label and colour", () => {
    expect(vendorOf("claude-code", null)).toMatchObject({ key: "claude", label: "Claude" });
    expect(vendorOf("codex", null)).toMatchObject({ key: "codex", label: "Codex" });
    expect(vendorOf("gemini", null)).toMatchObject({ key: "gemini", label: "Gemini" });
    expect(vendorOf("hermes", null)).toMatchObject({ key: "hermes", label: "Hermes" });
  });

  it("a Claude Code worker is identified by its lane, not by the harness", () => {
    expect(vendorOf("claude-worker", "deepseek")).toMatchObject({ key: "deepseek", label: "DeepSeek" });
    expect(vendorOf("claude-worker", "mimo")).toMatchObject({ key: "mimo", label: "MiMo" });
    expect(vendorOf("claude-worker", "glm")).toMatchObject({ key: "glm", label: "GLM" });
    expect(vendorOf("claude-worker", "kimi")).toMatchObject({ key: "kimi", label: "Kimi" });
  });

  it("an unknown lane still gets a readable label; no lane yet is a generic worker", () => {
    expect(vendorOf("claude-worker", "gpt-oss")).toMatchObject({ key: "gpt-oss", label: "gpt-oss" });
    expect(vendorOf("claude-worker", null)).toMatchObject({ key: "worker", label: "Worker" });
  });

  it("a known non-Anthropic lane beats the claude-code harness (MiMo run from the main config dir)", () => {
    expect(vendorOf("claude-code", "mimo")).toMatchObject({ key: "mimo", label: "MiMo" });
    expect(vendorOf("codex", "mimo")).toMatchObject({ key: "codex" }); // other harnesses ignore lane
  });

  it("no harness → null (no badge)", () => {
    expect(vendorOf(null, null)).toBeNull();
    expect(vendorOf(undefined, undefined)).toBeNull();
  });

  it("every vendor colour is a hex the CSS variable can take", () => {
    for (const h of ["claude-code", "codex", "gemini", "hermes"]) expect(vendorOf(h, null)!.color).toMatch(/^#[0-9a-f]{6}$/i);
    for (const l of ["deepseek", "mimo", "glm", "kimi", "other"]) expect(vendorOf("claude-worker", l)!.color).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe("vendorBadgeHtml", () => {
  it("renders a dot and a label, escaping the lane", () => {
    const html = vendorBadgeHtml("claude-worker", "deepseek");
    expect(html).toContain("vendor-badge");
    expect(html).toContain("DeepSeek");
    expect(vendorBadgeHtml("claude-worker", "<img onerror=x>")).not.toContain("<img");
  });

  it("empty string when there is nothing to show", () => {
    expect(vendorBadgeHtml(null, null)).toBe("");
  });
});
