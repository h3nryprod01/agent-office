import { describe, expect, it } from "vitest";
import { createMasker } from "../src/presentation/mask";

// Fake-but-realistic sensitive values. Nothing here is a real project.
const HOME = "/Users/jane.doe"; // leak-ok: invented fixture value
const CWD = `${HOME}/Projects/acme-web`;
const WT = `${CWD}/.claude/worktrees/fix-checkout-3f9a2c`;

const frame = (over: Record<string, unknown> = {}) => ({
  v: 1,
  id: "evt-1",
  type: "tool_call",
  sessionId: "11111111-2222-3333-4444-555555555555",
  agentId: "11111111-2222-3333-4444-555555555555",
  harness: "claude",
  cwd: WT,
  repo: "acme-web",
  ts: 1_700_000_000_000,
  agent: "fix-checkout-3f9a2c",
  tool: "Read",
  status: "start",
  detail: `Read ${CWD}/src/checkout/PaymentForm.tsx`,
  meta: { toolUseId: "toolu_01ABC", kind: "text" },
  ...over,
});

describe("createMasker — identity keys become stable aliases", () => {
  it("same raw value → same alias, different raw values → different aliases", () => {
    const m = createMasker();
    const a = m.mask({ repo: "acme-web" }) as { repo: string };
    const b = m.mask({ repo: "acme-web" }) as { repo: string };
    const c = m.mask({ repo: "globex-api" }) as { repo: string };
    expect(a.repo).toBe("project-1");
    expect(b.repo).toBe("project-1");
    expect(c.repo).toBe("project-2");
  });

  it("masks cwd / repo / agent / branch / detail of a daemon frame", () => {
    const m = createMasker();
    const out = JSON.stringify(m.mask(frame({ branch: "feature/secret-merger" })));
    for (const needle of ["acme-web", "jane.doe", "fix-checkout", "PaymentForm", "secret-merger", "checkout"]) {
      expect(out).not.toContain(needle);
    }
  });

  it("keeps structural fields a renderer needs to function", () => {
    const m = createMasker();
    const out = m.mask(frame()) as Record<string, unknown>;
    expect(out.v).toBe(1);
    expect(out.type).toBe("tool_call");
    expect(out.sessionId).toBe("11111111-2222-3333-4444-555555555555");
    expect(out.ts).toBe(1_700_000_000_000);
    expect(out.tool).toBe("Read");
    expect(out.status).toBe("start");
    expect(out.harness).toBe("claude");
    expect((out.meta as { toolUseId: string }).toolUseId).toBe("toolu_01ABC");
  });

  it("a repo seen before its cwd still gets the project alias inside the cwd path", () => {
    const m = createMasker();
    const out = m.mask(frame()) as { cwd: string; repo: string };
    expect(out.repo).toBe("project-1");
    expect(out.cwd).toContain("project-1");
    expect(out.cwd.startsWith("~/")).toBe(true);
  });

  it("is idempotent on its own output (alias in → same alias out)", () => {
    const m = createMasker();
    const once = m.mask({ repo: "acme-web", cwd: CWD });
    const twice = m.mask(once);
    expect(twice).toEqual(once);
  });
});

describe("createMasker — free text and paths", () => {
  it("blurs free text but keeps its shape", () => {
    const m = createMasker();
    const out = m.mask({ text: "Please refund Maria Gonzalez the 4200 deposit" }) as { text: string };
    expect(out.text).not.toMatch(/Maria|Gonzalez|refund|deposit|4200/);
    expect(out.text.split(" ")).toHaveLength(7);
  });

  it("aliases paths inside free text, keeps the extension and the tool verb", () => {
    const m = createMasker();
    const out = m.mask({ detail: `Read ${CWD}/src/checkout/PaymentForm.tsx` }) as { detail: string };
    expect(out.detail.startsWith("Read ")).toBe(true);
    expect(out.detail).toMatch(/\.tsx$/);
    expect(out.detail).not.toContain("PaymentForm");
    expect(out.detail).not.toContain("jane");
  });

  it("maps the same path segment to the same alias everywhere", () => {
    const m = createMasker();
    const a = m.mask({ path: `${CWD}/src/a/Secret.ts` }) as { path: string };
    const b = m.mask({ detail: `Edit ${CWD}/src/a/Secret.ts` }) as { detail: string };
    expect(b.detail).toContain(a.path);
  });

  it("scrubs Windows and home-relative paths", () => {
    const m = createMasker();
    const out = JSON.stringify(
      m.mask({ cwd: "C:\\Users\\Bob\\code\\client-portal", file: "~/clients/ACME/contract.pdf" }),
    );
    for (const needle of ["Bob", "client-portal", "ACME", "contract"]) expect(out).not.toContain(needle);
  });

  it("default-deny: an unknown string field is blurred, an unknown uuid/number/bool is kept", () => {
    const m = createMasker();
    const out = m.mask({
      customerNote: "call Maria about the penthouse",
      someRef: "11111111-2222-3333-4444-555555555555",
      count: 7,
      flag: true,
      nothing: null,
    }) as Record<string, unknown>;
    expect(out.customerNote).not.toMatch(/Maria|penthouse/);
    expect(out.someRef).toBe("11111111-2222-3333-4444-555555555555");
    expect(out.count).toBe(7);
    expect(out.flag).toBe(true);
    expect(out.nothing).toBeNull();
  });

  it("walks nested objects and arrays", () => {
    const m = createMasker();
    const out = JSON.stringify(
      m.mask({ items: [{ title: "Pitch deck for Initech", project: "initech-crm", tags: ["urgent-merger"] }] }),
    );
    for (const needle of ["Initech", "initech", "merger", "Pitch"]) expect(out).not.toContain(needle);
  });

  it("hides tokens and keys outright", () => {
    const m = createMasker();
    const out = JSON.stringify(m.mask({ token: "sk-live-abc123", apiKey: "k_9999", ok: true }));
    expect(out).not.toMatch(/abc123|9999/);
  });
});

describe("createMasker — unmask for requests going back to the daemon", () => {
  it("restores project / agent / branch aliases in a string", () => {
    const m = createMasker();
    const f = m.mask({ repo: "acme-web", agent: "coder-01", branch: "feature/x" }) as Record<string, string>;
    expect(m.unmask(`/items?project=${f.repo}`)).toBe("/items?project=acme-web");
    expect(m.unmask(f.agent)).toBe("coder-01");
    expect(m.unmask(f.branch)).toBe("feature/x");
  });

  it("restores a whole aliased path to the real absolute path", () => {
    const m = createMasker();
    const f = m.mask({ path: `${CWD}/docs/brief.md` }) as { path: string };
    expect(m.unmask(f.path)).toBe(`${CWD}/docs/brief.md`);
  });

  it("does not confuse project-1 with project-10", () => {
    const m = createMasker();
    for (let i = 1; i <= 10; i++) m.mask({ repo: `repo-${i}-name` });
    expect(m.unmask("project-10")).toBe("repo-10-name");
    expect(m.unmask("project-1")).toBe("repo-1-name");
  });
});

describe("createMasker — maps keyed by project", () => {
  it("aliases the keys of repos{} and the defaultRepo string, consistently with cwd", () => {
    const m = createMasker();
    const out = m.mask({
      defaultRepo: "acme-web",
      repos: { "acme-web": { sessionId: "11111111-2222-3333-4444-555555555555", cwd: CWD } },
    }) as { defaultRepo: string; repos: Record<string, { cwd: string }> };
    expect(out.defaultRepo).toBe("project-1");
    expect(Object.keys(out.repos)).toEqual(["project-1"]);
    expect(out.repos["project-1"].cwd).toContain("project-1");
    expect(JSON.stringify(out)).not.toContain("acme");
  });
});

describe("createMasker — secrets never ride a 'safe' key", () => {
  it("hides secret-looking key names and secret-shaped values wherever they sit", () => {
    const m = createMasker();
    const out = JSON.stringify(
      m.mask({
        openaiKey: "k-live-1234567890abcdef",
        sessionKey: "abcdefghijklmnopqrstuvwxyz012345",
        key: "ghp_abcdefghijklmnopqrstuvwxyz0123456789", // leak-ok: invented fixture value
        note: "Bearer abcdefghijklmnop",
        authHeader: "Basic dXNlcjpwYXNz",
        refreshToken: "r1",
        jwt: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_abc-123", // leak-ok: invented fixture value
      }),
    );
    for (const needle of ["1234567890abcdef", "abcdefghijklmnop", "ghp_", "dXNlcjpwYXNz", "r1", "eyJ"]) {
      expect(out).not.toContain(needle);
    }
  });

  it("still keeps an ordinary harness key and opaque ids", () => {
    const m = createMasker();
    const out = m.mask({ key: "claude", toolUseId: "toolu_01A09q90qw90lq917835lq9", approvalId: "ap-1" }) as Record<string, string>;
    expect(out).toEqual({ key: "claude", toolUseId: "toolu_01A09q90qw90lq917835lq9", approvalId: "ap-1" });
  });
});

describe("createMasker — a replay file keeps its envelope", () => {
  it("leaves format/version/exportedAt alone so the file still parses", () => {
    const m = createMasker();
    const out = m.mask({ format: "agent-office-replay", version: 1, exportedAt: 0, events: [] }) as Record<string, unknown>;
    expect(out.format).toBe("agent-office-replay");
  });
});

describe("createMasker — review findings", () => {
  it("long paths, branches and repo names stay aliases, not ••••", () => {
    const m = createMasker();
    const out = m.mask({
      cwd: "/Users/jane/Projects/agent-office-public", // leak-ok: invented fixture value
      branch: "feature/a-very-long-branch-name-for-the-acme-merger",
      repo: "acmeclientwebsite-with-a-long-name-0123456789",
    }) as Record<string, string>;
    expect(out.cwd).toMatch(/^~\/dir-\d\/dir-\d$/);
    expect(out.branch).toBe("branch-1");
    expect(out.repo).toBe("project-1");
  });

  it("both parts of an MCP tool name are aliased, built-in tool names kept", () => {
    const m = createMasker();
    expect((m.mask({ tool: "mcp__acme_crm__lookup" }) as { tool: string }).tool).toBe("mcp__server-1__tool-1");
    expect((m.mask({ tool: "Bash" }) as { tool: string }).tool).toBe("Bash");
  });

  it("structural keys keep only structural-looking values", () => {
    const m = createMasker();
    const out = m.mask({ role: "Acme Corp billing specialist", status: "acme-web is broken", state: "working", mode: "ask" }) as Record<string, string>;
    expect(out.role).not.toMatch(/Acme|billing/);
    expect(out.status).not.toMatch(/acme|broken/);
    expect(out.state).toBe("working");
    expect(out.mode).toBe("ask");
  });

  it("phone/card-like numbers and id-prefixed words in free text are blurred", () => {
    const m = createMasker();
    const out = JSON.stringify(m.mask({ detail: "0912345678", text: "4111111111111111 call_acme_secret evt-acme-launch" }));
    for (const needle of ["0912345678", "4111", "acme"]) expect(out).not.toContain(needle);
  });

  it("keeps the words the adapter looks for when a tool call was denied", () => {
    const m = createMasker();
    const out = m.mask({ detail: "Permission to use Bash has been denied for secret-thing" }) as { detail: string };
    expect(out.detail).toMatch(/has been denied/i);
    expect(out.detail).not.toContain("secret-thing");
  });

  it("`author` is an agent-style identity, not a secret", () => {
    const m = createMasker();
    expect((m.mask({ author: "Maria" }) as { author: string }).author).toBe("agent-1");
  });

  it("unmask stays fast with thousands of aliases", () => {
    const m = createMasker();
    for (let i = 0; i < 5000; i++) m.mask({ repo: `repo-${i}`, path: `/Users/x/p/dir${i}/file${i}.ts` });
    const body = `{"text":"${"project-7 hello ".repeat(2000)}"}`;
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) m.unmask(body);
    expect(performance.now() - t0).toBeLessThan(400);
    expect(m.unmask("project-7")).toBe("repo-6");
  });
});

describe("createMasker — third review", () => {
  it("a project whose name is also a public word is still aliased inside free text", () => {
    const m = createMasker();
    m.mask({ repo: "Hermes" });
    const out = m.mask({ text: "pushed Hermes to staging" }) as { text: string };
    expect(out.text).not.toContain("Hermes");
    expect(out.text).toContain("project-1");
  });

  it("MCP names round-trip through unmask, and a name without a tool part gets no invented one", () => {
    const m = createMasker();
    const { tool } = m.mask({ tool: "mcp__acme_crm__lookup" }) as { tool: string };
    expect(m.unmask(tool)).toBe("mcp__acme_crm__lookup");
    expect((m.mask({ tool: "mcp__acme" }) as { tool: string }).tool).toBe("mcp__server-2");
  });
});
