import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VieNeuTts, createTtsHttpHandler } from "../src/tts.js";

class FakeWorker extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stdin = { written: [], write: (s) => this.stdin.written.push(s) };
    this.killedWith = null;
  }
  kill(signal) {
    this.killedWith = signal;
  }
  line(obj) {
    this.stdout.emit("data", JSON.stringify(obj) + "\n");
  }
}

function setup(opts = {}) {
  const workers = [];
  const tts = new VieNeuTts({
    pythonBin: process.execPath, // tồn tại → available() = true
    workerScript: "unused-by-fake",
    spawnFn: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
    ...opts,
  });
  return { tts, workers, worker: () => workers[workers.length - 1] };
}

function tmpWav(content = "RIFFfake-wav-bytes") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tts-test-"));
  const file = path.join(dir, "clip.wav");
  fs.writeFileSync(file, content);
  return file;
}

test("synth: spawn lười, chờ ready, trả WAV buffer và xoá file tạm", async () => {
  const { tts, workers, worker } = setup();
  assert.equal(workers.length, 0); // chưa có request → chưa spawn

  const p = tts.synth("Xin chào anh");
  assert.equal(workers.length, 1);
  worker().line({ ready: true });
  await new Promise((r) => setImmediate(r)); // cho synth ghi request sau ready

  const req = JSON.parse(worker().stdin.written[0]);
  assert.equal(req.text, "Xin chào anh");
  const file = tmpWav();
  worker().line({ id: req.id, file });

  const wav = await p;
  assert.equal(wav.toString(), "RIFFfake-wav-bytes");
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(fs.existsSync(file), false); // file tạm đã dọn
});

test("synth: dòng stdout không phải JSON (log thư viện) được bỏ qua", async () => {
  const { tts, worker } = setup();
  const p = tts.synth("câu");
  worker().stdout.emit("data", "Loading VieNeu v3 Turbo...\n");
  worker().line({ ready: true });
  await new Promise((r) => setImmediate(r));
  worker().stdout.emit("data", "some torch warning\n");
  const req = JSON.parse(worker().stdin.written[0]);
  const file = tmpWav();
  worker().line({ id: req.id, file });
  assert.ok(await p);
});

test("worker báo error per-request → synth reject, worker sống tiếp", async () => {
  const { tts, workers, worker } = setup();
  const p = tts.synth("câu lỗi");
  worker().line({ ready: true });
  await new Promise((r) => setImmediate(r));
  const req = JSON.parse(worker().stdin.written[0]);
  worker().line({ id: req.id, error: "phonemize failed" });
  await assert.rejects(p, /phonemize failed/);
  assert.equal(workers.length, 1); // không kill vì lỗi 1 request

  const p2 = tts.synth("câu sau");
  await new Promise((r) => setImmediate(r));
  const req2 = JSON.parse(worker().stdin.written[1]);
  worker().line({ id: req2.id, file: tmpWav("ok") });
  assert.equal((await p2).toString(), "ok");
});

test("worker chết → pending reject, request kế spawn worker mới", async () => {
  const { tts, workers, worker } = setup();
  const p = tts.synth("đang chờ");
  worker().line({ ready: true });
  worker().emit("exit", 1);
  await assert.rejects(p, /vieneu_worker_exited/);

  const p2 = tts.synth("thử lại");
  assert.equal(workers.length, 2);
  worker().line({ ready: true });
  await new Promise((r) => setImmediate(r));
  const req = JSON.parse(worker().stdin.written[0]);
  worker().line({ id: req.id, file: tmpWav("lại ok") });
  assert.equal((await p2).toString(), "lại ok");
});

test("timeout 1 câu → reject + kill worker để respawn sạch", async () => {
  const { tts, workers, worker } = setup({ requestTimeoutMs: 30 });
  const p = tts.synth("câu kẹt");
  worker().line({ ready: true });
  await assert.rejects(p, /vieneu_timeout/);
  assert.equal(worker().killedWith, "SIGTERM");

  const p2 = tts.synth("sau khi kẹt");
  assert.equal(workers.length, 2);
  worker().line({ ready: true });
  await new Promise((r) => setImmediate(r));
  const req = JSON.parse(worker().stdin.written[0]);
  worker().line({ id: req.id, file: tmpWav("hồi phục") });
  assert.equal((await p2).toString(), "hồi phục");
});

test("idle quá hạn → worker bị tắt để trả RAM", async () => {
  const { tts, worker } = setup({ idleMs: 25 });
  const p = tts.synth("câu duy nhất");
  worker().line({ ready: true });
  await new Promise((r) => setImmediate(r));
  const req = JSON.parse(worker().stdin.written[0]);
  worker().line({ id: req.id, file: tmpWav() });
  await p;
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(worker().killedWith, "SIGTERM");
});

test("pythonBin không tồn tại → available() false, synth reject ngay", async () => {
  const tts = new VieNeuTts({ pythonBin: "/nonexistent/python3" });
  assert.equal(tts.available(), false);
  await assert.rejects(tts.synth("x"), /vieneu_unavailable/);
});

// ── HTTP handler ───────────────────────────────────────────────────────────

function fakeHttp(method, body) {
  const req = new EventEmitter();
  req.method = method;
  const res = {
    statusCode: null,
    headers: null,
    body: null,
    writeHead(code, headers) {
      this.statusCode = code;
      this.headers = headers ?? {};
    },
    end(payload) {
      this.body = payload;
      this.ended = true;
    },
  };
  const send = () => {
    if (body !== undefined) req.emit("data", body);
    req.emit("end");
  };
  return { req, res, send };
}

const url = (p) => new URL(p, "http://127.0.0.1:8787");

test("handler: pathname khác /tts → false (fall through)", () => {
  const handler = createTtsHttpHandler({ available: () => true });
  const { req, res } = fakeHttp("POST");
  assert.equal(handler(req, res, url("/chat")), false);
});

test("handler: POST hợp lệ → 200 audio/wav với bytes từ synth", async () => {
  const handler = createTtsHttpHandler({
    available: () => true,
    synth: async (text) => Buffer.from(`WAV:${text}`),
  });
  const { req, res, send } = fakeHttp("POST", JSON.stringify({ text: "Chào anh" }));
  assert.equal(handler(req, res, url("/tts")), true);
  send();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers["content-type"], "audio/wav");
  assert.equal(res.body.toString(), "WAV:Chào anh");
});

test("handler: thiếu text → 400; VieNeu unavailable → 503; synth lỗi → 503", async () => {
  const bad = fakeHttp("POST", JSON.stringify({}));
  createTtsHttpHandler({ available: () => true })(bad.req, bad.res, url("/tts"));
  bad.send();
  assert.equal(bad.res.statusCode, 400);

  const off = fakeHttp("POST", JSON.stringify({ text: "x" }));
  createTtsHttpHandler({ available: () => false })(off.req, off.res, url("/tts"));
  off.send();
  assert.equal(off.res.statusCode, 503);
  assert.match(off.res.body, /vieneu_unavailable/);

  const boom = fakeHttp("POST", JSON.stringify({ text: "x" }));
  createTtsHttpHandler({
    available: () => true,
    synth: async () => {
      throw new Error("vieneu_timeout");
    },
  })(boom.req, boom.res, url("/tts"));
  boom.send();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(boom.res.statusCode, 503);
  assert.match(boom.res.body, /vieneu_timeout/);
});

test("handler: OPTIONS → 204 (CORS preflight), GET → 405", () => {
  const handler = createTtsHttpHandler({ available: () => true });
  const opt = fakeHttp("OPTIONS");
  handler(opt.req, opt.res, url("/tts"));
  assert.equal(opt.res.statusCode, 204);

  const get = fakeHttp("GET");
  handler(get.req, get.res, url("/tts"));
  assert.equal(get.res.statusCode, 405);
});
