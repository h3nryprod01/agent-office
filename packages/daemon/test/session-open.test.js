import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { terminalCommand, createSessionOpenHandler } from "../src/session-open.js";

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ao-open-")));

test("terminalCommand: macOS opens Terminal on the folder; Windows/Linux start a shell with that cwd", () => {
  assert.deepEqual(terminalCommand("/w/demo-app", "darwin"), { cmd: "open", args: ["-a", "Terminal", "/w/demo-app"], options: {} });
  // absolute shell, no cwd option: a cmd.exe planted in the agent's folder must not be picked up
  assert.deepEqual(terminalCommand("C:\\w\\demo-app", "win32", { SystemRoot: "C:\\Windows" }), {
    cmd: "C:\\Windows\\System32\\cmd.exe",
    args: ["/c", "start", "/D", "C:\\w\\demo-app", "C:\\Windows\\System32\\cmd.exe"],
    options: {},
  });
  assert.equal(terminalCommand("C:\\w", "win32", { ComSpec: "D:\\sys\\cmd.exe" }).cmd, "D:\\sys\\cmd.exe");
  assert.deepEqual(terminalCommand("/w/demo-app", "linux"), { cmd: "x-terminal-emulator", args: [], options: { cwd: "/w/demo-app" } });
});

test("a Windows folder name cmd.exe would re-parse is refused, not quoted", () => {
  for (const bad of ["C:\\w\\a&calc", "C:\\w\\a|b", "C:\\w\\%PATH%", "C:\\w\\a^b", "C:\\w\\a\"b", "C:\\w\\(x)", "C:\\w\\a\nb"]) {
    assert.equal(terminalCommand(bad, "win32", { SystemRoot: "C:\\Windows" }), null, bad);
  }
  assert.notEqual(terminalCommand("C:\\Program Files\\my app", "win32", { SystemRoot: "C:\\Windows" }), null);
});

function call(handler, method, body) {
  return new Promise((resolve) => {
    const req = {
      method,
      on(ev, cb) {
        if (ev === "data" && body !== undefined) cb(typeof body === "string" ? body : JSON.stringify(body));
        if (ev === "end") cb();
      },
    };
    const res = { writeHead(s) { this.status = s; }, end(b) { resolve({ status: this.status, body: b ? JSON.parse(b) : null }); } };
    const handled = handler(req, res, new URL("http://x/sessions/open-terminal"));
    assert.equal(handled, true);
  });
}

test("POST opens a terminal at the cwd the daemon itself observed for that agent — never a client-sent path", async () => {
  const launched = [];
  const handler = createSessionOpenHandler({
    resolveCwd: (id) => (id === "agent-1" ? dir : null),
    execFileFn: (cmd, args, options, cb) => { launched.push({ cmd, args, options }); cb(null); },
    platform: "darwin",
  });
  const ok = await call(handler, "POST", { agentId: "agent-1", cwd: "/etc" });
  assert.equal(ok.status, 200);
  assert.deepEqual(launched, [{ cmd: "open", args: ["-a", "Terminal", dir], options: {} }]);
});

test("unknown agent → 404, vanished folder → 404, bad body → 400, wrong method → 405", async () => {
  const handler = createSessionOpenHandler({
    resolveCwd: (id) => (id === "gone" ? path.join(dir, "nope") : null),
    execFileFn: () => assert.fail("must not launch"),
    platform: "darwin",
  });
  assert.equal((await call(handler, "POST", { agentId: "x" })).status, 404);
  assert.equal((await call(handler, "POST", { agentId: "gone" })).status, 404);
  assert.equal((await call(handler, "POST", "{nope")).status, 400);
  assert.equal((await call(handler, "POST", {})).status, 400);
  assert.equal((await call(handler, "GET")).status, 405);
});

test("other routes fall through", () => {
  const handler = createSessionOpenHandler({ resolveCwd: () => null });
  assert.equal(handler({ method: "GET" }, {}, new URL("http://x/other")), false);
});
