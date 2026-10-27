// lane L2: shared wording for approval modes and the "why was I asked" reasons.
// Kept apart from the panel so the intervention queue and the office tabs can use
// it without pulling the whole Settings panel in.

import { t, type Key } from "../i18n";

export type PolicyMode = "ask" | "auto" | "read-only" | "deny";
export const POLICY_MODES: readonly PolicyMode[] = ["ask", "auto", "read-only", "deny"];

export const isPolicyMode = (v: unknown): v is PolicyMode => POLICY_MODES.includes(v as PolicyMode);

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** t() with a visible fallback to the raw code for values this build has no wording for. */
function label(key: string, fallback: string): string {
  const text = t(key as Key);
  return text === key ? fallback : text;
}

export const modeLabel = (mode: string): string => label(`policy.mode.${mode}`, mode);
export const reasonLabel = (code: string): string => label(`policy.reason.${code}`, code);

/** "risky action: force push, secret file" — what a forced ask says about itself. */
export function whyText(forced: string | null | undefined, reasons: readonly string[] = []): string {
  const head = forced ? label(`policy.forced.${forced}`, forced) : "";
  const detail = reasons.map(reasonLabel).join(", ");
  return [head, detail].filter(Boolean).join(": ");
}

/** Small coloured chip: the mode a project (or an audit row) ran under. */
export function modeBadgeHtml(mode: string): string {
  const known = isPolicyMode(mode) ? mode : "ask";
  return `<span class="policy-badge mode-${known}" title="${esc(modeLabel(mode))}">${esc(modeLabel(mode))}</span>`;
}
