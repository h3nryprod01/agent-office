// R13-B-2: Nhật ký — a human-readable view over the daemon's /transcript.
//   A marketing person doesn't read `bash`/`rm`/`grep`; in "Kinh doanh" mode
//   each tool call is de-jargoned through a small vocabulary map (toBusiness).
//   "Kỹ thuật" mode shows the raw tool + text for whoever wants the truth.
// toBusiness is pure and exported so the vocab is unit-testable with no DOM
// and no network. mountActivityLog is the DOM binding; it fetches via the
// injected fetchTranscript (live-mode only — mock degrades to a placeholder).

export interface TranscriptRow {
  ts: number;
  role: "assistant" | "tool";
  text: string;
  tool?: string;
}

export interface ActivityLogHandle {
  refresh(): Promise<void>;
}

interface ActivityLogOpts {
  fetchTranscript?: (limit?: number) => Promise<TranscriptRow[]>;
}

type Mode = "business" | "tech";

/**
 * Translate one transcript entry into business Vietnamese. Pure.
 *
 * An assistant turn (no tool) is already human-readable — keep its text,
 * trimmed. A tool call maps through a small built-in vocab; the most specific
 * Bash match wins (test > git > rm/cp/mv > build), and any unrecognized tool
 * falls back to "Đang xử lý" WITHOUT leaking the tool name — in Kinh doanh
 * mode a marketer must never see "Bash" or "TodoWrite".
 */
export function toBusiness(input: { tool?: string; text?: string }): string {
  const tool = input.tool ?? "";
  const text = input.text ?? "";
  if (!tool) {
    return text.trim();
  }
  if (tool === "Bash") {
    if (/npm test|vitest|node --test/.test(text)) return "Đang chạy kiểm thử";
    if (/\bgit /.test(text)) return "Thao tác mã nguồn (git)";
    if (/\brm[ -]/.test(text)) return "Xoá tệp";
    if (/\b(cp|mv) /.test(text)) return "Sao chép/di chuyển tệp";
    if (/npm run build|vite build/.test(text)) return "Đóng gói bản chạy";
    return "Chạy lệnh hệ thống";
  }
  const obj = fileObject(text);
  if (tool === "Read" || tool === "Grep" || tool === "Glob") return obj ? `Đọc: ${obj}` : "Đọc & tra tài liệu";
  if (tool === "Write" || tool === "Edit") return obj ? `Sửa: ${obj}` : "Soạn/sửa nội dung";
  if (tool === "WebSearch" || tool === "WebFetch") return "Tra cứu trên web";
  return "Đang xử lý";
}

/**
 * Basename of the first path-like token in a tool's text (scans up to 4 tokens),
 * line-suffix stripped + capped. "" if none → caller keeps the generic phrase.
 * Never returns a tool name (only a filename the user already owns). Pure.
 */
function fileObject(text: string): string {
  for (const tok of text.trim().split(/\s+/).slice(0, 4)) {
    const bare = tok.replace(/[:#].*$/, ""); // drop "file.ts:12" / "url#frag"
    if (/\//.test(tok) || /\.[a-z0-9]{1,5}$/i.test(bare)) {
      const base = bare.split("/").pop() ?? bare;
      if (base) return base.length > 24 ? `${base.slice(0, 23)}…` : base;
    }
  }
  return "";
}

/**
 * Mount the activity log into `root`. Live mode only — mock (no fetchTranscript)
 * shows a placeholder and refresh() is a no-op.
 */
export function mountActivityLog(root: HTMLElement, opts: ActivityLogOpts): ActivityLogHandle {
  root.classList.add("activity-log");
  const fetchTranscript = opts.fetchTranscript;
  let rows: TranscriptRow[] = [];
  let mode: Mode = "business";

  if (!fetchTranscript) {
    root.innerHTML = `<p class="activity-log-placeholder">Nhật ký chỉ có ở live mode.</p>`;
    return { refresh: async () => {} };
  }
  // Rebind so the narrowing survives into the closures below.
  const load = fetchTranscript;

  render();

  root.addEventListener("click", (ev) => {
    const el = (ev.target as HTMLElement).closest<HTMLElement>("[data-mode]");
    if (!el) return;
    mode = el.dataset.mode === "tech" ? "tech" : "business";
    render();
  });

  async function refresh(): Promise<void> {
    try {
      rows = await load(100);
    } catch (err) {
      console.error("[activity-log] fetchTranscript failed:", err);
      rows = [];
    }
    render();
  }

  function render(): void {
    const items = mode === "tech" ? rows.map(techRow) : coalesceBusiness(rows);
    const listHtml = items.length
      ? items.join("")
      : `<p class="activity-log-empty">Chưa có hoạt động nào.</p>`;
    root.innerHTML =
      `<div class="activity-log-toolbar">` +
      modeButton("business", "Kinh doanh", mode === "business") +
      modeButton("tech", "Kỹ thuật", mode === "tech") +
      `</div>` +
      `<div class="activity-log-list">${listHtml}</div>`;
  }

  return { refresh };
}

/**
 * Business mode: consecutive rows that de-jargon to the SAME phrase collapse
 * into one line with a "× N" badge — kills the wall of identical "Đang xử lý".
 * Blank turns (assistant with empty text) are dropped. Pure; exported for tests.
 */
export function coalesceBusiness(rows: TranscriptRow[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < rows.length) {
    const phrase = toBusiness({ tool: rows[i].tool, text: rows[i].text });
    if (!phrase) {
      i++; // blank assistant turn — nothing to show
      continue;
    }
    const startTs = rows[i].ts;
    let n = 0;
    while (i < rows.length && toBusiness({ tool: rows[i].tool, text: rows[i].text }) === phrase) {
      n++;
      i++;
    }
    const badge = n > 1 ? ` <span class="activity-log-xn">× ${n}</span>` : "";
    out.push(
      `<div class="activity-log-row">` +
        `<span class="activity-log-time">${esc(logTime(startTs))}</span>` +
        `<span class="activity-log-content">${esc(phrase)}${badge}</span>` +
        `</div>`,
    );
  }
  return out;
}

function techRow(r: TranscriptRow): string {
  const content =
    `${r.tool ? `<span class="activity-log-tool">${esc(r.tool)}</span>` : ""}` +
    `<code class="activity-log-raw">${esc(r.text ?? "")}</code>`;
  return (
    `<div class="activity-log-row activity-log-row--tech">` +
    `<span class="activity-log-time">${esc(logTime(r.ts))}</span>` +
    `<span class="activity-log-content">${content}</span>` +
    `</div>`
  );
}

function logTime(ts: number): string {
  return new Date(ts).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" });
}

function modeButton(key: Mode, label: string, active: boolean): string {
  return (
    `<button class="activity-log-mode${active ? " active" : ""}" type="button" ` +
    `data-mode="${key}" aria-pressed="${active}">${esc(label)}</button>`
  );
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
