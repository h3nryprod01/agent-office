// lane L7: the Documents tab. Left: the project's documents and deliverables (markdown, PDF,
// images as a gallery, HTML pages, CSV) with kind filters and search. Right: the viewer
// (docsViewer.ts). Below ~760px it is one pane at a time: the list, then the document with a back button.

import { t } from "../i18n";
import {
  filterFiles,
  getActiveProject,
  kindCounts,
  pickProject,
  setActiveProject,
  type DocFile,
  type DocsApi,
  type KindFilter,
  type ProjectInfo,
} from "./docsModel";
import { mountDocViewer, type ViewerHandle } from "./docsViewer";
import { esc } from "./markdown";
import { mountProjectWizard, httpWizardDeps, type WizardHandle } from "./projectWizard";

export interface DocsHandle {
  /** Reload projects + the file list (called when the tab is shown). */
  refresh(): Promise<void>;
  /** Jump straight to a document — kanban links and `#doc=` deep links land here. */
  open(project: string, path: string): Promise<void>;
  readonly project: string | null;
}

export interface DocsOpts {
  /** Live-mode only; absent (mock) → a placeholder. */
  api?: DocsApi;
  askPm?: (text: string) => void;
  /** The active project changed (picked or created) — main.ts keeps the rest of the app in step. */
  onProject?: (project: ProjectInfo, created: boolean) => void;
}

const FILTERS: KindFilter[] = ["all", "docs", "image", "pdf", "html", "csv"];

export function mountDocs(root: HTMLElement, opts: DocsOpts): DocsHandle {
  root.classList.add("docs");
  const api = opts.api;
  if (!api) {
    root.innerHTML = `<p class="docs-placeholder">${esc(t("docs.liveOnly"))}</p>`;
    return { refresh: async () => {}, open: async () => {}, project: null };
  }
  const live = api;

  let projects: ProjectInfo[] = [];
  let project: string | null = null;
  let files: DocFile[] = [];
  let filter: KindFilter = "all";
  let query = "";
  let selected: string | null = null;
  let error = "";
  let loaded = false;
  let firstRunShown = false;

  root.innerHTML =
    `<div class="docs-head">` +
    `<select class="docs-project" aria-label="${esc(t("docs.project"))}"></select>` +
    `<button type="button" class="docs-new" data-act="new">${esc(t("docs.newProject"))}</button>` +
    `<input type="search" class="docs-search" placeholder="${esc(t("docs.search"))}" aria-label="${esc(t("docs.search"))}">` +
    `<div class="docs-chips" role="tablist"></div>` +
    `</div>` +
    `<div class="docs-body"><nav class="docs-list" aria-label="${esc(t("docs.title"))}"></nav><section class="docs-pane"></section></div>` +
    `<div class="wiz" hidden></div>`;

  const select = root.querySelector<HTMLSelectElement>(".docs-project")!;
  const search = root.querySelector<HTMLInputElement>(".docs-search")!;
  const chips = root.querySelector<HTMLElement>(".docs-chips")!;
  const list = root.querySelector<HTMLElement>(".docs-list")!;
  const pane = root.querySelector<HTMLElement>(".docs-pane")!;

  const viewer: ViewerHandle = mountDocViewer(pane, {
    api: live,
    ...(opts.askPm ? { askPm: opts.askPm } : {}),
    onChanged: () => void loadFiles(),
    onBack: () => {
      selected = null;
      root.classList.remove("has-doc");
      renderList();
    },
  });

  const wizard: WizardHandle = mountProjectWizard(
    root.querySelector<HTMLElement>(".wiz")!,
    httpWizardDeps((created) => void adopt(created.slug, true)),
  );

  // ---- loading -------------------------------------------------------------------------------

  async function loadProjects(): Promise<void> {
    try {
      projects = await live.projects();
      error = "";
    } catch {
      projects = [];
      error = t("docs.noDaemon");
    }
    loaded = true;
    const picked = pickProject(projects, project ?? getActiveProject());
    project = picked?.slug ?? null;
    renderHead();
  }

  async function loadFiles(): Promise<void> {
    if (!project) {
      files = [];
      renderList();
      return;
    }
    const asked = project;
    let next: DocFile[] = [];
    let failure = "";
    try {
      next = (await live.list(asked)).files;
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
    if (asked !== project) return; // the user switched projects while this was in flight
    files = next;
    error = failure;
    renderList();
  }

  /** Switch to `slug` (after the wizard created it, or the picker changed). */
  async function adopt(slug: string, created: boolean): Promise<boolean> {
    if (created || !projects.some((p) => p.slug === slug)) await loadProjects();
    const info = projects.find((p) => p.slug === slug);
    if (!info) return false; // an unknown slug (stale link) must not become the active project
    project = slug;
    selected = null;
    root.classList.remove("has-doc");
    viewer.clear();
    setActiveProject(slug);
    renderHead();
    await loadFiles();
    opts.onProject?.(info, created);
    return true;
  }

  // ---- rendering -----------------------------------------------------------------------------

  function renderHead(): void {
    select.innerHTML = projects
      .map((p) => `<option value="${esc(p.slug)}"${p.slug === project ? " selected" : ""}>${esc(p.name)}</option>`)
      .join("");
    select.hidden = projects.length === 0;
    const counts = kindCounts(files);
    chips.innerHTML = FILTERS.map(
      (f) =>
        `<button type="button" role="tab" class="docs-chip${filter === f ? " on" : ""}" aria-selected="${filter === f}" data-filter="${f}">` +
        `${esc(t(`docs.filter.${f}` as never))}<span>${counts[f]}</span></button>`,
    ).join("");
    chips.hidden = projects.length === 0;
    search.hidden = projects.length === 0;
  }

  function renderList(): void {
    renderHead();
    if (!loaded) {
      list.innerHTML = `<p class="docs-note">${esc(t("docs.loading"))}</p>`;
      return;
    }
    if (error) {
      list.innerHTML = `<p class="docs-note">${esc(error)}</p>`;
      return;
    }
    if (projects.length === 0) {
      list.innerHTML = "";
      firstRunShown = true;
      pane.innerHTML =
        `<div class="docs-firstrun"><div class="docs-firstrun-emoji">📁</div>` +
        `<p class="docs-firstrun-title">${esc(t("docs.noProjects"))}</p>` +
        `<p class="docs-firstrun-sub">${esc(t("docs.noProjectsHint"))}</p>` +
        `<button type="button" class="primary" data-act="new">${esc(t("docs.newProject"))}</button></div>`;
      return;
    }
    if (firstRunShown) {
      firstRunShown = false;
      viewer.clear();
    }
    const shown = filterFiles(files, filter, query);
    if (files.length === 0) {
      list.innerHTML = `<p class="docs-note">${esc(t("docs.empty"))}</p>`;
      return;
    }
    if (shown.length === 0) {
      list.innerHTML = `<p class="docs-note">${esc(t("docs.noMatch"))}</p>`;
      return;
    }
    list.innerHTML = filter === "image" ? galleryHtml(shown) : listHtml(shown);
  }

  function listHtml(shown: DocFile[]): string {
    return `<ul class="docs-files">${shown
      .map(
        (f) =>
          `<li><button type="button" class="docs-file${f.path === selected ? " on" : ""}" data-path="${esc(f.path)}">` +
          `<span class="docs-ficon" aria-hidden="true">${ICON[f.kind]}</span>` +
          `<span class="docs-fname">${esc(f.name)}<small>${esc(dirOf(f.path))}</small></span>` +
          `<span class="docs-badge st-${f.status}">${esc(t(`docs.status.${f.status}` as never))}</span></button></li>`,
      )
      .join("")}</ul>`;
  }

  function galleryHtml(shown: DocFile[]): string {
    return `<div class="docs-gallery">${shown
      .map(
        (f) =>
          `<button type="button" class="docs-thumb${f.path === selected ? " on" : ""}" data-path="${esc(f.path)}" title="${esc(f.path)}">` +
          `<img src="${esc(live.rawUrl(project!, f.path))}" alt="${esc(f.name)}" loading="lazy"><span>${esc(f.name)}</span></button>`,
      )
      .join("")}</div>`;
  }

  async function openDoc(path: string): Promise<void> {
    if (!project) return;
    selected = path;
    root.classList.add("has-doc");
    renderList();
    await viewer.show(project, path);
  }

  // ---- events --------------------------------------------------------------------------------

  select.addEventListener("change", () => void adopt(select.value, false));
  search.addEventListener("input", () => {
    query = search.value;
    renderList();
  });

  root.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    if (target.closest('[data-act="new"]')) {
      wizard.open();
      return;
    }
    const chip = target.closest<HTMLElement>("[data-filter]");
    if (chip) {
      filter = chip.dataset.filter as KindFilter;
      renderList();
      return;
    }
    const file = target.closest<HTMLElement>("[data-path]");
    if (file && list.contains(file)) void openDoc(file.dataset.path!);
  });

  renderList();

  return {
    get project() {
      return project;
    },
    async refresh(): Promise<void> {
      await loadProjects();
      await loadFiles();
    },
    async open(slug: string, path: string): Promise<void> {
      if (!projects.some((p) => p.slug === slug)) await loadProjects();
      if (project !== slug) {
        if (!(await adopt(slug, false))) {
          await loadFiles();
          return;
        }
      } else if (files.length === 0) await loadFiles();
      await openDoc(path);
    },
  };
}

const ICON: Record<DocFile["kind"], string> = {
  markdown: "📝",
  text: "📄",
  pdf: "📕",
  image: "🖼️",
  html: "🌐",
  csv: "📊",
};

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}
