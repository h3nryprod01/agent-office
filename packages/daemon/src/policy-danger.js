// lane L2: the "always ask a human" list. In `auto` mode a tool call is waved
// through UNLESS this module returns at least one reason code.
//
// Conservative on purpose: a false positive costs one click, a false negative
// is `rm -rf` on a shared checkout. So the shell patterns run on the raw command
// string (quotes included — `echo "rm -rf /"` is flagged too) and only the PATH
// checks use a real tokenizer. This is a tripwire for the common accidents and
// prompt-injected one-liners, not a sandbox: a determined attacker with shell
// access can obfuscate past any regex list. Use `read-only`/`deny` for that.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Stable order so callers (tests, audit rows, UI chips) see the same list every time. */
const ORDER = [
  "recursive-delete",
  "force-push",
  "destructive-git",
  "secret-read",
  "download-exec",
  "outside-cwd-write",
  "sensitive-config-write",
  "privileged",
  "destructive-infra",
  "publish",
  "self-control",
  "uninspectable",
];

const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const PATH_KEYS = ["file_path", "notebook_path", "path"];
const SEP = String.raw`(?:^|[\s;&|(\`"'/\\])`; // a shell word boundary, quotes and /bin/rm, \rm included

// ── shell patterns, run on the raw command ─────────────────────────────────
const SHELL_RULES = [
  ["recursive-delete", new RegExp(`${SEP}rm\\s+(?:[^\\n;&|]*?\\s)?(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?=\\s|$|["'])`)],
  ["recursive-delete", /\bfind\b[^\n;&|]*\s-delete\b/],
  ["recursive-delete", /\bfind\b[^\n;&|]*-exec(?:dir)?\s+(?:sudo\s+)?(?:rm|rmdir|shred)\b/],
  ["recursive-delete", /\bgit\s+(?:-C\s+\S+\s+)?clean\b[^\n;&|]*\s(?:-[a-zA-Z]*f[a-zA-Z]*|--force)\b/],
  ["recursive-delete", /\brsync\b[^\n;&|]*\s--delete/],
  ["destructive-git", /\bgit\s+(?:-C\s+\S+\s+)?reset\b[^\n;&|]*--hard\b/],
  ["destructive-git", /\bgit\s+(?:-C\s+\S+\s+)?branch\b[^\n;&|]*\s-D\b/],
  ["destructive-git", /\bgit\s+(?:filter-branch|filter-repo|reflog\s+expire)\b/],
  ["secret-read", new RegExp(`${SEP}printenv(?=\\s|$|[;&|)])`)],
  ["secret-read", new RegExp(`${SEP}env\\s*(?:$|[;&|)])`)],
  ["secret-read", new RegExp(`${SEP}(?:set|export\\s+-p|declare\\s+-[xp])\\s*(?:$|[;&|)])`)],
  ["secret-read", /\$\{?[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIALS?)[A-Z0-9_]*/],
  ["secret-read", /\bsecurity\s+(?:find-(?:generic|internet)-password|dump-keychain|export)\b/],
  ["secret-read", /\/proc\/\S*\/environ/],
  ["secret-read", /\bsops\s+(?:-d|--decrypt|decrypt)\b/],
  // untrusted code reaching a shell: fetch|sh, base64|sh, sh <(curl), eval "$(curl)"
  ["download-exec", /\|\s*(?:(?:\S*\/)?(?:sudo|env|xargs|exec)\s+(?:-\S+\s+)?)*(?:\S*\/)?(?:ba|z|da|k)?sh\b/],
  ["download-exec", /\b(?:curl|wget|base64)\b[^\n]*\|\s*(?:sudo\s+)?(?:python3?|node|perl|ruby|php)\b/],
  ["download-exec", /\b(?:ba|z|da|k)?sh\s+<\(\s*(?:curl|wget)\b/],
  ["download-exec", /\b(?:source|\.)\s+<\(\s*(?:curl|wget)\b/],
  ["download-exec", /\b(?:ba|z|da|k)?sh\b[^\n]*(?:\$\(|`)\s*(?:curl|wget)\b/],
  ["download-exec", /\beval\b[^\n]*(?:\$\(|`)\s*(?:curl|wget)\b/],
  ["download-exec", /\b(?:iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n]*\|\s*(?:iex|Invoke-Expression)\b/i],
  ["privileged", new RegExp(`${SEP}(?:sudo|doas)(?=\\s)`)],
  ["privileged", /\b(?:chmod|chown|chgrp)\s+(?:[^\n;&|]*\s)?-[a-zA-Z]*R/],
  ["destructive-infra", /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b/i],
  ["destructive-infra", /\bTRUNCATE\s+TABLE\b/i],
  ["destructive-infra", /\bterraform\s+destroy\b/],
  ["destructive-infra", /\bkubectl\s+delete\b/],
  ["destructive-infra", /\bdocker\s+(?:\S+\s+)?prune\b/],
  ["destructive-infra", /\b(?:mkfs(?:\.\w+)?|diskutil\s+(?:erase|partition))\b/],
  ["destructive-infra", /\bdd\b[^\n;&|]*\bof=\/dev\//],
  ["destructive-infra", /\bcrontab\s+-r\b/],
  ["destructive-infra", /\blaunchctl\s+(?:unload|bootout|remove)\b/],
  ["destructive-infra", /\bgh\s+repo\s+delete\b/],
  // an agent steering Agent Office itself (rewriting a policy, answering its own approval)
  ["self-control", /(?:127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(?::\d+)?\/(?:policy|approval|approvals|chat|open|templates\/apply|projects|items)\b/i],
  ["publish", /\b(?:npm|yarn|pnpm|cargo)\s+publish\b/],
  ["publish", /\bgh\s+(?:release\s+create|pr\s+merge)\b/],
  ["publish", /\btwine\s+upload\b/],
  ["publish", /\bdocker\s+push\b/],
];

// ── path rules ─────────────────────────────────────────────────────────────
const SECRET_BASENAMES = new Set([
  "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", ".npmrc", ".pypirc", ".netrc", ".pgpass",
  ".git-credentials", ".htpasswd", "credentials", "credentials.json", ".credentials.json", "kubeconfig",
  "secrets.json", "secrets.yml", "secrets.yaml", "secrets.toml", "service-account.json",
]);
const SECRET_DIRS = new Set([".ssh", ".gnupg", ".aws", ".kube"]);
const SECRET_EXT = /\.(?:pem|key|p12|pfx|jks|keystore|ppk)$/i;
const SAMPLE_SUFFIX = /\.(?:example|sample|template|dist|defaults)$/i;
const SHELL_RC = new Set([
  ".bashrc", ".zshrc", ".zprofile", ".zshenv", ".profile", ".bash_profile", ".bash_login", ".gitconfig",
]);

// verbs whose non-option arguments are written, moved, deleted or created
const WRITE_VERBS = new Set([
  "cp", "mv", "rm", "rmdir", "touch", "mkdir", "ln", "install", "chmod", "chown", "chgrp",
  "truncate", "tee", "rsync", "scp", "unzip", "tar", "dd", "shred",
]);

function realResolve(p) {
  const abs = path.resolve(p);
  const tail = [];
  for (let cur = abs; ; ) {
    try {
      return path.join(fs.realpathSync(cur), ...tail);
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

function expand(token, home) {
  if (token === "~") return home;
  if (token.startsWith("~/")) return path.join(home, token.slice(2));
  const m = /^\$\{?HOME\}?(\/.*)?$/.exec(token);
  if (m) return path.join(home, m[1] ?? "");
  return token;
}

/** Shell words + redirect targets. Quotes are stripped; `2>&1` style dups are dropped. */
function parseShell(cmd) {
  const segments = [];
  const redirects = [];
  let words = [];
  let cur = "";
  let has = false;
  let redirectNext = false;
  let dropNext = false;
  const pushWord = () => {
    if (!has) return;
    if (dropNext) dropNext = false;
    else if (redirectNext) {
      redirects.push(cur);
      redirectNext = false;
    } else words.push(cur);
    cur = "";
    has = false;
  };
  const endSegment = () => {
    pushWord();
    if (words.length > 0) segments.push(words);
    words = [];
  };
  let quote = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < cmd.length) cur += cmd[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < cmd.length) {
      cur += cmd[++i];
      has = true;
    } else if (c === ">") {
      if (has && /^\d+$/.test(cur)) {
        cur = "";
        has = false; // `2>file`: the 2 is the fd, not a word
      } else pushWord();
      if (cmd[i + 1] === ">") i++;
      if (cmd[i + 1] === "&") {
        i++;
        dropNext = true; // `2>&1`
      } else redirectNext = true;
    } else if (c === "\n" || c === ";" || c === "|" || c === "(" || c === ")" || c === "`") {
      endSegment();
    } else if (c === "&") {
      if (cmd[i + 1] === ">") continue; // `&>file`: the `>` branch takes over
      endSegment();
    } else if (/\s/.test(c)) {
      pushWord();
    } else {
      cur += c;
      has = true;
    }
  }
  endSegment();
  return { segments, redirects };
}

const WRAPPERS = new Set(["sudo", "doas", "command", "nohup", "time", "exec", "env", "timeout", "nice", "ionice", "xargs", "stdbuf", "setsid", "caffeinate"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);

/** Command verb of one segment, looking through `FOO=1`, sudo, env, timeout 60, nice -n 5, xargs -0 … */
function verbOf(words) {
  let wrapped = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^\w+=/.test(w)) continue;
    if (WRAPPERS.has(path.basename(w))) {
      wrapped = true;
      continue;
    }
    if (wrapped && (/^-/.test(w) || /^\d+[smhd]?$/.test(w))) continue; // the wrapper's own flags / duration
    return { verb: path.basename(w), args: words.slice(i + 1) };
  }
  return { verb: "", args: [] };
}

export function isSecretPath(p) {
  // lower-cased: macOS/Windows file systems ignore case, so `.ENV` is the same file as `.env`
  const clean = String(p).replace(/[\\/]+$/, "").toLowerCase();
  const base = path.basename(clean);
  if (!base || SAMPLE_SUFFIX.test(base)) return false;
  if (/^\.env(\..+)?$/.test(base)) return true;
  if (SECRET_BASENAMES.has(base) || SECRET_EXT.test(base)) return true;
  if (/(?:^|[\\/])(?:\.config[\\/]gh[\\/]hosts\.yml|\.docker[\\/]config\.json)$/.test(clean)) return true;
  return clean.split(/[\\/]/).some((seg) => SECRET_DIRS.has(seg)); // the directory itself counts, not only its children
}

function isSensitiveWriteTarget(absPath) {
  const abs = absPath.toLowerCase();
  const parts = abs.split(path.sep);
  const base = parts[parts.length - 1];
  if (SHELL_RC.has(base) || isSecretPath(abs) || base === ".envrc" || base === ".mcp.json") return true;
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === ".git") return true;
    if (parts[i] === ".claude" && (parts[i + 1] === "hooks" || /^settings.*\.json$/.test(parts[i + 1] ?? ""))) return true;
    if (parts[i] === "launchagents" || parts[i] === "launchdaemons" || parts[i] === ".husky") return true;
    if (parts[i] === ".github" && parts[i + 1] === "workflows") return true;
  }
  return base === "authorized_keys" || (parts.includes(".ssh") && base === "config");
}

/**
 * @param {{tool?: string, toolInput?: object|null, root: string, home?: string}} p
 *   `root` = the project directory (writes must stay inside it).
 * @returns {string[]} reason codes in a stable order; [] = nothing to ask about.
 */
export function classifyDanger({ tool = "", toolInput, root, home = os.homedir() }) {
  const input = toolInput && typeof toolInput === "object" ? toolInput : {};
  const reasons = new Set();
  if (input._truncated === true) reasons.add("uninspectable");
  const realRoot = realResolve(root);
  const inside = (abs) => abs === realRoot || abs.startsWith(realRoot + path.sep);

  /** Resolve a path-like token against the project; null for URLs/devices. */
  const resolveToken = (token) => {
    if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(token) || /^\/dev\/(?:null|std\w+|tty)$/.test(token)) return null;
    if (token.startsWith("$") && !/^\$\{?HOME\}?(\/|$)/.test(token)) return "/\0unknown"; // unresolvable → outside
    return realResolve(path.resolve(realRoot, expand(token, home)));
  };

  const checkWrite = (token) => {
    const abs = resolveToken(token);
    if (abs === null) return;
    if (!inside(abs)) reasons.add("outside-cwd-write");
    if (isSensitiveWriteTarget(abs)) reasons.add("sensitive-config-write");
  };

  /** One shell command string; recurses into `sh -c "…"` / `eval "…"` (depth-capped). */
  const scanBash = (cmd, depth) => {
    for (const [code, re] of SHELL_RULES) if (re.test(cmd)) reasons.add(code);
    scanFetchThenRun(cmd, reasons);
    for (const m of cmd.matchAll(/\bgit\s+(?:-C\s+\S+\s+)?push\b([^\n;&|"']*)/g)) {
      if (m[1].split(/\s+/).some(isForcePushArg)) reasons.add("force-push");
    }
    const { segments, redirects } = parseShell(cmd);
    for (const words of segments) {
      for (const w of words) if (isSecretPath(w)) reasons.add("secret-read");
      const { verb, args } = verbOf(words);
      if (depth < 3 && (SHELLS.has(verb) || verb === "eval")) {
        const i = verb === "eval" ? -1 : args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
        const inner = verb === "eval" ? args.join(" ") : i === -1 ? "" : (args[i + 1] ?? "");
        if (inner) scanBash(inner, depth + 1);
      }
      if (verb === "cd" || verb === "pushd") {
        // later relative paths are then relative to somewhere else: do not try to follow, ask instead
        const abs = args[0] ? resolveToken(args[0]) : os.homedir();
        if (abs !== null && !inside(abs)) reasons.add("outside-cwd-write");
      }
      if (verb === "git") gitRules(args, reasons);
      if ((verb === "sed" || verb === "perl") && args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))) args.filter((a) => !a.startsWith("-")).forEach(checkWrite);
      else if (verb === "curl" || verb === "wget") fetchTargets(verb, args).forEach(checkWrite);
      else if (WRITE_VERBS.has(verb)) {
        for (const a of args) {
          if (a.startsWith("of=")) checkWrite(a.slice(3));
          else if (a.startsWith("--target-directory=")) checkWrite(a.slice("--target-directory=".length));
          else if (!a.startsWith("-")) checkWrite(a);
        }
      }
    }
    for (const r of redirects) {
      if (isSecretPath(r)) reasons.add("sensitive-config-write");
      checkWrite(r);
    }
  };

  if (tool === "Bash") {
    // no command string at all is not "nothing to do": we cannot tell what would run
    if (typeof input.command !== "string" || input.command === "") reasons.add("uninspectable");
    else scanBash(input.command, 0);
  } else {
    const target = PATH_KEYS.map((k) => input[k]).find((v) => typeof v === "string" && v !== "");
    const globTarget = tool === "Glob" && typeof input.pattern === "string" ? input.pattern : null;
    for (const p of [target, globTarget]) if (p && isSecretPath(expand(p, home))) {
      if (FILE_WRITE_TOOLS.has(tool)) reasons.add("sensitive-config-write");
      else reasons.add("secret-read");
    }
    // MCP shells (desktop-commander start_process, shell run …) carry a command string too
    const cmdLike = typeof input.command === "string" ? input.command : typeof input.cmd === "string" ? input.cmd : null;
    if (cmdLike !== null) scanBash(cmdLike, 0);
    // MCP/unknown tools that look like writers (mcp__fs__write_file {path}) are judged like Write
    const writeLike = FILE_WRITE_TOOLS.has(tool) || /write|edit|create|delete|move|remove|save/i.test(tool);
    if (writeLike && target) checkWrite(target);
    if (/^(?:WebFetch|WebSearch)$/.test(tool) || /fetch|http|request/i.test(tool)) {
      for (const v of Object.values(input)) if (typeof v === "string" && SHELL_RULES.some(([c, re]) => c === "self-control" && re.test(v))) reasons.add("self-control");
    }
  }

  return ORDER.filter((code) => reasons.has(code));
}

/** git: find the subcommand past global options (`-C dir`, `-c k=v`, `--no-pager`, …), then judge its arguments. */
function gitRules(args, reasons) {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += ["-C", "-c", "--git-dir", "--work-tree", "--namespace"].includes(args[i]) ? 2 : 1;
  const sub = args[i];
  const rest = args.slice(i + 1);
  if (sub === "push" && rest.some(isForcePushArg)) reasons.add("force-push");
  else if (sub === "reset" && rest.includes("--hard")) reasons.add("destructive-git");
  else if (sub === "clean" && rest.some((a) => /^-[a-zA-Z]*f/.test(a) || a === "--force")) reasons.add("recursive-delete");
  else if (sub === "branch" && rest.includes("-D")) reasons.add("destructive-git");
  else if (["filter-branch", "filter-repo"].includes(sub) || (sub === "reflog" && rest.includes("expire"))) reasons.add("destructive-git");
  else if (sub === "config" && rest.some((a) => /^core\.hookspath$/i.test(a))) reasons.add("sensitive-config-write");
}

/** One `git push` argument that forces, deletes, mirrors, or names a `+ref` / `:ref`. */
const isForcePushArg = (a) =>
  /^(?:--force(?:-with-lease)?(?:=.*)?|--mirror|--delete|-d|-[a-zA-Z]*f[a-zA-Z]*)$/.test(a) || /^[+:]\S/.test(a);

/** curl -o f / wget -O f: the file(s) the download lands in. */
function fetchTargets(verb, args) {
  const flags = verb === "curl" ? ["-o", "--output"] : ["-O", "-P", "--output-document", "--directory-prefix"];
  return args.flatMap((a, i) => (flags.includes(a) && args[i + 1] ? [args[i + 1]] : []));
}

/** curl/wget that saves a file, then a later `&&`/`;` step that runs something. Segment by segment: linear, no regex backtracking over a long chain. */
function scanFetchThenRun(cmd, reasons) {
  const steps = cmd.split(/&&|\|\||;|\n/);
  const saved = steps.findIndex(
    (st) => /\b(?:curl|wget)\b/.test(st) && (/\s(?:-[a-zA-Z]*[oO]\b|--output|--remote-name)/.test(st) || />>?\s*\S/.test(st)),
  );
  if (saved !== -1 && steps.slice(saved + 1).some((st) => /(?:^|\s)(?:chmod\s+\+x|(?:ba|z)?sh\b|source\b|python3?\b|node\b|\.\/)/.test(st))) {
    reasons.add("download-exec");
  }
}
