/**
 * Time-to-intervene panel (lane L4): how long agents waited on a human in the
 * last 7 days — median, p90 and how many times. Fed by the daemon's
 * GET /metrics/intervention (daemon/src/intervention-metrics.js).
 * HTML builders are pure so they unit-test without a browser.
 */
import { t, type Key } from "../i18n";

interface Stat {
  count: number;
  medianMs: number;
  p90Ms: number;
  totalMs: number;
}

export interface InterventionSummary {
  window: { from: string; to: string; days: number };
  total: Stat;
  byKind: Record<string, Stat>;
}

const KIND_ORDER = ["waiting_permission", "blocked", "error"] as const;
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

const statLine = (s: Stat): string =>
  `<b>${fmtDuration(s.medianMs)}</b> ${t("intervention.median")} · <b>${fmtDuration(s.p90Ms)}</b> ${t("intervention.p90")} · <b>${t("intervention.count", { n: s.count })}</b>`;

export function interventionStatsHtml(summary: InterventionSummary): string {
  const head = `<h2>${t("intervention.title")} <small>${t("intervention.window")}</small></h2>`;
  if (summary.total.count === 0) return `${head}<p class="iv-empty">${t("intervention.empty")}</p>`;
  const rows = KIND_ORDER.filter((k) => (summary.byKind[k]?.count ?? 0) > 0)
    .map((k) => `<li><span class="iv-kind">${t(`intervention.kind.${k}` as Key)}</span> ${statLine(summary.byKind[k])}</li>`)
    .join("");
  return `${head}<p class="iv-total">${statLine(summary.total)}</p><ul class="iv-kinds">${rows}</ul>`;
}

/** Mount the panel; refreshes itself every minute. Returns a stop function. */
export function mountInterventionStats(
  root: HTMLElement,
  fetchSummary: () => Promise<InterventionSummary>,
): () => void {
  root.classList.add("iv-panel");
  root.hidden = true;
  const refresh = (): void => {
    fetchSummary()
      .then((s) => {
        root.innerHTML = interventionStatsHtml(s);
        root.hidden = false;
      })
      .catch(() => {
        // daemon offline or too old to know the endpoint: stay hidden, never throw
      });
  };
  refresh();
  const timer = setInterval(refresh, REFRESH_MS);
  return () => clearInterval(timer);
}
