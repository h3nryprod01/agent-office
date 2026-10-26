/**
 * "Open this session" (lane L4) — what you can do with a character's real CLI
 * session from the side panel:
 *   - copy the command that resumes it (with `cd` to its working directory),
 *   - open a terminal at that directory (daemon: POST /sessions/open-terminal),
 *   - open it in the Claude desktop app (claude://resume?session=<id>).
 *
 * Claude desktop link, verified on real data: the app's deep-link handler
 * `resume` takes a CLI session UUID and imports it, and the transcript session
 * id the daemon tails IS that UUID (every desktop session's metadata stores it
 * as `cliSessionId`). Codex / Gemini / Hermes have no such link.
 */
import { t } from "../i18n";

export interface SessionAgent {
  agentId: string;
  sessionId: string;
  cwd: string | null;
  harness: string | null;
  /** worker lane (e.g. "deepseek"), when the daemon reports one */
  lane?: string | null;
}

export interface SessionActions {
  resume: string | null;
  desktopUrl: string | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LANE_RE = /^[a-z0-9-]+$/;

/** The daemon reports "claude-code" today; the shared contract spells it "claude". */
const isClaude = (harness: string | null): boolean => harness === "claude-code" || harness === "claude";

/**
 * `cd` line for a pasted terminal command, "" when there is no cwd, null when
 * the path cannot be quoted safely. The cwd is chosen by an agent, so it is
 * treated as hostile: POSIX gets single quotes (no expansion of any kind, not
 * even `!`), Windows gets cmd's double quotes and refuses what cmd still
 * expands inside them.
 */
function cdPrefix(cwd: string | null): string | null {
  if (!cwd) return "";
  // control characters act as keystrokes (^U, ^O, ESC…) in a terminal's line editor on paste
  if (/[\x00-\x1f\x7f-\x9f]/.test(cwd)) return null;
  // the daemon host's OS is not the browser's: read the path itself. A bare
  // backslash is a legal POSIX filename character, so only a drive letter or
  // a UNC prefix means Windows
  if (/^[a-z]:[\\/]/i.test(cwd) || cwd.startsWith("\\\\")) {
    // `$` and backtick expand if the line lands in PowerShell, `"` and `%` in cmd
    return /["%$`]/.test(cwd) ? null : `cd /d "${cwd}" && `;
  }
  return `cd '${cwd.replace(/'/g, "'\\''")}' && `;
}

export function sessionActions(agent: SessionAgent): SessionActions {
  const id = agent.sessionId;
  if (!UUID_RE.test(id)) return { resume: null, desktopUrl: null }; // never splice an odd id into a shell line
  const cd = cdPrefix(agent.cwd);
  if (cd === null) return { resume: null, desktopUrl: isClaude(agent.harness) ? `claude://resume?session=${id}` : null };
  if (isClaude(agent.harness)) {
    return { resume: `${cd}claude --resume ${id}`, desktopUrl: `claude://resume?session=${id}` };
  }
  if (agent.harness === "codex") return { resume: `${cd}codex resume ${id}`, desktopUrl: null };
  if (agent.harness === "claude-worker" && agent.lane && LANE_RE.test(agent.lane)) {
    return { resume: `${cd}claude-${agent.lane} --resume ${id}`, desktopUrl: null };
  }
  return { resume: null, desktopUrl: null };
}

/** The daemon opens the terminal itself; the page only names the agent. */
export async function openTerminalFor(agentId: string): Promise<boolean> {
  try {
    const res = await fetch("/sessions/open-terminal", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Side-panel block. Empty when the agent has neither a cwd nor a resume command. */
export function sessionActionsHtml(agent: SessionAgent): string {
  const { resume, desktopUrl } = sessionActions(agent);
  const buttons = [
    resume ? `<button data-copy="${esc(resume)}" title="${esc(resume)}">${t("session.copyResume")}</button>` : "",
    agent.cwd ? `<button data-open-terminal="${esc(agent.agentId)}">${t("session.openTerminal")}</button>` : "",
    desktopUrl ? `<a class="session-link" href="${esc(desktopUrl)}">${t("session.openDesktop")}</a>` : "",
  ].join("");
  return buttons ? `<div class="row session-actions"><span class="k">${t("session.actions")}</span><span class="v">${buttons}</span></div>` : "";
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
