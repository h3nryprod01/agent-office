/**
 * Shareable PNG of the wait report. buildShareModel() is pure and carries every
 * string the image will show, so a test can prove nothing unmasked reaches it;
 * drawShareCard() only paints that model. Project names are left out unless the
 * caller says they are safe (Present mode on: the summary arrived already aliased).
 */
import { t } from "../i18n";
import { fmtDuration, topByWait, type InterventionSummary, type Stat } from "./interventionStats";

export interface ShareModel {
  title: string;
  window: string;
  facts: Array<{ label: string; value: string }>;
  rows: Array<{ label: string; value: string }>;
  footer: string;
}

export function buildShareModel(summary: InterventionSummary, opts: { showProjects: boolean }): ShareModel {
  const days = summary.window.days;
  const facts = [
    { label: t("intervention.totalWait"), value: fmtDuration(summary.total.totalMs) },
    { label: t("intervention.median"), value: fmtDuration(summary.total.medianMs) },
    { label: t("intervention.p90"), value: fmtDuration(summary.total.p90Ms) },
    { label: "#", value: String(summary.total.count) },
  ];
  if (summary.longest) facts.push({ label: t("intervention.longest"), value: fmtDuration(summary.longest.durationMs) });
  const p = summary.permission;
  if (p && p.count > 0) facts.push({ label: t("intervention.declined"), value: `${Math.round(p.denyRate * 100)}%` });
  if (typeof summary.autoApproved === "number") facts.push({ label: t("intervention.autoApproved"), value: String(summary.autoApproved) });
  const line = ([name, s]: [string, Stat]): { label: string; value: string } => ({
    label: name,
    value: `${fmtDuration(s.totalMs)} · ${t("intervention.count", { n: s.count })}`,
  });
  const rows = [
    ...(opts.showProjects ? topByWait(Object.entries(summary.byProject ?? {}), 4).map(line) : []),
    ...topByWait((summary.byHarness ?? []).map(({ harness, ...s }): [string, Stat] => [harness, s]), 3).map(line),
  ];
  return {
    title: t("intervention.title"),
    window: `${summary.window.from} → ${summary.window.to} · ${t("intervention.windowDays", { n: days })}`,
    facts,
    rows,
    footer: t("intervention.shareFooter"),
  };
}

export const shareFileName = (summary: InterventionSummary): string =>
  `agent-wait-${summary.window.from}_${summary.window.to}.png`;

export function drawShareCard(ctx: CanvasRenderingContext2D, m: ShareModel, w: number, h: number): void {
  ctx.fillStyle = "#0f172a";
  ctx.fillRect(0, 0, w, h);
  ctx.textBaseline = "top";
  ctx.fillStyle = "#f8fafc";
  ctx.font = "600 44px system-ui, sans-serif";
  ctx.fillText(m.title, 60, 50);
  ctx.fillStyle = "#94a3b8";
  ctx.font = "26px system-ui, sans-serif";
  ctx.fillText(m.window, 60, 108);

  const colW = (w - 120) / 4;
  m.facts.forEach((f, i) => {
    const x = 60 + (i % 4) * colW;
    const y = 170 + Math.floor(i / 4) * 130;
    ctx.fillStyle = "#f8fafc";
    ctx.font = "600 54px system-ui, sans-serif";
    ctx.fillText(f.value, x, y);
    ctx.fillStyle = "#94a3b8";
    ctx.font = "24px system-ui, sans-serif";
    ctx.fillText(f.label, x, y + 66);
  });

  ctx.font = "28px system-ui, sans-serif";
  const rowTop = 440;
  m.rows.slice(0, 6).forEach((r, i) => {
    const x = 60 + (i % 2) * ((w - 120) / 2);
    const y = rowTop + Math.floor(i / 2) * 44;
    ctx.fillStyle = "#cbd5e1";
    ctx.fillText(r.label, x, y);
    ctx.fillStyle = "#f8fafc";
    ctx.fillText(r.value, x + 260, y);
  });

  ctx.fillStyle = "#64748b";
  ctx.font = "22px system-ui, sans-serif";
  ctx.fillText(m.footer, 60, h - 44);
}

/** Paint the model to a canvas and hand the PNG to the browser as a download. */
export function downloadShareImage(summary: InterventionSummary, opts: { showProjects: boolean }): void {
  const canvas = document.createElement("canvas");
  canvas.width = 1200;
  canvas.height = 630;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  drawShareCard(ctx, buildShareModel(summary, opts), canvas.width, canvas.height);
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = shareFileName(summary);
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, "image/png");
}
