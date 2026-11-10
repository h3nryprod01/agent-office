// Launcher for the npx package (bin/office-lib.js): pure helpers only.
// The launcher itself (bin/office.js) starts a daemon and a browser, so it is
// exercised from the packed tarball, not here.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs,
  isEphemeralInstall,
  nodeMajorOk,
  browserCommand,
  daemonEnv,
} from "../bin/office-lib.js";

test("parseArgs: defaults", () => {
  const a = parseArgs([]);
  assert.deepEqual(a, { port: 8787, open: true, installService: false, yes: false, help: false, passthrough: null, error: null });
});

test("parseArgs: flags", () => {
  const a = parseArgs(["--port", "9001", "--no-open", "--install-service", "--yes"]);
  assert.equal(a.port, 9001);
  assert.equal(a.open, false);
  assert.equal(a.installService, true);
  assert.equal(a.yes, true);
});

test("parseArgs: --port=NNN form and bad ports", () => {
  assert.equal(parseArgs(["--port=9002"]).port, 9002);
  for (const bad of ["abc", "0", "70000", "-1", "80.5"]) {
    assert.match(parseArgs(["--port", bad]).error, /port/i, bad);
  }
  assert.match(parseArgs(["--port"]).error, /port/i);
});

test("parseArgs: unknown flag is an error, not silently ignored", () => {
  assert.match(parseArgs(["--frobnicate"]).error, /--frobnicate/);
});

test("parseArgs: a first non-flag word goes to the ao CLI untouched", () => {
  const a = parseArgs(["doctor", "--port", "9100"]);
  assert.deepEqual(a.passthrough, ["doctor", "--port", "9100"]);
  assert.equal(a.error, null);
});

test("parseArgs: --help", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-h"]).help, true);
});

test("isEphemeralInstall: npx cache paths, both separators", () => {
  assert.equal(isEphemeralInstall("/home/u/.npm/_npx/abc123/node_modules/pkg"), true);
  assert.equal(isEphemeralInstall("C:\\Users\\u\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\pkg"), true);
  assert.equal(isEphemeralInstall("/usr/local/lib/node_modules/pkg"), false);
  assert.equal(isEphemeralInstall("/home/u/src/agent-office"), false);
});

test("nodeMajorOk: needs 20+", () => {
  assert.equal(nodeMajorOk("v18.19.0"), false);
  assert.equal(nodeMajorOk("v20.0.0"), true);
  assert.equal(nodeMajorOk("v22.4.1"), true);
  assert.equal(nodeMajorOk("nonsense"), false);
});

test("browserCommand per platform", () => {
  assert.deepEqual(browserCommand("darwin", "http://localhost:1"), ["open", ["http://localhost:1"]]);
  assert.deepEqual(browserCommand("linux", "http://localhost:1"), ["xdg-open", ["http://localhost:1"]]);
  assert.deepEqual(browserCommand("win32", "http://localhost:1"), ["cmd", ["/c", "start", "", "http://localhost:1"]]);
});

test("daemonEnv: workspace default lives under the home dir, explicit values win", () => {
  const env = daemonEnv({ HOME: "/h", USERPROFILE: "" }, 9005, "/h");
  assert.equal(env.DAEMON_WS_PORT, "9005");
  assert.equal(env.AGENT_OFFICE_REPO, "/h/.agent-office/workspace");
  const own = daemonEnv({ AGENT_OFFICE_REPO: "/mine" }, 9005, "/h");
  assert.equal(own.AGENT_OFFICE_REPO, "/mine");
});
