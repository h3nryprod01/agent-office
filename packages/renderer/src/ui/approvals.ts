/**
 * Approvals store (spike R5②) — pending PermissionRequests answerable from
 * the office. Fed by tapping the RAW daemon v1 stream (main.ts wraps the
 * v1→v0 adapter) so neither the protocol nor the sim reducer changes:
 * approvals are UI-layer state, agents' ❗/status still come from the
 * existing hook_signal machinery.
 *
 * Safety: buttons only POST /approval-response; the daemon ignores unknown
 * or expired ids, and a failed POST leaves the item visible (the daemon TTL
 * clears it — the office can never invent an approval).
 */

export interface PendingApproval {
  id: string;
  sessionId: string;
  tool: string;
  preview: string;
  expiresAt: number;
}

interface ApprovalRawEvent {
  type?: string;
  sessionId?: string;
  tool?: string | null;
  meta?: {
    approvalId?: string;
    preview?: string;
    expiresAt?: number;
    state?: string;
  } | null;
}

const HTTP_BASE = "";

export class ApprovalsStore {
  private items = new Map<string, PendingApproval>();

  /** Tap for every raw daemon frame — cheap no-op for non-approval types. */
  onRaw(raw: unknown): void {
    const e = raw as ApprovalRawEvent;
    const id = e?.meta?.approvalId;
    if (!id) return;
    if (e.type === "approval_pending") {
      const expiresAt = e.meta?.expiresAt ?? 0;
      if (expiresAt <= Date.now()) return; // stale replay from the WS backlog
      this.items.set(id, {
        id,
        sessionId: e.sessionId ?? "",
        tool: e.tool ?? "unknown",
        preview: e.meta?.preview ?? "",
        expiresAt,
      });
    } else if (e.type === "approval_resolved") {
      this.items.delete(id);
    }
  }

  /** Late-join backfill: approvals created before this page connected. */
  async backfill(): Promise<void> {
    try {
      const res = await fetch(`${HTTP_BASE}/approvals`);
      const body = (await res.json()) as { items?: PendingApproval[] };
      for (const item of body.items ?? []) {
        if (item.id && item.expiresAt > Date.now()) this.items.set(item.id, item);
      }
    } catch {
      // daemon offline — WS reconnect + TTL make this self-healing
    }
  }

  /** ✓/✗ click. Optimistic removal; daemon TTL covers the failure cases. */
  async respond(id: string, decision: "allow" | "deny"): Promise<void> {
    this.items.delete(id);
    try {
      await fetch(`${HTTP_BASE}/approval-response`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, decision }),
      });
    } catch {
      // POST failed → the hook's own timeout falls back to the normal dialog
    }
  }

  /** Pending items, expired ones pruned, oldest (closest to expiry) first. */
  list(now: number = Date.now()): PendingApproval[] {
    for (const [id, item] of this.items) {
      if (item.expiresAt <= now) this.items.delete(id);
    }
    return [...this.items.values()].sort((a, b) => a.expiresAt - b.expiresAt);
  }
}
