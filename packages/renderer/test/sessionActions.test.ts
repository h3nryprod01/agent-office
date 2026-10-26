import { afterEach, describe, expect, it, vi } from "vitest";
import { openTerminalFor, sessionActions, sessionActionsHtml } from "../src/ui/sessionActions";

const UUID = "938f6dbf-7434-47f4-9c83-ee1719f9f8a2";
const agent = (over: Record<string, unknown> = {}) => ({
  agentId: UUID,
  sessionId: UUID,
  cwd: "/w/demo-app",
  harness: "claude-code",
  ...over,
});

describe("sessionActions", () => {
  it("claude: cd + claude --resume, and the Claude desktop deep link", () => {
    expect(sessionActions(agent())).toEqual({
      resume: `cd '/w/demo-app' && claude --resume ${UUID}`,
      desktopUrl: `claude://resume?session=${UUID}`,
    });
    // the contract name for the same harness
    expect(sessionActions(agent({ harness: "claude" })).resume).toContain("claude --resume");
  });

  it("codex: codex resume, no desktop link", () => {
    expect(sessionActions(agent({ harness: "codex" }))).toEqual({
      resume: `cd '/w/demo-app' && codex resume ${UUID}`,
      desktopUrl: null,
    });
  });

  it("claude-worker resumes through its lane wrapper; without a lane there is nothing safe to say", () => {
    expect(sessionActions(agent({ harness: "claude-worker", lane: "deepseek" }))).toEqual({
      resume: `cd '/w/demo-app' && claude-deepseek --resume ${UUID}`,
      desktopUrl: null,
    });
    expect(sessionActions(agent({ harness: "claude-worker" })).resume).toBeNull();
  });

  it("gemini / hermes / unknown harness: no resume command", () => {
    for (const harness of ["gemini", "hermes", null]) {
      expect(sessionActions(agent({ harness })).resume).toBeNull();
    }
  });

  it("Windows paths get cmd syntax; POSIX quoting survives odd characters", () => {
    expect(sessionActions(agent({ cwd: "C:\\Users\\x\\demo app" })).resume).toBe(`cd /d "C:\\Users\\x\\demo app" && claude --resume ${UUID}`);
    // single quotes: nothing inside expands, `!` and `$(...)` included
    expect(sessionActions(agent({ cwd: "/w/$HOME/a`b\"c'd!e" })).resume).toBe(
      `cd '/w/$HOME/a\`b"c'\\''d!e' && claude --resume ${UUID}`,
    );
  });

  it("a backslash in a POSIX path is not Windows: $(...) stays inert inside the single quotes", () => {
    expect(sessionActions(agent({ cwd: "/tmp/a\\b/$(id)" })).resume).toBe(`cd '/tmp/a\\b/$(id)' && claude --resume ${UUID}`);
  });

  it("refuses to build a command for a path it cannot quote safely (newline; % or \" on Windows)", () => {
    expect(sessionActions(agent({ cwd: "/w/a\nrm -rf /" })).resume).toBeNull();
    // control characters are keystrokes to a terminal's line editor (^U erases the line, ^O runs it)
    expect(sessionActions(agent({ cwd: "/tmp/x\u0015touch pwned\u000f" })).resume).toBeNull();
    expect(sessionActions(agent({ cwd: "/tmp/x\u001b[201~y" })).resume).toBeNull();
    expect(sessionActions(agent({ cwd: "C:\\w\\$(calc)" })).resume).toBeNull();
    expect(sessionActions(agent({ cwd: "C:\\w\\%PATH%" })).resume).toBeNull();
    expect(sessionActions(agent({ cwd: 'C:\\w\\"x' })).resume).toBeNull();
    expect(sessionActions(agent({ cwd: "\\\\server\\share\\p" })).resume).toBe(`cd /d "\\\\server\\share\\p" && claude --resume ${UUID}`);
  });

  it("no cwd → resume without the cd; a non-UUID session id never becomes a deep link or a command", () => {
    expect(sessionActions(agent({ cwd: null })).resume).toBe(`claude --resume ${UUID}`);
    const odd = sessionActions(agent({ sessionId: "abc; rm -rf /" }));
    expect(odd).toEqual({ resume: null, desktopUrl: null });
  });
});

describe("sessionActionsHtml", () => {
  it("renders copy / terminal / desktop actions, escaped", () => {
    const html = sessionActionsHtml({ ...agent(), cwd: '/w/"x"' });
    expect(html).toContain("data-copy=");
    expect(html).toContain(`href="claude://resume?session=${UUID}"`);
    expect(html).toContain(`data-open-terminal="${UUID}"`);
    expect(html).not.toContain('"/w/"x""');
  });

  it("offers the terminal even when there is no resume command, and nothing without a cwd", () => {
    const html = sessionActionsHtml(agent({ harness: "gemini" }));
    expect(html).not.toContain("data-copy");
    expect(html).toContain("data-open-terminal");
    expect(sessionActionsHtml(agent({ harness: "gemini", cwd: null }))).toBe("");
  });
});

describe("openTerminalFor", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs only the agent id (the daemon owns the path)", async () => {
    const f = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", f);
    expect(await openTerminalFor("agent-1")).toBe(true);
    expect(f).toHaveBeenCalledWith("/sessions/open-terminal", expect.objectContaining({ method: "POST", body: JSON.stringify({ agentId: "agent-1" }) }));
  });

  it("false on HTTP failure or network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await openTerminalFor("a")).toBe(false);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("x")));
    expect(await openTerminalFor("a")).toBe(false);
  });
});
