// @vitest-environment happy-dom
// The interactive office: approval cards over characters, the right-click menu, and the host actions.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ARM_MS, cardHtml, mountApprovalCards } from "../src/ui/approvalCards";
import { menuHtml, mountAgentMenu } from "../src/ui/agentMenu";
import { revealAgentFile, uploadToInbox, MAX_DROP_BYTES } from "../src/ui/officeActions";
import { ApprovalsStore, type PendingApproval } from "../src/ui/approvals";

const approval = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  id: "ap-1", sessionId: "s-1", tool: "Bash", preview: "npm test", expiresAt: Date.now() + 60_000, ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("approval card", () => {
  it("shows who, the tool, the command, the countdown and why it was asked — escaped", () => {
    const html = cardHtml(approval({ preview: "rm -rf <b>x</b>", policy: { forced: "danger" } }), "coder-01", false, Date.now());
    expect(html).toContain("coder-01");
    expect(html).toContain("Bash");
    expect(html).toContain("rm -rf &lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toMatch(/danger/);
    expect(html).toMatch(/data-decision="allow"/);
    expect(html).toMatch(/data-decision="deny"/);
  });
  it("long commands are cut until expanded", () => {
    const long = "x".repeat(400);
    expect(cardHtml(approval({ preview: long }), "a", false, Date.now())).not.toContain(long);
    expect(cardHtml(approval({ preview: long }), "a", true, Date.now())).toContain(long);
  });
  it("a click on Allow answers the store and removes the card", async () => {
    const store = new ApprovalsStore();
    store.onRaw({ type: "approval_pending", sessionId: "s-1", tool: "Bash", meta: { approvalId: "ap-1", preview: "npm test", expiresAt: Date.now() + 60_000 } });
    const fetchMock = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchMock);
    const root = document.createElement("div");
    document.body.appendChild(root);
    let clock = Date.now();
    const answered = vi.fn();
    const cards = mountApprovalCards(root, {
      store,
      agentOf: () => ({ agentId: "s-1", name: "coder-01" }),
      screenPos: () => ({ x: 100, y: 100 }),
      visible: () => true,
      onAnswered: answered,
      now: () => clock,
    });
    await new Promise((r) => setTimeout(r, 50)); // a few animation frames
    const allow = root.querySelector<HTMLButtonElement>('[data-decision="allow"]');
    expect(allow).not.toBeNull();
    allow!.click(); // the card only just appeared: this click was meant for something else
    expect(fetchMock).not.toHaveBeenCalled();
    clock += ARM_MS;
    allow!.click();
    expect(root.querySelector("[data-approval]")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/approval-response", expect.objectContaining({ method: "POST", body: JSON.stringify({ id: "ap-1", decision: "allow" }) }));
    await vi.waitFor(() => expect(answered).toHaveBeenCalledWith({ ok: true, status: 200 }));
    cards.stop();
  });
  it("no card when the office is not on screen or the agent is not in view", async () => {
    const store = new ApprovalsStore();
    store.onRaw({ type: "approval_pending", sessionId: "s-1", tool: "Bash", meta: { approvalId: "ap-2", preview: "ls", expiresAt: Date.now() + 60_000 } });
    const root = document.createElement("div");
    const off = mountApprovalCards(root, { store, agentOf: () => ({ agentId: "s-1", name: "a" }), screenPos: () => ({ x: 1, y: 1 }), visible: () => false });
    await new Promise((r) => setTimeout(r, 50));
    expect(root.querySelector("[data-approval]")).toBeNull();
    off.stop();
    const out = mountApprovalCards(root, { store, agentOf: () => ({ agentId: "s-1", name: "a" }), screenPos: () => null, visible: () => true });
    await new Promise((r) => setTimeout(r, 50));
    expect(root.querySelector<HTMLElement>("[data-approval]")?.hidden).toBe(true);
    out.stop();
  });
});

describe("agent menu", () => {
  it("lists the actions, shows what it is doing, and disables resume without a safe command", () => {
    const html = menuHtml({ agentId: "a1", name: "coder-<01>", doing: "Bash: npm test", resume: null });
    expect(html).toContain("coder-&lt;01&gt;");
    expect(html).toContain("Bash: npm test");
    expect(html).toMatch(/data-action="resume" disabled/);
    for (const a of ["details", "folder", "file", "terminal"]) expect(html).toContain(`data-action="${a}"`);
  });
  it("a click runs the action once and closes the menu", () => {
    const seen: string[] = [];
    const menu = mountAgentMenu((action) => seen.push(action));
    menu.open({ agentId: "a1", name: "x", doing: null, resume: "claude --resume 1" }, 10, 10);
    document.querySelector<HTMLElement>('.agent-menu [data-action="folder"]')!.click();
    expect(seen).toEqual(["folder"]);
    expect(document.querySelector<HTMLElement>(".agent-menu")!.hidden).toBe(true);
  });
});

describe("host actions", () => {
  it("'show the last file' falls back to the folder when the office saw no file yet", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_u: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return new Response("{}", { status: body.lastFile ? 404 : 200 });
    }));
    expect((await revealAgentFile("a1")).ok).toBe(true);
    expect(bodies).toEqual([{ agentId: "a1", lastFile: true }, { agentId: "a1" }]);
  });
  it("uploads send the file as base64 and refuse what is over 4 MB before sending", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, path: "inbox/a.txt" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await uploadToInbox("demo-app", new File(["hi"], "a.txt"))).toEqual({ path: "inbox/a.txt" });
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown[])[1] && ((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body))).toEqual({ project: "demo-app", name: "a.txt", data: btoa("hi") });
    const big = new File([new Uint8Array(MAX_DROP_BYTES + 1)], "big.bin");
    expect(await uploadToInbox("demo-app", big)).toEqual({ error: "too-large" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
