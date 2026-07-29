// R13-B: "Cấu hình" view — a real status/diagnostics screen (was a placeholder).
// Shows the two things a solo operator actually needs to self-diagnose: is the
// daemon connected, and which agent CLIs (Claude Code / Codex / Gemini) the app
// can see + are logged in. Plain DOM; the HTML builders are pure so they
// unit-test without a browser. The harness list is live-mode only (needs the
// daemon); mock shows a note.

export interface HarnessStatus {
  key: string;
  label: string;
  installed: boolean;
  /** null = not probed yet; true/false = last probe result. */
  loggedIn: boolean | null;
  reason?: string;
}

export interface SettingsHandle {
  /** Re-fetch the harness list (called when the view opens). */
  refresh(): void;
  /** Live daemon connection state (wired to the WS onStatus). */
  setConnected(connected: boolean): void;
}

interface SettingsDeps {
  /** host:port shown in the UI, e.g. "127.0.0.1:8787". */
  daemonUrl: string;
  fetchHarnesses?: () => Promise<HarnessStatus[]>;
  probeHarness?: (key: string) => Promise<HarnessStatus[]>;
}

/**
 * The daemon connection chip. Pure.
 *
 * `live: false` is ?mock=1, where the app never opens a socket. Reporting "Mất
 * kết nối" there accuses a daemon we never called — and in a demo it's the
 * daemon serving the page, so the screen calls itself broken while working.
 */
export function connectionHtml(connected: boolean, daemonUrl: string, live = true): string {
  if (!live) return `<span class="set-chip muted">● Chế độ demo (mock) — không nối daemon</span>`;
  return connected
    ? `<span class="set-chip ok">● Đã kết nối</span>`
    : `<span class="set-chip off">● Mất kết nối — daemon (${esc(daemonUrl)}) có đang chạy?</span>`;
}

/** One harness row: installed + login chips, and a "Kiểm tra" button if installed. Pure. */
export function harnessRowHtml(h: HarnessStatus): string {
  const installed = h.installed
    ? `<span class="set-chip ok">Đã cài</span>`
    : `<span class="set-chip off">Chưa cài</span>`;
  let login = "";
  if (h.installed) {
    login =
      h.loggedIn === true
        ? `<span class="set-chip ok">Đã đăng nhập</span>`
        : h.loggedIn === false
          ? `<span class="set-chip warn">${esc(h.reason || "Chưa đăng nhập")}</span>`
          : `<span class="set-chip muted">Chưa kiểm tra</span>`;
  }
  const probe = h.installed
    ? `<button class="set-probe" type="button" data-probe="${esc(h.key)}">Kiểm tra</button>`
    : "";
  return (
    `<div class="set-row">` +
    `<span class="set-row-label">${esc(h.label)}</span>` +
    `<span class="set-row-chips">${installed}${login}</span>` +
    probe +
    `</div>`
  );
}

export function mountSettings(root: HTMLElement, deps: SettingsDeps): SettingsHandle {
  root.classList.add("settings");
  let harnesses: HarnessStatus[] = [];
  let connected = false;
  let loaded = false;

  function render(): void {
    const harnessBody = !deps.fetchHarnesses
      ? `<p class="set-note">Nguồn agent chỉ hiện ở chế độ live (cần daemon).</p>`
      : loaded
        ? harnesses.map(harnessRowHtml).join("")
        : `<p class="set-note">Đang kiểm tra…</p>`;
    root.innerHTML =
      `<h1 class="set-title">Cấu hình</h1>` +
      `<section class="set-block"><h2>Kết nối</h2>` +
      `<div class="set-row"><span class="set-row-label">Daemon · ws://${esc(deps.daemonUrl)}</span>` +
      `<span class="set-row-chips" data-conn>${connectionHtml(connected, deps.daemonUrl, !!deps.fetchHarnesses)}</span></div>` +
      `</section>` +
      `<section class="set-block"><h2>Nguồn agent</h2>` +
      `<p class="set-hint">Các CLI agent mà văn phòng nhìn thấy. "Kiểm tra" xác nhận đăng nhập.</p>` +
      harnessBody +
      `</section>` +
      `<section class="set-block"><h2>Về</h2>` +
      `<p class="set-about">Agent Office — văn phòng trực quan cho công ty một-người vận hành bằng AI agent. "Công ty đóng hộp" cho từng loại việc.</p>` +
      `</section>`;
  }

  root.addEventListener("click", (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>("[data-probe]");
    if (!btn || !deps.probeHarness) return;
    btn.textContent = "Đang kiểm tra…";
    (btn as HTMLButtonElement).disabled = true;
    deps
      .probeHarness(btn.dataset.probe!)
      .then((list) => {
        harnesses = list;
        loaded = true;
        render();
      })
      .catch(() => {
        btn.textContent = "Lỗi — thử lại";
        (btn as HTMLButtonElement).disabled = false;
      });
  });

  render();

  return {
    refresh(): void {
      if (!deps.fetchHarnesses) {
        render();
        return;
      }
      deps
        .fetchHarnesses()
        .then((list) => {
          harnesses = list;
          loaded = true;
          connected = true; // the daemon answered → it's reachable
          render();
        })
        .catch(() => {
          loaded = true;
          connected = false;
          render();
        });
    },
    setConnected(c: boolean): void {
      connected = c;
      const el = root.querySelector("[data-conn]");
      if (el) el.innerHTML = connectionHtml(c, deps.daemonUrl, !!deps.fetchHarnesses);
      else render();
    },
  };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
