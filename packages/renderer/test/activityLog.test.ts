import { describe, expect, it } from "vitest";
import { toBusiness, coalesceBusiness } from "../src/ui/activityLog";
import type { TranscriptRow } from "../src/ui/activityLog";

// toBusiness is pure — no DOM, no network. The vocab map is the whole point of
// the "Kinh doanh" mode, so each branch gets a case, plus the no-leak guarantee
// that an unrecognized tool never shows its raw name to a marketer.
describe("toBusiness", () => {
  it("Bash + npm test → 'Đang chạy kiểm thử'", () => {
    expect(toBusiness({ tool: "Bash", text: "npm test" })).toBe("Đang chạy kiểm thử");
  });

  it("Bash + vitest also reads as running tests", () => {
    expect(toBusiness({ tool: "Bash", text: "npx vitest run" })).toBe("Đang chạy kiểm thử");
  });

  it("Bash + git → 'Thao tác mã nguồn (git)'", () => {
    expect(toBusiness({ tool: "Bash", text: "git commit -m x" })).toBe(
      "Thao tác mã nguồn (git)",
    );
  });

  it("Bash + rm → 'Xoá tệp'", () => {
    expect(toBusiness({ tool: "Bash", text: "rm -rf node_modules" })).toBe("Xoá tệp");
  });

  it("Bash + cp/mv → 'Sao chép/di chuyển tệp'", () => {
    expect(toBusiness({ tool: "Bash", text: "cp a b" })).toBe("Sao chép/di chuyển tệp");
  });

  it("Bash + build → 'Đóng gói bản chạy'", () => {
    expect(toBusiness({ tool: "Bash", text: "npm run build" })).toBe("Đóng gói bản chạy");
  });

  it("Read with a file path → 'Đọc: <file>'; a grep pattern stays generic", () => {
    expect(toBusiness({ tool: "Read", text: "src/ui/kanban.ts" })).toBe("Đọc: kanban.ts");
    expect(toBusiness({ tool: "Grep", text: "COLUMNS" })).toBe("Đọc & tra tài liệu");
  });

  it("Write/Edit with a file → 'Sửa: <file>'; no path → generic", () => {
    expect(toBusiness({ tool: "Write", text: "activityLog.ts" })).toBe("Sửa: activityLog.ts");
    expect(toBusiness({ tool: "Edit", text: "some prose no path" })).toBe("Soạn/sửa nội dung");
  });

  it("strips a line-number suffix from the basename", () => {
    expect(toBusiness({ tool: "Read", text: "packages/renderer/src/style.css:1554" })).toBe(
      "Đọc: style.css",
    );
  });

  it("scans past a leading non-path token to find the file", () => {
    expect(toBusiness({ tool: "Read", text: "80 tools/kb-campaign/item-design-gate.py 5:" })).toBe(
      "Đọc: item-design-gate.py",
    );
  });

  it("WebSearch/WebFetch → 'Tra cứu trên web'", () => {
    expect(toBusiness({ tool: "WebSearch", text: "giá khu vực" })).toBe("Tra cứu trên web");
  });

  it("Bash with nothing specific → 'Chạy lệnh hệ thống'", () => {
    expect(toBusiness({ tool: "Bash", text: "ls -la" })).toBe("Chạy lệnh hệ thống");
  });

  it("an unrecognized tool falls back WITHOUT leaking the tool name", () => {
    const out = toBusiness({ tool: "TodoWrite", text: "TodoWrite: plan the day" });
    expect(out).toBe("Đang xử lý");
    expect(out).not.toContain("TodoWrite");
  });

  it("an assistant turn (no tool) keeps its human text, trimmed", () => {
    expect(toBusiness({ tool: undefined, text: "  Tôi sẽ sửa lỗi này.  " })).toBe(
      "Tôi sẽ sửa lỗi này.",
    );
  });
});

// coalesceBusiness collapses the wall of identical de-jargoned rows so the Nhật
// ký shows signal, not 20 copies of "Đang xử lý".
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
    expect(html[0]).toContain("Chạy lệnh hệ thống");
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
    expect(html[0]).toContain("Đọc: a.ts"); // Read with a path → enriched phrase
  });
});
