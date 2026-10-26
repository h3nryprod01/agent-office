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
