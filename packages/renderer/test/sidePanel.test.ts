import { describe, expect, it } from "vitest";
import { timelineHtml, timelineLabel, transcriptHtml, type TranscriptLine } from "../src/ui/sidePanel";
import { statusLabelVi, type TimelineEntry } from "../src/sim/model";

describe("timelineHtml", () => {
  const entry = (over: Partial<TimelineEntry> = {}): TimelineEntry => ({
    ts: 1000,
    kind: "tool",
    text: "a very long tool preview that would normally clip in the collapsed view",
    ...over,
  });

  it("empty state", () => {
    expect(timelineHtml([], new Set())).toContain("Chưa có hoạt động");
  });

  it("collapsed by default: ▸ toggle, no 'expanded' class, full text still in the DOM (CSS clips it, not JS)", () => {
    const html = timelineHtml([entry()], new Set());
    expect(html).toContain("▸");
    expect(html).not.toContain("expanded");
    expect(html).toContain("a very long tool preview");
    expect(html).toContain('data-toggle-timeline-ts="1000"');
  });

  it("expanded (ts in the set): ▾ toggle + 'expanded' class", () => {
    const html = timelineHtml([entry()], new Set([1000]));
    expect(html).toContain("▾");
    expect(html).toContain("expanded");
  });

  it("newest entry first", () => {
    const html = timelineHtml([entry({ ts: 1, text: "first" }), entry({ ts: 2, text: "second" })], new Set());
    expect(html.indexOf("second")).toBeLessThan(html.indexOf("first"));
  });

  it("escapes text so a malicious detail string can't inject markup", () => {
    const html = timelineHtml([entry({ text: '<img src=x onerror=alert(1)>' })], new Set());
    expect(html).not.toContain("<img");
  });
});

describe("transcriptHtml", () => {
  const line = (over: Partial<TranscriptLine> = {}): TranscriptLine => ({
    ts: 1000,
    role: "assistant",
    text: "hello",
    ...over,
  });

  it("undefined = mock-mode placeholder, null = loading placeholder, [] = empty placeholder", () => {
    expect(transcriptHtml(undefined, new Set(), 20)).toContain("live mode");
    expect(transcriptHtml(null, new Set(), 20)).toContain("Đang tải");
    expect(transcriptHtml([], new Set(), 20)).toContain("Chưa có message");
  });

  it("renders a toggle per line, escaped text and tool name", () => {
    const html = transcriptHtml([line({ tool: "Bash", text: "<b>x</b>" })], new Set(), 20);
    expect(html).toContain("<code>Bash</code>");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain('data-toggle-transcript-ts="1000"');
  });

  it('"Xem thêm" shows when the buffer returned a full page and a higher tier exists', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => line({ ts: i }));
    expect(transcriptHtml(twenty, new Set(), 20)).toContain("data-more-transcript");
    expect(transcriptHtml(twenty, new Set(), 20)).toContain("Xem thêm (100)");
  });

  it('"Xem thêm" hides once the daemon returns fewer lines than asked — the backlog is exhausted', () => {
    const nineteen = Array.from({ length: 19 }, (_, i) => line({ ts: i }));
    expect(transcriptHtml(nineteen, new Set(), 20)).not.toContain("data-more-transcript");
  });

  it('"Xem thêm" hides at the top tier (500) even with a full page', () => {
    const full = Array.from({ length: 500 }, (_, i) => line({ ts: i }));
    expect(transcriptHtml(full, new Set(), 500)).not.toContain("data-more-transcript");
  });
});

describe("statusLabelVi", () => {
  it("maps raw statuses to plain Vietnamese", () => {
    expect(statusLabelVi("running_command")).toBe("Đang chạy lệnh");
    expect(statusLabelVi("waiting_permission")).toBe("Chờ bạn duyệt");
    expect(statusLabelVi("error")).toBe("Gặp lỗi");
    expect(statusLabelVi("idle")).toBe("Đang rảnh");
  });
});

describe("timelineLabel (de-jargon for non-tech readers)", () => {
  it("status entry → friendly Vietnamese, not the raw enum", () => {
    expect(timelineLabel({ ts: 1, kind: "status", text: "running_command — cd x", status: "running_command" })).toBe(
      "Đang chạy lệnh",
    );
  });

  it("tool result → ✓/✗ + business phrase, not the raw tool name", () => {
    expect(timelineLabel({ ts: 1, kind: "result", text: "✓ Bash", tool: "Bash" })).toBe("✓ Chạy lệnh hệ thống");
    expect(timelineLabel({ ts: 1, kind: "result", text: "✗ Read", tool: "Read" })).toBe("✗ Đọc & tra tài liệu");
  });

  it("tool call classifies via the command text (git → mã nguồn)", () => {
    expect(timelineLabel({ ts: 1, kind: "tool", text: "git commit -m x", tool: "Bash" })).toBe(
      "Thao tác mã nguồn (git)",
    );
  });

  it("an assistant message is kept verbatim (the AI's own words)", () => {
    expect(timelineLabel({ ts: 1, kind: "message", text: "Tôi sẽ sửa lỗi này." })).toBe("Tôi sẽ sửa lỗi này.");
  });
});
