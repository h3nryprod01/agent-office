// Pure helpers for the one-command launcher (bin/office.js). No I/O here so the
// argument rules and platform choices can be unit-tested.
import path from "node:path";

export const DEFAULT_PORT = 8787;

const FLAGS = new Set(["--port", "--no-open", "--install-service", "--yes", "-y", "--help", "-h"]);

/**
 * @param {string[]} argv arguments after the program name
 * @returns {{port:number, open:boolean, installService:boolean, yes:boolean, help:boolean, passthrough:string[]|null, error:string|null}}
 */
export function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, open: true, installService: false, yes: false, help: false, passthrough: null, error: null };
  // A first word that is not a flag ("doctor", "backup", ...) belongs to the ao CLI.
  if (argv.length > 0 && !argv[0].startsWith("-")) return { ...out, passthrough: [...argv] };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s, 2);
    if (!FLAGS.has(flag)) return { ...out, error: `unknown option ${argv[i]} (try --help)` };
    if (flag === "--port") {
      const raw = inline ?? argv[++i];
      const n = Number(raw);
      if (raw === undefined || !/^\d+$/.test(String(raw)) || n < 1 || n > 65535) {
        return { ...out, error: `--port needs a number from 1 to 65535 (got ${raw === undefined ? "nothing" : raw})` };
      }
      out.port = n;
    } else if (flag === "--no-open") out.open = false;
    else if (flag === "--install-service") out.installService = true;
    else if (flag === "--yes" || flag === "-y") out.yes = true;
    else out.help = true;
  }
  return out;
}

/** True when the package sits in npm's throwaway npx cache (a service pointing there would break). */
export function isEphemeralInstall(pkgDir) {
  return /(^|[\\/])_npx([\\/]|$)/.test(pkgDir);
}

export function nodeMajorOk(version) {
  const m = /^v?(\d+)\./.exec(version);
  return m !== null && Number(m[1]) >= 20;
}

/** [command, args] that opens `url` in the default browser. */
export function browserCommand(platform, url) {
  if (platform === "darwin") return ["open", [url]];
  if (platform === "win32") return ["cmd", ["/c", "start", "", url]];
  return ["xdg-open", [url]];
}

/** Environment for the daemon child: port, and a workspace outside the package directory. */
export function daemonEnv(base, port, home) {
  return {
    ...base,
    DAEMON_WS_PORT: String(port),
    AGENT_OFFICE_REPO: base.AGENT_OFFICE_REPO || path.join(home, ".agent-office", "workspace"),
  };
}

/** `update` pulls with git: refuse unless this package is itself a git checkout. Returns a message or null. */
export function updateRefusal(passthrough, hasGit, pkgName) {
  if (!passthrough || passthrough[0] !== "update" || hasGit) return null;
  return `\`update\` works on a git clone. This is an installed package; to update it run: npm i -g ${pkgName}@latest`;
}

/** [command, args] for the login-service installer; PowerShell spells the switch -Yes. */
export function serviceCommand(platform, pkgRoot, yes) {
  if (platform === "win32") {
    const file = `${pkgRoot}\\scripts\\install-daemon-service.ps1`;
    return ["powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", file, ...(yes ? ["-Yes"] : [])]];
  }
  const script = platform === "linux" ? "install-daemon-service-linux.sh" : "install-daemon-service.sh";
  return ["bash", [`${pkgRoot}/scripts/${script}`, ...(yes ? ["--yes"] : [])]];
}

/** True when an HTTP body is Agent Office's own page. */
export function looksLikeOffice(body) {
  return /<title>\s*Agent Office/i.test(body);
}
