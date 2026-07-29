// Resolves parentId for sub-agents within one root session's tree.
//
// A sub-agent is spawned by a `tool_use` block (tool name `Agent` on this
// machine — see docs/semantic-mapping.md) that lives either in the root
// session transcript or in another sub-agent's own transcript (depth-2+
// sub-agents spawning further sub-agents). Each sub-agent's sibling
// `agent-<agentId>.meta.json` records that spawning block's id as
// `toolUseId`. To turn a `toolUseId` into a `parentId` we need to know
// which agent's transcript that tool_use block appeared in — so every
// normalizer registers the tool_use ids it sees here, keyed per root
// session, and sub-agent normalizers look theirs up (resolving lazily,
// since the sub-agent's meta.json can be read before the parent's
// tool_use line has been tailed).

export class AgentRegistry {
  constructor() {
    /** @type {Map<string, Map<string, string>>} rootSessionId -> (toolUseId -> agentId) */
    this.toolUseOwners = new Map();
  }

  /**
   * Record that `toolUseId` was emitted by `agentId` within `rootSessionId`'s tree.
   * @param {string} rootSessionId
   * @param {string} toolUseId
   * @param {string} agentId
   */
  registerToolUse(rootSessionId, toolUseId, agentId) {
    let owners = this.toolUseOwners.get(rootSessionId);
    if (!owners) {
      owners = new Map();
      this.toolUseOwners.set(rootSessionId, owners);
    }
    owners.set(toolUseId, agentId);
  }

  /**
   * @param {string} rootSessionId
   * @param {string|null} toolUseId
   * @returns {string|null} the agentId that owns toolUseId, or null if not seen yet
   */
  resolveParent(rootSessionId, toolUseId) {
    if (!toolUseId) return null;
    return this.toolUseOwners.get(rootSessionId)?.get(toolUseId) ?? null;
  }

  /**
   * Drop a root session's whole tool_use map once the session has ended —
   * every tool_use id ever seen was retained forever otherwise
   * (wi-daemon-leak). A session that resumes after this simply re-registers
   * ids as its new lines are tailed.
   * @param {string} rootSessionId
   */
  clearSession(rootSessionId) {
    this.toolUseOwners.delete(rootSessionId);
  }
}
