/**
 * Time-to-intervene panel (lane L4): how long agents waited on a human over the
 * last 7 or 30 days — median, p90, how many times, total, longest, decline rate,
 * split by project and agent. Fed by the daemon's GET /metrics/intervention
 * (daemon/src/intervention-metrics.js). The PNG export lives in waitShare.ts.
 * HTML builders are pure so they unit-test without a browser.
 */
import { t, type Key } from "../i18n";

export interface Stat {
  count: number;
  medianMs: number;
  p90Ms: number;
  totalMs: number;
}

/** Every field after `byKind` is new in the report; an older daemon omits them and the card copes. */
export interface InterventionSummary {
  window: { from: string; to: string; days: number };
  total: Stat;
  byKind: Record<string, Stat>;
  longest?: { durationMs: number; kind: string; project: string; harness: string; endTs: number } | null;
  permission?: { count: number; denied: number; denyRate: number };
  autoApproved?: number | null;
  /** false = nothing was ever recorded; undefined (older daemon) is treated as a quiet window */
  anyRecords?: boolean;
  byProject?: Record<string, Stat>;
  byHarness?: Array<Stat & { harness: string }>;
}

const KIND_ORDER = ["waiting_permission", "blocked", "error"] as const;
const PERIODS = [7, 30] as const;
const TOP_ROWS = 3;
const REFRESH_MS = 60_000;

/** "42s", "3m 05s", "1h 23m". */
export function fmtDuration(ms: number): string {
  if (ms <= 0) return "0s";
  if (ms < 1000) return "<1s";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const pad = (n: number): string => String(n).padStart(2, "0");
  if (s < 3600) return `${Math.floor(s / 60)}m ${pad(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${pad(Math.floor((s % 3600) / 60))}m`;
}

export const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/** Largest total wait first; the report is about where time went. */
export function topByWait<T extends Stat>(rows: Array<[string, T]>, n = TOP_ROWS): Array<[string, T]> {
  return [...rows].sort((a, b) => b[1].totalMs - a[1].totalMs).slice(0, n);
}

const statLine = (s: Stat): string =>
  `<b>${fmtDuration(s.medianMs)}</b> ${t("intervention.median")} · <b>${fmtDuration(s.p90Ms)}</b> ${t("intervention.p90")} · <b>${t("intervention.count", { n: s.count })}</b>`;

const rowsHtml = (title: string, rows: Array<[string, Stat]>): string =>
  rows.length === 0
    ? ""
    : `<h3>${title}</h3><ul class="iv-rows">${rows
        .map(([name, s]) => `<li><span class="iv-kind">${escapeHtml(name)}</span> <b>${fmtDuration(s.totalMs)}</b> · ${t("intervention.count", { n: s.count })}</li>`)
        .join("")}</ul>`;

export function interventionStatsHtml(summary: InterventionSummary): string {
  const days = summary.window.days;
  const head = `<h2>${t("intervention.title")} <small>${t("intervention.windowDays", { n: days })}</small></h2>`;
  const controls = `<div class="iv-actions">${PERIODS.map(
    (n) => `<button type="button" data-days="${n}"${n === days ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"'}>${t("intervention.days", { n })}</button>`,
  ).join("")}<button type="button" class="iv-share" title="${escapeHtml(t("intervention.shareTitle"))}">${t("intervention.share")}</button></div>`;
  if (summary.total.count === 0) {
    const why = summary.anyRecords === false ? t("intervention.emptyHook") : t("intervention.emptyWindow", { n: days });
    return `${head}<p class="iv-empty">${why}</p>${controls}`;
  }
  const kinds = KIND_ORDER.filter((k) => (summary.byKind[k]?.count ?? 0) > 0)
    .map((k) => `<li><span class="iv-kind">${t(`intervention.kind.${k}` as Key)}</span> ${statLine(summary.byKind[k])}</li>`)
    .join("");
  const facts: string[] = [`${t("intervention.totalWait")} <b>${fmtDuration(summary.total.totalMs)}</b>`];
  if (summary.longest) facts.push(`${t("intervention.longest")} <b>${fmtDuration(summary.longest.durationMs)}</b>`);
  const p = summary.permission;
  if (p && p.count > 0) facts.push(`${t("intervention.declined")} <b>${Math.round(p.denyRate * 100)}%</b>`);
  if (typeof summary.autoApproved === "number") facts.push(`${t("intervention.autoApproved")} <b>${summary.autoApproved}</b>`);
  return [
    head,
    `<p class="iv-total">${statLine(summary.total)}</p>`,
    `<p class="iv-facts">${facts.join(" · ")}</p>`,
    `<ul class="iv-kinds">${kinds}</ul>`,
    rowsHtml(t("intervention.byProject"), topByWait(Object.entries(summary.byProject ?? {}))),
    rowsHtml(t("intervention.byHarness"), topByWait((summary.byHarness ?? []).map(({ harness, ...s }): [string, Stat] => [harness, s]))),
    controls,
  ].join("");
}

/** Mount the panel; refreshes itself every minute. Returns a stop function. */
export function mountInterventionStats(
  root: HTMLElement,
  fetchSummary: (days: number) => Promise<InterventionSummary>,
  onShare?: (summary: InterventionSummary) => void,
): () => void {
  root.classList.add("iv-panel");
  root.hidden = true;
  let days: number = PERIODS[0];
  let last: InterventionSummary | null = null;
  const refresh = (): void => {
    fetchSummary(days)
      .then((s) => {
        last = s;
        root.innerHTML = interventionStatsHtml(s);
        root.hidden = false;
      })
      .catch(() => {
        // daemon offline or too old to know the endpoint: stay hidden, never throw
      });
  };
  root.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement | null)?.closest?.("button");
    if (!btn) return;
    if (btn.dataset.days) {
      days = Number(btn.dataset.days);
      refresh();
    } else if (btn.classList.contains("iv-share") && last) onShare?.(last);
  });
  refresh();
  const timer = setInterval(refresh, REFRESH_MS);
  return () => clearInterval(timer);
}
