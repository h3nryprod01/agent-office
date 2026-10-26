// lane L1: `ao lan on|off|status` and `ao token add|list|revoke`.
// A token's plaintext exists only in the output of the command that created it.

import os from "node:os";
import { ROLES } from "../access.js";

const PLAIN_HTTP_WARNING =
  "Note: this is plain http. The token crosses the network in cleartext, so use it on a trusted network,\n" +
  "or put a VPN (e.g. Tailscale) / an HTTPS reverse proxy in front. See docs/onprem.md.";

export function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return out;
}

export function lanLinks(token, port, addresses) {
  const hosts = addresses.length ? addresses : ["localhost"];
  return hosts.map((h) => `http://${h}:${port}/?ao_token=${token}`);
}

function option(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
}

const USAGE = `Usage:
  ao lan on [--no-restart]      let other machines in (token required); creates the first owner token
  ao lan off [--no-restart]     back to this machine only (tokens are kept)
  ao lan status
  ao token add --label <name> --role <${ROLES.join("|")}>
  ao token list
  ao token revoke <id|label>`;

/**
 * @param {string[]} argv  everything after the program name, e.g. ["token","add",…]
 * @param {{store, log, restart: () => {ok: boolean, hint?: string}, addresses: () => string[], port: number}} ctx
 * @returns {number} exit code
 */
export function runAccessCommand(argv, ctx) {
  const { store, log, restart, port } = ctx;
  const [group, action] = argv;

  const restartIfWanted = () => {
    if (argv.includes("--no-restart")) {
      log("Not restarting (--no-restart). The change applies the next time the daemon starts.");
      return;
    }
    const r = restart();
    if (r.ok) log("Service restarted.");
    else log(`The change is saved, but the service did not restart. Restart it yourself: ${r.hint}`);
  };

  const printLinks = (token, role) => {
    log(`Access link (${role}) — shown once, copy it now:`);
    for (const link of lanLinks(token, port, ctx.addresses())) log(`  ${link}`);
  };

  if (group === "lan") {
    if (action === "status") {
      const tokens = store.list();
      log(`LAN access (as configured in access.json; the daemon applies it at its next start): ${store.lanEnabled() ? "ON (bind 0.0.0.0, token required for other machines)" : "off (this machine only)"}`);
      if (store.skippedCount()) log(`Note: ${store.skippedCount()} entr${store.skippedCount() === 1 ? "y" : "ies"} in access.json could not be read by this version; kept as they are, never used.`);
      log(`Tokens: ${tokens.length}${tokens.length ? ` (${tokens.map((t) => `${t.label}:${t.role}`).join(", ")})` : ""}`);
      return 0;
    }
    if (action === "on") {
      store.setLan(true);
      log("LAN access enabled.");
      if (store.list().length === 0) {
        const { token } = store.addToken({ label: "owner", role: "owner" });
        printLinks(token, "owner");
      } else {
        log("Existing tokens keep working. Add one for someone: ao token add --label <name> --role viewer");
      }
      log(PLAIN_HTTP_WARNING);
      if (ctx.platform === "win32") {
        log("Windows: allow node.exe through the firewall when asked (Private networks), or other machines cannot connect.");
      }
      restartIfWanted();
      return 0;
    }
    if (action === "off") {
      store.setLan(false);
      log("LAN access disabled — only this machine can connect. Tokens were kept.");
      restartIfWanted();
      return 0;
    }
  }

  if (group === "token") {
    if (action === "list") {
      const tokens = store.list();
      if (tokens.length === 0) log("No tokens yet. Create one: ao token add --label <name> --role viewer");
      for (const t of tokens) log(`${t.id}  ${t.role.padEnd(7)}  ${t.label}  (created ${t.createdAt.slice(0, 10)})`);
      return 0;
    }
    if (action === "add") {
      const label = option(argv, "--label");
      const role = option(argv, "--role");
      if (!label || !ROLES.includes(role)) {
        log(`--label and --role are required; role is one of ${ROLES.join(", ")}.\n${USAGE}`);
        return 2;
      }
      const { token } = store.addToken({ label, role });
      printLinks(token, role);
      if (!store.lanEnabled()) log("LAN access is still off — turn it on with: ao lan on");
      return 0;
    }
    if (action === "revoke") {
      const target = argv[2];
      if (!target) {
        log(USAGE);
        return 2;
      }
      if (store.revoke(target)) {
        log(`Revoked ${target}. It stops working immediately.`);
        return 0;
      }
      log(`No token with id or label "${target}". See: ao token list`);
      return 1;
    }
  }

  log(USAGE);
  return 2;
}
