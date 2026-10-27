import { afterEach, describe, expect, it } from "vitest";
import { setActiveMasker } from "../src/presentation/active";
import { createMasker } from "../src/presentation/mask";
import { parseReplayFile } from "../src/replay/recorder";

const file = JSON.stringify({
  format: "agent-office-replay",
  version: 1,
  exportedAt: 0,
  events: [
    { v: 0, id: "e2", type: "agent_message", timestamp: 2, sessionId: "s", agentId: "s", parentId: null, text: "refund Maria Gonzalez" },
    { v: 0, id: "e1", type: "session_started", timestamp: 1, sessionId: "s", agentId: "s", parentId: null, cwd: "/Users/jane.doe/Projects/acme-web", label: "acme-agent", repo: "acme-web" }, // leak-ok: invented fixture value
  ],
});

describe("parseReplayFile under presentation mode", () => {
  afterEach(() => setActiveMasker(null));

  it("is untouched when the mode is off", () => {
    expect(JSON.stringify(parseReplayFile(file))).toContain("acme-web");
  });

  it("masks a replay file imported from disk, and still sorts by time", () => {
    setActiveMasker(createMasker());
    const events = parseReplayFile(file);
    const text = JSON.stringify(events);
    for (const needle of ["acme", "jane", "Maria", "Gonzalez"]) expect(text).not.toContain(needle);
    expect(events.map((e) => e.id)).toEqual(["e1", "e2"]);
  });
});
