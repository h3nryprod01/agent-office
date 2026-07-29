import { describe, expect, it } from "vitest";
import { floorData } from "../src/ui/buildingView";
import type { RepoTab } from "../src/sim/selectors";

const tab = (repo: string, liveCount: number, hasAlert: boolean): RepoTab => ({
  repo,
  liveCount,
  hasAlert,
});

describe("floorData", () => {
  it("flags a floor alert when its repo has an alert agent", () => {
    const d = floorData(tab("repo-a", 3, true));
    expect(d.alert).toBe(true);
    expect(d.classes).toContain("alert");
  });

  it("omits the alert class when the repo is calm", () => {
    const d = floorData(tab("repo-b", 2, false));
    expect(d.alert).toBe(false);
    expect(d.classes).not.toContain("alert");
  });

  it("passes the repo name through untouched (rendered via textContent)", () => {
    expect(floorData(tab("acme-web", 1, false)).repo).toBe("acme-web");
  });

  it("lights up the active class only while the repo has live agents", () => {
    expect(floorData(tab("repo-c", 1, false)).classes).toContain("active");
    expect(floorData(tab("repo-c", 0, false)).classes).not.toContain("active");
  });
});
