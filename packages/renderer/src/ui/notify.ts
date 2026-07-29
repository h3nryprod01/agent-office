import type { OfficeState } from "../sim/model";
import { statusLabel } from "../sim/model";
import { interventionQueue } from "../sim/selectors";

/**
 * THE ONE THING (brainstorm 2026-07-17): push the ❗ OUT of the 3D window.
 *
 * When an agent newly needs a human (waiting_permission / blocked / error),
 * fire an OS notification through the browser Notification API — a native
 * toast on Windows / macOS / Linux with the host's notification sound — and
 * badge the taskbar/dock with the count. Click a toast → focus that agent.
 *
 * Cross-platform for free: the browser turns `Notification` into the host OS
 * toast, so there is no per-OS native glue to port (unlike the daemon's
 * macOS-only notifier.js). Verify on customer #1's Windows 11 (Edge/Chrome).
 *
 * Edge-triggered on `agentId:status`, so each event notifies ONCE, not every
 * tick — notification fatigue is the top risk here, not the code.
 */
export interface Notifier {
  sync(state: OfficeState): void;
}

interface AlertLike {
  agentId: string;
  status: string;
}

/**
 * Pure diff: which agents are newly in alert vs the set already notified.
 * Key = `agentId:status`, so a status change (blocked → error) re-notifies,
 * and an agent that left the queue is dropped from `next`.
 */
export function newAlerts(
  prev: ReadonlySet<string>,
  queue: readonly AlertLike[],
): { fresh: AlertLike[]; next: Set<string> } {
  const next = new Set<string>();
  const fresh: AlertLike[] = [];
  for (const a of queue) {
    const key = `${a.agentId}:${a.status}`;
    next.add(key);
    if (!prev.has(key)) fresh.push({ agentId: a.agentId, status: a.status });
  }
  return { fresh, next };
}

export function mountNotifier(onSelect: (agentId: string) => void): Notifier {
  let notified = new Set<string>();
  const canNotify = typeof Notification !== "undefined";

  // Permission must be asked from a user gesture — do it once on first click.
  if (canNotify && Notification.permission === "default") {
    window.addEventListener("pointerdown", () => void Notification.requestPermission(), {
      once: true,
    });
  }

  return {
    sync(state: OfficeState): void {
      const queue = interventionQueue(state);

      const nav = navigator as Navigator & {
        setAppBadge?: (n?: number) => Promise<void>;
        clearAppBadge?: () => Promise<void>;
      };
      if (queue.length > 0) void nav.setAppBadge?.(queue.length);
      else void nav.clearAppBadge?.();

      const { fresh, next } = newAlerts(notified, queue);
      notified = next; // track even when muted, so granting mid-run doesn't flood
      if (!canNotify || Notification.permission !== "granted") return;

      for (const { agentId } of fresh) {
        const a = state.agents.get(agentId);
        if (!a) continue;
        const opts: NotificationOptions & { renotify?: boolean } = {
          body: statusLabel(a.status) + (a.statusDetail ? ` — ${a.statusDetail}` : ""),
          tag: agentId, // one live toast per agent; renotify on a new status
          renotify: true,
        };
        const n = new Notification(`❗ ${a.name}`, opts);
        n.onclick = (): void => {
          window.focus();
          onSelect(agentId);
          n.close();
        };
      }
    },
  };
}
