// VieNeu TTS bridge (wi-voice-vieneu). Giọng vi hệ thống duy nhất Chrome thấy
// là Linh (compact) — đọc tiếng Việt rời rạc "như đánh vần", user đã bác 2 lần.
// Daemon expose POST /tts {text} → WAV; renderer phát qua <audio> cho reply
// tiếng Việt và tự fallback về speechSynthesis khi route này 503/tắt.
//
// Worker = tts_worker.py chạy bằng python của một venv có sẵn package `vieneu`.
// Spawn lười ở request đầu (load model ~5.5s), giữ ấm giữa các request, tự tắt
// sau idleMs để trả RAM. Tính năng này là tuỳ chọn: không có venv thì
// available() = false và route /tts trả 503, phần còn lại của app chạy bình thường.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Đặt VIENEU_PYTHON trỏ tới python của venv có package `vieneu`. Không đặt thì
// thử vị trí quy ước `.venv-tts/` ở gốc repo; không có venv → available()=false
// → /tts trả 503 và renderer im lặng bỏ qua giọng đọc.
const DEFAULT_PYTHON = fileURLToPath(
  new URL("../../../.venv-tts/bin/python", import.meta.url)
);
const DEFAULT_WORKER = fileURLToPath(new URL("./tts_worker.py", import.meta.url));

export class VieNeuTts {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.pythonBin] python có package vieneu (VIENEU_PYTHON)
   * @param {string} [opts.workerScript]
   * @param {number} [opts.requestTimeoutMs] trần cho 1 câu (gồm cả model load lần đầu)
   * @param {number} [opts.idleMs] không có request trong khoảng này → kill worker
   * @param {typeof spawn} [opts.spawnFn] test injection
   */
  constructor({
    pythonBin = process.env.VIENEU_PYTHON ?? DEFAULT_PYTHON,
    workerScript = DEFAULT_WORKER,
    requestTimeoutMs = 30_000,
    idleMs = 30 * 60 * 1000,
    spawnFn = spawn,
  } = {}) {
    this.pythonBin = pythonBin;
    this.workerScript = workerScript;
    this.requestTimeoutMs = requestTimeoutMs;
    this.idleMs = idleMs;
    this.spawnFn = spawnFn;
    this.worker = null;
    this.ready = null; // Promise resolve khi worker in {"ready":true}
    this.seq = 0;
    /** @type {Map<number, {resolve: Function, reject: Function, timer: any}>} */
    this.pending = new Map();
    this.idleTimer = null;
    this.disposed = false;
  }

  available() {
    return !this.disposed && existsSync(this.pythonBin);
  }

  /** Text 1 câu → Buffer WAV. Reject khi worker chết/timeout/VieNeu báo lỗi. */
  async synth(text) {
    if (!this.available()) throw new Error("vieneu_unavailable");
    this.#ensureWorker();
    await this.ready;
    const id = ++this.seq;
    const wav = await new Promise((resolve, reject) => {
      // worker có thể chết ngay giữa await ready và lúc này (race exit event)
      if (!this.worker) {
        reject(new Error("vieneu_worker_exited"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // 1 câu kẹt là cả queue phía sau kẹt — kill để request kế spawn lại sạch
        this.#kill(new Error("vieneu_timeout"));
        reject(new Error("vieneu_timeout"));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.stdin.write(JSON.stringify({ id, text }) + "\n");
    });
    this.#armIdle();
    return wav;
  }

  dispose() {
    this.disposed = true;
    this.#kill(new Error("vieneu_disposed"));
  }

  #ensureWorker() {
    if (this.worker) return;
    const child = this.spawnFn(this.pythonBin, [this.workerScript], {
      // stderr thẳng ra log daemon — warning của torch/transformers hữu ích khi debug
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.worker = child;
    let readyResolve, readyReject;
    this.ready = new Promise((res, rej) => {
      readyResolve = res;
      readyReject = rej;
    });
    // node --test coi unhandled rejection là fail kể cả khi synth() sẽ await sau
    this.ready.catch(() => {});
    this.readyReject = readyReject;

    let buf = "";
    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          continue; // log của thư viện — bỏ qua
        }
        if (msg.ready) {
          readyResolve();
          continue;
        }
        const req = this.pending.get(msg.id);
        if (!req) continue;
        this.pending.delete(msg.id);
        clearTimeout(req.timer);
        if (msg.error || !msg.file) {
          req.reject(new Error(msg.error || "vieneu_bad_reply"));
          continue;
        }
        readFile(msg.file)
          .then((wav) => {
            unlink(msg.file).catch(() => {});
            req.resolve(wav);
          })
          .catch((err) => req.reject(err));
      }
    });

    const gone = () => {
      if (this.worker === child) this.#kill(new Error("vieneu_worker_exited"));
    };
    child.on("exit", gone);
    child.on("error", gone);
  }

  #kill(error) {
    const child = this.worker;
    this.worker = null;
    this.ready = null;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    this.readyReject?.(error);
    this.readyReject = null;
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    this.pending.clear();
    child?.kill?.("SIGTERM");
  }

  #armIdle() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.pending.size === 0) this.#kill(new Error("vieneu_idle"));
    }, this.idleMs);
    this.idleTimer.unref?.();
  }
}

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};

/**
 * HTTP route cho extraHttp: POST /tts {text} → 200 audio/wav.
 * 503 = VieNeu không sẵn sàng (venv thiếu / worker lỗi / timeout) — renderer
 * hiểu là "dùng speechSynthesis đi", nên route này chết không làm mất voice.
 * @param {VieNeuTts} tts
 */
export function createTtsHttpHandler(tts) {
  return (req, res, url) => {
    if (url.pathname !== "/tts") return false;
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return true;
    }
    if (req.method !== "POST") {
      res.writeHead(405, CORS_HEADERS);
      res.end();
      return true;
    }
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 8192) req.destroy(); // 1 câu, không phải cả reply
    });
    req.on("end", () => {
      const respond = (statusCode, payload) => {
        res.writeHead(statusCode, { ...CORS_HEADERS, "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = null;
      }
      const text = typeof parsed?.text === "string" ? parsed.text.trim() : "";
      if (!text) {
        respond(400, { ok: false, error: "text (chuỗi không rỗng) là bắt buộc" });
        return;
      }
      if (!tts.available()) {
        respond(503, { ok: false, error: "vieneu_unavailable" });
        return;
      }
      tts.synth(text).then(
        (wav) => {
          res.writeHead(200, { ...CORS_HEADERS, "content-type": "audio/wav" });
          res.end(wav);
        },
        (error) => respond(503, { ok: false, error: error.message })
      );
    });
    return true;
  };
}
