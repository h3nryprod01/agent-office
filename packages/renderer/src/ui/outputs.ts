// "Tủ hồ sơ" (wi-office-life): click the filing cabinet in the office →
// this panel lists real project outputs from the daemon's GET /outputs
// (docs/media/** + whitelisted work-item local paths) with Mở / Hiện trong
// Finder buttons hitting POST /open. Plain DOM overlay, same shape as
// orgchart.ts's toggle+overlay pattern minus the toggle button (triggered by
// the in-world sprite click instead — main.ts wires OfficeView.onFurnitureClick).

export interface OutputFile {
  name: string;
  path: string;
  size: number;
  mtime: number;
  kind: string;
}

export interface OutputsHandle {
  show(): void;
}

const KIND_ICON: Record<string, string> = {
  video: "🎬",
  image: "🖼️",
  doc: "📄",
  other: "📦",
};

/** "12.3 MB" / "480 KB" / "512 B" */
export function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export function outputsListHtml(files: OutputFile[]): string {
  if (files.length === 0) return `<p class="empty">Chưa có output nào trong docs/media/.</p>`;
  return `<ul class="outputs-list">${files
    .map(
      (f) => `<li>
        <span class="out-icon">${KIND_ICON[f.kind] ?? KIND_ICON.other}</span>
        <span class="out-name" title="${esc(f.path)}">${esc(f.name)}</span>
        <span class="out-meta">${fmtSize(f.size)} · ${new Date(f.mtime).toLocaleDateString()}</span>
        <span class="out-actions">
          <button data-open="${esc(f.path)}">Mở</button>
          <button data-reveal="${esc(f.path)}">Mở thư mục chứa</button>
        </span>
      </li>`,
    )
    .join("")}</ul>`;
}

export function mountOutputs(
  root: HTMLElement,
  fetchOutputs?: () => Promise<{ files: OutputFile[] }>,
  openPath?: (path: string, reveal?: boolean) => Promise<void>,
): OutputsHandle {
  root.classList.add("outputs");
  root.innerHTML = `<div class="outputs-overlay" hidden></div>`;
  const overlay = root.querySelector<HTMLElement>(".outputs-overlay")!;

  function render(body: string): void {
    overlay.innerHTML = `<div class="outputs-panel"><h2>Tủ hồ sơ <button class="outputs-close" title="Đóng">✕</button></h2>${body}</div>`;
  }

  function close(): void {
    overlay.hidden = true;
  }

  overlay.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    if (target === overlay || target.closest(".outputs-close")) {
      close();
      return;
    }
    const openBtn = target.closest<HTMLElement>("[data-open]");
    if (openBtn?.dataset.open) {
      openPath?.(openBtn.dataset.open, false);
      return;
    }
    const revealBtn = target.closest<HTMLElement>("[data-reveal]");
    if (revealBtn?.dataset.reveal) {
      openPath?.(revealBtn.dataset.reveal, true);
    }
  });

  return {
    show(): void {
      overlay.hidden = false;
      if (!fetchOutputs) {
        render(`<p class="empty">Tủ hồ sơ chỉ hoạt động ở live mode (?ws=1).</p>`);
        return;
      }
      render(`<p class="placeholder">Đang tải…</p>`);
      fetchOutputs()
        .then((data) => render(outputsListHtml(data.files)))
        .catch(() => render(`<p class="empty">Không kết nối được daemon.</p>`));
    },
  };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
