// lane L6: persona cards, the SOP view and the tiny markdown renderer behind it.
import { describe, expect, it } from "vitest";
import { mdToHtml, personaCardHtml, personaMeta, sopHtml, type Sop } from "../src/ui/personas";

const member = {
  name: "developer",
  role: "Implements tickets",
  sop: "sops/developer.md",
  persona: {
    name: "Linh",
    role: "Developer",
    avatar: "engineer",
    voice: "Plain and brief",
    tone: "calm",
    prompt: "You are Linh.",
    promptFile: null,
  },
};

const sop: Sop = {
  title: "Developer",
  role: "Implements one ticket",
  inputs: ["A ticket"],
  steps: ["Write the failing test", "Make it pass"],
  done: ["Tests green"],
  handoff: [{ to: "code-reviewer", what: "the PR link" }],
  escalate: ["The ticket contradicts the code"],
  body: "## Rules\n\n- one **ticket** at a time\n- `git status` first",
};

describe("personaCardHtml", () => {
  it("shows name, role, voice and tone, tags the avatar slug, and offers the SOP", () => {
    const html = personaCardHtml(member);
    expect(html).toContain("Linh");
    expect(html).toContain("Developer");
    expect(html).toContain("Plain and brief");
    expect(html).toContain("calm");
    expect(html).toContain('data-avatar="engineer"');
    expect(html).toContain('data-sop="developer"');
  });

  it("renders nothing for a member without a persona (old rosters look as before)", () => {
    expect(personaCardHtml({ name: "legacy", role: "x" })).toBe("");
  });

  it("offers no SOP button when the member has no SOP", () => {
    expect(personaCardHtml({ ...member, sop: null })).not.toContain("data-sop");
  });

  it("escapes everything that comes from the roster", () => {
    const html = personaCardHtml({
      ...member,
      name: 'x"><img src=x onerror=alert(1)>',
      persona: { ...member.persona, name: "<script>alert(1)</script>", avatar: 'a" onmouseover="x' },
    });
    expect(html).not.toMatch(/<script|<img/);
    expect(html).toContain('data-avatar="a&#34; onmouseover=&#34;x"'); // the quote cannot close the attribute
  });
});

describe("sopHtml", () => {
  it("renders every section with numbered steps and a done checklist", () => {
    const html = sopHtml(sop);
    expect(html).toContain("Developer");
    expect(html).toMatch(/<ol[^>]*>\s*<li>Write the failing test<\/li>/);
    expect(html).toContain("Tests green");
    expect(html).toContain("code-reviewer");
    expect(html).toContain("the PR link");
    expect(html).toContain("The ticket contradicts the code");
    expect(html).toContain("<strong>ticket</strong>");
    expect(html).toContain("<code>git status</code>");
  });

  it("escapes SOP text", () => {
    const html = sopHtml({ ...sop, title: "<b>x</b>", steps: ["<script>1</script>", "b"] });
    expect(html).not.toMatch(/<b>x|<script>/);
  });
});

describe("mdToHtml", () => {
  it("handles headings, lists, fences and tables, and escapes raw html", () => {
    const html = mdToHtml("# T\n\npara <i>x</i>\n\n- a\n- b\n\n```\ncode <x>\n```\n\n| h1 | h2 |\n|---|---|\n| c1 | c2 |\n");
    expect(html).toContain("<h4>T</h4>");
    expect(html).toContain("&#60;i&#62;x&#60;/i&#62;");
    expect(html).toMatch(/<ul>\s*<li>a<\/li>\s*<li>b<\/li>\s*<\/ul>/);
    expect(html).toContain("<pre><code>code &#60;x&#62;");
    expect(html).toMatch(/<table[^>]*>.*<th>h1<\/th>.*<td>c2<\/td>/s);
  });
});

describe("personaMeta", () => {
  it("says how many people arrive with a persona and an SOP", () => {
    expect(personaMeta({ personaCount: 9, sopCount: 11 })).toBe("9 personas · 11 SOPs");
  });
  it("is empty for a template without any", () => {
    expect(personaMeta({})).toBeNull();
    expect(personaMeta({ personaCount: 0, sopCount: 0 })).toBeNull();
  });
});
