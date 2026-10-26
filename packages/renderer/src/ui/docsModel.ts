// lane L7: types, pure helpers and the HTTP client for the Documents tab. No DOM in here, so the
// filtering / anchoring / path rules are unit-testable (test/docsModel.test.ts).

import type { MdBlock } from "./markdown";

export type DocKind = "markdown" | "text" | "pdf" | "image" | "html" | "csv";
export type DocStatus = "draft" | "review" | "approved";
export type KindFilter = "all" | "docs" | "pdf" | "image" | "html" | "csv";

export interface DocFile {
  path: string;
  name: string;
  kind: DocKind;
  size: number;
  mtime: number;
  status: DocStatus;
}

export interface DocAnchor {
  heading: string | null;
  quote: string | null;
}

export interface DocComment {
  id: string;
  text: string;
  anchor: DocAnchor;
  author: string | null;
  by: string;
  createdAt: string;
  resolved: boolean;
}

export interface DocReview {
  id: string;
  decision: "approve" | "changes";
  note: string | null;
  by: string;
  at: string;
  itemId: string | null;
}

export interface DocDetail {
  path: string;
  name: string;
  kind: DocKind;
  size: number;
  mtime: number;
  role: string;
  status: DocStatus;
  statusAt: string | null;
  comments: DocComment[];
  reviews: DocReview[];
  content?: string;
}

export interface DocVersion {
  id: string;
  current: boolean;
  at: string;
  by: string | null;
  label: string;
}

export interface ProjectInfo {
  slug: string;
  name: string;
  template: string;
  cwd: string;
}

export interface DocsApi {
  projects(): Promise<ProjectInfo[]>;
  list(project: string): Promise<{ files: DocFile[]; role: string }>;
  doc(project: string, path: string): Promise<DocDetail>;
  rawUrl(project: string, path: string): string;
  versions(project: string, path: string): Promise<{ source: "git" | "snapshots"; versions: DocVersion[] }>;
  version(project: string, path: string, id: string): Promise<{ id: string; content: string }>;
  save(project: string, path: string, content: string, baseMtime: number): Promise<{ mtime: number; status: DocStatus }>;
  comment(project: string, path: string, text: string, anchor: DocAnchor): Promise<DocComment>;
  resolve(project: string, path: string, id: string, resolved: boolean): Promise<void>;
  setStatus(project: string, path: string, status: "draft" | "review"): Promise<void>;
  review(
    project: string,
    path: string,
    decision: "approve" | "changes",
    note: string,
  ): Promise<{ status: DocStatus; item: { id: string; title: string } | null }>;
}

/** An HTTP error from the daemon: carries the status so the UI can tell a 409 conflict from a 403. */
export class DocsHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function httpDocsApi(base = ""): DocsApi {
  const q = (params: Record<string, string>): string => new URLSearchParams(params).toString();
  async function call<T>(res: Response): Promise<T> {
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new DocsHttpError(body.error ?? `HTTP ${res.status}`, res.status);
    return body;
  }
  const get = <T>(route: string, params: Record<string, string>): Promise<T> =>
    fetch(`${base}${route}?${q(params)}`).then((r) => call<T>(r));
  const post = <T>(route: string, body: Record<string, unknown>): Promise<T> =>
    fetch(`${base}${route}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => call<T>(r));

  return {
    projects: () => fetch(`${base}/projects`).then((r) => call<ProjectInfo[]>(r)),
    list: (project) => get("/docs", { project }),
    doc: (project, path) => get("/docs/doc", { project, path }),
    rawUrl: (project, path) => `${base}/docs/file?${q({ project, path })}`,
    versions: (project, path) => get("/docs/versions", { project, path }),
    version: (project, path, id) => get("/docs/version", { project, path, id }),
    save: (project, path, content, baseMtime) => post("/docs/save", { project, path, content, baseMtime }),
    comment: (project, path, text, anchor) => post("/docs/comment", { project, path, text, anchor }),
    resolve: (project, path, id, resolved) => post<void>("/docs/comment/resolve", { project, path, id, resolved }),
    setStatus: (project, path, status) => post<void>("/docs/status", { project, path, status }),
    review: (project, path, decision, note) => post("/docs/review", { project, path, decision, note }),
  };
}

// ---- filtering -------------------------------------------------------------------------------

const FILTER_KINDS: Record<Exclude<KindFilter, "all">, DocKind[]> = {
  docs: ["markdown", "text"],
  pdf: ["pdf"],
  image: ["image"],
  html: ["html"],
  csv: ["csv"],
};

export function filterFiles(files: DocFile[], kind: KindFilter, query: string): DocFile[] {
  const needle = query.trim().toLowerCase();
  return files.filter(
    (f) => (kind === "all" || FILTER_KINDS[kind].includes(f.kind)) && (needle === "" || f.path.toLowerCase().includes(needle)),
  );
}

export function kindCounts(files: DocFile[]): Record<KindFilter, number> {
  const counts: Record<KindFilter, number> = { all: files.length, docs: 0, pdf: 0, image: 0, html: 0, csv: 0 };
  for (const f of files) {
    for (const [filter, kinds] of Object.entries(FILTER_KINDS)) {
      if (kinds.includes(f.kind)) counts[filter as KindFilter] += 1;
    }
  }
  return counts;
}

// ---- comments --------------------------------------------------------------------------------

/** Does `comment` belong to this rendered block? Heading comments carry no quote. */
export function anchorMatches(comment: DocComment, block: MdBlock): boolean {
  const { heading, quote } = comment.anchor;
  if (quote) return block.quote === quote && (block.heading ?? null) === (heading ?? null);
  if (heading) return block.quote === heading && block.heading === heading;
  return false;
}

/** Comments that point at something specific but no block matches any more (the text changed). */
export function orphanComments(comments: DocComment[], blocks: MdBlock[]): DocComment[] {
  return comments.filter((c) => (c.anchor.heading || c.anchor.quote) && !blocks.some((b) => anchorMatches(c, b)));
}

// ---- paths -----------------------------------------------------------------------------------

/**
 * Resolve `href` (as written inside the document at `docPath`) to a project-relative path.
 * Null when it leaves the project, is absolute, or has a scheme — the daemon would refuse it anyway.
 */
export function resolveRelative(docPath: string, href: string): string | null {
  const bare = href.split("#")[0]!.split("?")[0]!;
  if (bare === "" || bare.startsWith("/") || bare.includes("\\") || /^[a-z][a-z0-9+.-]*:/i.test(bare)) return null;
  const out = docPath.split("/").slice(0, -1);
  for (const part of bare.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(part);
  }
  return out.length > 0 ? out.join("/") : null;
}

/** `#doc=<project>/<path>` — the deep link a kanban card (or a message) can carry. */
export function docHash(project: string, path: string): string {
  return `#doc=${encodeURIComponent(project)}/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function parseDocHash(hash: string): { project: string; path: string } | null {
  const m = hash.match(/^#doc=([^/]+)\/(.+)$/);
  if (!m) return null;
  try {
    return { project: decodeURIComponent(m[1]!), path: m[2]!.split("/").map(decodeURIComponent).join("/") };
  } catch {
    return null;
  }
}

// ---- entry view ------------------------------------------------------------------------------

/** Templates for people who do not code: they open to PM chat + Documents instead of the 3D office. */
const NON_CODER_TEMPLATES = new Set(["content-studio", "real-estate-marketing"]);

export function entryViewFor(template: string | null | undefined): "docs" | "office" {
  return template && NON_CODER_TEMPLATES.has(template) ? "docs" : "office";
}

const ACTIVE_KEY = "agent-office.activeProject";

export function getActiveProject(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export function setActiveProject(slug: string): void {
  try {
    localStorage.setItem(ACTIVE_KEY, slug);
  } catch {
    // not persisting is survivable
  }
}

/** The project to open: the remembered one if it still exists, else the only/first one. */
export function pickProject(projects: ProjectInfo[], remembered: string | null): ProjectInfo | null {
  return projects.find((p) => p.slug === remembered) ?? projects[0] ?? null;
}

/**
 * Which view the app opens to. Ask the daemon which project is active; a non-coder template opens
 * to PM chat + Documents, anything else (or no daemon, no project, a slow answer) to the office.
 */
export async function resolveEntryView(api: Pick<DocsApi, "projects">, timeoutMs = 1500): Promise<"docs" | "office"> {
  try {
    const projects = await Promise.race([
      api.projects(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
    ]);
    return entryViewFor(pickProject(projects, getActiveProject())?.template);
  } catch {
    return "office";
  }
}
