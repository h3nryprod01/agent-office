import { vi } from "vitest";
import { fakeFetch, liveFrames, makeFakeWebSocket, sideFrames } from "./sensitiveDaemon";

// The shell index.html ships: every view mounts into one of these.
const SHELL = [
  "navbar", "app", "office-tabs", "controls", "timeline-bar", "queue-panel", "board", "orgchart", "building",
  "costs", "outputs", "hiring-hall", "templates", "side-panel", "kanban", "log", "settings",
].map((id) => `<div id="${id}"></div>`).join("");

const VIEWS = ["office", "kanban", "log", "costs", "settings"];
export const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** Everything a person could read or inspect: text, plus the attributes that render as text. */
export function visibleSurface(): string {
  const parts: string[] = [document.body.textContent ?? "", document.title];
  for (const el of Array.from(document.body.querySelectorAll("*"))) {
    for (const attr of ["title", "placeholder", "aria-label", "alt", "value", "href", "data-name", "data-repo", "data-agent"]) {
      const v = el.getAttribute(attr);
      if (v) parts.push(v);
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) parts.push(el.value);
  }
  return parts.join("\n");
}

/** Boots the real main.ts against the fake daemon. `search` is the page's query string. */
export async function bootApp(search: string): Promise<void> {
  const now = Date.now();
  document.body.innerHTML = SHELL;
  (window as unknown as { happyDOM: { setURL(u: string): void } }).happyDOM.setURL(`http://localhost:5173/${search}`);
  localStorage.clear();
  vi.stubGlobal("fetch", fakeFetch(now));
  vi.stubGlobal("WebSocket", makeFakeWebSocket(() => [...liveFrames(now), ...sideFrames(now)]));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  await import("../../src/main");
  await settle(80);
}

// Buttons that would reload the page or send something; everything else is fair game.
const SKIP = (b: HTMLElement): boolean =>
  b.classList.contains("set-lang") || b.classList.contains("send") || (b.textContent ?? "").includes("\u{1F3AD}");

/**
 * Visits every top-level view, then clicks every button the app has (panels,
 * overlays, tabs, rows) for a few rounds so lazily-built UI appears too,
 * collecting the visible surface after each step.
 */
export async function sweepEveryView(): Promise<string> {
  const seen: string[] = [visibleSurface()];
  for (const key of VIEWS) {
    document.querySelector<HTMLElement>(`#navbar [data-nav="${key}"]`)?.click();
    await settle(60);
    seen.push(visibleSurface());
  }
  // the activity log's Technical tab shows raw tool names and tool text
  document.querySelector<HTMLElement>('#navbar [data-nav="log"]')?.click();
  await settle(80);
  document.querySelector<HTMLElement>('#log [data-mode="tech"]')?.click();
  await settle(30);
  seen.push(visibleSurface());
  const clicked = new Set<HTMLElement>();
  for (let round = 0; round < 3; round++) {
    for (const b of Array.from(document.querySelectorAll<HTMLElement>("button, [data-agent], .floor, .row-toggle"))) {
      if (clicked.has(b) || SKIP(b)) continue;
      clicked.add(b);
      b.click();
      await settle(15);
      seen.push(visibleSurface());
    }
  }
  return seen.join("\n");
}
