// lane L2: data-rule warnings in the intervention queue. The daemon broadcasts a
// "policy_alert" frame when a session of a harness/lane that the project does not
// allow shows up (policy-watch.js). Like approvals this is UI-layer state tapped
// straight off the raw frames — it never touches agent status.

export interface PolicyAlert {
  id: string;
  /** The session to pan to / open when the item is clicked. */
  targetSessionId: string;
  project: string;
  projectName: string;
  kind: string;
  value: string;
  allowed: string[];
  ts: number;
}

interface RawFrame {
  type?: string;
  id?: string;
  ts?: number;
  meta?: {
    project?: string;
    projectName?: string;
    kind?: string;
    value?: string;
    allowed?: unknown;
    targetSessionId?: string;
  } | null;
}

const DISMISSED_KEY = "agent-office.policyAlertsDismissed";
const MAX_ALERT_AGE_MS = 24 * 60 * 60 * 1000; // the WS backlog can replay old frames

function loadDismissed(): Set<string> {
  try {
    const raw = localStorage.getItem(DISMISSED_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return new Set(Array.isArray(list) ? list.filter((v): v is string => typeof v === "string") : []);
  } catch {
    return new Set(); // private mode / storage disabled: dismissals just last this page load
  }
}

export class PolicyAlertsStore {
  private items = new Map<string, PolicyAlert>();
  private dismissed = loadDismissed();

  onRaw(raw: unknown): void {
    const e = raw as RawFrame | null;
    if (!e || e.type !== "policy_alert" || !e.id || !e.meta?.targetSessionId) return;
    if (this.dismissed.has(e.id)) return;
    const ts = typeof e.ts === "number" ? e.ts : Date.now();
    if (Date.now() - ts > MAX_ALERT_AGE_MS) return;
    this.items.set(e.id, {
      id: e.id,
      targetSessionId: e.meta.targetSessionId,
      project: e.meta.project ?? "",
      projectName: e.meta.projectName ?? e.meta.project ?? "",
      kind: e.meta.kind ?? "harness",
      value: e.meta.value ?? "",
      allowed: Array.isArray(e.meta.allowed) ? e.meta.allowed.filter((v): v is string => typeof v === "string") : [],
      ts,
    });
  }

  /** Newest first. */
  list(): PolicyAlert[] {
    return [...this.items.values()].sort((a, b) => b.ts - a.ts);
  }

  dismiss(id: string): void {
    this.items.delete(id);
    this.dismissed.add(id);
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify([...this.dismissed].slice(-200)));
    } catch {
      // storage unavailable — the alert is gone for this page load, which is all we can promise
    }
  }
}
