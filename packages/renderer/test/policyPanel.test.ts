import { describe, expect, it } from "vitest";
import {
  auditTableHtml,
  buildPolicyPayload,
  draftFrom,
  projectCardHtml,
  type AuditRow,
  type ProjectPolicy,
} from "../src/ui/policyPanel";
import { modeBadgeHtml, whyText } from "../src/ui/policyLabels";

const project = (over: Partial<ProjectPolicy["policy"]> = {}): ProjectPolicy => ({
  slug: "acme-web",
  name: "Acme <Web>",
  cwd: "/work/acme-web",
  repo: "acme-web",
  hasPolicy: true,
  policy: {
    approval: { mode: "auto", roles: { pm: "auto" }, tools: { Bash: "deny" } },
    allowedHarnesses: ["claude"],
    allowedLanes: null,
    ...over,
  },
});

describe("draft ↔ payload", () => {
  it("round-trips a saved policy", () => {
    const p = project();
    expect(buildPolicyPayload(draftFrom(p))).toEqual(p.policy);
  });

  it("empty harness list and blank lanes mean 'no rule' (null), lanes are split and lower-cased", () => {
    const d = draftFrom(project());
    d.harnesses = [];
    d.lanes = "DeepSeek, glm  kimi";
    const out = buildPolicyPayload(d);
    expect(out.allowedHarnesses).toBeNull();
    expect(out.allowedLanes).toEqual(["deepseek", "glm", "kimi"]);
    d.lanes = "  ";
    expect(buildPolicyPayload(d).allowedLanes).toBeNull();
  });

  it("does not share mutable state with the saved policy", () => {
    const p = project();
    const d = draftFrom(p);
    d.tools.Edit = "ask";
    d.harnesses.push("codex");
    expect(p.policy.approval.tools).toEqual({ Bash: "deny" });
    expect(p.policy.allowedHarnesses).toEqual(["claude"]);
  });
});

describe("projectCardHtml", () => {
  it("escapes project names and shows the current mode, overrides and ticked harnesses", () => {
    const p = project();
    const html = projectCardHtml(p, draftFrom(p));
    expect(html).toContain("Acme &#60;Web&#62;");
    expect(html).not.toContain("<Web>");
    expect(html).toContain('<option value="auto" selected>Auto</option>');
    expect(html).toContain("Bash → Deny");
    expect(html).toContain("pm → Auto");
    expect(html).toMatch(/data-harness="claude" checked/);
    expect(html).not.toMatch(/data-harness="codex" checked/);
    expect(html).toContain("policy-badge mode-auto");
  });

  it("a project with no policy opens on Ask with nothing ticked", () => {
    const p = project({ approval: { mode: "ask", roles: {}, tools: {} }, allowedHarnesses: null });
    const html = projectCardHtml(p, draftFrom(p));
    expect(html).toContain('<option value="ask" selected>Ask</option>');
    expect(html).not.toContain(" checked");
  });
});

describe("auditTableHtml", () => {
  const row = (over: Partial<AuditRow> = {}): AuditRow => ({
    ts: 1_700_000_000_000,
    project: "acme-web",
    agent: "acme-web",
    harness: "claude-worker",
    lane: "deepseek",
    tool: "Bash",
    preview: "git push --force <x>",
    mode: "auto",
    decision: "ask",
    reasons: ["force-push"],
    forced: "danger",
    ...over,
  });

  it("empty → a calm message, not an empty table", () => {
    expect(auditTableHtml([])).toContain("Nothing decided automatically yet.");
  });

  it("shows agent, harness·lane, tool, mode, decision and the reason; escapes the preview", () => {
    const html = auditTableHtml([row()]);
    expect(html).toContain("acme-web · claude-worker · deepseek");
    expect(html).toContain("<strong>Bash</strong>");
    expect(html).toContain("git push --force &#60;x&#62;");
    expect(html).toContain("policy-decision ask");
    expect(html).toContain("risky action: force push");
    expect(html).toContain("mode-auto");
  });

  it("plain claude is not repeated in the agent column", () => {
    expect(auditTableHtml([row({ harness: "claude", lane: null })])).toContain("<td>acme-web</td>");
  });
});

describe("labels", () => {
  it("whyText: forced head + readable reasons; unknown codes pass through", () => {
    expect(whyText("danger", ["secret-read", "force-push"])).toBe("risky action: secret file, force push");
    expect(whyText("budget", [])).toBe("over budget");
    expect(whyText(null, ["brand-new-code"])).toBe("brand-new-code");
    expect(whyText(null, [])).toBe("");
  });

  it("modeBadgeHtml: unknown mode degrades to the ask styling", () => {
    expect(modeBadgeHtml("read-only")).toContain("mode-read-only");
    expect(modeBadgeHtml("weird")).toContain("mode-ask");
  });
});

describe("harnesses the form has no checkbox for", () => {
  it("are shown ticked and survive the draft→payload round trip", () => {
    const p = project({ allowedHarnesses: ["aider", "claude"] });
    const html = projectCardHtml(p, draftFrom(p));
    expect(html).toMatch(/data-harness="aider" checked/);
    expect(buildPolicyPayload(draftFrom(p)).allowedHarnesses).toEqual(["aider", "claude"]);
  });
});
