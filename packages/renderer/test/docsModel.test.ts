import { describe, expect, it } from "vitest";
import {
  anchorMatches,
  docHash,
  entryViewFor,
  filterFiles,
  kindCounts,
  orphanComments,
  parseDocHash,
  pickProject,
  resolveEntryView,
  resolveRelative,
  type DocComment,
  type DocFile,
} from "../src/ui/docsModel";
import { renderMarkdown } from "../src/ui/markdown";

const file = (path: string, kind: DocFile["kind"]): DocFile => ({
  path,
  name: path.split("/").pop()!,
  kind,
  size: 1,
  mtime: 1,
  status: "draft",
});
const FILES = [
  file("README.md", "markdown"),
  file("reports/q3.md", "markdown"),
  file("reports/brief.pdf", "pdf"),
  file("img/hero.png", "image"),
  file("img/Logo.PNG", "image"),
  file("data/leads.csv", "csv"),
  file("site/index.html", "html"),
  file("notes.txt", "text"),
];

describe("filterFiles / kindCounts", () => {
  it("'docs' covers markdown and text; others map 1:1", () => {
    expect(filterFiles(FILES, "docs", "").map((f) => f.path)).toEqual(["README.md", "reports/q3.md", "notes.txt"]);
    expect(filterFiles(FILES, "image", "").length).toBe(2);
    expect(filterFiles(FILES, "pdf", "")[0]!.path).toBe("reports/brief.pdf");
  });

  it("search is case-insensitive over the whole path and combines with the kind", () => {
    expect(filterFiles(FILES, "all", "REPORTS").map((f) => f.path)).toEqual(["reports/q3.md", "reports/brief.pdf"]);
    expect(filterFiles(FILES, "image", "logo").map((f) => f.path)).toEqual(["img/Logo.PNG"]);
    expect(filterFiles(FILES, "pdf", "q3")).toEqual([]);
  });

  it("counts per chip", () => {
    expect(kindCounts(FILES)).toEqual({ all: 8, docs: 3, pdf: 1, image: 2, html: 1, csv: 1 });
  });
});

describe("comment anchoring", () => {
  const md = "Preface.\n\n## Plan\n\nStep one.\n\nStep two.";
  const { blocks } = renderMarkdown(md);
  const comment = (anchor: DocComment["anchor"]): DocComment => ({
    id: "c1",
    text: "t",
    anchor,
    author: null,
    by: "owner",
    createdAt: "",
    resolved: false,
  });

  it("a quote comment matches only its own paragraph under its heading", () => {
    const c = comment({ heading: "Plan", quote: "Step one." });
    expect(blocks.filter((b) => anchorMatches(c, b)).map((b) => b.index)).toEqual([2]);
  });

  it("a heading comment matches the heading block, not the paragraphs below it", () => {
    const c = comment({ heading: "Plan", quote: null });
    expect(blocks.filter((b) => anchorMatches(c, b)).map((b) => b.index)).toEqual([1]);
  });

  it("a whole-document comment matches no block and is not an orphan", () => {
    const c = comment({ heading: null, quote: null });
    expect(blocks.some((b) => anchorMatches(c, b))).toBe(false);
    expect(orphanComments([c], blocks)).toEqual([]);
  });

  it("when the text changes underneath it, the comment is reported as an orphan, not dropped", () => {
    const c = comment({ heading: "Plan", quote: "A paragraph that was rewritten." });
    expect(orphanComments([c], blocks)).toEqual([c]);
  });
});

describe("resolveRelative", () => {
  it("resolves against the document's folder", () => {
    expect(resolveRelative("reports/q3.md", "hero.png")).toBe("reports/hero.png");
    expect(resolveRelative("reports/q3.md", "./img/a.png")).toBe("reports/img/a.png");
    expect(resolveRelative("reports/q3.md", "../README.md")).toBe("README.md");
    expect(resolveRelative("README.md", "docs/a.md#intro")).toBe("docs/a.md");
  });

  it("refuses anything that leaves the project, is absolute, or has a scheme", () => {
    expect(resolveRelative("reports/q3.md", "../../etc/passwd")).toBeNull();
    expect(resolveRelative("README.md", "../x.md")).toBeNull();
    expect(resolveRelative("README.md", "/etc/passwd")).toBeNull();
    expect(resolveRelative("README.md", "file:///etc/passwd")).toBeNull();
    expect(resolveRelative("README.md", "C:\\x")).toBeNull();
    expect(resolveRelative("README.md", "#only-a-fragment")).toBeNull();
  });
});

describe("doc hash", () => {
  it("round-trips, including spaces and unicode", () => {
    const hash = docHash("acme-web", "báo cáo/Q3 plan.md");
    expect(parseDocHash(hash)).toEqual({ project: "acme-web", path: "báo cáo/Q3 plan.md" });
  });

  it("ignores hashes that are not doc links or are malformed", () => {
    expect(parseDocHash("#office")).toBeNull();
    expect(parseDocHash("#doc=onlyproject")).toBeNull();
    expect(parseDocHash("#doc=a/%E0%A4%A")).toBeNull();
  });
});

describe("entry view", () => {
  it("non-coder templates open to chat + docs; everything else to the office", () => {
    expect(entryViewFor("content-studio")).toBe("docs");
    expect(entryViewFor("real-estate-marketing")).toBe("docs");
    expect(entryViewFor("coding")).toBe("office");
    expect(entryViewFor(undefined)).toBe("office");
  });

  it("pickProject prefers the remembered slug, falls back to the first, null when empty", () => {
    const p = (slug: string) => ({ slug, name: slug, template: "coding", cwd: "/x" });
    expect(pickProject([p("a"), p("b")], "b")?.slug).toBe("b");
    expect(pickProject([p("a"), p("b")], "gone")?.slug).toBe("a");
    expect(pickProject([], null)).toBeNull();
  });
});

describe("resolveEntryView", () => {
  const p = (template: string) => ({ slug: "x", name: "x", template, cwd: "/x" });

  it("opens to docs for a non-coder project, office otherwise", async () => {
    expect(await resolveEntryView({ projects: async () => [p("content-studio")] })).toBe("docs");
    expect(await resolveEntryView({ projects: async () => [p("coding")] })).toBe("office");
    expect(await resolveEntryView({ projects: async () => [] })).toBe("office");
  });

  it("falls back to the office when the daemon fails or is too slow", async () => {
    expect(await resolveEntryView({ projects: async () => Promise.reject(new Error("down")) })).toBe("office");
    expect(await resolveEntryView({ projects: () => new Promise(() => {}) }, 20)).toBe("office");
  });
});
