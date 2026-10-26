/**
 * Presentation mode — the masking core. Pure: no DOM, no network.
 *
 * Everything the renderer shows is data that arrived over fetch() or a
 * WebSocket. mask() rewrites that data on the way in, so views never see a
 * project name, a path, a branch or a line of someone's chat, and no view has
 * to know presentation mode exists (other lanes keep adding views; they get
 * covered for free).
 *
 * The policy is deny-by-default: a string is blurred unless its key is known
 * to be structural (ids, enums, tool names, timestamps) or it looks like an
 * id/number. Identity keys (repo, cwd, agent, branch…) become stable aliases
 * (`project-1`, `agent-3`) so the office still reads as a coherent story.
 */

type Kind = "project" | "agent" | "branch" | "dir" | "file" | "link" | "server" | "tool";

const PREFIX: Record<Kind, string> = {
  project: "project",
  agent: "agent",
  branch: "branch",
  dir: "dir",
  file: "file",
  link: "link",
  server: "server",
  tool: "tool",
};

/** Keys whose string value is a project / repo / office name. */
const PROJECT_KEYS = new Set(["repo", "project", "projectslug", "projectname", "slug", "office"]);
/** Keys whose string value is an agent / person name. */
const AGENT_KEYS = new Set(["agent", "agentname", "assignee", "owner", "author", "label", "name"]);
const BRANCH_KEYS = new Set(["branch", "gitbranch", "ref"]);
/** Containers whose object KEYS are project names (`{ repos: { "acme-web": {...} } }`). */
const PROJECT_MAP_KEYS = new Set(["repos", "projects", "offices", "byproject"]);
/** Containers whose object KEYS are tool names or role names (the approval policy: `{ tools: { "mcp__crm__lookup": "deny" } }`). */
const TOOL_MAP_KEYS = new Set(["tools"]);
const ROLE_MAP_KEYS = new Set(["roles"]);
/** The values of those maps are approval modes: public words the panel must read back intact. */
const APPROVAL_MODES = new Set(["ask", "auto", "read-only", "deny"]);
/** Agent CLIs and model vendors are product names, public; any other harness or lane value is aliased. */
const PUBLIC_HARNESSES = new Set(["claude", "claude-code", "codex", "gemini", "claude-worker", "hermes", "deepseek", "mimo", "glm", "kimi"]);
const HARNESS_LIST_KEYS = new Set(["allowedharnesses", "allowedlanes"]);
/**
 * Built-in tool names a policy may key on. Anything else in a policy's tool map (a custom tool, a
 * prefix like `Notebook*`) can carry a client's name, so it is aliased — reversibly, for saving.
 */
const BUILTIN_TOOLS = new Set([
  "Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "LS", "WebFetch", "WebSearch", "Task", "Agent",
  "TodoWrite", "NotebookRead", "NotebookEdit", "Skill", "BashOutput", "KillShell", "ExitPlanMode",
  // Codex and Gemini CLI built-ins
  "shell", "apply_patch", "update_plan", "exec_command", "read_file", "write_file", "replace", "run_shell_command",
  "glob", "search_file_content", "list_directory", "web_fetch", "google_web_search", "read_many_files", "save_memory",
]);
/** Keys whose value is removed outright. */
const SECRET_KEY =
  /token|secret|passw|credential|cookie|apikey|api_key|privatekey|private_key|accesskey|access_key|sessionkey|signature|jwt|authorization|oauth/i;
/** `auth` as a whole word (authHeader, x_auth) — but not `author`. */
const isSecretKey = (key: string): boolean =>
  SECRET_KEY.test(key) || key.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).includes("auth");
/** Values that look like credentials, whatever key they sit under. */
const SECRET_VALUE =
  /^(sk-[\w-]{8,}|gh[pousr]_\w{16,}|xox[abprs]-[\w-]+|AKIA[0-9A-Z]{12,}|eyJ[\w-]+\.[\w-]+\.[\w-]+|(Bearer|Basic)\s+\S+|k-live-\S+)/;
/** A long opaque run: letters AND digits, few hyphens — a credential, not a hyphenated name. */
const looksLikeCredential = (v: string): boolean =>
  /^[A-Za-z0-9+_=-]{32,}$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v) && (v.match(/-/g)?.length ?? 0) <= 2;

/** Keys whose value is structural — enums, ids, tool names, timestamps. Kept verbatim. */
const SAFE_KEY =
  /^(v|id|type|kind|status|state|tool|harness|lane|role|model|source|mode|window|unit|currency|ok|ts|at|timestamp|avatar|voice|tone|level|severity|priority|lang|locale|key|method|version|format|schema)$|(Id|Ids|At|Ts|Usd|Count|Ms|Version|Status|Kind)$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const PLAIN_NUMBER = /^[-+]?\d{1,6}(\.\d+)?$/; // longer digit runs read as phone / card numbers
const OPAQUE_ID = /^(?:(?:toolu|msg|req|call)_[A-Za-z0-9]{10,}|evt-\d+|ap-\d+|cm-\d+)$/;

/** Words that carry no information about the user: tool and harness vocabulary. */
const PUBLIC_WORDS = new Set(
  [
    "Read", "Write", "Edit", "MultiEdit", "Bash", "Grep", "Glob", "Task", "Agent", "TodoWrite", "WebFetch",
    "WebSearch", "NotebookEdit", "Workflow", "Skill", "Claude", "Codex", "Gemini", "Hermes", "DeepSeek",
    "Opus", "Sonnet", "Haiku", "Fable", "idle", "working", "done", "error", "blocked",
    // the daemon adapter recognises a refused tool call by this phrase
    "has", "been", "denied",
  ].map((w) => w.toLowerCase()),
);
/** Common path segments and file names that identify nobody. */
const PUBLIC_SEGMENTS = new Set([
  ".claude", ".git", ".github", "worktrees", "src", "test", "tests", "docs", "lib", "dist", "build", "public",
  "packages", "node_modules", "scripts", "assets", "templates", "app", "main", "master", "develop", "tmp",
  "readme.md", "claude.md", "agents.md", "package.json", "tsconfig.json", "index.ts", "index.js", "main.ts",
  "main.js", "style.css", "index.html", "~", ".", "..",
]);

const BLOCK = "▒"; // ▒
const BLUR_MIN = 2;
const BLUR_MAX = 9;

export interface Masker {
  /** Returns a masked deep copy of any JSON-like value. Never mutates its input. */
  mask<T>(value: T): T;
  /** Masks a free-text string (chat line, markdown body, error message). */
  maskText(text: string): string;
  /** Replaces aliases in an outgoing string with the real values they stand for. */
  unmask(text: string): string;
}

export function createMasker(): Masker {
  /** raw → alias, per namespace (a path segment and a repo may share a raw string). */
  const forward = new Map<string, string>();
  /** alias → raw. Aliases are globally unique, so one table serves unmask(). */
  const reverse = new Map<string, string>();
  const counters: Record<Kind, number> = { project: 0, agent: 0, branch: 0, dir: 0, file: 0, link: 0, server: 0, tool: 0 };
  /** every raw project name seen so far, so path segments can reuse the project alias */
  const projectRaw = new Set<string>();

  const isAlias = (s: string): boolean => reverse.has(s);

  function alias(kind: Kind, raw: string, ext = ""): string {
    const k = `${kind}\u0000${raw}`;
    const known = forward.get(k);
    if (known) return known;
    counters[kind] += 1;
    const a = `${PREFIX[kind]}-${counters[kind]}${ext}`;
    forward.set(k, a);
    reverse.set(a, raw);
    return a;
  }

  function maskProject(raw: string): string {
    if (isAlias(raw)) return raw;
    projectRaw.add(raw);
    return alias("project", raw);
  }

  function maskSegment(seg: string, last: boolean): string {
    if (seg === "" || PUBLIC_SEGMENTS.has(seg.toLowerCase()) || isAlias(seg)) return seg;
    if (projectRaw.has(seg)) return alias("project", seg);
    const ext = last ? /(\.[A-Za-z0-9]{1,5})$/.exec(seg)?.[1] : undefined;
    return ext ? alias("file", seg, ext) : alias("dir", seg);
  }

  /** `/Users/jane/Projects/acme/src/a.ts` → `~/dir-1/project-1/src/file-2.ts` */ // leak-ok: invented fixture value
  function maskPath(raw: string): string {
    if (raw.startsWith("~/") && raw.split("/").every((s) => s === "~" || isAlias(s) || PUBLIC_SEGMENTS.has(s.toLowerCase()))) {
      return raw;
    }
    const norm = raw.replace(/\\/g, "/");
    const home = /^(?:[A-Za-z]:)?\/(?:Users|home)\/[^/]+(?=\/|$)/.exec(norm);
    const rest = home ? norm.slice(home[0].length) : norm;
    const prefix = home || norm.startsWith("~") ? "~" : "";
    const parts = (home ? rest : norm.replace(/^~/, "")).split("/");
    const lastIdx = parts.length - 1;
    const body = parts.map((seg, i) => maskSegment(seg, i === lastIdx)).join("/");
    const out = prefix ? `~${body.startsWith("/") ? body : `/${body}`}` : body;
    // whole-path reverse entry so a path round-trips through unmask() exactly
    if (!reverse.has(out)) reverse.set(out, raw);
    return out;
  }

  const looksLikePath = (s: string): boolean => /[\\/]/.test(s) || s.startsWith("~");
  const looksLikeUrl = (s: string): boolean => /^[a-z][a-z0-9+.-]*:\/\//i.test(s);

  function blur(word: string): string {
    return BLOCK.repeat(Math.min(Math.max(word.length, BLUR_MIN), BLUR_MAX));
  }

  /** Mask one whitespace-free token, keeping surrounding punctuation. */
  function maskToken(token: string): string {
    const m = /^([^\p{L}\p{N}~/\\.]*)(.*?)([^\p{L}\p{N}/\\]*)$/u.exec(token);
    if (!m) return blur(token);
    const [, lead, core, trail] = m;
    if (!core) return token;
    if (isAlias(core) || PUBLIC_WORDS.has(core.toLowerCase())) return token;
    if (UUID.test(core) || OPAQUE_ID.test(core)) return token;
    if (looksLikeUrl(core)) return lead + alias("link", core) + trail;
    if (looksLikePath(core)) return lead + maskPath(core) + trail;
    if (projectRaw.has(core)) return lead + alias("project", core) + trail;
    return lead + blur(core) + trail;
  }

  function maskText(text: string): string {
    return text
      .split(/(\s+)/)
      .map((part) => (part === "" || /^\s+$/.test(part) ? part : maskToken(part)))
      .join("");
  }

  /** Built-in tool names are public; both parts of `mcp__<server>__<tool>` can name a client. */
  function maskTool(value: string): string {
    if (value.startsWith("mcp__")) {
      const [, server = "", ...rest] = value.split("__");
      const masked = `mcp__${alias("server", server)}__${alias("tool", rest.join("__"))}`;
      reverse.set(masked, value); // the whole name is one unmask token, so map it whole too
      return masked;
    }
    // only built-in names are public; a custom tool can name a client (same rule as the policy map keys)
    return BUILTIN_TOOLS.has(value) ? value : alias("tool", value);
  }

  function maskString(key: string, value: string, siblings: Record<string, unknown>): string {
    const lower = key.toLowerCase();
    // harness / lane names first: before the secret and alias checks, so even an odd name ("sk-…",
    // "project-1") becomes a reversible alias the daemon still accepts on save
    if (HARNESS_LIST_KEYS.has(lower) || lower === "harness" || lower === "lane") {
      return PUBLIC_HARNESSES.has(value) ? value : alias("tool", value);
    }
    if (isSecretKey(key) || SECRET_VALUE.test(value)) return "••••";
    if (isAlias(value)) return value;
    if (PROJECT_KEYS.has(lower) || /repo$/i.test(key) || (lower === "name" && "slug" in siblings)) return maskProject(value);
    if (BRANCH_KEYS.has(lower)) return /^(main|master|develop|HEAD)$/.test(value) ? value : alias("branch", value);
    if (AGENT_KEYS.has(lower)) return alias("agent", value);
    if (/(^|[a-z])(path|dir|cwd|root|file|workdir|folder)$/i.test(key) || lower === "cwd") return maskPath(value);
    if (lower === "tool") return maskTool(value);
    // a long opaque run (other than a uuid or a known id form) is a credential until proven otherwise
    if (!UUID.test(value) && !OPAQUE_ID.test(value) && looksLikeCredential(value)) return "••••";
    // structural keys keep structural-looking values only: one token, no path — free text there is still free text
    if (SAFE_KEY.test(key)) return /^[^\s/\\]{0,64}$/.test(value) ? value : maskText(value);
    if (UUID.test(value) || ISO_DATE.test(value) || PLAIN_NUMBER.test(value) || OPAQUE_ID.test(value)) return value;
    return maskText(value);
  }

  /** Identity keys first, so a cwd walked later reuses the project alias. */
  function orderedKeys(obj: Record<string, unknown>): string[] {
    const keys = Object.keys(obj);
    const first = keys.filter((k) => PROJECT_KEYS.has(k.toLowerCase()));
    return [...first, ...keys.filter((k) => !PROJECT_KEYS.has(k.toLowerCase()))];
  }

  function walk(value: unknown, key: string, siblings: Record<string, unknown>, inArray = false): unknown {
    if (typeof value === "string") return maskString(key, value, siblings);
    if (Array.isArray(value)) return value.map((v) => walk(v, key, siblings, true));
    if (value && typeof value === "object") {
      const src = value as Record<string, unknown>;
      // preserve the original key order in the output, but visit identity keys first
      const keyed = !inArray && PROJECT_MAP_KEYS.has(key.toLowerCase());
      if (keyed) for (const k of Object.keys(src)) maskProject(k); // register before values mention them
      const visited: Record<string, unknown> = {};
      const lowerKey = key.toLowerCase();
      const modeMap = !inArray && (TOOL_MAP_KEYS.has(lowerKey) || ROLE_MAP_KEYS.has(lowerKey));
      for (const k of orderedKeys(src)) {
        const v = src[k];
        visited[k] = modeMap && typeof v === "string" && APPROVAL_MODES.has(v) ? v : walk(v, k, src);
      }
      const out: Record<string, unknown> = {};
      const keyOf = (k: string): string =>
        keyed ? maskProject(k)
        : !inArray && TOOL_MAP_KEYS.has(lowerKey) ? (k.startsWith("mcp__") ? maskTool(k) : BUILTIN_TOOLS.has(k) ? k : alias("tool", k))
        : !inArray && ROLE_MAP_KEYS.has(lowerKey) ? alias("agent", k)
        : k;
      for (const k of Object.keys(src)) out[keyOf(k)] = visited[k];
      return out;
    }
    return value;
  }

  /** A path-ish run of word characters: `project-7`, `file-3.ts`, `~/dir-1/project-2/src/file-9.ts`. */
  const TOKEN = /(?:~\/)?[\w.-]+(?:\/[\w.-]+)*/g;

  function unmask(text: string): string {
    if (reverse.size === 0) return text;
    // one pass over the tokens with Map lookups: cost grows with the text, not with the alias table
    return text.replace(TOKEN, (tok) => {
      let end = tok.length; // "see project-7." — the trailing dots are the sentence's
      while (end > 0 && tok[end - 1] === ".") end--;
      const core = tok.slice(0, end);
      const trail = tok.slice(end);
      const whole = reverse.get(core);
      if (whole !== undefined) return whole + trail;
      if (!core.includes("/")) return tok;
      return core.split("/").map((seg) => reverse.get(seg) ?? seg).join("/") + trail;
    });
  }

  return {
    mask: <T>(value: T): T => walk(value, "", {}) as T,
    maskText,
    unmask,
  };
}

