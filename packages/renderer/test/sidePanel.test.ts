import { describe, expect, it } from "vitest";
import { timelineHtml, timelineLabel, transcriptHtml, type TranscriptLine } from "../src/ui/sidePanel";
import { statusLabel, type TimelineEntry } from "../src/sim/model";
import { getLang, setLang } from "../src/i18n";

describe("timelineHtml", () => {
  const entry = (over: Partial<TimelineEntry> = {}): TimelineEntry => ({
    ts: 1000,
    kind: "tool",
    text: "a very long tool preview that would normally clip in the collapsed view",
    ...over,
  });

  it("empty state", () => {
    expect(timelineHtml([], new Set())).toContain("Nothing yet");
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
    expect(transcriptHtml(null, new Set(), 20)).toContain("Loading");
    expect(transcriptHtml([], new Set(), 20)).toContain("No messages");
  });

  it("renders a toggle per line, escaped text and tool name", () => {
    const html = transcriptHtml([line({ tool: "Bash", text: "<b>x</b>" })], new Set(), 20);
    expect(html).toContain("<code>Bash</code>");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain('data-toggle-transcript-ts="1000"');
  });

  it('"Show more" shows when the buffer returned a full page and a higher tier exists', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => line({ ts: i }));
    expect(transcriptHtml(twenty, new Set(), 20)).toContain("data-more-transcript");
    expect(transcriptHtml(twenty, new Set(), 20)).toContain("Show more (100)");
  });

  it('"Show more" hides once the daemon returns fewer lines than asked — the backlog is exhausted', () => {
    const nineteen = Array.from({ length: 19 }, (_, i) => line({ ts: i }));
    expect(transcriptHtml(nineteen, new Set(), 20)).not.toContain("data-more-transcript");
  });

  it('"Show more" hides at the top tier (500) even with a full page', () => {
    const full = Array.from({ length: 500 }, (_, i) => line({ ts: i }));
    expect(transcriptHtml(full, new Set(), 500)).not.toContain("data-more-transcript");
  });
});

describe("statusLabel", () => {
  it("maps raw statuses to plain language, never the enum name", () => {
    expect(statusLabel("running_command")).toBe("Running a command");
    expect(statusLabel("waiting_permission")).toBe("Waiting for you");
    expect(statusLabel("error")).toBe("Hit an error");
    expect(statusLabel("idle")).toBe("Idle");
  });

  it("follows the selected language", () => {
    // The language is module state, so restore it even if an assertion throws —
    // otherwise every later test in this file starts reading Vietnamese.
    const before = getLang();
    try {
      setLang("vi");
      expect(statusLabel("waiting_permission")).toBe("Chờ bạn duyệt");
      setLang("en");
      expect(statusLabel("waiting_permission")).toBe("Waiting for you");
    } finally {
      setLang(before);
    }
  });
});

describe("timelineLabel (de-jargon for non-tech readers)", () => {
  it("status entry → plain language, not the raw enum", () => {
    expect(timelineLabel({ ts: 1, kind: "status", text: "running_command — cd x", status: "running_command" })).toBe(
      "Running a command",
    );
  });

  it("tool result → ✓/✗ + business phrase, not the raw tool name", () => {
    expect(timelineLabel({ ts: 1, kind: "result", text: "✓ Bash", tool: "Bash" })).toBe("✓ Running a shell command");
    expect(timelineLabel({ ts: 1, kind: "result", text: "✗ Read", tool: "Read" })).toBe("✗ Reading and looking things up");
  });

  it("tool call classifies via the command text (git → version control)", () => {
    expect(timelineLabel({ ts: 1, kind: "tool", text: "git commit -m x", tool: "Bash" })).toBe(
      "Version control (git)",
    );
  });

  it("an assistant message is kept verbatim (the AI's own words)", () => {
    expect(timelineLabel({ ts: 1, kind: "message", text: "Tôi sẽ sửa lỗi này." })).toBe("Tôi sẽ sửa lỗi này.");
  });
});
