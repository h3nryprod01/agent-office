import { describe, expect, it } from "vitest";
import {
  hirePrompt,
  newMemberNames,
  rosterFrameDiff,
  rosterHtml,
  type RosterPayload,
} from "../src/ui/hiringHall";

const roster = (members: Record<string, string[]>): RosterPayload => ({
  version: 1,
  updated: "2026-07-08",
  departments: Object.entries(members).map(([name, names]) => ({
    name,
    budgetUsdPerDay: 100,
    members: names.map((n) => ({ name: n, role: "vai trò", hired: "2026-07-08", source: "src", cv: null })),
  })),
});

describe("newMemberNames", () => {
  it("greets nobody without a baseline (first snapshot / daemon restart)", () => {
    expect(newMemberNames(null, roster({ dev: ["a", "b"] }))).toEqual([]);
  });

  it("detects members added to an existing department", () => {
    const prev = roster({ media: ["hyperframes"] });
    const next = roster({ media: ["hyperframes", "thumbnail-designer"] });
    expect(newMemberNames(prev, next)).toEqual(["thumbnail-designer"]);
  });

  it("detects members of a brand-new department, ignores removals, dedupes", () => {
    const prev = roster({ dev: ["forge", "gone-soon"] });
    const next = {
      ...roster({ dev: ["forge"], ops: ["schedule"] }),
      departments: [
        ...roster({ dev: ["forge"], ops: ["schedule"] }).departments,
        // same name in a second dept must not double-greet
        { name: "media", budgetUsdPerDay: null, members: [{ name: "schedule", role: null, hired: null, source: null, cv: null }] },
      ],
    };
    expect(newMemberNames(prev, next)).toEqual(["schedule"]);
  });
});

describe("rosterFrameDiff (walk-in trigger, mock walkIn path)", () => {
  const mountTs = 1_000;

  it("ignores frames that are not roster_updated", () => {
    expect(rosterFrameDiff(null, { type: "chat_message", ts: 2_000 }, mountTs)).toBeNull();
    expect(rosterFrameDiff(null, { type: "roster_updated", ts: 2_000 }, mountTs)).toBeNull(); // no payload
  });

  it("ignores WS backlog replays from before page load", () => {
    const frame = { type: "roster_updated", ts: 500, meta: { roster: roster({ dev: ["a"] }) } };
    expect(rosterFrameDiff(null, frame, mountTs)).toBeNull();
  });

  it("returns the fresh roster + names to walk in", () => {
    const prev = roster({ dev: ["forge"] });
    const next = roster({ dev: ["forge", "thumbnail-designer"] });
    const frame = { type: "roster_updated", ts: 2_000, meta: { roster: next } };
    const diff = rosterFrameDiff(prev, frame, mountTs);
    expect(diff).not.toBeNull();
    expect(diff!.newNames).toEqual(["thumbnail-designer"]);
    expect(diff!.roster).toBe(next);

    // mock walk-in: what mountHiringHall does with the diff
    const walked: string[] = [];
    for (const name of diff!.newNames) walked.push(name);
    expect(walked).toEqual(["thumbnail-designer"]);
  });

  it("adopts silently when there is no baseline yet", () => {
    const frame = { type: "roster_updated", ts: 2_000, meta: { roster: roster({ dev: ["a", "b"] }) } };
    const diff = rosterFrameDiff(null, frame, mountTs);
    expect(diff!.newNames).toEqual([]);
    expect(diff!.roster.departments[0].members).toHaveLength(2);
  });
});

describe("rosterHtml", () => {
  it("renders departments, member rows and the updated stamp", () => {
    const html = rosterHtml(roster({ dev: ["forge"], media: ["hyperframes"] }));
    expect(html).toContain("Cập nhật roster: 2026-07-08 · 2 thành viên");
    expect(html).toContain("dev");
    expect(html).toContain("forge");
    expect(html).toContain("trần $100/ngày");
    expect(html).toContain("📅 2026-07-08");
  });

  it("escapes HTML in member fields", () => {
    const r: RosterPayload = {
      version: 1,
      updated: null,
      departments: [
        {
          name: "dev",
          budgetUsdPerDay: null,
          members: [{ name: "<img src=x>", role: "<script>", hired: null, source: null, cv: null }],
        },
      ],
    };
    const html = rosterHtml(r);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
  });

  it("shows an empty-state hint when there is no roster at all", () => {
    expect(rosterHtml({ version: null, updated: null, departments: [] })).toContain("Chưa có roster");
  });
});

describe("hirePrompt", () => {
  it("routes through company-hire and asks for the scan verdict", () => {
    const p = hirePrompt("thumbnail designer cho media");
    expect(p).toBe(
      "Dùng skill company-hire: tuyển thumbnail designer cho media. Báo cáo verdict scan + kết quả vào chat.",
    );
  });
});
