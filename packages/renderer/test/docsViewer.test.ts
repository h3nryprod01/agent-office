import { describe, expect, it } from "vitest";
import { withCsp } from "../src/ui/docsViewer";

describe("withCsp", () => {
  it("puts the CSP meta after a leading doctype so the page stays out of quirks mode", () => {
    const out = withCsp("<!DOCTYPE html><html><body>hi</body></html>");
    expect(out.startsWith("<!DOCTYPE html><meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(out).toContain("<html><body>hi</body></html>");
  });

  it("prepends it when there is no doctype", () => {
    expect(withCsp("<h1>x</h1>")).toMatch(/^<meta http-equiv="Content-Security-Policy".*<h1>x<\/h1>$/);
  });

  it("forbids every network load", () => {
    expect(withCsp("x")).toContain("default-src 'none'");
  });

  it("removes a meta refresh in any common spelling (CSP does not cover navigations)", () => {
    for (const tag of [
      '<meta http-equiv="refresh" content="0;url=http://127.0.0.1:8787/harnesses?probe=x">',
      "<META HTTP-EQUIV=Refresh CONTENT='0;url=/x'>",
      '<meta content="0;url=/x" http-equiv = "refresh">',
    ]) {
      expect(withCsp(`<head>${tag}</head><body>ok</body>`)).not.toMatch(/refresh/i);
    }
    expect(withCsp('<meta charset="utf-8"><p>ok</p>')).toContain('<meta charset="utf-8">');
  });
});
