// lane L1: `ao lan …` and `ao token …`. The thing that matters most: a plaintext
// token is printed exactly once, at creation, and never again.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runAccessCommand, lanLinks } from "../src/cli/access-cmd.js";
import { AccessStore } from "../src/access.js";

function setup(over = {}) {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ao-cmd-")), "access.json");
  const logs = [];
  const restarts = [];
  const ctx = {
    store: new AccessStore({ file }),
    log: (m) => logs.push(m),
    restart: () => (restarts.push(1), { ok: true }),
    addresses: () => ["192.0.2.10"],
    port: 8787,
    platform: "linux",
    ...over,
  };
  return { ctx, logs, restarts, text: () => logs.join("\n"), file };
}

test("lan on: enables LAN, creates the first owner token, prints a working link once, restarts", () => {
  const { ctx, text, restarts, file } = setup();
  const code = runAccessCommand(["lan", "on"], ctx);
  assert.equal(code, 0);
  assert.equal(new AccessStore({ file }).lanEnabled(), true);
  const tokens = new AccessStore({ file }).list();
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].role, "owner");
  const link = /http:\/\/192\.0\.2\.10:8787\/\?ao_token=(ao_[A-Za-z0-9_-]{43})/.exec(text());
  assert.ok(link, `expected a one-time link in:\n${text()}`);
  assert.equal(new AccessStore({ file }).verify(link[1]).role, "owner");
  assert.equal(restarts.length, 1);
  assert.match(text(), /plain http|cleartext|trusted network/i, "must warn that the token crosses the LAN in clear");
});

test("lan on twice does not mint another owner token", () => {
  const { ctx, file } = setup();
  runAccessCommand(["lan", "on"], ctx);
  runAccessCommand(["lan", "on"], ctx);
  assert.equal(new AccessStore({ file }).list().length, 1);
});

test("lan on --no-restart leaves the service alone", () => {
  const { ctx, restarts } = setup();
  runAccessCommand(["lan", "on", "--no-restart"], ctx);
  assert.equal(restarts.length, 0);
});

test("lan off: turns it off, keeps the tokens, restarts", () => {
  const { ctx, restarts, file } = setup();
  runAccessCommand(["lan", "on"], ctx);
  runAccessCommand(["lan", "off"], ctx);
  const store = new AccessStore({ file });
  assert.equal(store.lanEnabled(), false);
  assert.equal(store.list().length, 1);
  assert.equal(restarts.length, 2);
});

test("lan status reports state without creating anything", () => {
  const { ctx, text, file } = setup();
  assert.equal(runAccessCommand(["lan", "status"], ctx), 0);
  assert.match(text(), /off/i);
  assert.equal(fs.existsSync(file), false);
});

test("token add: prints a link for the role, and list never shows a token or hash", () => {
  const { ctx, logs, text } = setup();
  assert.equal(runAccessCommand(["token", "add", "--label", "Mai", "--role", "viewer"], ctx), 0);
  assert.match(text(), /viewer/);
  const secret = /ao_token=(ao_[A-Za-z0-9_-]{43})/.exec(text())[1];
  logs.length = 0;
  assert.equal(runAccessCommand(["token", "list"], ctx), 0);
  assert.match(text(), /Mai/);
  assert.match(text(), /viewer/);
  assert.ok(!text().includes(secret));
  assert.ok(!/hash/i.test(text()));
});

test("token add validates: bad role, missing label → exit 2 with usage, nothing stored", () => {
  const { ctx, file, text } = setup();
  assert.equal(runAccessCommand(["token", "add", "--label", "x", "--role", "admin"], ctx), 2);
  assert.match(text(), /owner, manager|viewer/);
  assert.equal(runAccessCommand(["token", "add", "--role", "viewer"], ctx), 2);
  assert.equal(fs.existsSync(file), false);
});

test("token revoke by label or id; unknown → exit 1", () => {
  const { ctx, text } = setup();
  runAccessCommand(["token", "add", "--label", "Mai", "--role", "viewer"], ctx);
  assert.equal(runAccessCommand(["token", "revoke", "Mai"], ctx), 0);
  assert.equal(ctx.store.list().length, 0);
  assert.equal(runAccessCommand(["token", "revoke", "nobody"], ctx), 1);
  assert.match(text(), /no token/i);
});

test("unknown subcommand → exit 2", () => {
  const { ctx } = setup();
  assert.equal(runAccessCommand(["token", "frobnicate"], ctx), 2);
  assert.equal(runAccessCommand(["lan", "sideways"], ctx), 2);
});

test("lanLinks: one link per address; falls back to localhost with a note when there is no LAN address", () => {
  assert.deepEqual(lanLinks("ao_x", 8787, ["192.0.2.10", "198.51.100.4"]), [
    "http://192.0.2.10:8787/?ao_token=ao_x",
    "http://198.51.100.4:8787/?ao_token=ao_x",
  ]);
  assert.deepEqual(lanLinks("ao_x", 8787, []), ["http://localhost:8787/?ao_token=ao_x"]);
});

test("restart failure is a warning with the manual step, not a crash — the config is already saved", () => {
  const { ctx, text } = setup({ restart: () => ({ ok: false, hint: "systemctl --user restart agent-office-daemon" }) });
  assert.equal(runAccessCommand(["lan", "on"], ctx), 0);
  assert.match(text(), /restart it yourself.*systemctl/is);
});
