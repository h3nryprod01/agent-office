// "Bảng lương" panel (wi-cost-dashboard): toggle button top-right, tables
// per-repo / per-agent / per-day with plain-div bars, window selector
// 24h/7d/30d. Plain DOM like the other Mission Control panels, no chart
// library. HTML builders are pure string functions so they unit-test
// without a browser.

import type { WorkItem, WorkItemsFile } from "./workItems";

export type CostWindow = "24h" | "7d" | "30d";
export const COST_WINDOWS: CostWindow[] = ["24h", "7d", "30d"];

interface CostRow {
  usd: number;
  tokens: number;
}

export interface CostsPayload {
  window: CostWindow;
  totalUsd: number;
  tokensTotal: number;
  tokens: { input: number; output: number; cacheWrite: number; cacheRead: number };
  byRepo: (CostRow & { repo: string })[];
  byAgent: (CostRow & { sessionId: string; repo: string; harness?: string })[];
  byDay: (CostRow & { day: string })[];
  /** claude-code / codex / gemini. Absent while a pre-multiharness daemon is still running. */
  byHarness?: (CostRow & { harness: string })[];
  unknownModels: { model: string; tokens: number }[];
  /** Budget guard (Feature C). Absent while a pre-budget daemon runs. */
  budgetUsd?: number | null;
  overBudget?: boolean;
}

/** "$12.34" above a dollar, more precision below so small sessions aren't all "$0.00". */
export function fmtUsd(usd: number): string {
  return `$${usd >= 1 ? usd.toFixed(2) : usd.toFixed(3)}`;
}

/** "1.2M" / "34k" / "512" */
export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

/**
 * One table of rows with a proportional bar. Bars scale on USD when any row
 * has a price, otherwise on tokens (e.g. all-unknown-model windows).
 */
export function costTableHtml(
  title: string,
  rows: (CostRow & { label: string })[],
): string {
  if (rows.length === 0) return "";
  const byUsd = rows.some((r) => r.usd > 0);
  const max = Math.max(...rows.map((r) => (byUsd ? r.usd : r.tokens)), 1e-9);
  const lines = rows
    .map((r) => {
      const pct = Math.max(2, Math.round(((byUsd ? r.usd : r.tokens) / max) * 100));
      return `<tr>
        <td class="cost-label" title="${esc(r.label)}">${esc(r.label)}</td>
        <td class="cost-bar-cell"><div class="cost-bar" style="width:${pct}%"></div></td>
        <td class="cost-num">${fmtUsd(r.usd)}</td>
        <td class="cost-num cost-dim">${fmtTokens(r.tokens)}</td>
      </tr>`;
    })
    .join("");
  return `<h3>${esc(title)}</h3><table class="cost-table">${lines}</table>`;
}

/** Agent label: registry assignee for the session if known, else short session id. */
export function agentLabel(sessionId: string, items: WorkItem[]): string {
  const item = items.find((it) => it.sessionId === sessionId);
  return item?.assignee || item?.title || sessionId.slice(0, 8);
}

export function costsPanelHtml(data: CostsPayload, workItems: WorkItem[]): string {
  const windows = COST_WINDOWS.map(
    (w) =>
      `<button class="cost-window${w === data.window ? " active" : ""}" data-window="${w}">${w}</button>`,
  ).join("");
  const unknown =
    data.unknownModels.length > 0
      ? `<p class="cost-unknown">⚠ Model chưa có giá (tokens tính, USD = 0): ${data.unknownModels
          .map((u) => `${esc(u.model)} (${fmtTokens(u.tokens)})`)
          .join(", ")}</p>`
      : "";
  const budget =
    data.overBudget && data.budgetUsd
      ? `<p class="cost-overbudget">⚠ Vượt ngân sách: ${fmtUsd(data.totalUsd)} / ${fmtUsd(data.budgetUsd)}. Yêu cầu cần duyệt sẽ chờ bạn duyệt vượt.</p>`
      : "";
  return `
    <div class="cost-head">${windows}</div>
    <p class="cost-total">${fmtUsd(data.totalUsd)} · ${fmtTokens(data.tokensTotal)} tokens
      <span class="cost-dim">(in ${fmtTokens(data.tokens.input)} · out ${fmtTokens(data.tokens.output)} · cache w ${fmtTokens(data.tokens.cacheWrite)} / r ${fmtTokens(data.tokens.cacheRead)})</span></p>
    ${unknown}
    ${budget}
    ${costTableHtml("Theo harness", (data.byHarness ?? []).map((r) => ({ ...r, label: r.harness })))}
    ${costTableHtml("Theo repo", data.byRepo.map((r) => ({ ...r, label: r.repo })))}
    ${costTableHtml("Theo agent", data.byAgent.map((r) => ({ ...r, label: agentLabel(r.sessionId, workItems) })))}
    ${costTableHtml("Theo ngày", data.byDay.map((r) => ({ ...r, label: r.day })))}
  `;
}

export function mountCosts(
  root: HTMLElement,
  fetchCosts?: (window: CostWindow) => Promise<CostsPayload>,
  fetchWorkItems?: () => Promise<WorkItemsFile>,
): { expand: () => void } {
  if (!fetchCosts) {
    // `root.hidden = true` was right when #costs was a corner widget in the
    // office: no daemon, no widget. R13-B promoted it to a nav tab, and a hidden
    // tab is a blank screen — the 💰 click landed on nothing at all. Say what
    // Bảng việc and Nhật ký say instead.
    root.innerHTML = `<p class="costs-placeholder">Chi phí chỉ có ở live mode.</p>`;
    return { expand: () => {} };
  }
  root.classList.add("costs");
  let open = false;
  let selectedWindow: CostWindow = "24h";
  let data: CostsPayload | null = null;
  let workItems: WorkItem[] = [];

  function render(): void {
    const label = data
      ? `${data.overBudget ? "⚠ " : ""}Chi phí · ${fmtUsd(data.totalUsd)}`
      : "Chi phí";
    const header = `<button class="costs-toggle">${label}</button>`;
    const body = open
      ? `<div class="costs-panel">${data ? costsPanelHtml(data, workItems) : `<p class="placeholder">Đang tải…</p>`}</div>`
      : "";
    root.innerHTML = header + body;
  }

  function refresh(): void {
    fetchCosts!(selectedWindow)
      .then((payload) => {
        data = payload;
        render();
      })
      .catch(() => {
        /* daemon unreachable — keep last known numbers */
      });
    fetchWorkItems?.()
      .then((file) => {
        workItems = file.items;
        if (open) render();
      })
      .catch(() => {});
  }

  root.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    const win = target.closest<HTMLElement>(".cost-window")?.dataset.window as CostWindow | undefined;
    if (win) {
      selectedWindow = win;
      refresh();
      return;
    }
    if (!target.closest(".costs-toggle")) return;
    open = !open;
    render();
    if (open) refresh();
  });

  // R13-B: the "Chi phí" nav view forces the panel open + full-width (CSS) so
  // clicking it lands on the dashboard, not a lone toggle pill in the corner.
  function expand(): void {
    if (!open) {
      open = true;
      render();
    }
    refresh();
  }

  render();
  refresh();
  return { expand };
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
