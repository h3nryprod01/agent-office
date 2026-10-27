import { t } from "../i18n";
import type { ReplayView } from "../ui/timelineBar";

/**
 * ?clean=1 — a full-bleed office with a small HUD, for recording the launch
 * timelapse: panels and chat are hidden by CSS (body[data-clean]) and this
 * draws the replay's own clock and head-count.
 */
export function mountCleanHud(getView: () => ReplayView | null): void {
  if (typeof location === "undefined" || new URLSearchParams(location.search).get("clean") !== "1") return;
  document.body.dataset.clean = "on";
  const el = document.createElement("div");
  el.id = "clean-hud";
  document.body.append(el);
  const caption = document.createElement("div");
  caption.id = "clean-caption";
  caption.textContent = t("hud.caption");
  document.body.append(caption);
  // the replay's own range lives on the (hidden) scrubber — no need to thread it through main.ts
  const startMs = (): number => Number(document.querySelector<HTMLInputElement>("#rp-scrub")?.min ?? 0);
  setInterval(() => {
    const v = getView();
    if (!v) {
      el.textContent = "";
      return;
    }
    const elapsedMin = Math.max(0, Math.round((v.now - startMs()) / 60_000));
    const agents = [...v.state.agents.values()];
    const working = agents.filter((a) => a.status === "working" || a.status === "reading" || a.status === "running_command").length;
    el.innerHTML =
      `<b>${t("hud.clock", { h: Math.floor(elapsedMin / 60), m: String(elapsedMin % 60).padStart(2, "0") })}</b>` +
      `<span>${t("hud.agents", { n: agents.length })}</span><span>${t("hud.working", { n: working })}</span>`;
  }, 200);
}
