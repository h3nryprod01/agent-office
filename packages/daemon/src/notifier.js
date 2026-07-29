// macOS notifications when an agent has needed the human for too long.
//
// The office renderer already shows who is stuck — but only if you are
// looking at it. This module watches the same broadcast stream the renderer
// receives and, when an agent sits in a needs-intervention state
// (waiting_permission / error) continuously past a threshold (30s), fires
// ONE desktop notification for that stuck episode. The episode resets when
// the agent shows any sign of life again, so a re-stuck agent notifies again.
//
// Delivery: terminal-notifier if installed (gives a click-to-open URL via
// -open), otherwise plain `osascript -e 'display notification ...'` (no
// click action possible — the office URL is appended to the message text
// instead). No new npm dependencies.
//
// Disable with AGENT_OFFICE_NOTIFY=0.

import { execFile } from "node:child_process";
import { isWindows, isLinux, notifyCommand } from "./platform.js";
import { sendMessage } from "./telegram.js";

const DEFAULT_THRESHOLD_MS = 30_000;
const DEFAULT_OFFICE_URL = process.env.AGENT_OFFICE_URL ?? "http://localhost:5199";

export class Notifier {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.thresholdMs] how long an agent must be continuously
   *   stuck before the notification fires
   * @param {boolean} [opts.enabled] override the AGENT_OFFICE_NOTIFY env gate
   * @param {string} [opts.officeUrl] URL opened on click / appended to the text
   * @param {Function} [opts.deliver] injectable delivery fn for tests —
   *   receives {title, subtitle, message, url}
   */
  constructor({
    thresholdMs = DEFAULT_THRESHOLD_MS,
    enabled = process.env.AGENT_OFFICE_NOTIFY !== "0",
    officeUrl = DEFAULT_OFFICE_URL,
    deliver = deliverNotification,
  } = {}) {
    this.thresholdMs = thresholdMs;
    this.enabled = enabled;
    this.officeUrl = officeUrl;
    this.deliver = deliver;
    /**
     * One entry per currently-stuck agent. `notified` is the per-episode
     * dedup: it stays true (and the entry stays put) until the agent is
     * confirmed active again, so a long stuck stretch notifies exactly once.
     * @type {Map<string, {event: Object, timer: NodeJS.Timeout|null, notified: boolean}>}
     */
    this.stuck = new Map();
  }

  /** @param {import("./event-schema.js").NormalizedEvent} event */
  onEvent(event) {
    if (!this.enabled || !event?.agentId) return;
    if (event.type === "session_end") return this._clear(event.agentId);
    if (event.type === "hook_signal") {
      if (event.meta?.state === "waiting_permission") return this._stuck(event);
      return this._clear(event.agentId); // "working" downgrade = alive again
    }
    if (event.status === "error") return this._stuck(event);
    // Any other transcript event means the agent is producing output — a
    // stuck agent by definition produces nothing.
    this._clear(event.agentId);
  }

  /** @private */
  _stuck(event) {
    const entry = this.stuck.get(event.agentId);
    if (entry) {
      entry.event = event; // freshen the reason text; timer keeps counting
      return;
    }
    const next = {
      event,
      notified: false,
      timer: setTimeout(() => {
        next.timer = null;
        next.notified = true;
        this.deliver(composeNotification(next.event, this.officeUrl));
      }, this.thresholdMs),
    };
    if (typeof next.timer.unref === "function") next.timer.unref();
    this.stuck.set(event.agentId, next);
  }

  /** @private */
  _clear(agentId) {
    const entry = this.stuck.get(agentId);
    if (!entry) return;
    if (entry.timer) clearTimeout(entry.timer);
    this.stuck.delete(agentId);
  }
}

/**
 * Deep link opened on click: office URL + ?focus=<agentId> so the renderer
 * jumps to that agent's repo tab and pans the camera to them.
 * @param {string} officeUrl
 * @param {string|null|undefined} agentId
 */
export function buildOfficeUrl(officeUrl, agentId) {
  if (!agentId) return officeUrl;
  const u = new URL(officeUrl);
  u.searchParams.set("focus", agentId);
  return u.href;
}

/**
 * What the notification says: who (agent · repo), what state, why (short).
 * @param {import("./event-schema.js").NormalizedEvent} event
 * @param {string} url
 */
export function composeNotification(event, url) {
  const label =
    event.meta?.state === "waiting_permission"
      ? "Waiting for approval"
      : /denied/i.test(event.detail ?? "")
        ? "Blocked"
        : "Error";
  const reason = event.detail || event.tool || "";
  return {
    title: "Agent Office",
    subtitle: `${event.agent} · ${event.repo}`,
    message: `${label} >30s${reason ? `: ${reason}` : ""}`,
    url: buildOfficeUrl(url, event.agentId),
  };
}

// The daemon runs as a launchd service with the bare system PATH (no
// /opt/homebrew/bin), so a plain "terminal-notifier" ENOENTs in production
// and every notification silently fell back to osascript — whose banners
// have no click action and open Script Editor (a file-open dialog) when
// clicked. Probe the Homebrew install locations before giving up.
// ponytail: module-level index, advanced on ENOENT — the daemon is a
// singleton process, a probe-once cache class would be ceremony.
const NOTIFIER_CANDIDATES = [
  "terminal-notifier",
  "/opt/homebrew/bin/terminal-notifier",
  "/usr/local/bin/terminal-notifier",
];
let notifierIdx = 0;

/**
 * Default delivery. Windows → PowerShell balloon (notifyCommand); Linux →
 * notify-send; macOS → terminal-notifier (clickable) → osascript fallback.
 * Every platform also gets a best-effort Telegram push (telegram.js;
 * no-op unless TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID are set).
 * `execFileFn` defaults to the real execFile so runtime is unchanged but every
 * branch is testable with a fake. `platform` defaults to the real platform.
 */
export function deliverNotification(
  { title, subtitle, message, url },
  { platform = process.platform, execFileFn = execFile, sendTelegram = sendMessage } = {},
) {
  // Secondary channel, right alongside the OS notification below: fire and
  // forget, independent of which platform branch runs or whether it
  // succeeds. sendTelegram() (telegram.js) already swallows its own
  // config/network errors — but defend here too (belt-and-suspenders, same
  // reasoning as askPm's try/catch in telegram.js): a sync throw or a
  // rejected promise from *any* injected sendTelegram must never take down
  // the OS notification below, or the daemon itself (an unhandled rejection
  // is fatal by default on Node >=15).
  try {
    Promise.resolve(sendTelegram(`${title} — ${subtitle}\n${message}\n${url}`)).catch(() => {});
  } catch {
    // best-effort secondary channel only — see above
  }

  if (isWindows(platform)) {
    const { cmd, args } = notifyCommand({ title, subtitle, message, url }, platform);
    if (!cmd) return; // defensive — notifyCommand(win32) always returns "powershell"
    execFileFn(cmd, args, (error) => {
      // ponytail: degrade, don't throw — a notification failure must never break
      // the daemon. (Same posture as the macOS osascript fallback below.)
      if (error) console.warn("[notifier] windows balloon failed:", error.message);
    });
    return;
  }
  if (isLinux(platform)) {
    // notify-send is bare fire-and-forget: no -A (that flag implies --wait and
    // would hang execFile until the user clicks the notification).
    execFileFn("notify-send", ["-a", "Agent Office", title, message], (error) => {
      if (error) console.error("[notifier] notify-send failed:", error.message);
    });
    return;
  }
  if (notifierIdx < NOTIFIER_CANDIDATES.length) {
    execFileFn(
      NOTIFIER_CANDIDATES[notifierIdx],
      ["-title", title, "-subtitle", subtitle, "-message", message, "-open", url],
      (error) => {
        if (error && error.code === "ENOENT") {
          notifierIdx += 1;
          deliverNotification({ title, subtitle, message, url }, { platform, execFileFn });
        } else if (error) {
          console.error("[notifier] terminal-notifier failed:", error.message);
        }
      },
    );
    return;
  }
  const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = `display notification "${esc(`${message} — ${url}`)}" with title "${esc(title)}" subtitle "${esc(subtitle)}"`;
  execFileFn("osascript", ["-e", script], (error) => {
    if (error) console.error("[notifier] osascript failed:", error.message);
  });
}

/**
 * Observe every event the daemon broadcasts by wrapping server.broadcast —
 * one registration point covers all current and future emitters (transcript,
 * hooks, codex, chat). Notifier failures must never break event delivery.
 * @param {import("./ws-server.js").EventBroadcastServer} server
 * @param {ConstructorParameters<typeof Notifier>[0]} [opts]
 */
export function attachNotifier(server, opts) {
  const notifier = new Notifier(opts);
  const original = server.broadcast.bind(server);
  server.broadcast = (event) => {
    original(event);
    try {
      notifier.onEvent(event);
    } catch (error) {
      console.error("[notifier] error handling event:", error.message);
    }
  };
  return notifier;
}
