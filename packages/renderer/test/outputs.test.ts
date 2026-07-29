import { describe, expect, it } from "vitest";
import { fmtSize, outputsListHtml, type OutputFile } from "../src/ui/outputs";

describe("fmtSize", () => {
  it("bytes, KB, MB thresholds", () => {
    expect(fmtSize(512)).toBe("512 B");
    expect(fmtSize(2048)).toBe("2 KB");
    expect(fmtSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("outputsListHtml", () => {
  const file = (over: Partial<OutputFile> = {}): OutputFile => ({
    name: "video.mp4",
    path: "/repo/docs/media/promo/video.mp4",
    size: 1024,
    mtime: Date.parse("2026-01-01"),
    kind: "video",
    ...over,
  });

  it("empty state when no files", () => {
    expect(outputsListHtml([])).toContain("Chưa có output");
  });

  it("renders name, open/reveal buttons with the full path", () => {
    const html = outputsListHtml([file()]);
    expect(html).toContain("video.mp4");
    expect(html).toContain('data-open="/repo/docs/media/promo/video.mp4"');
    expect(html).toContain('data-reveal="/repo/docs/media/promo/video.mp4"');
  });

  it("escapes path/name so a malicious file entry can't inject markup", () => {
    const html = outputsListHtml([file({ name: '<img src=x onerror=alert(1)>.mp4', path: "/x/\"onmouseover=alert(1).mp4" })]);
    expect(html).not.toContain("<img");
    expect(html).not.toContain('"onmouseover=alert(1)');
  });

  it("falls back to the generic icon for an unknown kind", () => {
    const html = outputsListHtml([file({ kind: "other" })]);
    expect(html).toContain("📦");
  });
});
