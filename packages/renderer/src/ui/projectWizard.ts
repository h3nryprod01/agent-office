// lane L7: "New project" wizard for people who do not edit files. Pick a template, name the
// project, answer the questions that the template's goals.md leaves blank (one form field per
// blank), add free-text goals — the daemon writes the answers into the new project's goals.md.

import { t, type Key } from "../i18n";
import type { ProjectInfo } from "./docsModel";
import { esc } from "./markdown";

export interface WizardField {
  key: string;
  hint: string | null;
  example: string | null;
}

export interface WizardDeps {
  fetchTemplates(): Promise<{ name: string }[]>;
  fetchFields(template: string): Promise<WizardField[]>;
  create(body: { name: string; template: string; cwd?: string; fields: Record<string, string>; notes: string }): Promise<ProjectInfo>;
  onCreated(project: ProjectInfo): void;
}

export interface WizardHandle {
  open(): void;
}

/** `PRODUCT` → "Product", `SỐ LEAD/THÁNG` → "Số lead/tháng": the blank's key, made readable. */
export function fieldLabel(key: string): string {
  const lower = key.toLocaleLowerCase();
  return lower.charAt(0).toLocaleUpperCase() + lower.slice(1);
}

/** A template's friendly name/description from the dictionary; falls back to the folder name. */
export function templateText(name: string, part: "" | ".desc" = ""): string {
  const key = `wizard.tpl.${name}${part}` as Key;
  const text = t(key);
  return text === key ? (part === "" ? name : "") : text;
}

export function httpWizardDeps(onCreated: (p: ProjectInfo) => void): WizardDeps {
  const json = async <T>(res: Response): Promise<T> => {
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    return body;
  };
  return {
    fetchTemplates: () => fetch("/templates").then((r) => json<{ name: string }[]>(r)),
    fetchFields: (template) =>
      fetch(`/wizard/template?name=${encodeURIComponent(template)}`)
        .then((r) => json<{ fields: WizardField[] }>(r))
        .then((b) => b.fields),
    create: (body) =>
      fetch("/wizard/create", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }).then((r) => json<ProjectInfo>(r)),
    onCreated,
  };
}

export function mountProjectWizard(root: HTMLElement, deps: WizardDeps): WizardHandle {
  root.classList.add("wiz");
  let templates: { name: string }[] = [];
  let template = "";
  let fields: WizardField[] | null = null;
  let values: Record<string, string> = {};
  let name = "";
  let folder = "";
  let notes = "";
  let error = "";
  let creating = false;

  function close(): void {
    root.innerHTML = "";
    root.hidden = true;
  }

  function render(): void {
    root.hidden = false;
    const cards = templates
      .map((tpl) => {
        const on = tpl.name === template;
        const desc = templateText(tpl.name, ".desc");
        return (
          `<button type="button" class="wiz-tpl${on ? " on" : ""}" data-tpl="${esc(tpl.name)}" aria-pressed="${on}">` +
          `<strong>${esc(templateText(tpl.name))}</strong>${desc ? `<span>${esc(desc)}</span>` : ""}</button>`
        );
      })
      .join("");

    let fieldsHtml = "";
    if (template) {
      fieldsHtml =
        fields === null
          ? `<p class="wiz-hint">${esc(t("wizard.fields.loading"))}</p>`
          : fields.length === 0
            ? ""
            : `<h3>${esc(t("wizard.fields"))}</h3><p class="wiz-hint">${esc(t("wizard.fields.hint"))}</p>` +
              fields
                .map(
                  (f) =>
                    `<label class="wiz-field"><span>${esc(fieldLabel(f.key))}</span>` +
                    (f.hint ? `<small>${esc(f.hint)}</small>` : "") +
                    `<input type="text" data-key="${esc(f.key)}" maxlength="200" value="${esc(values[f.key] ?? "")}" placeholder="${esc(f.example ?? "")}"></label>`,
                )
                .join("");
    }

    root.innerHTML =
      `<div class="wiz-overlay"><div class="wiz-panel" role="dialog" aria-modal="true" aria-label="${esc(t("wizard.title"))}">` +
      `<h2>${esc(t("wizard.title"))}</h2>` +
      `<h3>${esc(t("wizard.step.template"))}</h3><div class="wiz-tpls">${cards}</div>` +
      `<label class="wiz-field"><span>${esc(t("wizard.name"))}</span>` +
      `<input type="text" data-field="name" maxlength="60" value="${esc(name)}" placeholder="${esc(t("wizard.name.placeholder"))}"></label>` +
      fieldsHtml +
      `<label class="wiz-field"><span>${esc(t("wizard.notes"))}</span><small>${esc(t("wizard.notes.hint"))}</small>` +
      `<textarea data-field="notes" rows="3">${esc(notes)}</textarea></label>` +
      `<label class="wiz-field"><span>${esc(t("wizard.folder"))}</span><small>${esc(t("wizard.folder.hint"))}</small>` +
      `<input type="text" data-field="folder" value="${esc(folder)}" placeholder="${esc(t("wizard.folder.placeholder"))}"></label>` +
      (error ? `<p class="wiz-error" role="alert">${esc(error)}</p>` : "") +
      `<div class="wiz-actions"><button type="button" class="primary" data-act="create"${creating ? " disabled" : ""}>${esc(t(creating ? "wizard.creating" : "wizard.create"))}</button>` +
      `<button type="button" data-act="cancel">${esc(t("wizard.cancel"))}</button></div>` +
      `</div></div>`;
  }

  root.addEventListener("input", (ev) => {
    const el = ev.target as HTMLInputElement | HTMLTextAreaElement;
    if (el.dataset.key) values = { ...values, [el.dataset.key]: el.value };
    else if (el.dataset.field === "name") name = el.value;
    else if (el.dataset.field === "folder") folder = el.value;
    else if (el.dataset.field === "notes") notes = el.value;
  });

  root.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    if (target.classList.contains("wiz-overlay")) return close();

    const tpl = target.closest<HTMLElement>("[data-tpl]");
    if (tpl) {
      const picked = tpl.dataset.tpl!;
      if (picked === template) return;
      template = picked;
      fields = null;
      values = {};
      render();
      deps.fetchFields(picked).then(
        (f) => {
          if (template !== picked) return; // the user already picked another one
          fields = f;
          render();
        },
        () => {
          if (template !== picked) return;
          fields = [];
          render();
        },
      );
      return;
    }

    const act = target.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "cancel") return close();
    if (act !== "create" || creating) return;

    if (name.trim() === "") {
      error = t("wizard.nameRequired");
      render();
      return;
    }
    if (!template) {
      error = t("wizard.step.template");
      render();
      return;
    }
    creating = true;
    error = "";
    render();
    deps
      .create({
        name: name.trim(),
        template,
        ...(folder.trim() ? { cwd: folder.trim() } : {}),
        fields: Object.fromEntries(Object.entries(values).filter(([, v]) => v.trim() !== "")),
        notes,
      })
      .then(
        (project) => {
          creating = false;
          close();
          deps.onCreated(project);
        },
        (err: unknown) => {
          creating = false;
          error = t("wizard.error", { error: err instanceof Error ? err.message : String(err) });
          render();
        },
      );
  });

  return {
    open(): void {
      template = "";
      fields = null;
      values = {};
      name = "";
      folder = "";
      notes = "";
      error = "";
      creating = false;
      root.hidden = false;
      root.innerHTML = `<div class="wiz-overlay"><div class="wiz-panel"><p class="wiz-hint">${esc(t("docs.loading"))}</p></div></div>`;
      deps.fetchTemplates().then(
        (list) => {
          templates = list;
          render();
        },
        (err: unknown) => {
          templates = [];
          error = t("wizard.error", { error: err instanceof Error ? err.message : String(err) });
          render();
        },
      );
    },
  };
}
