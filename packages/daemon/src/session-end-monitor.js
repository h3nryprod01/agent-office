// Emits a synthetic `session_end` event when an agent (root session or
// sub-agent) has had no new transcript lines for SESSION_INACTIVITY_TIMEOUT_MS
// AND has no tool call still in flight.
//
// Why this exists: transcripts never contain an explicit "session closed"
// line (see packages/daemon/README.md, "Known limitations"). Without this,
// an idle agent's character just sits there forever. This is a coarse
// stand-in for a real Stop/SessionEnd hook signal.
//
// Why "no tool call in flight" matters, not just "no recent line": measured
// against real transcripts on this machine, a `tool_call` "start" event
// fires the moment a tool_use block appears, but its matching "ok"/"error"
// event only fires once the *next* line (the tool_result) is written — and
// long-running tools (video renders, builds, background jobs) can take much
// longer than a few minutes to return. Across ~20k real tool calls sampled
// on this machine, 219 took over 5 minutes and 111 took over 10 minutes to
// resolve. A monitor keyed only on "time since last line" would misfire
// mid-render. So this monitor tracks each agent's count of started-but-not-
// yet-finished tool calls and refuses to fire while that count is nonzero,
// no matter how long the gap — inactivity is only real once the agent has
// no outstanding work AND has produced nothing new for `timeoutMs`.

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // see README for reasoning
const SWEEP_INTERVAL_MS = 15_000; // fine-grained enough that "session_end"
// fires within ~15s of crossing the timeout, without a tight loop that adds
// meaningful CPU cost.

export class SessionEndMonitor {
  /**
   * @param {Object} [opts]
   * @param {number} [opts.timeoutMs]
   * @param {(agentInfo: {sessionId: string, agentId: string, parentId: string|null, cwd: string|null}) => void} opts.onTimeout
   */
  constructor({ timeoutMs = DEFAULT_TIMEOUT_MS, onTimeout }) {
    this.timeoutMs = timeoutMs;
    this.onTimeout = onTimeout;
    /**
     * @type {Map<string, {sessionId: string, parentId: string|null, cwd: string|null,
     *   lastSeenTs: number, pendingToolCalls: number}>} keyed by agentId
     */
    this.agents = new Map();
    this._timer = null;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this._sweep(), SWEEP_INTERVAL_MS);
    if (typeof this._timer.unref === "function") this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  /**
   * Call for every normalized event an agent produces, to reset its
   * inactivity clock and track whether it currently has a tool call in
   * flight (a `tool_call` event with status "start" opens one; "ok" or
   * "error" closes it).
   * @param {import("./event-schema.js").NormalizedEvent} event
   */
  touch(event) {
    const { agentId, sessionId, parentId, cwd, harness, type, status } = event;
    const existing = this.agents.get(agentId);
    let pendingToolCalls = existing?.pendingToolCalls ?? 0;
    if (type === "tool_call") {
      if (status === "start") pendingToolCalls += 1;
      else if (pendingToolCalls > 0) pendingToolCalls -= 1;
    }

    this.agents.set(agentId, {
      sessionId,
      parentId: parentId ?? existing?.parentId ?? null,
      cwd: cwd ?? existing?.cwd ?? null,
      harness: harness ?? existing?.harness ?? "claude-code",
      lastSeenTs: Date.now(),
      pendingToolCalls,
    });
  }

  _sweep() {
    const now = Date.now();
    for (const [agentId, agent] of this.agents) {
      if (agent.pendingToolCalls > 0) continue; // still working, however long it's taking
      if (now - agent.lastSeenTs < this.timeoutMs) continue;

      // Fire once and forget the agent entirely — an entry kept around with
      // an "ended" flag lived for the daemon's whole lifetime, one per agent
      // ever seen (wi-daemon-leak). An agent that wakes up later gets
      // recreated fresh by touch(), same as before.
      this.agents.delete(agentId);
      this.onTimeout({
        sessionId: agent.sessionId,
        agentId,
        parentId: agent.parentId,
        cwd: agent.cwd,
        harness: agent.harness,
      });
    }
  }
}
