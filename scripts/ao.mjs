#!/usr/bin/env node
// Agent Office command line: the operations a person who just installed it needs.
//   doctor [--port N] [--json] [--preflight]   is this machine ready, and how to fix what is not
//   update [--dry-run]                          back up, pull, build, restart
//   backup [--out DIR]                          archive ~/.agent-office
//   restore <archive> [--no-restart]            put an archive back (the current data is moved aside)
//   lan on|off|status                           let other machines in, with a token
//   token add|list|revoke                       who may connect, and as what
// The shell wrappers (start.sh, start.ps1, install-ubuntu.sh) forward these verbs here.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { agentOfficeHome, AccessStore } from "../packages/daemon/src/access.js";
import { runChecks, formatReport, exitCode } from "../packages/daemon/src/cli/doctor.js";
import { createBackup, restoreBackup, defaultBackupDir } from "../packages/daemon/src/cli/backup.js";
import { runUpdate, restartCommand, defaultRun } from "../packages/daemon/src/cli/update.js";
import { runAccessCommand, lanAddresses } from "../packages/daemon/src/cli/access-cmd.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const home = agentOfficeHome();

function flag(argv, name) {
  return argv.includes(name);
}
function option(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

const HELP = `Agent Office

  doctor [--port N] [--json] [--preflight]
  update [--dry-run]
  backup [--out DIR]          (default ${defaultBackupDir()})
  restore <archive.tar.gz> [--no-restart]
  lan on|off|status
  token add --label <name> --role owner|manager|viewer
  token list | token revoke <id|label>`;

async function main(argv) {
  const [verb, ...rest] = argv;
  const port = Number(option(rest, "--port") ?? process.env.DAEMON_WS_PORT ?? 8787);

  switch (verb) {
    case "doctor": {
      const preflight = flag(rest, "--preflight");
      const results = await runChecks({ repo, home, port, preflight });
      if (flag(rest, "--json")) console.log(JSON.stringify(results, null, 2));
      else console.log(formatReport(results, { onlyProblems: preflight }));
      return exitCode(results, { preflight });
    }
    case "update": {
      try {
        await runUpdate({ repo, home, port, dryRun: flag(rest, "--dry-run") });
        return 0;
      } catch (error) {
        console.error(`\nupdate stopped: ${error.message}`);
        return 1;
      }
    }
    case "backup": {
      try {
        const { archive } = createBackup({ home, outDir: option(rest, "--out") ?? defaultBackupDir() });
        console.log(`Backup written: ${archive}\nIt contains your access tokens' hashes: keep it private.`);
        return 0;
      } catch (error) {
        console.error(`backup failed: ${error.message}`);
        return 1;
      }
    }
    case "restore": {
      const archive = rest.find((a) => !a.startsWith("--"));
      if (!archive) {
        console.error("usage: restore <archive.tar.gz>");
        return 2;
      }
      try {
        const { aside, entries } = restoreBackup({ archive: path.resolve(archive), home });
        console.log(`Restored ${entries} entries into ${home}.`);
        if (aside) console.log(`Your previous data was kept at: ${aside}\nDelete it yourself once you are happy.`);
        // the access list comes back with the data: say who is let in, don't let it be a surprise
        const access = new AccessStore();
        const people = access.list();
        if (access.lanEnabled() || people.length) {
          console.log(
            `Restored access settings: LAN ${access.lanEnabled() ? "ON" : "off"}, ${people.length} token(s)` +
              `${people.length ? ` (${people.map((t) => `${t.label}:${t.role}`).join(", ")})` : ""}. Check with: ao token list`,
          );
        }
        if (flag(rest, "--no-restart")) {
          console.log("Not restarting (--no-restart): restart the daemon to load the restored data.");
        } else {
          const { cmd, args } = restartCommand();
          const r = defaultRun(cmd, args);
          console.log(
            r.status === 0
              ? "Service restarted with the restored data."
              : `Could not restart the service. Restart it yourself: ${[cmd, ...args].join(" ")}`,
          );
        }
        return 0;
      } catch (error) {
        console.error(`restore failed (nothing was changed): ${error.message}`);
        if (process.platform === "win32") console.error("If a file was locked: stop the AgentOfficeDaemon task (Stop-ScheduledTask) and run restore again.");
        return 1;
      }
    }
    case "lan":
    case "token":
      try {
        return runAccessCommand(argv, {
          store: new AccessStore(),
          log: (m) => console.log(m),
          port,
          platform: process.platform,
          addresses: lanAddresses,
          restart: () => {
            const { cmd, args } = restartCommand();
            const r = defaultRun(cmd, args);
            return { ok: r.status === 0, hint: [cmd, ...args].join(" ") };
          },
        });
      } catch (error) {
        console.error(error.message); // e.g. "access.json is unreadable; fix or move it aside first"
        return 1;
      }
    default:
      console.log(HELP);
      return verb ? 2 : 0;
  }
}

process.exitCode = await main(process.argv.slice(2));
