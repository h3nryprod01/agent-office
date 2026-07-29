// Turns raw hook-log lines (from notify.mjs, tailed by HookLogTailer) into
// low-latency "waiting_permission" / "working" signals, and reconciles them
// against the transcript-derived tool_call events so the two sources never
// double-count the same tool invocation.
//
// Why this exists (docs/semantic-mapping.md open question #1): transcript
// JSONL only ever gets a line written once a turn is complete. For a tool
// call that needs user approval, the "waiting for permission" moment has no
// transcript line at all — by the time anything is written, the decision
// (allow/deny) has already happened. A PreToolUse hook is the only channel
// that observes the pending-approval moment itself.
//
// What this module does NOT decide: whether a given PreToolUse hook firing
// actually means "blocked on human approval" versus "about to run, no
// approval needed" (e.g. an already-allowlisted tool). Claude Code's hook
// contract does not tell a PreToolUse hook whether the call will need
// interactive approval — that decision happens after the hook chain runs.
//
// Emission strategy (changed when this module was first wired in, Round 3):
// verified against real hook-log data from the Mission Control session —
// auto-allowed tools produce a Pre→Post pair ~100ms-2s apart. Emitting
// "waiting_permission" immediately on every PreToolUse would therefore
// flash a red alert on EVERY tool call, which is exactly the noise Mission
// Control must not produce. So instead:
//   - PreToolUse arms a GRACE_MS timer (default 2s). If the call is
//     confirmed to have proceeded before it fires — by (a) the matching
//     PostToolUse line, or (b) the transcript-derived tool_call event —
//     nothing is ever emitted for that call.
//   - If the timer fires with no confirmation, we emit
//     "waiting_permission": the call has been pending for GRACE_MS, which
//     for interactive sessions means a permission prompt (or a genuinely
//     long tool run — accepted false positive, it clears on completion).
//   - When a confirmation arrives AFTER "waiting_permission" was emitted,
//     we emit a "working" downgrade so the alert clears immediately.

const DEFAULT_GRACE_MS = 2_000;

// Once "waiting_permission" has been emitted, we keep the entry so the
// eventual confirmation can emit the "working" downgrade. If nothing ever
// confirms (session killed mid-prompt), drop the entry after this long so
// the map can't grow forever.
const EMITTED_TTL_MS = 10 * 60 * 1000;

/**
 * @typedef {Object} HookSignal
 * @property {"waiting_permission"|"working"} state
 * @property {string|null} sessionId
 * @property {string|null} cwd
 * @property {string|null} tool
 * @property {number} ts
 * @property {string|null} toolUseId
 */

export class HookSignalReconciler {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.graceMs] how long a PreToolUse may stay
   *   unconfirmed before it is reported as "waiting_permission"
   */
  constructor({ graceMs = DEFAULT_GRACE_MS } = {}) {
    this.graceMs = graceMs;
    /**
     * Keyed by `${sessionId}:${toolName}` (fallback key when toolUseId is
     * unavailable — the transcript-derived tool_call events are keyed the
     * same way so the two sources can clear each other).
     * @type {Map<string, {line: Object, timer: NodeJS.Timeout, emitted: boolean, emit: Function}>}
     */
    this.pending = new Map();
  }

  /**
   * Feed one parsed line from the hook log.
   * @param {Object} line as written by notify.mjs: {hook, sessionId, cwd, toolName, toolUseId, ts}
   * @param {(signal: HookSignal) => void} emit callback for a signal to broadcast
   */
  onHookLine(line, emit) {
    if (!line || typeof line !== "object") return;
    const key = this._key(line.sessionId, line.toolName);
    if (!key) return;

    if (line.hook === "PreToolUse") {
      // Two PreToolUse lines for the same session+tool without a resolution
      // in between (parallel tool calls in one message) — keep only the
      // newest; per-call fidelity needs toolUseId in PostToolUse payloads,
      // which real data shows we have, but the transcript clear path
      // doesn't, so the coarser key wins for now.
      this._drop(key);

      const entry = {
        line,
        emitted: false,
        emit,
        timer: setTimeout(() => {
          entry.emitted = true;
          emit(this._signal("waiting_permission", line));
          // keep the entry (for the downgrade), but bound its lifetime
          entry.timer = setTimeout(() => this.pending.delete(key), EMITTED_TTL_MS);
          if (typeof entry.timer.unref === "function") entry.timer.unref();
        }, this.graceMs),
      };
      if (typeof entry.timer.unref === "function") entry.timer.unref();
      this.pending.set(key, entry);
      return;
    }

    if (line.hook === "PostToolUse") {
      this._confirm(key, line.ts);
    }
  }

  /**
   * Feed one transcript-derived NormalizedEvent (from normalize.js) so a
   * tool_call event for the same session+tool also counts as confirmation —
   * covers PostToolUse hook logging being disabled or failing.
   * @param {import("./event-schema.js").NormalizedEvent} event
   */
  onNormalizedEvent(event) {
    if (!event || event.type !== "tool_call") return;
    const key = this._key(event.sessionId, event.tool);
    if (!key) return;
    this._confirm(key, event.ts);
  }

  /**
   * A confirmation that the pending call proceeded: cancel the grace timer,
   * and if "waiting_permission" already went out, emit the downgrade.
   * @private
   */
  _confirm(key, ts) {
    const entry = this.pending.get(key);
    if (!entry) return;
    const { line, emitted, emit } = entry;
    this._drop(key);
    if (emitted) {
      emit(this._signal("working", { ...line, ts: ts ?? line.ts }));
    }
  }

  /** @private */
  _drop(key) {
    const entry = this.pending.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(key);
  }

  /** @private */
  _signal(state, line) {
    return {
      state,
      sessionId: line.sessionId ?? null,
      cwd: line.cwd ?? null,
      tool: line.toolName ?? null,
      ts: line.ts ?? Date.now(),
      toolUseId: line.toolUseId ?? null,
    };
  }

  /** @private */
  _key(sessionId, toolName) {
    if (!sessionId || !toolName) return null;
    return `${sessionId}:${toolName}`;
  }
}
