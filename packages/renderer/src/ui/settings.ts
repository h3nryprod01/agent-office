// R13-B: "Cấu hình" view — a real status/diagnostics screen (was a placeholder).
// Shows the two things a solo operator actually needs to self-diagnose: is the
// daemon connected, and which agent CLIs (Claude Code / Codex / Gemini) the app
// can see + are logged in. Plain DOM; the HTML builders are pure so they
// unit-test without a browser. The harness list is live-mode only (needs the
// daemon); mock shows a note.

import { getLang, setLang, t, type Lang } from "../i18n";
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
  if (!live) return `<span class="set-chip muted">${t("settings.mockMode")}</span>`;
  return connected
    ? `<span class="set-chip ok">${t("settings.connected")}</span>`
    : `<span class="set-chip off">${t("settings.disconnected", { url: esc(daemonUrl) })}</span>`;
}

/** One harness row: installed + login chips, and a "Kiểm tra" button if installed. Pure. */
export function harnessRowHtml(h: HarnessStatus): string {
  const installed = h.installed
    ? `<span class="set-chip ok">${t("settings.installed")}</span>`
    : `<span class="set-chip off">${t("settings.notInstalled")}</span>`;
  let login = "";
  if (h.installed) {
    login =
      h.loggedIn === true
        ? `<span class="set-chip ok">${t("settings.loggedIn")}</span>`
        : h.loggedIn === false
          ? `<span class="set-chip warn">${esc(h.reason || t("settings.notLoggedIn"))}</span>`
          : `<span class="set-chip muted">${t("settings.notChecked")}</span>`;
  }
  const probe = h.installed
    ? `<button class="set-probe" type="button" data-probe="${esc(h.key)}">${t("settings.check")}</button>`
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
      ? `<p class="set-note">${t("settings.sourcesLiveOnly")}</p>`
      : loaded
        ? harnesses.map(harnessRowHtml).join("")
        : `<p class="set-note">${t("settings.checking")}</p>`;
    root.innerHTML =
      `<h1 class="set-title">${t("nav.settings")}</h1>` +
      `<section class="set-block"><h2>${t("settings.connection")}</h2>` +
      `<div class="set-row"><span class="set-row-label">Daemon · ws://${esc(deps.daemonUrl)}</span>` +
      `<span class="set-row-chips" data-conn>${connectionHtml(connected, deps.daemonUrl, !!deps.fetchHarnesses)}</span></div>` +
      `</section>` +
      `<section class="set-block"><h2>${t("settings.agentSources")}</h2>` +
      `<p class="set-hint">${t("settings.sourcesHint")}</p>` +
      harnessBody +
      `</section>` +
      `<section class="set-block"><h2>${t("settings.language")}</h2>` +
      `<div class="set-row"><span class="set-row-chips">` +
      langButton("en", "English") +
      langButton("vi", "Tiếng Việt") +
      `</span></div>` +
      `<p class="set-hint">${t("settings.languageHint")}</p>` +
      `</section>` +
      `<section class="set-block"><h2>${t("settings.about")}</h2>` +
      `<p class="set-about">${t("settings.aboutText")}</p>` +
      `</section>`;
  }

  function langButton(lang: Lang, label: string): string {
    const active = getLang() === lang ? " active" : "";
    return `<button class="set-lang${active}" type="button" data-lang="${lang}" aria-pressed="${!!active}">${label}</button>`;
  }

  root.addEventListener("click", (ev) => {
    const langBtn = (ev.target as HTMLElement).closest<HTMLElement>("[data-lang]");
    if (langBtn) {
      const lang = langBtn.dataset.lang as Lang;
      if (lang !== getLang()) {
        setLang(lang);
        // Every rendered string was read at render time; a reload is simpler and
        // more honest than re-rendering panels that may not be mounted right now.
        location.reload();
      }
      return;
    }

    const btn = (ev.target as HTMLElement).closest<HTMLElement>("[data-probe]");
    if (!btn || !deps.probeHarness) return;
    btn.textContent = t("settings.checking");
    (btn as HTMLButtonElement).disabled = true;
    deps
      .probeHarness(btn.dataset.probe!)
      .then((list) => {
        harnesses = list;
        loaded = true;
        render();
      })
      .catch(() => {
        btn.textContent = t("settings.checkFailed");
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
