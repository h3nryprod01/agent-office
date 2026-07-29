import { t } from "../i18n";
import { statusLabel, type AgentModel, type OfficeState, type TimelineEntry } from "../sim/model";
import { toBusiness } from "./activityLog";
import { formatSince } from "../sim/selectors";
import { workItemSectionHtml, type WorkItem, type WorkItemsFile } from "./workItems";

/** One transcript line from the daemon's GET /transcript endpoint. */
export interface TranscriptLine {
  ts: number;
  role: "assistant" | "tool";
  text: string;
  tool?: string;
}

/** "Xem thêm" progression for GET /transcript?limit= (wi-office-life — read the full backlog without leaving the office). */
const TRANSCRIPT_LIMIT_TIERS = [20, 100, 500];

/**
 * Mission Control side panel: everything about one agent, denser than the
 * in-canvas badges. Plain DOM on purpose (like controls.ts) — text-heavy UI
 * is cheaper and more accessible outside the Pixi canvas.
 */
export interface SidePanel {
  show(agentId: string): void;
  hide(): void;
  /**
   * Re-render from the latest sim state (call on a timer, ~2-4 Hz).
   * `now` defaults to wall clock; replay passes its virtual clock so the
   * "đã bao lâu" readouts stay on the recording's time axis.
   */
  render(state: OfficeState, now?: number): void;
}

/**
 * @param fetchTranscript optional — fetch last-N transcript lines for a
 *   session. Passed only in live (?ws=1) mode; mock mode leaves the panel's
 *   transcript section as a placeholder.
 */
/**
 * @param pmResume optional (wi-pm-ux) — returns the `claude --resume` hand-over
 *   command when the agent is a pinned PM character, null otherwise.
 */
export function mountSidePanel(
  root: HTMLElement,
  fetchTranscript?: (sessionId: string, limit: number) => Promise<TranscriptLine[]>,
  fetchWorkItems?: () => Promise<WorkItemsFile>,
  pmResume?: (a: AgentModel) => string | null,
): SidePanel {
  let selectedId: string | null = null;
  // Transcript is fetched once per selection (and again when the limit grows
  // via "Xem thêm"), async; null = not loaded yet.
  let transcript: TranscriptLine[] | null = null;
  let transcriptFor: string | null = null;
  let transcriptLimit = TRANSCRIPT_LIMIT_TIERS[0];
  let transcriptFetchedLimit = 0;
  // Work registry: refetched every time the panel opens (show()), no polling.
  let workItems: WorkItem[] | null = null;
  let workItemsFor: string | null = null;
  // See-more (wi-office-life): entries/lines the user expanded, by ts. Two
  // separate sets — timeline and transcript can share ts values for the same
  // underlying event, and must not cross-toggle each other.
  const expandedTimeline = new Set<number>();
  const expandedTranscript = new Set<number>();
  // Signature of the last-rendered content: the DOM is only replaced when
  // something actually changed — the "since" counter ticks in place — so a
  // click can't land on a node a timer render just detached.
  let lastSig = "";

  root.classList.add("side-panel");
  root.addEventListener("click", (ev) => {
    const target = ev.target as HTMLElement;
    if (target.closest("[data-close]")) {
      selectedId = null;
      lastSig = "";
      root.hidden = true;
      document.body.classList.remove("side-panel-open");
      return;
    }
    const copyBtn = target.closest<HTMLElement>("[data-copy]");
    if (copyBtn?.dataset.copy) {
      navigator.clipboard
        .writeText(copyBtn.dataset.copy)
        .then(() => {
          copyBtn.textContent = t("panel.copied");
        })
        .catch(() => {
          copyBtn.textContent = t("panel.copyManually");
        });
      return;
    }
    const timelineToggle = target.closest<HTMLElement>("[data-toggle-timeline-ts]");
    if (timelineToggle?.dataset.toggleTimelineTs) {
      const ts = Number(timelineToggle.dataset.toggleTimelineTs);
      if (expandedTimeline.has(ts)) expandedTimeline.delete(ts);
      else expandedTimeline.add(ts);
      lastSig = "";
      return;
    }
    const transcriptToggle = target.closest<HTMLElement>("[data-toggle-transcript-ts]");
    if (transcriptToggle?.dataset.toggleTranscriptTs) {
      const ts = Number(transcriptToggle.dataset.toggleTranscriptTs);
      if (expandedTranscript.has(ts)) expandedTranscript.delete(ts);
      else expandedTranscript.add(ts);
      lastSig = "";
      return;
    }
    if (target.closest("[data-more-transcript]")) {
      const idx = TRANSCRIPT_LIMIT_TIERS.indexOf(transcriptLimit);
      transcriptLimit = TRANSCRIPT_LIMIT_TIERS[Math.min(idx + 1, TRANSCRIPT_LIMIT_TIERS.length - 1)];
      lastSig = ""; // render() picks up transcriptLimit !== transcriptFetchedLimit and refetches
    }
  });
  root.hidden = true;

  function render(state: OfficeState, now: number = Date.now()): void {
    if (!selectedId) return;
    const agent = state.agents.get(selectedId);
    if (!agent) {
      root.innerHTML = `<header><h2>${t("panel.agentGone")}</h2><button data-close>×</button></header>`;
      lastSig = "gone";
      return;
    }

    // Fetch transcript when the selection changes OR "Xem thêm" grew the
    // limit (mark first to avoid a refetch storm from the 4 Hz render timer).
    if (fetchTranscript && (transcriptFor !== agent.agentId || transcriptFetchedLimit !== transcriptLimit)) {
      transcriptFor = agent.agentId;
      const limit = transcriptLimit;
      transcriptFetchedLimit = limit;
      transcript = null;
      fetchTranscript(agent.sessionId, limit)
        .then((lines) => {
          if (transcriptFor === agent.agentId && transcriptLimit === limit) {
            transcript = lines;
            lastSig = ""; // force a re-render now that the lines are in
          }
        })
        .catch(() => {
          /* daemon unreachable — leave the loading note, no crash */
        });
    }

    if (fetchWorkItems && workItemsFor !== agent.agentId) {
      workItemsFor = agent.agentId;
      workItems = null;
      fetchWorkItems()
        .then((file) => {
          if (workItemsFor === agent.agentId) {
            workItems = file.items;
            lastSig = "";
          }
        })
        .catch(() => {
          /* daemon unreachable — leave the loading note, no crash */
        });
    }

    const workItemSection = fetchWorkItems
      ? workItemSectionHtml(agent, workItems)
      : workItemSectionHtml(agent, undefined);
    const resumeCmd = pmResume?.(agent) ?? null;

    const sig = [
      agent.agentId,
      agent.status,
      agent.statusDetail,
      agent.currentTool,
      agent.timeline.length,
      transcript?.length ?? -1,
      workItemSection,
      resumeCmd,
    ].join(" ");
    if (sig !== lastSig) {
      lastSig = sig;
      root.innerHTML = panelHtml(
        agent,
        now,
        workItemSection,
        fetchTranscript ? transcript : undefined,
        resumeCmd,
        expandedTimeline,
        expandedTranscript,
        transcriptLimit,
      );
    }
    const since = root.querySelector("[data-since]");
    if (since) since.textContent = formatSince(agent.statusSince, now);
  }

  return {
    show(agentId: string): void {
      if (selectedId !== agentId) {
        lastSig = "";
        transcriptLimit = TRANSCRIPT_LIMIT_TIERS[0];
        expandedTimeline.clear();
        expandedTranscript.clear();
      }
      selectedId = agentId;
      // Force a registry refetch on every open — links go stale as agents
      // fill in pr/planeUrl, and opening the panel is the natural refresh.
      workItemsFor = null;
      root.hidden = false;
      document.body.classList.add("side-panel-open");
    },
    hide(): void {
      selectedId = null;
      lastSig = "";
      root.hidden = true;
      document.body.classList.remove("side-panel-open");
    },
    render,
  };
}

/**
 * @param transcript undefined = mock mode (show placeholder); null = live
 *   mode, still loading; array = loaded lines.
 */
function panelHtml(
  a: AgentModel,
  now: number,
  workItemSection: string,
  transcript: TranscriptLine[] | null | undefined,
  resumeCmd: string | null | undefined,
  expandedTimeline: ReadonlySet<number>,
  expandedTranscript: ReadonlySet<number>,
  transcriptLimit: number,
): string {
  const rows = [
    ...(resumeCmd
      ? [
          [
            t("panel.resumeInClaude"),
            `<code>${esc(resumeCmd)}</code> <button data-copy="${esc(resumeCmd)}" title="${t("panel.resumeCopyTitle")}">copy</button>`,
          ],
        ]
      : []),
    [t("panel.status"), `<span class="status-chip status-${a.status}">${esc(statusLabel(a.status))}</span> · <span data-since>${formatSince(a.statusSince, now)}</span>`],
    [t("panel.detail"), a.statusDetail ? esc(a.statusDetail) : "—"],
    [t("wall.inProgress"), a.currentTool ? esc(toBusiness({ tool: a.currentTool })) : "—"],
    [t("panel.cwd"), a.cwd ? `<code>${esc(a.cwd)}</code>` : "—"],
    [t("panel.session"), `<code>${esc(shorten(a.sessionId))}</code>`],
    [t("panel.reportsTo"), `<code>${esc(shorten(a.agentId))}</code>${a.parentId ? ` · thuộc <code>${esc(shorten(a.parentId))}</code>` : t("panel.topLevel")}`],
  ]
    .map(([k, v]) => `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`)
    .join("");

  return `
    <header>
      <h2>${esc(a.name)}${a.role ? ` <small>· ${esc(a.role)}</small>` : ""}</h2>
      <button data-close title="${t("panel.close")}">×</button>
    </header>
    ${rows}
    <h3>Work item</h3>
    ${workItemSection}
    <h3>${t("panel.recentActivity")}</h3>
    <ul class="timeline">${timelineHtml(a.timeline, expandedTimeline)}</ul>
    <h3>Transcript</h3>
    ${transcriptHtml(transcript, expandedTranscript, transcriptLimit)}
  `;
}

/**
 * "Hoạt động gần nhất": each entry clips to a couple of lines by default
 * (CSS .row-text) with a ▸/▾ toggle to show the full, untruncated text the
 * daemon sent (wi-office-life — never need to go back to the CLI to read the
 * rest). `expanded` holds the entry.ts values the user opened.
 */
/** De-jargon a timeline entry for non-tech readers: raw statuses + tool names
 *  become plain Vietnamese; assistant messages stay as written. Pure. Exported
 *  for tests. */
export function timelineLabel(t: TimelineEntry): string {
  if (t.kind === "status" && t.status) return statusLabel(t.status);
  if ((t.kind === "tool" || t.kind === "result") && t.tool) {
    const mark = t.kind === "result" ? (t.text.startsWith("✗") ? "✗ " : "✓ ") : "";
    return mark + toBusiness({ tool: t.tool, text: t.text });
  }
  return t.text;
}

export function timelineHtml(entries: readonly TimelineEntry[], expanded: ReadonlySet<number>): string {
  if (entries.length === 0) return `<li>${t("panel.noActivity")}</li>`;
  return [...entries]
    .reverse()
    .map((t) => rowHtml(`tl-${t.kind}`, t.ts, expanded.has(t.ts), "data-toggle-timeline-ts", timelineLabel(t)))
    .join("");
}

/**
 * @param transcript undefined = mock mode (show placeholder); null = live
 *   mode, still loading; array = loaded lines.
 */
export function transcriptHtml(
  transcript: TranscriptLine[] | null | undefined,
  expanded: ReadonlySet<number>,
  limit: number,
): string {
  if (transcript === undefined) {
    return `<p class="placeholder">${t("panel.transcriptLiveOnly")}</p>`;
  }
  if (transcript === null) {
    return `<p class="placeholder">${t("panel.loading")}</p>`;
  }
  if (transcript.length === 0) {
    return `<p class="placeholder">${t("panel.noMessages")}</p>`;
  }
  const lines = transcript
    .map((t) =>
      rowHtml(
        `tl-${t.role}`,
        t.ts,
        expanded.has(t.ts),
        "data-toggle-transcript-ts",
        t.text ?? "",
        t.tool ? `<code>${esc(t.tool)}</code> ` : "",
      ),
    )
    .join("");
  // fewer lines than asked for = the daemon's buffer is exhausted, more
  // "Xem thêm" clicks would return the exact same thing
  const nextTier = TRANSCRIPT_LIMIT_TIERS[TRANSCRIPT_LIMIT_TIERS.indexOf(limit) + 1];
  const moreBtn =
    nextTier && transcript.length >= limit
      ? `<button class="transcript-more" data-more-transcript>${t("panel.showMore", { n: nextTier })}</button>`
      : "";
  return `<ul class="timeline">${lines}</ul>${moreBtn}`;
}

/** One collapsible "▸ time text" row shared by the timeline and transcript lists. */
function rowHtml(
  cssClass: string,
  ts: number,
  isOpen: boolean,
  toggleAttr: "data-toggle-timeline-ts" | "data-toggle-transcript-ts",
  text: string,
  prefix = "",
): string {
  return `<li class="${cssClass}${isOpen ? " expanded" : ""}">
    <button class="row-toggle" ${toggleAttr}="${ts}" title="${isOpen ? "Thu gọn" : "Xem đầy đủ"}">${isOpen ? "▾" : "▸"}</button>
    <time>${new Date(ts).toLocaleTimeString()}</time> ${prefix}<span class="row-text">${esc(text)}</span>
  </li>`;
}

function shorten(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…` : id;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
