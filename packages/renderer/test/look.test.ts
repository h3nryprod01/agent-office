import { describe, expect, it } from "vitest";
import type { AgentModel } from "../src/sim/model";
import { avatarIsImage, displayName, harnessFamily, lookOf, withDemoLook, LANE_COLORS } from "../src/render3d/look";

const agent = (over: Record<string, unknown> = {}): AgentModel =>
  ({ agentId: "a-1", name: "coder-01", harness: null, ...over }) as unknown as AgentModel;

/** WCAG contrast, same maths as robotKit.test — the face ink must read on every worker skin */
const lum = (hex: number): number => {
  const c = (v: number): number => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * c((hex >> 16) & 255) + 0.7152 * c((hex >> 8) & 255) + 0.0722 * c(hex & 255);
};
const contrast = (a: number, b: number): number => { const [h, l] = [lum(a), lum(b)].sort((x, y) => y - x); return (h + 0.05) / (l + 0.05); };
const INK = 0x0d1117;

describe("harnessFamily", () => {
  it("accepts both the daemon ids and the contract ids", () => {
    expect(harnessFamily("claude-code")).toBe("claude");
    expect(harnessFamily("claude")).toBe("claude");
    expect(harnessFamily("Codex")).toBe("codex");
    expect(harnessFamily("claude-worker")).toBe("claude-worker");
    expect(harnessFamily("hermes")).toBe("hermes");
    expect(harnessFamily("gemini")).toBe("gemini");
  });
  it("is 'unknown' for nothing or something new, never a throw", () => {
    expect(harnessFamily(null)).toBe("unknown");
    expect(harnessFamily("")).toBe("unknown");
    expect(harnessFamily("some-new-cli")).toBe("unknown");
  });
});

describe("lookOf", () => {
  it("leaves an agent with no harness exactly as it was (no skin override, no accessory)", () => {
    const l = lookOf(agent());
    expect(l.skin).toBeNull();
    expect(l.accessory).toBe("none");
  });

  it("keeps Claude agents on their varied per-name skin", () => {
    expect(lookOf(agent({ harness: "claude-code" })).skin).toBeNull();
  });

  it("gives every other harness its own uniform and a different silhouette", () => {
    const looks = ["codex", "gemini", "hermes", "claude-worker"].map((h) => lookOf(agent({ harness: h })));
    expect(new Set(looks.map((l) => l.accessory)).size).toBe(4);
    expect(new Set(looks.map((l) => l.skin?.accent)).size).toBeGreaterThan(2);
  });

  it("colours a worker's hard hat and uniform by lane", () => {
    const ds = lookOf(agent({ harness: "claude-worker", lane: "deepseek" }));
    const mi = lookOf(agent({ harness: "claude-worker", lane: "mimo" }));
    expect(ds.trim).toBe(LANE_COLORS.deepseek);
    expect(ds.skin?.accent).toBe(LANE_COLORS.deepseek);
    expect(mi.trim).not.toBe(ds.trim);
    expect(ds.glyph).toBe("D");
  });

  it("copes with a lane nobody has heard of", () => {
    const l = lookOf(agent({ harness: "claude-worker", lane: "brand-new-vendor" }));
    expect(l.skin).not.toBeNull();
    expect(l.glyph).toBe("B");
  });

  it("only uses lane for workers' colours; a lane on a codex agent changes nothing", () => {
    expect(lookOf(agent({ harness: "codex", lane: "deepseek" })).skin?.id).toBe("codex");
  });

  it("every uniform keeps the face readable (dark ink on the lit screen)", () => {
    const skins = ["codex", "gemini", "hermes", ...Object.keys(LANE_COLORS), "unheard-of"].map((x) =>
      x === "codex" || x === "gemini" || x === "hermes"
        ? lookOf(agent({ harness: x })).skin!
        : lookOf(agent({ harness: "claude-worker", lane: x })).skin!);
    for (const s of skins) expect(contrast(INK, s.screen), s.id).toBeGreaterThanOrEqual(4.5);
  });

  it("passes the persona's text fields through, and ignores a non-object one", () => {
    const p = { name: "Mai", role: "PM", avatar: "🦊" };
    expect(lookOf(agent({ persona: p })).persona).toMatchObject(p);
    expect(lookOf(agent({ persona: "oops" })).persona).toBeNull();
  });

  it("drops persona fields of the wrong type instead of throwing later", () => {
    // a number name would throw in name.trim() inside the render loop and freeze the office
    const l = lookOf(agent({ persona: { name: 42, avatar: { url: "x" }, role: "PM" } }));
    expect(l.persona?.name).toBeUndefined();
    expect(l.persona?.avatar).toBeUndefined();
    expect(l.persona?.role).toBe("PM");
    expect(displayName(agent({ persona: { name: 42 } }))).toBe("coder-01");
  });
});

describe("displayName", () => {
  it("prefers the persona's name", () => {
    expect(displayName(agent({ persona: { name: "Mai" } }))).toBe("Mai");
  });
  it("falls back to the agent name when the persona has none or a blank one", () => {
    expect(displayName(agent())).toBe("coder-01");
    expect(displayName(agent({ persona: { name: "  " } }))).toBe("coder-01");
  });
});

describe("avatarIsImage", () => {
  it("treats emoji and plain text as text", () => {
    expect(avatarIsImage("🦊")).toBe(false);
    expect(avatarIsImage("MK")).toBe(false);
  });
  it("loads same-origin paths and inline data images", () => {
    expect(avatarIsImage("/avatars/mai.png")).toBe(true);
    expect(avatarIsImage("data:image/png;base64,AAAA")).toBe(true);
  });
  it("refuses anything that would reach another host", () => {
    expect(avatarIsImage("https://cdn.example.com/a.webp")).toBe(false); // would tell that host who's watching
    expect(avatarIsImage("http://insecure.example.com/a.png")).toBe(false); // plain http
    expect(avatarIsImage("//evil.example.com/a.png")).toBe(false); // protocol-relative
    expect(avatarIsImage("/\\evil.example.com/a.png")).toBe(false); // browsers read /\ as //
    expect(avatarIsImage("javascript:alert(1)")).toBe(false);
    expect(avatarIsImage("data:text/html;base64,AAAA")).toBe(false);
  });
});

describe("withDemoLook", () => {
  it("never overwrites an agent that already has a harness", () => {
    const real = agent({ harness: "codex" });
    expect(withDemoLook(real)).toBe(real);
  });
  it("is deterministic, and spreads across several families", () => {
    const fams = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const a = agent({ agentId: `stress-${i}` });
      expect(withDemoLook(a).harness).toBe(withDemoLook(a).harness);
      fams.add(harnessFamily(withDemoLook(a).harness));
    }
    expect(fams.size).toBeGreaterThanOrEqual(4);
  });
  it("keeps a lane or persona the agent already has", () => {
    const ids = Array.from({ length: 80 }, (_, i) => `y${i}`);
    for (const id of ids) {
      const d = withDemoLook(agent({ agentId: id, lane: "glm", persona: { name: "Real" } })) as AgentModel & { lane?: string; persona?: { name?: string } };
      expect(d.persona?.name).toBe("Real");
      if (d.harness === "claude-worker") expect(d.lane).toBe("glm");
    }
  });
  it("gives demo workers a lane", () => {
    const ws = Array.from({ length: 60 }, (_, i) => withDemoLook(agent({ agentId: `x${i}` })) as AgentModel & { lane?: string })
      .filter((a) => a.harness === "claude-worker");
    expect(ws.length).toBeGreaterThan(0);
    expect(ws.every((a) => typeof a.lane === "string")).toBe(true);
  });
});
