/**
 * A fake daemon whose data is full of names that must never reach a screen in
 * presentation mode. Every value is invented; "Maria Gonzalez" and "acme-web"
 * stand in for a client and a project.
 */
// no dot in the user name on purpose: a dotted one hid a long-path bug once
export const HOME = "/Users/jane"; // leak-ok: invented fixture value
export const CWD = `${HOME}/Projects/acme-web`;
export const WORKTREE = `${CWD}/.claude/worktrees/fix-checkout-3f9a2c`;

/** Substrings that, if found anywhere in the rendered DOM, mean a leak. */
export const SENSITIVE = [
  "acme",
  "globex",
  "jane",
  "PaymentForm",
  "Maria",
  "Gonzalez",
  "penthouse",
  "secret-merger",
  "fix-checkout",
  "3f9a2c",
  "refund",
  "initech",
  "mcp__acme",
  "billing specialist",
  "0912345678",
  "/Users/",
  "Projects/",
];

const SESSION_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const SESSION_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const SUB_A = "cccccccc-3333-4333-8333-cccccccccccc";

type Frame = Record<string, unknown>;

/** Raw daemon-v1 frames, timestamped relative to `now` (the adapter drops anything older than 10 min). */
export function liveFrames(now: number): Frame[] {
  let n = 0;
  const base = (sessionId: string, agentId: string, over: Frame): Frame => ({
    v: 1,
    id: `evt-${++n}`,
    sessionId,
    agentId,
    parentId: agentId === sessionId ? null : sessionId,
    harness: "claude",
    ts: now - 60_000 + n * 1000,
    status: null,
    tool: null,
    meta: null,
    detail: "",
    ...over,
  });
  return [
    base(SESSION_A, SESSION_A, { type: "session_start", cwd: WORKTREE, repo: "acme-web", agent: "fix-checkout-3f9a2c", branch: "fix/secret-merger" }),
    base(SESSION_A, SESSION_A, {
      type: "tool_call", cwd: WORKTREE, repo: "acme-web", agent: "fix-checkout-3f9a2c", tool: "Read", status: "start",
      detail: `Read ${CWD}/src/checkout/PaymentForm.tsx`, meta: { toolUseId: "toolu_01" },
    }),
    base(SESSION_A, SESSION_A, {
      type: "speak", cwd: WORKTREE, repo: "acme-web", agent: "fix-checkout-3f9a2c", detail: "I will refund Maria Gonzalez from the penthouse deal", meta: { kind: "text" },
    }),
    base(SESSION_A, SUB_A, {
      type: "tool_call", cwd: WORKTREE, repo: "acme-web", agent: "reviewer-for-acme", tool: "Bash", status: "start",
      detail: `cd ${CWD} && git checkout secret-merger`, meta: { toolUseId: "toolu_02" },
    }),
    base(SESSION_A, SESSION_A, {
      type: "tool_call", cwd: WORKTREE, repo: "acme-web", agent: "fix-checkout-3f9a2c", tool: "mcp__acme_crm__lookup", status: "start",
      detail: "lookup 0912345678", meta: { toolUseId: "toolu_03" },
    }),
    base(SESSION_B, SESSION_B, { type: "session_start", cwd: `${HOME}/Projects/globex-api`, repo: "globex-api", agent: "initech-bot" }),
    base(SESSION_B, SESSION_B, {
      type: "hook_signal", cwd: `${HOME}/Projects/globex-api`, repo: "globex-api", agent: "initech-bot", tool: "Edit",
      detail: `waiting for approval: Edit ${HOME}/Projects/globex-api/secrets/initech.env`, meta: { state: "waiting_permission" },
    }),
  ];
}

/** Non-event frames the UI taps off the same socket. */
export function sideFrames(now: number): Frame[] {
  return [
    {
      type: "approval_pending", sessionId: SESSION_B, tool: "Edit",
      meta: { approvalId: "ap-1", preview: `Edit ${HOME}/Projects/globex-api/secrets/initech.env`, expiresAt: now + 600_000 },
    },
    { type: "chat_message", id: "cm-1", repo: "acme-web", sessionId: "pm-1", meta: { role: "user", text: "refund Maria Gonzalez" } },
    { type: "chat_message", id: "cm-2", repo: "acme-web", sessionId: "pm-1", meta: { role: "assistant", text: "Drafting the penthouse refund note", done: true } },
    {
      type: "roster_updated",
      meta: { roster: { version: 1, updated: null, departments: [{ name: "initech-sales", budgetUsdPerDay: 5, members: [{ name: "Maria Gonzalez", role: "Acme Corp billing specialist", hired: null, source: null, cv: { notes: "knows the penthouse client" } }] }] } },
    },
  ];
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Route table for the fake daemon's HTTP side; unknown routes 404 like the real one. */
export function fakeFetch(now: number): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost:8787");
    switch (url.pathname) {
      case "/transcript":
        return json([
          { ts: now - 5000, role: "assistant", text: "Refund Maria Gonzalez the deposit on the penthouse" },
          { ts: now - 4500, role: "tool", tool: "mcp__acme_crm__lookup", text: "lookup 0912345678" },
          { ts: now - 4000, role: "tool", tool: "Read", text: `Read ${CWD}/src/checkout/PaymentForm.tsx` },
        ]);
      case "/work-items":
        return json({
          version: 1,
          items: [
            { id: "wi-1", title: "Fix checkout for acme-web", assignee: "fix-checkout-3f9a2c", branch: "fix/secret-merger", sessionId: SESSION_A, status: "doing" },
          ],
        });
      case "/items":
        return json({ items: [{ id: "it-1", title: "Pitch deck for Initech merger", source: "human", status: "idea" }] });
      case "/costs":
        return json({
          window: "24h", totalUsd: 12.5, tokensTotal: 1000, tokens: { input: 1, output: 1, cacheWrite: 1, cacheRead: 1 },
          byRepo: [{ repo: "acme-web", usd: 8, tokens: 600 }, { repo: "globex-api", usd: 4.5, tokens: 400 }],
          byAgent: [{ sessionId: SESSION_A, repo: "acme-web", harness: "claude", usd: 8, tokens: 600 }],
          byDay: [{ day: "2026-10-27", usd: 12.5, tokens: 1000 }], unknownModels: [],
        });
      case "/harnesses":
        return json([{ key: "claude", label: "Claude Code", installed: true, loggedIn: true, reason: `found at ${HOME}/.local/bin/claude` }]);
      case "/outputs":
        return json({ files: [{ name: "Maria-Gonzalez-contract.pdf", path: `${CWD}/out/Maria-Gonzalez-contract.pdf`, size: 10, mtime: now, kind: "doc" }] });
      case "/roster":
        return json({ version: 1, updated: null, departments: [{ name: "initech-sales", budgetUsdPerDay: 5, members: [{ name: "Maria Gonzalez", role: "Acme Corp billing specialist", hired: null, source: null, cv: null }] }] });
      case "/templates":
        return json([{ name: "acme-onboarding", departments: [{ name: "globex-ops", memberCount: 2 }], memberTotal: 2, hasGoals: true, missingSkills: ["initech-skill"] }]);
      case "/approvals":
        return json({ items: [] });
      case "/chat":
        return json({ defaultRepo: "acme-web", repos: { "acme-web": { sessionId: "pm-1", cwd: CWD } } });
      default:
        return json({ error: "not found" }, 404);
    }
  };
}

/** Minimal WebSocket stand-in: connects on the next tick and delivers `frames`. */
export function makeFakeWebSocket(frames: () => Frame[]): typeof WebSocket {
  class FakeWebSocket extends EventTarget {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    readyState = 0;
    onopen: ((e: Event) => void) | null = null;
    // a prototype accessor, as on a real WebSocket, so a subclass can intercept it
    private handler: ((e: MessageEvent) => void) | null = null;
    get onmessage(): ((e: MessageEvent) => void) | null { return this.handler; }
    set onmessage(fn: ((e: MessageEvent) => void) | null) { this.handler = fn; }
    onclose: ((e: Event) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    constructor(public url: string) {
      super();
      this.addEventListener("open", (e) => this.onopen?.(e));
      setTimeout(() => {
        this.readyState = 1;
        this.dispatchEvent(new Event("open"));
        for (const f of frames()) this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(f) }));
      }, 0);
    }
    send(): void {}
    close(): void { this.readyState = 3; }
  }
  return FakeWebSocket as unknown as typeof WebSocket;
}
