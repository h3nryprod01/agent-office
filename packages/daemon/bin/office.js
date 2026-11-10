#!/usr/bin/env node
// One-command launcher: starts the daemon in the foreground (it also serves the
// bundled renderer) and opens the browser. Installs NO background service unless
// --install-service is given. Verified from the packed tarball; see README.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { browserCommand, daemonEnv, isEphemeralInstall, looksLikeOffice, nodeMajorOk, parseArgs, serviceCommand, updateRefusal } from "./office-lib.js";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PKG_NAME = JSON.parse(readFileSync(path.join(PKG_ROOT, "package.json"), "utf8")).name;
const VI = /^vi/i.test(process.env.LANG ?? "");
const say = (en, vi) => (VI ? vi : en);
const die = (msg, code = 1) => {
  console.error(msg);
  process.exit(code);
};

const HELP = say(
  `${PKG_NAME} - see which coding agents are waiting on you

Usage: ${PKG_NAME} [--port N] [--no-open]
       ${PKG_NAME} --install-service [--yes]     (start at login; needs a global install)
       ${PKG_NAME} doctor|backup|...             (passed to the ao CLI)

  --port N           port to listen on (default 8787; this machine only unless LAN mode is on)
  --no-open          do not open the browser
  --install-service  install a login service; asks first, --yes skips the question
`,
  `${PKG_NAME} - xem agent nào đang chờ bạn

Dùng: ${PKG_NAME} [--port N] [--no-open]
      ${PKG_NAME} --install-service [--yes]     (tự chạy khi đăng nhập; cần cài global)
      ${PKG_NAME} doctor|backup|...             (chuyển sang CLI ao)

  --port N           cổng lắng nghe (mặc định 8787; chỉ máy này trừ khi bật chế độ LAN)
  --no-open          không mở trình duyệt
  --install-service  cài dịch vụ chạy nền khi đăng nhập; hỏi trước, --yes để bỏ qua câu hỏi
`,
);

const args = parseArgs(process.argv.slice(2));
if (args.error) die(args.error + "\n\n" + HELP);
if (args.help) {
  console.log(HELP);
  process.exit(0);
}
if (!nodeMajorOk(process.version)) {
  die(say(`Node.js 20+ is required (this is ${process.version}): https://nodejs.org/en/download`, `Cần Node.js 20+ (đang là ${process.version}): https://nodejs.org/en/download`));
}

const run = (cmd, argv, opts = {}) => spawn(cmd, argv, { stdio: "inherit", ...opts });
const exitWith = (child) => child.on("exit", (code, sig) => process.exit(code ?? (sig ? 1 : 0)));

const refusal = updateRefusal(args.passthrough, existsSync(path.join(PKG_ROOT, ".git")), PKG_NAME);
if (refusal) die(refusal);

if (args.passthrough) {
  exitWith(run(process.execPath, [path.join(PKG_ROOT, "scripts", "ao.mjs"), ...args.passthrough]));
} else if (args.installService) {
  if (isEphemeralInstall(PKG_ROOT)) {
    die(say(
      `This copy lives in npm's temporary npx cache; a login service pointing here would break.\nInstall it first:  npm install -g ${PKG_NAME}  then run  ${PKG_NAME} --install-service`,
      `Bản này nằm trong cache tạm của npx; dịch vụ trỏ vào đây sẽ hỏng.\nCài trước:  npm install -g ${PKG_NAME}  rồi chạy lại  ${PKG_NAME} --install-service`,
    ));
  }
  // the service must keep the PM workspace out of the package folder (lost on update, maybe read-only)
  const env = daemonEnv(process.env, args.port, os.homedir());
  mkdirSync(env.AGENT_OFFICE_REPO, { recursive: true });
  const [cmd, argv] = serviceCommand(process.platform, PKG_ROOT, args.yes);
  exitWith(run(cmd, argv, { env }));
} else {
  await launch();
}

function portBusy(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

function fetchBody(url) {
  return new Promise((resolve) => {
    http
      .get(url, { timeout: 2000 }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += body.length < 4096 ? c : ""));
        res.on("end", () => resolve(body));
      })
      .on("error", () => resolve(""));
  });
}

function openBrowser(url) {
  const [cmd, argv] = browserCommand(process.platform, url);
  spawn(cmd, argv, { stdio: "ignore", detached: true }).on("error", () => console.log(say(`Open ${url} in your browser.`, `Mở ${url} trong trình duyệt.`))).unref();
}

function ping(url) {
  return new Promise((resolve) => {
    http.get(url, (res) => (res.resume(), resolve(res.statusCode === 200))).on("error", () => resolve(false));
  });
}

async function launch() {
  if (!existsSync(path.join(PKG_ROOT, "packages", "renderer", "dist", "index.html"))) {
    console.error(say(
      "Warning: the renderer is not built, so the page will be blank. In a clone: npm --prefix packages/renderer run build",
      "Cảnh báo: chưa build renderer nên trang sẽ trắng. Trong bản clone: npm --prefix packages/renderer run build",
    ));
  }
  if (await portBusy(args.port)) {
    const url = `http://localhost:${args.port}`;
    if (looksLikeOffice(await fetchBody(url))) {
      // a second daemon would write the same ~/.agent-office, so point at the running one
      console.log(say(`Agent Office is already running at ${url}. Open it.`, `Agent Office đã chạy ở ${url}. Mở nó.`));
      if (args.open) openBrowser(url);
      process.exit(0);
    }
    die(say(
      `Port ${args.port} is in use by something else. Pick another: ${PKG_NAME} --port ${args.port + 1}`,
      `Cổng ${args.port} đang bị chương trình khác dùng. Chọn cổng khác: ${PKG_NAME} --port ${args.port + 1}`,
    ));
  }
  const env = daemonEnv(process.env, args.port, os.homedir());
  mkdirSync(env.AGENT_OFFICE_REPO, { recursive: true });
  const daemon = run(process.execPath, ["--max-old-space-size=768", path.join(PKG_ROOT, "packages", "daemon", "src", "index.js")], { env });
  let up = false;
  daemon.on("exit", (code) => {
    if (!up) console.error(say("The daemon stopped before it was ready (see its output above).", "Daemon dừng trước khi sẵn sàng (xem log phía trên)."));
    process.exit(code ?? 1);
  });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => daemon.kill(sig));

  // localhost, not 127.0.0.1: browsers grant microphone permission per origin (see scripts/start.sh).
  const url = `http://localhost:${args.port}`;
  for (let i = 0; i < 75 && !up; i++) {
    up = await ping(url);
    if (!up) await new Promise((r) => setTimeout(r, 200));
  }
  if (!up) {
    daemon.kill("SIGTERM");
    die(say(`The daemon did not answer at ${url} within 15 s.`, `Daemon không trả lời ở ${url} sau 15 giây.`));
  }
  console.log(`Agent Office -> ${url}  ${say("(Ctrl+C to stop)", "(Ctrl+C để dừng)")}`);
  if (args.open) openBrowser(url);
}
