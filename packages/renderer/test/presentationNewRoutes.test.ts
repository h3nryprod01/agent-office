// Integration check (coordinator): the lanes merged alongside presentation mode added
// routes whose payloads use field names the masker was never shown. Feed each shape,
// filled with the sensitive fixture's names, through the masker; none may survive.
import { describe, expect, it } from "vitest";
import { createMasker } from "../src/presentation/mask";
import { CWD, HOME, SENSITIVE, WORKTREE } from "./fixtures/sensitiveDaemon";

const PAYLOADS: Record<string, unknown> = {
  "/overview": {
    projects: [
      {
        slug: "acme-web", name: "acme-web", template: "coding",
        pm: { state: "busy", unread: 2, lastText: "refund Maria Gonzalez for the penthouse" },
        items: { idea: 1, doing: 2, review: 0, done: 3, dropped: 0 },
        pendingApprovals: 1,
        members: [{ id: "m1", name: "Maria Gonzalez", role: "manager", telegram: { userId: 912345678 } }],
        rooms: ["initech-sales"],
      },
    ],
  },
  "/policy": [
    {
      slug: "globex-api", name: "globex-api", cwd: `${HOME}/Projects/globex-api`, repo: "globex-api", hasPolicy: true,
      policy: { approval: { mode: "auto", roles: { "billing specialist": "ask" }, tools: { "mcp__acme_crm__lookup": "deny" } }, allowedHarnesses: ["claude"], allowedLanes: null },
    },
  ],
  "/policy/audit": [
    {
      ts: 1, project: "acme-web", sessionId: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", agent: "fix-checkout-3f9a2c", harness: "claude", lane: null,
      role: "billing specialist", tool: "Bash", preview: `cd ${CWD} && git checkout secret-merger`, mode: "auto", decision: "allow", reasons: [], forced: null,
    },
  ],
  "/docs": { files: [{ path: "briefs/penthouse-Maria-Gonzalez.md", name: "penthouse-Maria-Gonzalez.md", kind: "markdown", size: 10, mtime: 1, status: "review" }] },
  "/docs/doc": {
    path: "briefs/penthouse.md", name: "penthouse.md", kind: "markdown", size: 10, mtime: 1, role: "owner", status: "review", statusAt: null,
    comments: [{ id: "c1", author: "Maria Gonzalez", text: "call 0912345678 about the refund", anchor: { heading: "Acme terms", quote: "initech owes" } }],
    reviews: [], content: "# Penthouse for Maria Gonzalez\n\nAcme pays the refund. Path: " + CWD,
  },
  "/radar": { collisions: [{ id: "x1", path: `${WORKTREE}/src/checkout/PaymentForm.tsx`, rel: "src/checkout/PaymentForm.tsx", repo: "acme-web", sessions: [{ sessionId: "s1", agent: "fix-checkout-3f9a2c", cwd: WORKTREE }], soft: true }] },
  "/scorecard": { lanes: [{ lane: "deepseek", tasks: 3, passRate: 0.66, usd: 1.2, lastRepo: "acme-web", lastTask: "refund flow for initech" }] },
  "/roster-members": { departments: [{ name: "initech-sales", members: [{ name: "Maria Gonzalez", role: "Acme Corp billing specialist", persona: { name: "Maria", tone: "warm", prompt: "You handle acme refunds" }, sop: "sops/billing.md" }] }] },
};

describe("presentation mode masks the payloads of routes added by other lanes", () => {
  for (const [route, body] of Object.entries(PAYLOADS)) {
    it(route, () => {
      const out = JSON.stringify(createMasker().mask(body));
      expect(SENSITIVE.filter((s) => out.includes(s))).toEqual([]);
    });
  }
  it("control: the raw payloads do contain the names", () => {
    const raw = JSON.stringify(PAYLOADS);
    expect(SENSITIVE.filter((s) => raw.includes(s)).length).toBeGreaterThan(8);
  });
});

describe("presentation mode keeps policy maps round-trippable", () => {
  it("modes survive, tool and role keys are aliased and come back on unmask", () => {
    const m = createMasker();
    const body = { approval: { mode: "auto", roles: { "billing specialist": "ask" }, tools: { "mcp__acme_crm__lookup": "deny", "Notebook*": "read-only", Bash: "auto", acme_crm_sync: "ask" } }, allowedHarnesses: ["claude", "claude-worker"], allowedLanes: ["deepseek", "acme-lane"] };
    const masked = m.mask(body);
    const out = JSON.stringify(masked);
    expect(SENSITIVE.filter((s) => out.includes(s))).toEqual([]);
    expect(Object.values(masked.approval.tools).sort()).toEqual(["ask", "auto", "deny", "read-only"]);
    expect(masked.approval.tools.Bash).toBe("auto"); // built-in tool names stay readable
    expect(masked.allowedHarnesses).toEqual(["claude", "claude-worker"]);
    expect(masked.allowedLanes[0]).toBe("deepseek");
    // what the daemon validates (policy.js): aliases must still be legal values
    for (const k of Object.keys(masked.approval.tools)) expect(k).toMatch(/^[A-Za-z0-9_.:-]{1,79}\*?$/);
    for (const v of [...masked.allowedHarnesses, ...masked.allowedLanes]) expect(v).toMatch(/^[a-z0-9][a-z0-9-]{0,39}$/);
    expect(Object.values(masked.approval.roles)).toEqual(["ask"]);
    expect(JSON.parse(m.unmask(out))).toEqual(body);
  });
  it("metrics keyed by project name are masked", () => {
    const out = JSON.stringify(createMasker().mask({ byProject: { "acme-web": { count: 3 } }, byDay: [{ day: "2026-10-27", byProject: { "globex-api": { count: 1 } } }] }));
    expect(SENSITIVE.filter((s) => out.includes(s))).toEqual([]);
  });
});

// The path a real save takes while presenting: the panel builds its payload from the masked
// project, the fetch patch unmasks the body, and the daemon validates what arrives.
import { draftFrom, buildPolicyPayload, type ProjectPolicy } from "../src/ui/policyPanel";
import { unmaskBody } from "../src/presentation/install";
// @ts-expect-error — plain JS module from the daemon package, imported to validate exactly as it does
import { validatePolicy } from "../../daemon/src/policy.js";

describe("saving a policy while presenting reaches the daemon intact", () => {
  const real: ProjectPolicy = {
    slug: "acme-web", name: "acme-web", cwd: `${HOME}/Projects/acme-web`, repo: "acme-web", hasPolicy: true,
    policy: {
      approval: { mode: "auto", roles: { "billing-specialist": "ask" }, tools: { "mcp__acme_crm__lookup": "deny", "Notebook*": "read-only", acme_crm_sync: "ask", Bash: "auto" } },
      allowedHarnesses: ["claude", "claude-worker", "acme-harness"],
      allowedLanes: ["deepseek", "sk-abcdefghij", "project-1"],
    },
  };
  it("round-trips through draftFrom → buildPolicyPayload → unmaskBody → validatePolicy", () => {
    const m = createMasker();
    const masked = m.mask(real);
    expect(SENSITIVE.filter((s) => JSON.stringify(masked).includes(s))).toEqual([]);
    const sent = JSON.parse(unmaskBody(m, JSON.stringify({ project: masked.slug, policy: buildPolicyPayload(draftFrom(masked)) })));
    expect(sent.project).toBe("acme-web");
    expect(sent.policy).toEqual(real.policy);
    expect(validatePolicy(sent.policy)).toEqual(real.policy);
  });
  it("the audit rows under the card are masked the same way", () => {
    const row = { ts: 1, project: "acme-web", agent: "acme-bot", harness: "acme-harness", lane: "acme-lane", tool: "acme_crm_sync", preview: "sync", mode: "auto", decision: "allow", reasons: [], forced: null };
    const out = JSON.stringify(createMasker().mask(row));
    expect(SENSITIVE.filter((s) => out.includes(s))).toEqual([]);
  });
});

describe("masking harness/lane values twice keeps the same alias (replays saved while presenting)", () => {
  it("is idempotent and still unmasks to the real name", () => {
    const m = createMasker();
    const once = m.mask({ harness: "acme-h", lane: "acme-lane" });
    const twice = m.mask(once);
    expect(twice).toEqual(once);
    expect(m.unmask(twice.harness)).toBe("acme-h");
  });
});

describe("shipped template names stay readable (they pick the office room); custom ones do not", () => {
  it("keeps real-estate-marketing, masks a client-named template", () => {
    const out = createMasker().mask([{ slug: "acme-web", template: "real-estate-marketing" }, { slug: "globex", template: "acme-custom" }]);
    expect(out[0].template).toBe("real-estate-marketing");
    expect(JSON.stringify(out)).not.toContain("acme");
  });
});
