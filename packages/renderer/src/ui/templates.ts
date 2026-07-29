// "🏢 Công ty đóng hộp" (wi-templates-panel): the storefront for company
// templates — browse templates/ (daemon GET /templates) and apply one onto the
// real roster (POST /templates/apply). This is what a customer is shown when
// the product is sold, so the destructive bit is loud: applying OVERWRITES
// ~/.claude/company/roster.yaml, hence the two-step confirm below.
//
// Panel shape follows costs.ts (toggle button + overlay). Every piece of text
// that comes from the daemon — template names, skill names, backup paths, goals
// — reaches the DOM through textContent, never innerHTML.

import { t } from "../i18n";
export interface TemplateDept {
  name: string;
  memberCount: number;
}

export interface TemplateSummary {
  name: string;
  departments: TemplateDept[];
  memberTotal: number;
  hasGoals: boolean;
  missingSkills: string[];
}

export interface ApplyResult {
  backupPath: string | null;
  missingSkills: string[];
  goals: string | null;
}

/** Where apply writes, shown before the user commits. The daemon owns the real path. */
export const ROSTER_PATH_HINT = "~/.claude/company/roster.yaml";

/** "2 departments · 8 people · has goals.md" */
export function summaryMeta(tpl: TemplateSummary): string {
  const goals = tpl.hasGoals ? t("templates.hasGoals") : t("templates.noGoals");
  return t("templates.meta", {
    depts: tpl.departments.length,
    members: tpl.memberTotal,
    goals,
  });
}

/** The skill-gap warning, or null when the machine already has everything. */
export function missingLabel(missing: string[]): string | null {
  if (missing.length === 0) return null;
  return t("templates.missingSkills", { n: missing.length, list: missing.join(", ") });
}

/** What the apply button says, armed or not. */
export function applyButtonLabel(armed: boolean): string {
  return armed ? t("templates.confirmOverwrite") : t("templates.apply");
}

/** The warning shown between the two clicks. */
export function armWarning(name: string): string {
  return t("templates.applyWarning", { name, path: ROSTER_PATH_HINT });
}

/**
 * Two-step confirm, as a state machine so it tests without a DOM.
 * First click on a template arms it; clicking the SAME one again applies.
 * Clicking a different template moves the arm rather than applying — a
 * misaimed second click must never overwrite the roster with the wrong company.
 */
export function nextArm(
  armed: string | null,
  clicked: string,
): { armed: string | null; apply: string | null } {
  if (armed === clicked) return { armed: null, apply: clicked };
  return { armed: clicked, apply: null };
}

/** Result lines after a successful apply, in display order. */
export function applyLines(result: ApplyResult): string[] {
  const lines = [
    result.backupPath
      ? t("templates.backedUp", { path: result.backupPath })
      : t("templates.createdFresh"),
  ];
  const missing = missingLabel(result.missingSkills);
  lines.push(missing ?? t("templates.allSkillsPresent"));
  return lines;
}

export interface TemplatesHandle {
  open(): void;
}

export function mountTemplates(
  root: HTMLElement,
  opts: {
    /** undefined = mock mode (no daemon): the panel stays hidden entirely. */
    fetchTemplates?: () => Promise<TemplateSummary[]>;
    applyTemplate?: (name: string) => Promise<ApplyResult>;
  } = {},
): TemplatesHandle {
  if (!opts.fetchTemplates || !opts.applyTemplate) {
    root.hidden = true; // mock mode — applying a template needs the daemon
    return { open() {} };
  }
  const { fetchTemplates, applyTemplate } = opts;

  root.classList.add("templates");
  root.innerHTML = `
    <button class="tpl-toggle">${t("templates.button")}</button>
    <div class="tpl-overlay" hidden>
      <div class="tpl-panel">
        <h2>${t("templates.button")} <button class="tpl-close" title="${t("templates.close")}">✕</button></h2>
        <p class="tpl-note">${t("templates.note")}</p>
        <div class="tpl-list"><p class="placeholder">${t("templates.loading")}</p></div>
        <div class="tpl-result" hidden></div>
      </div>
    </div>`;

  const overlay = root.querySelector<HTMLElement>(".tpl-overlay")!;
  const list = root.querySelector<HTMLElement>(".tpl-list")!;
  const result = root.querySelector<HTMLElement>(".tpl-result")!;

  let armed: string | null = null;
  let busy = false;
  let cache: TemplateSummary[] = [];

  const el = (tag: string, cls: string, text?: string): HTMLElement => {
    const node = document.createElement(tag);
    node.className = cls;
    if (text !== undefined) node.textContent = text; // daemon text — never innerHTML
    return node;
  };

  function renderList(): void {
    const templates = cache;
    list.replaceChildren();
    if (templates.length === 0) {
      list.append(el("p", "empty", t("templates.empty")));
      return;
    }
    for (const tpl of templates) {
      const card = el("section", "tpl-card");
      card.append(el("h3", "tpl-name", tpl.name), el("p", "tpl-meta", summaryMeta(tpl)));

      const depts = tpl.departments.map((d) => `${d.name} (${d.memberCount})`).join(" · ");
      if (depts) card.append(el("p", "tpl-depts", depts));

      const warn = missingLabel(tpl.missingSkills);
      if (warn) card.append(el("p", "tpl-warn", warn));

      const button = document.createElement("button");
      button.className = "tpl-apply";
      button.dataset.apply = tpl.name;
      button.textContent = applyButtonLabel(armed === tpl.name);
      card.append(button);

      if (armed === tpl.name) card.append(el("p", "tpl-confirm", armWarning(tpl.name)));
      list.append(card);
    }
  }

  function renderResult(name: string, r: ApplyResult): void {
    result.hidden = false;
    result.replaceChildren(el("h3", "tpl-result-title", t("templates.applied", { name })));
    for (const line of applyLines(r)) result.append(el("p", "tpl-result-line", line));
    if (r.goals) {
      result.append(el("h4", "tpl-goals-title", t("templates.goalsHeading")));
      result.append(el("pre", "tpl-goals", r.goals));
    }
  }

  function refresh(): void {
    fetchTemplates()
      .then((templates) => {
        cache = templates;
        renderList();
      })
      .catch(() => {
        list.replaceChildren(el("p", "empty", t("templates.noDaemon", { url: location.host })));
      });
  }

  function reset(): void {
    armed = null;
    busy = false;
  }

  function doApply(name: string): void {
    busy = true;
    result.hidden = false;
    result.replaceChildren(el("p", "placeholder", t("templates.applying", { name })));
    applyTemplate(name)
      .then((r) => {
        reset();
        renderResult(name, r);
        refresh(); // missingSkills may have changed meaning now that the roster did
      })
      .catch((error: unknown) => {
        reset();
        result.replaceChildren(
          el("p", "tpl-warn", t("templates.applyFailed", { error: error instanceof Error ? error.message : String(error) })),
        );
        refresh();
      });
  }

  root.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;

    if (target.closest(".tpl-toggle")) {
      overlay.hidden = false;
      reset();
      result.hidden = true;
      refresh();
      return;
    }
    if (target === overlay || target.closest(".tpl-close")) {
      overlay.hidden = true;
      reset();
      return;
    }
    if (busy) return;

    const button = target.closest<HTMLElement>("[data-apply]");
    if (!button?.dataset.apply) return;
    const step = nextArm(armed, button.dataset.apply);
    armed = step.armed;
    if (step.apply) doApply(step.apply);
    else renderList(); // re-render so the armed card shows the confirm warning
  });

  return {
    open(): void {
      overlay.hidden = false;
      reset();
      refresh();
    },
  };
}
