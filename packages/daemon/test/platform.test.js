import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  isWindows,
  binCandidates,
  commonBinDirs,
  revealCommand,
  notifyCommand,
  cliSpawnOptions,
} from "../src/platform.js";

// R14: win32 branches are asserted by their OUTPUT ({cmd,args}, lists), never
// by executing a Windows command on this macOS dev box. Real-Windows success is
// a human step (docs/windows-port.md).

test("isWindows", () => {
  assert.equal(isWindows("win32"), true);
  assert.equal(isWindows("darwin"), false);
  assert.equal(isWindows("linux"), false);
});

test("binCandidates: win32 tries claude.cmd (+exe/ps1); darwin just the bare name", () => {
  const win = binCandidates("claude", "win32");
  assert.ok(win.includes("claude.cmd"), `expected claude.cmd in ${JSON.stringify(win)}`);
  assert.deepEqual(binCandidates("claude", "darwin"), ["claude"]);
});

test("revealCommand: win32 explorer /select, ; darwin open -R", () => {
  assert.deepEqual(revealCommand("C:\\x\\a.txt", true, "win32"), {
    cmd: "explorer",
    args: ["/select,C:\\x\\a.txt"],
  });
  assert.deepEqual(revealCommand("C:\\x\\a.txt", false, "win32"), {
    cmd: "explorer",
    args: ["C:\\x\\a.txt"],
  });
  const mac = revealCommand("/x/a.txt", true, "darwin");
  assert.equal(mac.cmd, "open");
  assert.deepEqual(mac.args, ["-R", "/x/a.txt"]);
});

test("revealCommand: linux → xdg-open the containing dir (reveal or not, no per-file select)", () => {
  assert.deepEqual(revealCommand("/x/a.txt", true, "linux"), {
    cmd: "xdg-open",
    args: ["/x"],
  });
  assert.deepEqual(revealCommand("/x/a.txt", false, "linux"), {
    cmd: "xdg-open",
    args: ["/x/a.txt"],
  });
});

test("commonBinDirs: win32 includes %APPDATA%\\npm; darwin keeps the homebrew list", () => {
  const appdata = "C:\\Users\\k\\AppData\\Roaming";
  const win = commonBinDirs("win32", { APPDATA: appdata, USERPROFILE: "C:\\Users\\k" });
  // path.join on the host (darwin) normalizes with "/" — assert via the same
  // join so the test is portable, then also confirm the npm dir is present.
  assert.ok(win.includes(path.join(appdata, "npm")));
  assert.ok(win.some((d) => d.endsWith("npm")));

  const mac = commonBinDirs("darwin", {});
  assert.ok(mac.includes("/opt/homebrew/bin"));
  assert.ok(mac.includes("/usr/local/bin"));
});

test("cliSpawnOptions: win32 shell:true; darwin falsy", () => {
  assert.equal(cliSpawnOptions("win32").shell, true);
  assert.ok(!cliSpawnOptions("darwin").shell);
});

test("notifyCommand: win32 → powershell; darwin → {cmd:null} marker (notifier keeps its own path)", () => {
  const win = notifyCommand({ title: "Agent Office", message: "stuck >30s" }, "win32");
  assert.match(win.cmd, /powershell/i);
  assert.equal(win.args[0], "-NoProfile");
  assert.equal(win.args[1], "-Command");
  // single-quote escaping: an apostrophe in the title becomes ''
  const withQuote = notifyCommand({ title: "Bob's task" }, "win32");
  assert.ok(withQuote.args[2].includes("'Bob''s task'"));

  const mac = notifyCommand({ title: "x", message: "y" }, "darwin");
  assert.equal(mac.cmd, null);
});

test("notifyCommand: linux → notify-send", () => {
  const linux = notifyCommand({ title: "Agent Office", message: "stuck >30s" }, "linux");
  assert.deepEqual(linux, {
    cmd: "notify-send",
    args: ["-a", "Agent Office", "Agent Office", "stuck >30s"],
  });
});

test("revealCommand: Open runs nothing — folders and known documents open, everything else is selected", () => {
  const dir = true, file = false;
  assert.deepEqual(revealCommand("/x/Tool.app", false, "darwin", dir).args, ["-R", "/x/Tool.app"]);
  assert.deepEqual(revealCommand("/x/me.github.io", false, "darwin", dir).args, ["/x/me.github.io"]);
  assert.deepEqual(revealCommand("/x/plain", false, "darwin", dir).args, ["/x/plain"]);
  assert.deepEqual(revealCommand("/x/report.pdf", false, "darwin", file).args, ["/x/report.pdf"]);
  for (const f of ["/x/run", "/x/run.command", "/x/a.jar", "/x/link.webloc", "/x/Setup.pkg"]) {
    assert.deepEqual(revealCommand(f, false, "darwin", file).args, ["-R", f], f);
  }
  assert.deepEqual(revealCommand("C:\\x\\setup.exe", false, "win32", file).args, ["/select,C:\\x\\setup.exe"]);
  assert.deepEqual(revealCommand("C:\\x\\a.pif", false, "win32", file).args, ["/select,C:\\x\\a.pif"]);
  assert.deepEqual(revealCommand("C:\\x\\notes.txt", false, "win32", file).args, ["C:\\x\\notes.txt"]);
  assert.deepEqual(revealCommand("C:\\x\\Tool.app", false, "win32", dir).args, ["C:\\x\\Tool.app"]);
  assert.deepEqual(revealCommand("C:\\x\\a,b.txt", true, "win32", file), { cmd: "explorer", args: ["C:\\x"] });
  assert.deepEqual(revealCommand("/x/run.sh", false, "linux", file).args, ["/x"]);
  // looked up on disk when not given: this test file is a file, its folder a folder
  assert.equal(revealCommand(import.meta.dirname, false, "darwin").args[0], import.meta.dirname);
});
