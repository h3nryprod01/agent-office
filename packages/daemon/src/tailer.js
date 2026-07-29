// Tails append-only JSONL transcript files under a projects root
// (~/.claude/projects/**/*.jsonl) and emits parsed lines as they're written.
//
// Why polling instead of fs.watch: fs.watch is unreliable across platforms
// for detecting pure appends (no rename/create event fires on macOS for a
// simple write() append in many editors/processes) and it's not recursive
// on Linux. Transcript files are appended to by the Claude Code CLI process
// continuously while a session is active, so a short poll interval gives us
// near-real-time delivery with much simpler, more portable code. We track a
// byte offset per file and only read the newly appended bytes each tick.
//
// Sub-agent transcripts: alongside `<project>/<sessionId>.jsonl` (the root
// session transcript), Claude Code writes each sub-agent's own turns to a
// separate file under `<project>/<sessionId>/subagents/`, in one of two
// shapes observed on this machine (see docs/semantic-mapping.md):
//   <project>/<sessionId>/subagents/agent-<agentId>.jsonl                (direct sub-agent)
//   <project>/<sessionId>/subagents/workflows/<runId>/agent-<agentId>.jsonl (workflow sub-agent)
// Each has a sibling `agent-<agentId>.meta.json` (written before the jsonl
// starts filling) containing `{agentType, description, toolUseId, spawnDepth}`
// for direct sub-agents, or just `{agentType: "workflow-subagent"}` (no
// toolUseId) for workflow ones. `toolUseId`, when present, is the id of the
// tool_use block (root session or another sub-agent, tool name `Agent` on
// this machine) that spawned it — the key normalize.js/agent-registry.js use
// to resolve `parentId`. Workflow sub-agents have no such tool_use block
// (devfleet/workflow spawning doesn't go through a tool call at all), so
// their parentId is instead derived structurally in index.js: `workflows/`
// is always a direct child of `<sessionId>/subagents/` on this machine,
// never nested under another agent's own file, so the root session is
// their parent.

import { EventEmitter } from "node:events";
import { readdirSync, statSync, createReadStream, existsSync, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_POLL_INTERVAL_MS = 1000;
// Skip history for transcript files idle longer than this on first sight —
// the same cutoff codex-tailer.js has had since PR #5, which was never
// applied here. Without it every boot re-reads the ENTIRE projects corpus
// (2.5GB / 4000+ files on this machine) because `offsets` lives only in
// memory: measured OOM crash-loop, 661 restarts/day (wi-daemon-leak).
// Safe to skip: a skipped idle session that wakes up still opens with a
// clean session_start, because normalize.js emits session_start off the
// first user/assistant line it sees, not off file history.
const DEFAULT_BACKFILL_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * @typedef {Object} SubagentContext
 * @property {string} rootSessionId  the session that (transitively) owns this sub-agent file
 * @property {string} agentId        this sub-agent's own id (from the file name / meta.json)
 * @property {string|null} toolUseId id of the spawning tool_use block, if known
 * @property {number} spawnDepth     1 = spawned directly by the root session, 2+ = spawned by
 *                                   another sub-agent (from meta.json; defaults to 1 if absent)
 *
 * @fires TranscriptTailer#line  ({filePath, sessionId, subagent: SubagentContext|null, line: object})
 * @fires TranscriptTailer#error ({filePath, error})
 */
export class TranscriptTailer extends EventEmitter {
  /**
   * @param {Object} opts
   * @param {string} opts.projectsRoot absolute path to ~/.claude/projects
   * @param {number} [opts.pollIntervalMs]
   * @param {number} [opts.backfillMaxAgeMs] files idle longer than this when
   *   first seen start tailing at EOF instead of replaying their history
   */
  constructor({
    projectsRoot,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    backfillMaxAgeMs = DEFAULT_BACKFILL_MAX_AGE_MS,
  }) {
    super();
    this.projectsRoot = projectsRoot;
    this.pollIntervalMs = pollIntervalMs;
    this.backfillMaxAgeMs = backfillMaxAgeMs;
    /** @type {Map<string, number>} filePath -> bytes already read */
    this.offsets = new Map();
    this._timer = null;
    this._ticking = false;
  }

  start() {
    if (this._timer) return;
    this._tick(); // run immediately so we don't wait a full interval on boot
    this._timer = setInterval(() => this._tick(), this.pollIntervalMs);
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async _tick() {
    // A tick can outlive the poll interval (slow disk, many files). Without
    // this guard setInterval stacks a new tick every second on top of the
    // running one, each re-reading every file that has no offset yet —
    // measured 72 concurrent ticks / 3.3M duplicate lines after 83s on this
    // machine's corpus, the direct cause of the 2.6GB OOM (wi-daemon-leak).
    if (this._ticking) return;
    this._ticking = true;
    try {
      let files;
      try {
        files = await findTranscriptFiles(this.projectsRoot);
      } catch (error) {
        this.emit("error", { filePath: this.projectsRoot, error });
        return;
      }

      for (const { filePath, subagent } of files) {
        try {
          await this._readNewBytes(filePath, subagent);
        } catch (error) {
          this.emit("error", { filePath, error });
        }
      }
    } finally {
      this._ticking = false;
    }
  }

  /**
   * @param {string} filePath
   * @param {SubagentContext|null} subagent
   */
  async _readNewBytes(filePath, subagent) {
    const stats = await stat(filePath);

    if (!this.offsets.has(filePath) && Date.now() - stats.mtimeMs > this.backfillMaxAgeMs) {
      // First sight of a long-idle file: skip its history, tail from here.
      this.offsets.set(filePath, stats.size);
      return;
    }
    const previousOffset = this.offsets.get(filePath) ?? 0;

    if (stats.size < previousOffset) {
      // File shrank/was replaced (e.g. truncated) — restart from the top.
      this.offsets.set(filePath, 0);
      return this._readNewBytes(filePath, subagent);
    }
    if (stats.size === previousOffset) return; // nothing new

    const sessionId = subagent ? subagent.rootSessionId : path.basename(filePath, ".jsonl");
    const chunk = await readRange(filePath, previousOffset, stats.size);
    this.offsets.set(filePath, stats.size);

    const lines = chunk.split("\n").filter((l) => l.trim().length > 0);
    for (const rawLine of lines) {
      let parsed;
      try {
        parsed = JSON.parse(rawLine);
      } catch {
        continue; // partial/corrupt line — skip rather than crash the tailer
      }
      this.emit("line", { filePath, sessionId, subagent, line: parsed });
    }
  }
}

/**
 * Recursively find transcript *.jsonl files under root, classifying each as
 * either a root session transcript or a sub-agent transcript (see module
 * doc comment for the two sub-agent path shapes).
 *
 * Layout: `<root>/<project>/<sessionId>.jsonl` (root transcript) with an
 * optional sibling directory `<root>/<project>/<sessionId>/subagents/...`
 * holding that session's sub-agent files.
 *
 * @param {string} root
 * @returns {Promise<Array<{filePath: string, subagent: SubagentContext|null}>>}
 */
async function findTranscriptFiles(root) {
  if (!existsSync(root)) return [];
  const projectDirs = await readdir(root, { withFileTypes: true });
  const rootFiles = [];
  const subagentFiles = [];

  for (const projectEntry of projectDirs) {
    if (!projectEntry.isDirectory()) continue;
    const projectPath = path.join(root, projectEntry.name);
    const sessionEntries = await readdir(projectPath, { withFileTypes: true }).catch(() => []);

    for (const sessionEntry of sessionEntries) {
      const fullPath = path.join(projectPath, sessionEntry.name);
      if (sessionEntry.isFile() && sessionEntry.name.endsWith(".jsonl")) {
        rootFiles.push({ filePath: fullPath, subagent: null });
      } else if (sessionEntry.isDirectory()) {
        const rootSessionId = sessionEntry.name;
        const subagentsDir = path.join(fullPath, "subagents");
        subagentFiles.push(...(await findSubagentFiles(subagentsDir, rootSessionId)));
      }
    }
  }

  // Root transcripts first, then sub-agents ordered shallowest-first: a
  // sub-agent's spawning tool_use line lives in its parent's transcript
  // (root for depth 1, another sub-agent for depth 2+), so processing
  // parents before children within one tick lets the parentId registry
  // (see agent-registry.js) resolve on the very first pass instead of only
  // on a later poll tick. Directory listing order is not reliable for this
  // (a session's own subdirectory can sort before its `.jsonl` file, and
  // depth-1/depth-2 sub-agent files live side by side under the same
  // `subagents/` dir), so this ordering is enforced explicitly.
  subagentFiles.sort((a, b) => a.subagent.spawnDepth - b.subagent.spawnDepth);
  return [...rootFiles, ...subagentFiles];
}

/**
 * Find sub-agent transcript files under `<sessionId>/subagents/`, at either
 * of the two known shapes:
 *   subagents/agent-<agentId>.jsonl                       (direct sub-agent)
 *   subagents/workflows/<runId>/agent-<agentId>.jsonl     (workflow sub-agent)
 * @param {string} subagentsDir
 * @param {string} rootSessionId
 * @returns {Promise<Array<{filePath: string, subagent: SubagentContext}>>}
 */
async function findSubagentFiles(subagentsDir, rootSessionId) {
  const entries = await readdir(subagentsDir, { withFileTypes: true }).catch(() => []);
  const results = [];

  for (const entry of entries) {
    const fullPath = path.join(subagentsDir, entry.name);
    if (entry.isFile() && entry.name.startsWith("agent-") && entry.name.endsWith(".jsonl")) {
      results.push({ filePath: fullPath, subagent: readSubagentContext(fullPath, rootSessionId) });
    } else if (entry.isDirectory() && entry.name === "workflows") {
      // subagents/workflows/<runId>/agent-<agentId>.jsonl — one more level
      // of nesting (each workflow run gets its own <runId> directory).
      const runDirs = await readdir(fullPath, { withFileTypes: true }).catch(() => []);
      for (const runDir of runDirs) {
        if (!runDir.isDirectory()) continue;
        const runPath = path.join(fullPath, runDir.name);
        const runEntries = await readdir(runPath, { withFileTypes: true }).catch(() => []);
        for (const runEntry of runEntries) {
          if (runEntry.isFile() && runEntry.name.startsWith("agent-") && runEntry.name.endsWith(".jsonl")) {
            const nestedPath = path.join(runPath, runEntry.name);
            results.push({ filePath: nestedPath, subagent: readSubagentContext(nestedPath, rootSessionId) });
          }
        }
      }
    }
  }
  return results;
}

/**
 * Derive a sub-agent's id and spawning tool_use id from its filename and
 * sibling `.meta.json` (read once per poll tick; these are small, static
 * files written before the transcript starts filling).
 * @param {string} filePath path to `agent-<agentId>.jsonl`
 * @param {string} rootSessionId
 * @returns {SubagentContext}
 */
function readSubagentContext(filePath, rootSessionId) {
  const base = path.basename(filePath, ".jsonl"); // "agent-<agentId>"
  const agentId = base.startsWith("agent-") ? base.slice("agent-".length) : base;
  const metaPath = path.join(path.dirname(filePath), `${base}.meta.json`);

  let toolUseId = null;
  let spawnDepth = 1;
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    toolUseId = typeof meta.toolUseId === "string" ? meta.toolUseId : null;
    if (typeof meta.spawnDepth === "number") spawnDepth = meta.spawnDepth;
  } catch {
    // meta.json missing/unreadable/malformed — parentId resolution falls
    // back to "unknown", still emitting a valid non-breaking event.
  }

  return { rootSessionId, agentId, toolUseId, spawnDepth };
}

/**
 * Read bytes [start, end) from a file as utf8 text.
 * @param {string} filePath
 * @param {number} start
 * @param {number} end
 * @returns {Promise<string>}
 */
function readRange(filePath, start, end) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = createReadStream(filePath, { start, end: end - 1 });
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
}

// Exported for tests / initial-snapshot use cases (sync variants for CLI ergonomics).
export function listJsonlFilesSync(root) {
  if (!existsSync(root)) return [];
  const results = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      let nested = [];
      try {
        nested = readdirSync(fullPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const nestedEntry of nested) {
        if (nestedEntry.isFile() && nestedEntry.name.endsWith(".jsonl")) {
          results.push(path.join(fullPath, nestedEntry.name));
        }
      }
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      results.push(fullPath);
    }
  }
  return results;
}

export function fileSizeSync(filePath) {
  return statSync(filePath).size;
}
