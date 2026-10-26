/**
 * Collision radar (lane L4) — open collision alerts from the daemon's radar
 * (daemon/src/radar.js), shown in the intervention queue. Same shape as
 * ApprovalsStore: UI-layer state fed by the RAW daemon frames, so neither the
 * protocol nor the sim reducer learns about it.
 *
 *   collision_alert    → add   (meta = the alert)
 *   collision_resolved → remove (meta.alertId)
 *
 * Alerts are advisory: nothing here can block or change an agent.
 */
import { t } from "../i18n";

export interface RadarAgent {
  agentId: string;
  sessionId: string;
  name: string;
  harness?: string | null;
  repo?: string | null;
}

export interface RadarAlert {
  alertId: string;
  kind: "file" | "worktree" | "worker";
  severity: "hard" | "soft";
  path?: string;
  relPath?: string | null;
  since: number;
  /** [the agent that was there first, the agent that triggered the alert] */
  agents: RadarAgent[];
}

/** A WS frame older than this was replayed from the buffer, not sent just now. */
const STALE_MS = 60 * 60 * 1000;

export class RadarStore {
  private items = new Map<string, RadarAlert>();

  /** Tap for every raw daemon frame — cheap no-op for other types. */
  onRaw(raw: unknown): void {
    const e = raw as { type?: string; meta?: Partial<RadarAlert> | null };
    if (e?.type === "collision_alert") {
      // a frame replayed from the daemon's buffer long after it was sent is a leftover
      const sent = (raw as { ts?: number }).ts;
      if (typeof sent === "number" && Date.now() - sent > STALE_MS) return;
      this.add(e.meta);
    } else if (e?.type === "collision_resolved" && e.meta?.alertId) this.items.delete(e.meta.alertId);
  }

  private add(meta: Partial<RadarAlert> | null | undefined): void {
    if (!meta?.alertId || !Array.isArray(meta.agents) || meta.agents.length < 2) return;
    const since = typeof meta.since === "number" ? meta.since : Date.now();
    this.items.set(meta.alertId, { ...(meta as RadarAlert), since });
  }

  /**
   * GET /radar is the authoritative list of open alerts: it fills a late-joining
   * page AND removes ghosts left by a collision_resolved this page missed
   * (e.g. while the socket was reconnecting). Call it again now and then.
   */
  async backfill(): Promise<void> {
    try {
      const body = (await (await fetch("/radar")).json()) as { alerts?: Partial<RadarAlert>[] };
      this.items.clear();
      for (const alert of body.alerts ?? []) this.add(alert);
    } catch {
      // daemon offline — the WS replay and the next alert self-heal this
    }
  }

  /** Hard alerts first, newest first within a tier. */
  list(): RadarAlert[] {
    return [...this.items.values()].sort(
      (a, b) => Number(b.severity === "hard") - Number(a.severity === "hard") || b.since - a.since,
    );
  }
}

const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/**
 * The two lines the queue shows for an alert, in the current UI language.
 * `nameOf` maps an agentId to the name the office shows for that character;
 * the daemon's own label (a cwd basename) is only the fallback.
 */
export function radarText(
  alert: RadarAlert,
  nameOf: (agentId: string) => string | undefined = () => undefined,
): { who: string; what: string } {
  let names = alert.agents.map((a) => nameOf(a.agentId) ?? a.name);
  if (new Set(names).size < names.length) {
    // the office numbers characters per repo, so "coder-01" can be two different agents
    names = names.map((n, i) => `${n} (${alert.agents[i].repo || alert.agents[i].agentId.slice(0, 4)})`);
  }
  const last = alert.agents[alert.agents.length - 1];
  const vars = {
    a: names.slice(0, -1).join(", "), // a third agent joining reads "alpha, gamma and beta"
    b: names[names.length - 1],
    file: alert.kind === "worktree" ? (alert.relPath ?? "") : baseName(alert.path ?? ""),
    repo: last.repo ?? alert.agents[0].repo ?? "",
  };
  switch (alert.kind) {
    case "file":
      return { who: t("radar.kind.file"), what: t("radar.what.file", vars) };
    case "worktree":
      return { who: t("radar.kind.worktree"), what: t("radar.what.worktree", vars) };
    default:
      return { who: t("radar.kind.worker"), what: t("radar.what.worker", vars) };
  }
}

/** One queue row. Clicking it selects the agent that triggered the alert. */
export function radarItemHtml(
  alert: RadarAlert,
  nameOf?: (agentId: string) => string | undefined,
): string {
  const { who, what } = radarText(alert, nameOf);
  const target = alert.agents[alert.agents.length - 1].agentId;
  return `
            <li data-agent-id="${esc(target)}" class="radar radar-${alert.severity === "hard" ? "hard" : "soft"}">
              <span class="who">⚠ ${esc(who)}</span>
              <span class="what">${esc(what)}</span>
            </li>`;
}

function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
