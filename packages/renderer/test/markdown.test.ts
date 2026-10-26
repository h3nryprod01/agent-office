import { describe, expect, it } from "vitest";
import { parseCsv, plainText, renderInline, renderMarkdown } from "../src/ui/markdown";

describe("renderInline", () => {
  it("escapes HTML before adding any markup", () => {
    expect(renderInline("<script>alert(1)</script> & <b>x</b>")).toBe(
      "&#60;script&#62;alert(1)&#60;/script&#62; &#38; &#60;b&#62;x&#60;/b&#62;",
    );
  });

  it("renders code, bold, italic and strikethrough; code contents stay literal", () => {
    expect(renderInline("**b** *i* ~~s~~ `**not bold**`")).toBe(
      "<strong>b</strong> <em>i</em> <del>s</del> <code>**not bold**</code>",
    );
  });

  it("does not turn snake_case or a * b * c into emphasis", () => {
    expect(renderInline("a snake_case_name and 2 * 3 * 4")).toBe("a snake_case_name and 2 * 3 * 4");
  });

  it("links: http(s) open in a new tab; javascript:/data: become plain text; & in a label is not double-escaped", () => {
    expect(renderInline("[docs](https://example.com/a?b=1&c=2)")).toBe(
      '<a href="https://example.com/a?b=1&#38;c=2" target="_blank" rel="noopener noreferrer">docs</a>',
    );
    expect(renderInline("[x](javascript:alert(1))")).not.toContain("href");
    expect(renderInline("[x](data:text/html;base64,AAAA)")).not.toContain("href");
    expect(renderInline("[Tom & Jerry](javascript:void)")).toBe("Tom &#38; Jerry");
  });

  it("relative links go through the resolver; unresolved ones are plain text", () => {
    const resolveDocLink = (h: string) => (h.endsWith(".md") ? `reports/${h}` : null);
    expect(renderInline("[q3](q3.md)", { resolveDocLink })).toBe('<a href="#" data-doc-path="reports/q3.md">q3</a>');
    expect(renderInline("[x](notes.exe)", { resolveDocLink })).toBe("x");
  });

  it("images: only through the resolver or https; others fall back to the alt text", () => {
    const resolveImage = (s: string) => `/docs/file?path=${s}`;
    expect(renderInline("![logo](a.png)", { resolveImage })).toContain('src="/docs/file?path=a.png"');
    expect(renderInline("![logo](a.png)")).toBe("logo");
    expect(renderInline("![x](javascript:alert(1))", { resolveImage: () => null })).not.toContain("<img");
  });

  it("a quote character in a URL cannot break out of the attribute", () => {
    const html = renderInline('[x](https://e.com/"onmouseover="alert(1))');
    expect(html).not.toMatch(/onmouseover="/);
  });
});

describe("renderMarkdown", () => {
  it("renders headings, paragraphs, lists, quotes, code and rules", () => {
    const { html } = renderMarkdown(
      ["# Title", "", "Intro line one", "line two", "", "- a", "- b", "", "1. one", "2. two", "", "> quoted", "", "```", "<b>raw</b>", "```", "", "---"].join("\n"),
    );
    expect(html).toContain("<h1");
    expect(html).toContain("Intro line one<br>line two");
    expect(html).toContain("<ul>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<blockquote");
    expect(html).toContain("&#60;b&#62;raw&#60;/b&#62;");
    expect(html).toContain("<hr>");
  });

  it("renders a table, with cells escaped", () => {
    const { html } = renderMarkdown("| Name | Val |\n|---|---|\n| a | <i>1</i> |");
    expect(html).toContain("<th>Name</th>");
    expect(html).toContain("<td>&#60;i&#62;1&#60;/i&#62;</td>");
  });

  it("each block records the heading it sits under and a short quote of itself", () => {
    const { blocks } = renderMarkdown("Preface.\n\n## Plan\n\nStep **one** done.\n\n- x\n- y");
    expect(blocks.map((b) => b.heading)).toEqual([null, "Plan", "Plan", "Plan"]);
    expect(blocks[2]!.quote).toBe("Step one done.");
    expect(blocks[3]!.quote).toBe("x y");
  });

  it("commentable adds a button per block; off by default", () => {
    expect(renderMarkdown("# A\n\ntext").html).not.toContain("md-cmt");
    const on = renderMarkdown("# A\n\ntext", { commentable: true, commentLabel: "Comment" }).html;
    expect(on.match(/class="md-cmt"/g)).toHaveLength(2);
  });

  it("raw HTML in the source is never passed through", () => {
    const { html } = renderMarkdown('<img src=x onerror="alert(1)">\n\n<iframe src="//evil"></iframe>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<iframe");
  });

  it("an unterminated code fence swallows the rest instead of looping", () => {
    expect(renderMarkdown("```\nopen forever").html).toContain("open forever");
  });
});

describe("plainText", () => {
  it("strips markup for anchors", () => {
    expect(plainText("**Bold** [link](http://x) `code`")).toBe("Bold link code");
  });
});

describe("parseCsv", () => {
  it("handles quotes, doubled quotes, embedded commas and newlines", () => {
    const { rows } = parseCsv('a,b\n"x, y","say ""hi"""\n"line1\nline2",z\n');
    expect(rows).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"'],
      ["line1\nline2", "z"],
    ]);
  });

  it("picks ; when the header uses it", () => {
    expect(parseCsv("a;b\n1;2").rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("caps rows and reports it", () => {
    const text = Array.from({ length: 10 }, (_, i) => `r${i},x`).join("\n");
    const out = parseCsv(text, 3);
    expect(out.rows).toHaveLength(3);
    expect(out.truncated).toBe(true);
  });

  it("CRLF line endings and no trailing newline", () => {
    expect(parseCsv("a,b\r\n1,2").rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("hardening", () => {
  it("a heading line with a long run of spaces does not backtrack (was seconds)", () => {
    const started = performance.now();
    renderMarkdown(`# a${" ".repeat(20000)}b`);
    renderMarkdown(`${"- ".repeat(5000)}x`);
    renderMarkdown(`| a | b |\n${"-".repeat(20000)} x`);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("closing hashes are still stripped from a heading", () => {
    expect(renderMarkdown("## Plan ##").blocks[0]!.heading).toBe("Plan");
    expect(renderMarkdown("## C# is fine").blocks[0]!.heading).toBe("C# is fine");
    // an empty heading ("# " alone) is a heading with no text, as in CommonMark — and must not loop forever
    expect(renderMarkdown("# ").blocks.map((b) => b.level)).toEqual([1]);
    expect(renderMarkdown("#\n\n# \n\ntext").blocks).toHaveLength(3);
  });

  it("remote images are never loaded: they become a link", () => {
    const { html } = renderMarkdown("![pixel](http://127.0.0.1:8787/harnesses?probe=x)", { resolveImage: () => "/x" });
    expect(html).not.toContain("<img");
    expect(html).toContain('href="http://127.0.0.1:8787/harnesses?probe=x"');
  });

  it("a NUL in the source cannot forge a stash marker", () => {
    const html = renderInline("`<b>x</b>` \u00000\u0000");
    expect(html.match(/<code>/g)).toHaveLength(1);
    expect(html).not.toContain("\u0000");
  });
});
