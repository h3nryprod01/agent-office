// lane A (N2): `ao approvals setup | remove` — answer Claude Code permission prompts from a phone.
//
//   setup   (a) is the daemon running?  (b) register the PermissionRequest hook in ~/.claude/settings.json
//           (asks first, backs the file up, merges without touching other keys)  (c) a Telegram bot token
//           in the daemon's environment  (d) pair your phone with a one-time code  (e) send a test approval
//           and wait for the tap.
//   remove  take the hook out again (same backup rule).
//
// `--dry-run` shows what (b) would change and does (a), (c), (d), but never writes the settings file and
// never sends the test approval (e). It refuses port 8787 (the default daemon): a dry run is for a test daemon.
//
// Secrets: the bot token is never printed, never stored by this command, never put in a URL we print.
// Everything with side effects (fs, network, prompts, clock) is injected so tests run on a temp HOME, a
// test daemon and a fake Telegram.

import fs from "node:fs";
import path from "node:path";

export const GATEWAY_FILE = "approve-gateway.mjs";
export const DEFAULT_PORT = 8787;
const MATCHER = "Bash|Edit|Write";
const HOOK_TIMEOUT_S = 120; // just above the gateway's own 118s abort, see hooks/approve-gateway.mjs

// ── the settings.json change (pure) ──────────────────────────────────────────────────────
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const commandsOf = (entry) => (Array.isArray(entry?.hooks) ? entry.hooks.map((h) => (typeof h?.command === "string" ? h.command : "")) : []);
const isOurs = (entry) => commandsOf(entry).some((c) => c.includes(GATEWAY_FILE));

/** The shell command Claude Code runs. A non-default port is passed through the environment the gateway reads. */
export function gatewayCommand({ repo, port = DEFAULT_PORT, platform = process.platform }) {
  const script = path.join(repo, "packages", "daemon", "hooks", GATEWAY_FILE);
  const prefix = port !== DEFAULT_PORT && platform !== "win32" ? `AGENT_OFFICE_PORT=${port} ` : "";
  return `${prefix}node "${script}"`;
}

export function hookEntry(command) {
  return { matcher: MATCHER, hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_S }] };
}

/** @returns {{ok: true, next: object, state: "added"|"already"} | {ok: false, error: string}} */
export function planInstall(settings, command) {
  if (!isObject(settings)) return { ok: false, error: "settings.json is not a JSON object" };
  if (settings.hooks !== undefined && !isObject(settings.hooks)) return { ok: false, error: '"hooks" in settings.json is not an object' };
  const list = settings.hooks?.PermissionRequest;
  if (list !== undefined && !Array.isArray(list)) return { ok: false, error: '"hooks.PermissionRequest" in settings.json is not a list' };
  const existing = (list ?? []).filter(isOurs);
  if (existing.length > 0) {
    const same = existing.some((e) => commandsOf(e).includes(command));
    if (same) return { ok: true, next: settings, state: "already" };
    return { ok: false, error: `an Agent Office approve hook is already registered with a different command (${commandsOf(existing[0]).find((c) => c.includes(GATEWAY_FILE))}). Run "ao approvals remove" first.` };
  }
  const next = { ...settings, hooks: { ...(settings.hooks ?? {}), PermissionRequest: [...(list ?? []), hookEntry(command)] } };
  return { ok: true, next, state: "added" };
}

/** @returns {{ok: true, next: object, removed: number} | {ok: false, error: string}} */
export function planRemove(settings) {
  if (!isObject(settings)) return { ok: false, error: "settings.json is not a JSON object" };
  const list = settings.hooks?.PermissionRequest;
  if (list === undefined) return { ok: true, next: settings, removed: 0 };
  if (!Array.isArray(list)) return { ok: false, error: '"hooks.PermissionRequest" in settings.json is not a list' };
  let removed = 0;
  const kept = [];
  for (const entry of list) {
    if (!isOurs(entry)) {
      kept.push(entry);
      continue;
    }
    // an entry that also holds someone else's hook keeps those
    const others = (entry.hooks ?? []).filter((h) => !(typeof h?.command === "string" && h.command.includes(GATEWAY_FILE)));
    removed += (entry.hooks ?? []).length - others.length;
    if (others.length > 0) kept.push({ ...entry, hooks: others });
  }
  if (removed === 0) return { ok: true, next: settings, removed: 0 };
  const { PermissionRequest: _old, ...restHooks } = settings.hooks;
  const hooks = kept.length > 0 ? { ...restHooks, PermissionRequest: kept } : restHooks;
  const { hooks: _h, ...rest } = settings;
  return { ok: true, next: Object.keys(hooks).length > 0 ? { ...rest, hooks } : rest, removed };
}

// ── settings file I/O ────────────────────────────────────────────────────────────────────
export function settingsPath(home) {
  return path.join(home, ".claude", "settings.json");
}

/** @returns {{ok: true, settings: object, exists: boolean} | {ok: false, error: string}} */
export function readSettings(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { ok: true, settings: {}, exists: false };
    return { ok: false, error: `cannot read ${file}: ${error.code ?? "error"}` };
  }
  if (text.trim() === "") return { ok: true, settings: {}, exists: true };
  try {
    return { ok: true, settings: JSON.parse(text), exists: true };
  } catch {
    return { ok: false, error: `${file} is not valid JSON; nothing was changed. Fix it, then run this again.` };
  }
}

const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

/** Back up (when the file exists), then write atomically with the file's own permissions. @returns {{backup: string|null}} */
export function writeSettings(file, next, { now = Date.now } = {}) {
  let mode = 0o600;
  let backup = null;
  if (fs.existsSync(file)) {
    mode = fs.statSync(file).mode & 0o777;
    backup = `${file}.ao-backup-${stamp(now())}`;
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backup, mode);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const tmp = `${file}.ao-tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode });
  fs.renameSync(tmp, file);
  return { backup };
}

// ── talking to the daemon ────────────────────────────────────────────────────────────────
function makeApi({ port, fetchFn }) {
  const base = `http://127.0.0.1:${port}`;
  return async (method, p, body, timeoutMs = 10_000) => {
    const res = await fetchFn(base + p, {
      method,
      headers: { "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      // not JSON
    }
    return { status: res.status, body: json };
  };
}

const USAGE = `Usage:
  ao approvals setup  [--dry-run] [--yes] [--project <slug>] [--port N] [--wait <seconds>]
  ao approvals remove [--dry-run] [--yes]
Registers (or removes) the Claude Code hook that lets you answer permission prompts from Telegram.
--dry-run changes nothing and sends nothing; it refuses port ${DEFAULT_PORT} (the default daemon): use a test daemon.`;

const TOKEN_HELP = [
  "No bot token reaches the daemon yet. To make a bot:",
  "  1. In Telegram open @BotFather, send /newbot, pick a name; it replies with a token.",
  "  2. Put the token in the DAEMON's environment as TELEGRAM_BOT_TOKEN, never in a file you commit.",
  "     (e.g. `sv run TELEGRAM_BOT_TOKEN -- <start command>`, or the service's own env file.) Then restart the daemon.",
  "  This command never prints or stores the token.",
];

function option(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

/**
 * @param {string[]} argv everything after "approvals"
 * @param {Object} ctx
 * @param {string} ctx.repo checkout the hook script lives in
 * @param {string} ctx.home the user's home directory (HOME), where .claude/settings.json is
 * @param {number} ctx.port daemon port
 * @param {(m: string) => void} ctx.log
 * @param {(question: string) => Promise<string>} [ctx.ask] "" when there is no one to ask
 * @param {(question: string) => Promise<string>} [ctx.askHidden] reads a secret without echo
 * @param {NodeJS.ProcessEnv} [ctx.env]
 * @param {typeof fetch} [ctx.fetchFn]
 * @param {(ms: number) => Promise<void>} [ctx.sleep]
 * @param {() => number} [ctx.now]
 * @param {string} [ctx.telegramApiBase] tests only: a fake Telegram server
 * @returns {Promise<number>} 0 done, 1 error, 2 usage, 3 stopped waiting for you
 */
export async function runApprovalsCommand(argv, ctx) {
  const {
    repo, home, port, log, ask = async () => "", askHidden = async () => "", env = process.env,
    fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now,
    telegramApiBase = "https://api.telegram.org", platform = process.platform,
  } = ctx;
  const [action, ...rest] = argv;
  const dryRun = rest.includes("--dry-run");
  const yes = rest.includes("--yes");
  if (action !== "setup" && action !== "remove") {
    log(USAGE);
    return action ? 2 : 0;
  }
  if (dryRun && port === DEFAULT_PORT) {
    log(`--dry-run refuses port ${DEFAULT_PORT}: that is the default (real) daemon. Start a test daemon on another port and pass --port <N>.`);
    return 2;
  }
  const file = settingsPath(home);
  const command = gatewayCommand({ repo, port, platform });
  const confirm = async (question) => yes || /^y(es)?$/i.test((await ask(`${question} [y/N] `)).trim());

  // ── the settings change, shared by setup and remove ──
  async function changeSettings(plan, { verb, doneText }) {
    const read = readSettings(file);
    if (!read.ok) return log(`  ✗ ${read.error}`), 1;
    const result = plan(read.settings);
    if (!result.ok) return log(`  ✗ ${result.error}`), 1;
    if (result.state === "already" || result.removed === 0) return log(`  ✓ ${verb === "remove" ? "no Agent Office hook in" : "already registered in"} ${file}`), 0;
    log(`  Change to ${file}${read.exists ? "" : " (the file does not exist yet)"}:`);
    for (const line of JSON.stringify(verb === "remove" ? { removed: `PermissionRequest hook running ${GATEWAY_FILE}` } : { hooks: { PermissionRequest: [hookEntry(command)] } }, null, 2).split("\n")) log(`    ${line}`);
    log("  Everything else in the file is kept; the file is re-written as 2-space JSON.");
    if (dryRun) return log("  (dry run: nothing written)"), 0;
    if (!(await confirm(`  Write this to ${file}?`))) return log("  Not written."), 3;
    try {
      const { backup } = writeSettings(file, result.next, { now });
      log(`  ✓ ${doneText}${backup ? `\n  Backup of the old file: ${backup}` : ""}`);
      return 0;
    } catch (error) {
      return log(`  ✗ could not write ${file}: ${error.code ?? "error"}. The old file is untouched.`), 1;
    }
  }

  if (action === "remove") {
    log("Removing the Agent Office approve hook");
    const code = await changeSettings(planRemove, { verb: "remove", doneText: "removed. Claude Code shows its normal prompts again (new sessions)." });
    return code;
  }

  // ── setup ──
  const api = makeApi({ port, fetchFn });
  let failed = false;

  log(`Agent Office: approve from your phone${dryRun ? " (DRY RUN: nothing is written, no test approval is sent)" : ""}\n`);

  log(`(a) Daemon on port ${port}`);
  let channels = null;
  try {
    const r = await api("GET", "/channels");
    channels = r.status === 200 ? r.body?.channels : null;
  } catch {
    // handled below
  }
  const daemonUp = channels !== null;
  if (daemonUp) log("  ✓ running");
  else {
    log(`  ✗ no Agent Office daemon answered on port ${port}. Start it, then run this again. (The hook below can still be registered.)`);
    failed = true;
  }

  log("\n(b) Claude Code hook");
  const hookCode = await changeSettings((s) => planInstall(s, command), { verb: "install", doneText: "registered. New Claude Code sessions will ask your phone (when someone can answer), else show the normal prompt." });
  if (hookCode === 1) return 1;
  if (hookCode === 3) log("  Skipped. Run this again when you want it.");
  if (!daemonUp) return 1;

  log("\n(c) Telegram bot");
  if (channels.telegram?.enabled) {
    log("  ✓ the daemon has a bot token");
  } else {
    for (const line of TOKEN_HELP) log(`  ${line}`);
    const token = await checkToken({ env, askHidden, fetchFn, telegramApiBase, log });
    log(token === "ok" ? "  When the daemon runs with it, run this command again." : "  Then run this command again.");
    return 3;
  }

  log("\n(d) Pair your phone");
  const project = await pickProject({ api, rest, ask, log });
  if (typeof project === "number") return project;
  const approvers = project.members.filter((m) => (m.role === "owner" || m.role === "manager") && m.channels.includes("telegram"));
  if (approvers.length > 0) {
    log(`  ✓ ${project.slug} already has ${approvers.map((m) => `${m.name} (${m.role})`).join(", ")} on Telegram`);
  } else {
    const made = await api("POST", "/pairing", { project: project.slug, role: "owner" });
    if (made.status !== 201 || !made.body?.code) return log(`  ✗ could not create a pairing code (HTTP ${made.status})`), 1;
    log(`  Open your bot in Telegram and send:   /pair ${made.body.code}`);
    log("  The code works once and expires in 15 minutes. Waiting…");
    const paired = await waitForPairing({ api, slug: project.slug, before: project.members.length, waitMs: Number(option(rest, "--wait") ?? 300) * 1000, sleep, now });
    if (!paired) return log("  ✗ nobody paired in time. Run this again for a new code."), 3;
    log(`  ✓ paired: ${paired.name} (${paired.role})`);
  }

  log("\n(e) Test approval");
  if (dryRun) {
    log("  (dry run: not sent)");
    log("\nDry run complete.");
    return 0;
  }
  const cwd = (await api("GET", `/policy?project=${encodeURIComponent(project.slug)}`)).body?.cwd;
  if (typeof cwd !== "string") return log("  ✗ could not read the project folder from the daemon"), 1;
  log("  Sent. Look at Telegram and tap Allow or Deny (waits up to about 2 minutes).");
  const t0 = now();
  let answer;
  try {
    answer = (await api("POST", "/approval-request", { sessionId: "ao-setup-test", tool: "Bash", toolInput: { command: "echo Agent Office approval test: tap Allow or Deny" }, cwd, harness: "claude" }, 125_000)).body?.decision;
  } catch {
    answer = "none";
  }
  if (answer === "allow" || answer === "deny") {
    log(`  ✓ got "${answer}" from your phone. Approving from Telegram works.`);
    if (answer === "allow" && now() - t0 < 1500) log("  Note: that came back instantly, so the project's policy may have answered it (mode auto). Check Settings > Approval policy.");
    log("\nDone.");
    return 0;
  }
  log("  ✗ no answer. Check that you paired as owner/manager, that you did not block the bot, then try again.");
  return 3;
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────
/** Validate a token the user has at hand (env or hidden prompt) without ever showing it. */
async function checkToken({ env, askHidden, fetchFn, telegramApiBase, log }) {
  const token = env.TELEGRAM_BOT_TOKEN || (await askHidden("  Paste the token here only to check it (hidden, not stored), or press Enter to skip: ")).trim();
  if (!token) return "none";
  try {
    const res = await fetchFn(`${telegramApiBase}/bot${token}/getMe`, { signal: AbortSignal.timeout(10_000) });
    const body = await res.json();
    if (body?.ok && body.result?.username) {
      log(`  ✓ that token belongs to @${body.result.username}`);
      return "ok";
    }
    log("  ✗ Telegram did not accept that token.");
  } catch {
    log("  ✗ could not reach Telegram to check the token.");
  }
  return "bad";
}

async function pickProject({ api, rest, ask, log }) {
  const r = await api("GET", "/overview");
  const projects = r.body?.projects ?? [];
  if (projects.length === 0) return log("  ✗ no project yet: create one in the office (Projects), then run this again."), 1;
  const wanted = option(rest, "--project");
  let chosen = wanted ? projects.find((p) => p.slug === wanted) : projects.length === 1 ? projects[0] : null;
  if (wanted && !chosen) return log(`  ✗ no project "${wanted}". Yours: ${projects.map((p) => p.slug).join(", ")}`), 1;
  if (!chosen) {
    const answer = (await ask(`  Which project? (${projects.map((p) => p.slug).join(", ")}): `)).trim();
    chosen = projects.find((p) => p.slug === answer);
    if (!chosen) return log("  ✗ pass --project <slug>."), 2;
  }
  return { slug: chosen.slug, members: (chosen.members ?? []).map((m) => ({ ...m, channels: m.channels ?? [] })) };
}

async function waitForPairing({ api, slug, before, waitMs, sleep, now }) {
  const deadline = now() + waitMs;
  while (now() < deadline) {
    const r = await api("GET", "/overview").catch(() => null);
    const p = r?.body?.projects?.find((x) => x.slug === slug);
    const members = p?.members ?? [];
    if (members.length > before) return members[members.length - 1];
    await sleep(1500);
  }
  return null;
}
