// The TTS bridge. The only system Vietnamese voice Chrome exposes reads word by
// word, which was rejected twice — hence a local model instead. The daemon
// serves POST /tts {text} → WAV and the renderer plays it through <audio>.
//
// The worker is tts_worker.py, run by the python of a venv that has the model
// package. Spawned lazily on the first request (~5.5s to load the model), kept
// warm between requests, and killed after idleMs to give the RAM back.
// The whole feature is optional: with no venv, available() is false, /tts
// returns 503, and the rest of the app is unaffected.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Point VIENEU_PYTHON at the python of a venv that has the model package.
// Unset, it tries the conventional `.venv-tts/` at the repo root; with neither,
// available() is false, /tts returns 503, and the renderer quietly skips speech.
const DEFAULT_PYTHON = fileURLToPath(
  new URL("../../../.venv-tts/bin/python", import.meta.url)
);
const DEFAULT_WORKER = fileURLToPath(new URL("./tts_worker.py", import.meta.url));

export class VieNeuTts {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.pythonBin] python that has the model package (VIENEU_PYTHON)
   * @param {string} [opts.workerScript]
   * @param {number} [opts.requestTimeoutMs] ceiling for one sentence, including the first model load
   * @param {number} [opts.idleMs] no request for this long → kill the worker
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

  /** One sentence of text → a WAV Buffer. Rejects if the worker dies, times out, or errors. */
  async synth(text) {
    if (!this.available()) throw new Error("vieneu_unavailable");
    this.#ensureWorker();
    await this.ready;
    const id = ++this.seq;
    const wav = await new Promise((resolve, reject) => {
      // the worker can die between `await ready` and here (exit-event race)
      if (!this.worker) {
        reject(new Error("vieneu_worker_exited"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // one stuck sentence stalls everything behind it — kill so the next request respawns clean
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
      // stderr goes straight to the daemon log — the model library's warnings are useful when debugging
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.worker = child;
    let readyResolve, readyReject;
    this.ready = new Promise((res, rej) => {
      readyResolve = res;
      readyReject = rej;
    });
    // node --test counts an unhandled rejection as a failure even when synth() awaits it later
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
 * 503 means the voice backend is unavailable — a missing venv, a worker error,
 * or a timeout. The renderer treats it as "no speech this time" and carries on.
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
        respond(400, { ok: false, error: "text is required and must be a non-empty string" });
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
