import { describe, expect, it } from "vitest";
import { toBusiness, coalesceBusiness } from "../src/ui/activityLog";
import type { TranscriptRow } from "../src/ui/activityLog";

// toBusiness is pure — no DOM, no network. The vocab map is the whole point of
// the "Business" mode, so each branch gets a case, plus the no-leak guarantee
// that an unrecognized tool never shows its raw name to a marketer.
describe("toBusiness", () => {
  it("Bash + npm test → 'Running tests'", () => {
    expect(toBusiness({ tool: "Bash", text: "npm test" })).toBe("Running tests");
  });

  it("Bash + vitest also reads as running tests", () => {
    expect(toBusiness({ tool: "Bash", text: "npx vitest run" })).toBe("Running tests");
  });

  it("Bash + git → 'Version control (git)'", () => {
    expect(toBusiness({ tool: "Bash", text: "git commit -m x" })).toBe(
      "Version control (git)",
    );
  });

  it("Bash + rm → 'Deleting files'", () => {
    expect(toBusiness({ tool: "Bash", text: "rm -rf node_modules" })).toBe("Deleting files");
  });

  it("Bash + cp/mv → 'Copying or moving files'", () => {
    expect(toBusiness({ tool: "Bash", text: "cp a b" })).toBe("Copying or moving files");
  });

  it("Bash + build → 'Building'", () => {
    expect(toBusiness({ tool: "Bash", text: "npm run build" })).toBe("Building");
  });

  it("Read with a file path → 'Reading: <file>'; a grep pattern stays generic", () => {
    expect(toBusiness({ tool: "Read", text: "src/ui/kanban.ts" })).toBe("Reading: kanban.ts");
    expect(toBusiness({ tool: "Grep", text: "COLUMNS" })).toBe("Reading and looking things up");
  });

  it("Write/Edit with a file → 'Editing: <file>'; no path → generic", () => {
    expect(toBusiness({ tool: "Write", text: "activityLog.ts" })).toBe("Editing: activityLog.ts");
    expect(toBusiness({ tool: "Edit", text: "some prose no path" })).toBe("Writing and editing");
  });

  it("strips a line-number suffix from the basename", () => {
    expect(toBusiness({ tool: "Read", text: "packages/renderer/src/style.css:1554" })).toBe(
      "Reading: style.css",
    );
  });

  it("scans past a leading non-path token to find the file", () => {
    expect(toBusiness({ tool: "Read", text: "80 tools/kb-campaign/item-design-gate.py 5:" })).toBe(
      "Reading: item-design-gate.py",
    );
  });

  it("WebSearch/WebFetch → 'Searching the web'", () => {
    expect(toBusiness({ tool: "WebSearch", text: "giá khu vực" })).toBe("Searching the web");
  });

  it("Bash with nothing specific → 'Running a shell command'", () => {
    expect(toBusiness({ tool: "Bash", text: "ls -la" })).toBe("Running a shell command");
  });

  it("an unrecognized tool falls back WITHOUT leaking the tool name", () => {
    const out = toBusiness({ tool: "TodoWrite", text: "TodoWrite: plan the day" });
    expect(out).toBe("Working");
    expect(out).not.toContain("TodoWrite");
  });

  it("an assistant turn (no tool) keeps its human text, trimmed", () => {
    expect(toBusiness({ tool: undefined, text: "  Tôi sẽ sửa lỗi này.  " })).toBe(
      "Tôi sẽ sửa lỗi này.",
    );
  });
});

// coalesceBusiness collapses the wall of identical de-jargoned rows so the Nhật
// ký shows signal, not 20 copies of "Working".
describe("coalesceBusiness", () => {
  const r = (tool: string | undefined, text: string, ts = 0): TranscriptRow => ({
    ts,
    role: tool ? "tool" : "assistant",
    text,
    ...(tool ? { tool } : {}),
  });

  it("collapses a run of identical phrases into one line with × N", () => {
    const html = coalesceBusiness([r("Bash", "ls -la"), r("Bash", "pwd"), r("Bash", "cat x")]);
    expect(html).toHaveLength(1);
    expect(html[0]).toContain("Running a shell command");
    expect(html[0]).toContain("× 3");
  });

  it("keeps distinct phrases as separate lines, no × badge", () => {
    const html = coalesceBusiness([r("Read", "a.ts"), r("Write", "b.ts")]);
    expect(html).toHaveLength(2);
    expect(html.join("")).not.toContain("activity-log-xn");
  });

  it("drops blank assistant turns", () => {
    const html = coalesceBusiness([r(undefined, "   "), r("Read", "a.ts")]);
    expect(html).toHaveLength(1);
    expect(html[0]).toContain("Reading: a.ts"); // Read with a path → enriched phrase
  });
});
