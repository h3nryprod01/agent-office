import { t } from "../i18n";
import { isPresentationMode, setPresentationMode } from "./install";

/** 🎭 button in the controls bar. Flipping it reloads the page (see install.ts). */
export function mountPresentationToggle(root: HTMLElement): void {
  const on = isPresentationMode();
  const btn = document.createElement("button");
  btn.textContent = on ? t("present.on") : t("present.off");
  btn.title = t("present.title");
  btn.classList.toggle("sfx-on", on);
  btn.addEventListener("click", () => setPresentationMode(!on));
  root.append(btn);

  if (on) {
    const badge = document.createElement("div");
    badge.id = "present-badge";
    badge.textContent = t("present.badge");
    document.body.append(badge);
  }
}
