import { describe, expect, it } from "vitest";
import { connectionHtml, harnessRowHtml, type HarnessStatus } from "../src/ui/settings";

describe("connectionHtml", () => {
  it("shows a connected chip", () => {
    const h = connectionHtml(true, "127.0.0.1:8787");
    expect(h).toContain("Connected");
    expect(h).toContain("set-chip ok");
  });

  it("shows an offline chip with the daemon address", () => {
    const h = connectionHtml(false, "127.0.0.1:8787");
    expect(h).toContain("Disconnected");
    expect(h).toContain("127.0.0.1:8787");
    expect(h).toContain("set-chip off");
  });

  // ?mock=1 never opens a socket, so `connected` is false there forever. Reading
  // that as "Disconnected" made the demo accuse the daemon that was serving it.
  it("says demo mode, not disconnected, when we never dialled the daemon", () => {
    const h = connectionHtml(false, "127.0.0.1:8787", false);
    expect(h).toContain("Demo mode");
    expect(h).not.toContain("Disconnected");
  });

  it("still reports a real outage in live mode", () => {
    expect(connectionHtml(false, "127.0.0.1:8787", true)).toContain("Disconnected");
  });
});

describe("harnessRowHtml", () => {
  const base: HarnessStatus = { key: "claude", label: "Claude Code", installed: true, loggedIn: null };

  it("installed + logged in → both green chips + a probe button", () => {
    const h = harnessRowHtml({ ...base, loggedIn: true });
    expect(h).toContain("Installed");
    expect(h).toContain("Signed in");
    expect(h).toContain('data-probe="claude"');
  });

  it("not installed → 'Not installed', no login chip, no probe button", () => {
    const h = harnessRowHtml({ ...base, installed: false });
    expect(h).toContain("Not installed");
    expect(h).not.toContain("Signed in");
    expect(h).not.toContain("data-probe");
  });

  it("installed but not probed → 'Not checked' + probe button", () => {
    const h = harnessRowHtml({ ...base, loggedIn: null });
    expect(h).toContain("Not checked");
    expect(h).toContain('data-probe="claude"');
  });

  it("installed but logged out → warn chip carrying the reason", () => {
    const h = harnessRowHtml({ ...base, loggedIn: false, reason: "signed in" });
    expect(h).toContain("set-chip warn");
    expect(h).toContain("signed in");
  });
});
