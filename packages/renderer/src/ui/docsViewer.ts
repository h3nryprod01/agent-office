// lane L7: the right-hand side of the Documents tab — one document, rendered by kind, with the
// review controls (status, approve / request changes), comments, in-place markdown editing and
// version history. Pure DOM; every daemon call goes through the injected DocsApi.

import { t } from "../i18n";
import {
  DocsHttpError,
  anchorMatches,
  orphanComments,
  resolveRelative,
  type DocAnchor,
  type DocComment,
  type DocDetail,
  type DocVersion,
  type DocsApi,
} from "./docsModel";
import { esc, parseCsv, renderMarkdown, type MdBlock } from "./markdown";

export interface ViewerDeps {
  api: DocsApi;
  /** Pre-fill the PM chat with a draft (does not send). */
  askPm?: (text: string) => void;
  /** Something changed on the daemon (status, edit) — the list should refresh. */
  onChanged: () => void;
  /** Mobile: back to the list. */
  onBack: () => void;
}

export interface ViewerHandle {
  show(project: string, path: string): Promise<void>;
  clear(): void;
}

interface Draft {
  comment: string;
  changes: string;
  edit: string;
}

type Notice = { kind: "ok" | "err"; text: string; reload?: boolean } | null;

const fmtDate = (iso: string): string => new Date(iso).toLocaleDateString();
const fmtDateTime = (iso: string): string => new Date(iso).toLocaleString();

export function mountDocViewer(root: HTMLElement, deps: ViewerDeps): ViewerHandle {
  root.classList.add("docs-viewer");
  const { api } = deps;

  let project = "";
  let path = "";
  let detail: DocDetail | null = null;
  let editing = false;
  let changesOpen = false;
  let historyOpen = false;
  let versions: { source: "git" | "snapshots"; versions: DocVersion[] } | null = null;
  let older: { id: string; at: string; content: string } | null = null;
  let blocks: MdBlock[] = [];
  let pending: DocAnchor | null = null;
  let notice: Notice = null;
  let busy = false;
  let draft: Draft = { comment: "", changes: "", edit: "" };
  /** Bumped by every show(): an answer that arrives for an earlier document is dropped. */
  let seq = 0;
  /** The text of an edit that lost a save conflict, kept readable so it can be merged by hand. */
  let lostEdit: string | null = null;

  const canWrite = (): boolean => detail !== null && detail.role !== "viewer";

  function clear(): void {
    detail = null;
    root.innerHTML = `<p class="docs-pick">${esc(t("docs.pick"))}</p>`;
  }

  /** Fetch the current document's detail; a response for a document that is no longer shown is ignored. */
  async function fetchDetail(): Promise<boolean> {
    const token = seq;
    const next = await api.doc(project, path);
    if (token !== seq) return false;
    detail = next;
    return true;
  }

  async function load(): Promise<void> {
    const token = seq;
    try {
      await fetchDetail();
    } catch (error) {
      if (token !== seq) return;
      detail = null;
      notice = { kind: "err", text: t("docs.error", { error: messageOf(error) }) };
    }
    if (token === seq) render();
  }

  async function show(nextProject: string, nextPath: string): Promise<void> {
    seq += 1;
    busy = false;
    detail = null; // nothing can be clicked while the new document loads
    project = nextProject;
    path = nextPath;
    editing = false;
    changesOpen = false;
    historyOpen = false;
    versions = null;
    older = null;
    pending = null;
    notice = null;
    lostEdit = null;
    draft = { comment: "", changes: "", edit: "" };
    root.innerHTML = `<p class="docs-pick">${esc(t("docs.loading"))}</p>`;
    await load();
  }

  /** Run a daemon action; any failure becomes a visible notice instead of a silent no-op. */
  async function act(fn: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    const token = seq;
    try {
      await fn();
    } catch (error) {
      if (token !== seq) return;
      const conflict = error instanceof DocsHttpError && error.status === 409;
      notice = conflict
        ? { kind: "err", text: t("docs.edit.conflict"), reload: true }
        : { kind: "err", text: t("docs.error", { error: messageOf(error) }) };
      render();
    } finally {
      if (token === seq) busy = false;
    }
  }

  // ---- rendering -----------------------------------------------------------------------------

  function render(): void {
    if (!detail) {
      root.innerHTML =
        `<div class="docs-bar"><button type="button" class="docs-back" data-act="back">${esc(t("docs.back"))}</button></div>` +
        noticeHtml();
      return;
    }
    const d = detail;
    const name = esc(d.name);
    root.innerHTML =
      `<div class="docs-bar">` +
      `<button type="button" class="docs-back" data-act="back">${esc(t("docs.back"))}</button>` +
      `<h2 class="docs-title" title="${esc(d.path)}">${name}</h2>` +
      `<span class="docs-badge st-${d.status}">${esc(t(`docs.status.${d.status}` as never))}</span>` +
      `</div>` +
      `<p class="docs-meta">${esc(d.path)} · ${fmtSize(d.size)} · ${esc(fmtDateTime(new Date(d.mtime).toISOString()))}</p>` +
      toolbarHtml(d) +
      reviewHtml(d) +
      noticeHtml() +
      historyHtml() +
      `<div class="docs-main">` +
      `<div class="docs-content-col">${older ? olderBannerHtml() : ""}${lostEditHtml()}${contentHtml(d)}</div>` +
      commentsHtml(d) +
      `</div>`;
    decorateBlocks(d);
    if (d.kind === "html") void fillHtmlFrame(d.path);
  }

  /**
   * An HTML deliverable is shown through `srcdoc` in a sandboxed frame (no scripts, no same-origin,
   * no forms) rather than by pointing the frame at the daemon: the text is fetched like any other
   * file and never gets the daemon's origin, whichever browser is on the other end.
   */
  async function fillHtmlFrame(forPath: string): Promise<void> {
    const frame = root.querySelector<HTMLIFrameElement>("iframe[data-html]");
    if (!frame) return;
    try {
      const res = await fetch(api.rawUrl(project, forPath));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      // The frame has no scripts, but a page can still make the browser GET things (images, meta refresh):
      // a CSP meta as the first element shuts every network load, leaving inline styles and data: images.
      const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">`;
      if (path === forPath && frame.isConnected) frame.srcdoc = csp + text;
    } catch (error) {
      // not render(): that would call this again and loop on a persistent failure
      const text = t("docs.error", { error: messageOf(error) });
      if (path === forPath) frame.insertAdjacentHTML("beforebegin", `<p class="docs-notice err" role="status">${esc(text)}</p>`);
    }
  }

  function toolbarHtml(d: DocDetail): string {
    const raw = esc(api.rawUrl(project, path));
    const buttons: string[] = [];
    if (d.kind === "markdown" && canWrite() && !editing && !older) {
      buttons.push(`<button type="button" data-act="edit">${esc(t("docs.action.edit"))}</button>`);
    }
    if (d.kind === "markdown" || d.kind === "text" || d.kind === "csv") {
      buttons.push(
        `<button type="button" data-act="history" class="${historyOpen ? "on" : ""}">${esc(t("docs.action.history"))}</button>`,
      );
    }
    buttons.push(`<a class="docs-linkbtn" href="${raw}" target="_blank" rel="noopener noreferrer">${esc(t("docs.action.openRaw"))}</a>`);
    if (deps.askPm) buttons.push(`<button type="button" data-act="ask-pm">${esc(t("docs.action.askPm"))}</button>`);
    return `<div class="docs-toolbar">${buttons.join("")}</div>`;
  }

  function reviewHtml(d: DocDetail): string {
    if (!canWrite()) return `<p class="docs-note">${esc(t("docs.viewerOnly"))}</p>`;
    if (d.status === "approved") {
      const when = d.statusAt ? fmtDate(d.statusAt) : "";
      return (
        `<div class="docs-review approved"><span>✓ ${esc(t("docs.approvedOn", { date: when }))}</span>` +
        `<button type="button" data-act="reopen">${esc(t("docs.action.reopen"))}</button></div>`
      );
    }
    const send =
      d.status === "draft"
        ? `<button type="button" data-act="send-review">${esc(t("docs.action.sendForReview"))}</button>`
        : "";
    const form = changesOpen
      ? `<div class="docs-changes"><textarea data-field="changes" rows="3" placeholder="${esc(t("docs.changes.placeholder"))}">${esc(draft.changes)}</textarea>` +
        `<div class="docs-row"><button type="button" class="primary" data-act="send-changes">${esc(t("docs.changes.send"))}</button>` +
        `<button type="button" data-act="toggle-changes">${esc(t("docs.action.cancel"))}</button></div></div>`
      : "";
    return (
      `<div class="docs-review">${send}` +
      `<button type="button" class="primary" data-act="approve">${esc(t("docs.action.approve"))}</button>` +
      `<button type="button" data-act="toggle-changes">${esc(t("docs.action.requestChanges"))}</button></div>${form}`
    );
  }

  function noticeHtml(): string {
    if (!notice) return "";
    const reload = notice.reload
      ? ` <button type="button" data-act="reload">${esc(t("docs.edit.reload"))}</button>`
      : "";
    return `<p class="docs-notice ${notice.kind}" role="status">${esc(notice.text)}${reload}</p>`;
  }

  function historyHtml(): string {
    if (!historyOpen) return "";
    if (!versions) return `<div class="docs-history"><p class="docs-note">${esc(t("docs.loading"))}</p></div>`;
    const title = versions.source === "git" ? t("docs.history.git") : t("docs.history.snapshots");
    const rows = versions.versions
      .map((v) => {
        const label = v.current ? t("docs.history.current") : v.label || t("docs.history.saved");
        const who = v.by ? ` · ${esc(v.by)}` : "";
        return (
          `<li><span class="docs-ver-label">${esc(label)}</span>` +
          `<span class="docs-ver-meta">${esc(fmtDateTime(v.at))}${who}</span>` +
          `<button type="button" data-act="view-version" data-id="${esc(v.id)}" data-at="${esc(v.at)}">${esc(t("docs.history.view"))}</button></li>`
        );
      })
      .join("");
    return `<div class="docs-history"><h3>${esc(title)}</h3><ul>${rows}</ul></div>`;
  }

  function olderBannerHtml(): string {
    return (
      `<p class="docs-notice warn">${esc(t("docs.history.viewing", { when: fmtDateTime(older!.at) }))} ` +
      `<button type="button" data-act="back-current">${esc(t("docs.history.back"))}</button></p>`
    );
  }

  function lostEditHtml(): string {
    if (lostEdit === null) return "";
    return (
      `<details class="docs-lost" open><summary>${esc(t("docs.edit.lost"))}</summary>` +
      `<textarea readonly rows="8">${esc(lostEdit)}</textarea></details>`
    );
  }

  function contentHtml(d: DocDetail): string {
    if (editing) {
      return (
        `<textarea class="docs-editor" data-field="edit" spellcheck="true">${esc(draft.edit)}</textarea>` +
        `<div class="docs-row"><button type="button" class="primary" data-act="save">${esc(t("docs.action.save"))}</button>` +
        `<button type="button" data-act="cancel-edit">${esc(t("docs.action.cancel"))}</button></div>`
      );
    }
    const raw = esc(api.rawUrl(project, path));
    switch (d.kind) {
      case "markdown": {
        const result = renderMarkdown(older ? older.content : (d.content ?? ""), {
          commentable: canWrite() && !older,
          commentLabel: t("docs.comment.paragraph"),
          resolveImage: (src) => {
            const rel = resolveRelative(path, src);
            return rel ? api.rawUrl(project, rel) : null;
          },
          resolveDocLink: (href) => resolveRelative(path, href),
        });
        blocks = result.blocks;
        return `<article class="docs-content md">${result.html}</article>`;
      }
      case "text":
        blocks = [];
        return `<pre class="docs-content docs-text">${esc(older ? older.content : (d.content ?? ""))}</pre>`;
      case "csv": {
        blocks = [];
        const { rows, truncated } = parseCsv(older ? older.content : (d.content ?? ""));
        const [head, ...body] = rows;
        const table = head
          ? `<div class="md-table-wrap"><table><thead><tr>${head.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead>` +
            `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`
          : "";
        const note = truncated ? `<p class="docs-note">${esc(t("docs.csv.truncated", { n: rows.length }))}</p>` : "";
        return `<div class="docs-content">${table}${note}</div>`;
      }
      case "pdf":
        blocks = [];
        // The browser's own PDF viewer; no library. iOS Safari only shows page 1 in an iframe, hence the link.
        return (
          `<iframe class="docs-frame" src="${raw}" title="${esc(d.name)}"></iframe>` +
          `<p class="docs-note">${esc(t("docs.pdf.fallback"))} <a href="${raw}" target="_blank" rel="noopener noreferrer">${esc(t("docs.action.openRaw"))}</a>.</p>`
        );
      case "image":
        blocks = [];
        return `<div class="docs-content docs-imgwrap"><img class="docs-img" src="${raw}" alt="${esc(d.name)}"></div>`;
      case "html":
        blocks = [];
        // sandbox="" = no scripts, no same-origin, no forms: a generated page is shown, never run.
        return (
          `<iframe class="docs-frame" sandbox="" data-html title="${esc(d.name)}"></iframe>` +
          `<p class="docs-note">${esc(t("docs.html.note"))}</p>`
        );
    }
  }

  function anchorLabel(a: DocAnchor): string {
    if (a.heading && a.quote) return `${a.heading} › “${a.quote}”`;
    return a.heading ?? (a.quote ? `“${a.quote}”` : t("docs.comment.whole"));
  }

  function commentHtml(c: DocComment, orphan: boolean): string {
    const who = c.author ? `${c.author}` : c.by;
    const where = c.anchor.heading || c.anchor.quote
      ? `<button type="button" class="docs-anchor" data-act="goto" data-id="${esc(c.id)}">${esc(anchorLabel(c.anchor))}</button>` +
        (orphan ? ` <em class="docs-orphan">${esc(t("docs.comment.orphan"))}</em>` : "")
      : "";
    const toggle = canWrite()
      ? `<button type="button" class="docs-mini" data-act="resolve" data-id="${esc(c.id)}" data-to="${c.resolved ? "0" : "1"}">${esc(t(c.resolved ? "docs.comment.reopen" : "docs.comment.resolve"))}</button>`
      : "";
    return (
      `<li class="docs-comment${c.resolved ? " resolved" : ""}" data-cid="${esc(c.id)}">` +
      `<div class="docs-comment-head"><strong>${esc(who)}</strong><span>${esc(fmtDateTime(c.createdAt))}</span></div>` +
      (where ? `<div class="docs-comment-where">${where}</div>` : "") +
      `<p>${esc(c.text)}</p>${toggle}</li>`
    );
  }

  function commentsHtml(d: DocDetail): string {
    const orphans = new Set(orphanComments(d.comments, blocks).map((c) => c.id));
    const sorted = [...d.comments].sort((a, b) => Number(a.resolved) - Number(b.resolved));
    const list =
      d.comments.length === 0
        ? `<p class="docs-note">${esc(t("docs.comment.none"))}</p>`
        : `<ul class="docs-comment-list">${sorted.map((c) => commentHtml(c, orphans.has(c.id))).join("")}</ul>`;
    const form = canWrite()
      ? `<div class="docs-comment-form">` +
        `<p class="docs-comment-on">${esc(t("docs.comment.on", { where: pending ? anchorLabel(pending) : t("docs.comment.whole") }))}` +
        (pending ? ` <button type="button" class="docs-mini" data-act="clear-anchor">${esc(t("docs.comment.clear"))}</button>` : "") +
        `</p><textarea data-field="comment" rows="3" placeholder="${esc(t("docs.comment.placeholder"))}">${esc(draft.comment)}</textarea>` +
        `<button type="button" class="primary" data-act="comment">${esc(t("docs.comment.add"))}</button></div>`
      : "";
    const open = d.comments.filter((c) => !c.resolved).length;
    return `<aside class="docs-comments"><h3>${esc(t("docs.comments", { n: open }))}</h3>${list}${form}</aside>`;
  }

  /** Badge each paragraph's 💬 with how many open comments point at it. */
  function decorateBlocks(d: DocDetail): void {
    for (const el of root.querySelectorAll<HTMLElement>(".md-block")) {
      const block = blocks[Number(el.dataset.block)];
      if (!block) continue;
      const n = d.comments.filter((c) => !c.resolved && anchorMatches(c, block)).length;
      const btn = el.querySelector<HTMLElement>(".md-cmt");
      if (btn) btn.dataset.n = String(n);
    }
  }

  // ---- events --------------------------------------------------------------------------------

  root.addEventListener("input", (ev) => {
    const el = ev.target as HTMLTextAreaElement;
    const field = el.dataset?.field;
    if (field === "comment" || field === "changes" || field === "edit") draft = { ...draft, [field]: el.value };
  });

  root.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;

    const cmt = target.closest<HTMLElement>(".md-cmt");
    if (cmt) {
      const blockEl = cmt.closest<HTMLElement>(".md-block")!;
      const block = blocks[Number(blockEl.dataset.block)];
      if (block) {
        const isHeading = blockEl.classList.contains("md-heading");
        pending = isHeading ? { heading: block.heading, quote: null } : { heading: block.heading, quote: block.quote || null };
        render();
        const box = root.querySelector<HTMLTextAreaElement>('[data-field="comment"]');
        box?.scrollIntoView({ block: "center" });
        box?.focus();
      }
      return;
    }

    const docLink = target.closest<HTMLElement>("[data-doc-path]");
    if (docLink) {
      ev.preventDefault();
      void show(project, docLink.dataset.docPath!);
      return;
    }

    const btn = target.closest<HTMLElement>("[data-act]");
    if (!btn) return;
    const id = btn.dataset.id ?? "";
    switch (btn.dataset.act) {
      case "back":
        deps.onBack();
        break;
      case "reload":
        if (editing) lostEdit = draft.edit;
        notice = null;
        editing = false;
        void load();
        break;
      case "edit":
        editing = true;
        draft = { ...draft, edit: detail?.content ?? "" };
        notice = null;
        render();
        break;
      case "cancel-edit":
        editing = false;
        render();
        break;
      case "save":
        void act(async () => {
          await api.save(project, path, draft.edit, detail!.mtime);
          editing = false;
          lostEdit = null;
          notice = { kind: "ok", text: t("docs.edit.saved") };
          versions = null;
          await fetchDetail();
          render();
          deps.onChanged();
        });
        break;
      case "history":
        historyOpen = !historyOpen;
        render();
        if (historyOpen && !versions) {
          const token = seq;
          void api.versions(project, path).then(
            (v) => {
              if (token !== seq) return;
              versions = v;
              render();
            },
            (error) => {
              if (token !== seq) return;
              historyOpen = false;
              notice = { kind: "err", text: t("docs.error", { error: messageOf(error) }) };
              render();
            },
          );
        }
        break;
      case "view-version":
        void act(async () => {
          if (id === "current") {
            older = null;
          } else {
            const v = await api.version(project, path, id);
            older = { id, at: btn.dataset.at ?? "", content: v.content };
          }
          render();
        });
        break;
      case "back-current":
        older = null;
        render();
        break;
      case "ask-pm":
        deps.askPm?.(t("docs.askPm.prefill", { path }));
        break;
      case "send-review":
        void act(async () => {
          await api.setStatus(project, path, "review");
          await load();
          deps.onChanged();
        });
        break;
      case "reopen":
        void act(async () => {
          await api.setStatus(project, path, "draft");
          await load();
          deps.onChanged();
        });
        break;
      case "approve":
        void act(async () => {
          await api.review(project, path, "approve", "");
          notice = null;
          await load();
          deps.onChanged();
        });
        break;
      case "toggle-changes":
        changesOpen = !changesOpen;
        render();
        break;
      case "send-changes":
        void act(async () => {
          const out = await api.review(project, path, "changes", draft.changes);
          changesOpen = false;
          draft = { ...draft, changes: "" };
          await fetchDetail();
          notice = { kind: "ok", text: t("docs.changes.sent", { title: out.item?.title ?? "" }) };
          render();
          deps.onChanged();
        });
        break;
      case "comment":
        void act(async () => {
          await api.comment(project, path, draft.comment, pending ?? { heading: null, quote: null });
          draft = { ...draft, comment: "" };
          pending = null;
          notice = null;
          await fetchDetail();
          render();
        });
        break;
      case "clear-anchor":
        pending = null;
        render();
        break;
      case "resolve":
        void act(async () => {
          await api.resolve(project, path, id, btn.dataset.to === "1");
          await fetchDetail();
          render();
        });
        break;
      case "goto": {
        const c = detail?.comments.find((x) => x.id === id);
        const index = c ? blocks.findIndex((b) => anchorMatches(c, b)) : -1;
        const el = index >= 0 ? root.querySelector<HTMLElement>(`[data-block="${index}"]`) : null;
        if (el) {
          el.scrollIntoView({ block: "center", behavior: "smooth" });
          el.classList.add("flash");
          setTimeout(() => el.classList.remove("flash"), 1400);
        }
        break;
      }
    }
  });

  clear();
  return { show, clear };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
