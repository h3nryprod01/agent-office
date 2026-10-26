// lane L2: glue between a permission request and the project's policy.
// evaluate() resolves cwd → project → mode, asks policy.js for a verdict, and
// writes an audit row for everything the policy decided on its own (allow/deny)
// and for every ask it forced (danger list / budget) so the UI can say why.

import { deriveAgentLabel } from "./event-schema.js";
import { decide, normalizeHarness } from "./policy.js";
import { previewToolInput } from "./approvals.js";

const PREVIEW_MAX = 200;

/** Strip credentials a command line may carry before it lands in a log. */
export function redact(text) {
  return String(text ?? "")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 ***")
    .replace(/\b(sk|pk|ghp|gho|ghs|ghu|github_pat|glpat|xox[a-z]|AKIA|AIza|npm_|rk_(?:live|test)_)[-_A-Za-z0-9]{8,}/g, "***")
    .replace(/(\w+:\/\/)[^\s/:@]+:[^\s/@]+@/g, "$1***@") // scheme://user:pass@host
    .replace(/(--?(?:password|passwd|pwd|token|secret|api[-_]?key)(?:=|\s+))\S+/gi, "$1***") // --password hunter2
    .replace(/(\bsshpass\s+-p\s+)\S+/g, "$1***")
    .replace(/(\s-u\s+)[^\s:]+:\S+/g, "$1***") // curl -u user:pass
    .replace(/(\s-p)(?=\S{3,})\S+/g, "$1***") // mysql -phunter2
    .replace(/((?:api[_-]?key|token|secret|passw(?:or)?d|authorization)\w*\s*[=:]\s*)\S+/gi, "$1***")
    .slice(0, PREVIEW_MAX);
}

export class PolicyEngine {
  /**
   * @param {Object} opts
   * @param {import("./policy-store.js").PolicyStore} opts.store
   * @param {() => boolean} [opts.isOverBudget]
   * @param {() => number} [opts.now]
   * @param {string} [opts.home] overridable for tests
   */
  constructor({ store, isOverBudget = () => false, now = Date.now, home }) {
    this.store = store;
    this.isOverBudget = isOverBudget;
    this.now = now;
    this.home = home;
  }

  /**
   * @param {{sessionId?: string, tool?: string, toolInput?: object, cwd?: string|null, role?: string, harness?: string, lane?: string}} r
   * @returns {null | (ReturnType<typeof decide> & {project: string})} null = this cwd is in no project
   */
  evaluate(r) {
    const project = this.store.projectFor(r.cwd);
    if (!project) return null;
    const verdict = decide({
      policy: project.policy,
      tool: r.tool,
      toolInput: r.toolInput,
      role: r.role,
      overBudget: this.isOverBudget(),
      root: project.cwd,
      home: this.home,
    });
    if (verdict.decision !== "ask" || verdict.forced) {
      try {
        this.store.appendAudit(project.slug, {
          ts: this.now(),
          project: project.slug,
          sessionId: r.sessionId ?? "",
          agent: deriveAgentLabel(r.cwd),
          harness: normalizeHarness(r.harness),
          lane: r.lane ?? null,
          role: r.role ?? null,
          tool: r.tool ?? "unknown",
          preview: redact(previewToolInput(r.tool, r.toolInput)),
          mode: verdict.mode,
          modeSource: verdict.source,
          decision: verdict.decision,
          reasons: verdict.reasons,
          forced: verdict.forced,
        });
      } catch (error) {
        // the verdict must not depend on the log: a full disk can't turn a deny into a hang
        console.warn("[policy] audit write failed:", error.message);
      }
    }
    return { ...verdict, project: project.slug };
  }
}
