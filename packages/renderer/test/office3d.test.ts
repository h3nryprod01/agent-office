// Tests for the pure decision logic exported by src/render3d/Office3D.ts.
//
// Only the colour mapping is reachable from outside — the rest (seat assignment,
// station routing) lives inside createOffice3D's closure and needs WebGL to
// construct, so it stays untested for now. That gap is deliberate and known.
//
// Importing Office3D is safe headless: the module body is imports + constants;
// nothing touches WebGL until createOffice3D() is called, which these never do.

import { describe, expect, it } from "vitest";
import type { AgentModel } from "../src/sim/model";
import { agentColor, agentSkin } from "../src/render3d/Office3D";
import { SKINS } from "../src/render3d/robotKit";

function agent(name: string, agentId = `id-${name}`): AgentModel {
  // only the fields agentSkin reads; the rest never enter the colour decision
  return { agentId, name } as AgentModel;
}

describe("agentSkin", () => {
  it("is stable — the same agent always gets the same skin", () => {
    // A colour that changed between ticks would make the office unreadable: the
    // legend, the monitor tint and the character would drift apart.
    const first = agentSkin(agent("coder-05"));
    for (let i = 0; i < 50; i++) {
      expect(agentSkin(agent("coder-05")).id).toBe(first.id);
    }
  });

  it("gives each named role its signature skin", () => {
    expect(agentSkin(agent("marketing-01")).id).toBe("ember");
    expect(agentSkin(agent("content-02")).id).toBe("matrix");
    expect(agentSkin(agent("planner-01")).id).toBe("violet");
    expect(agentSkin(agent("designer-03")).id).toBe("magenta");
  });

  it("keeps a role's colour regardless of its number", () => {
    expect(agentSkin(agent("marketing-01")).id).toBe(agentSkin(agent("marketing-99")).id);
  });

  it("spreads unnamed roles across the palette instead of one flat colour", () => {
    // coders are the common case; if they all collapsed to one skin the room
    // would read as a monoculture, which is exactly what skins exist to avoid.
    const ids = new Set(
      Array.from({ length: 12 }, (_, i) => agentSkin(agent(`coder-${String(i + 1).padStart(2, "0")}`)).id),
    );
    expect(ids.size).toBeGreaterThan(1);
  });

  it("always resolves to a real skin, even with a blank name", () => {
    const known = new Set(SKINS.map((s) => s.id));
    for (const n of ["", "x", "coder-01", "weird name!!", "MARKETING-01"]) {
      expect(known.has(agentSkin(agent(n)).id)).toBe(true);
    }
  });

  it("falls back to the agentId when the name is empty", () => {
    // name is "" here, so the hash must still have something stable to chew on
    const a = { agentId: "abc-123", name: "" } as AgentModel;
    expect(agentSkin(a).id).toBe(agentSkin({ ...a } as AgentModel).id);
  });

  it("is case-insensitive about roles", () => {
    expect(agentSkin(agent("Marketing-01")).id).toBe("ember");
  });
});

describe("agentColor", () => {
  it("is the skin's accent — what the legend, ticker and monitor tint all use", () => {
    const a = agent("marketing-01");
    expect(agentColor(a)).toBe(agentSkin(a).accent);
  });
});
