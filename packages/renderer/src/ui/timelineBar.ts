import type { OfficeState } from "../sim/model";
import { EventRecorder, parseReplayFile } from "../replay/recorder";
import { ReplayCursor } from "../replay/playback";
import { createVideoExporter } from "../replay/videoExport";

const SPEEDS = [1, 4, 16, 60];
const TICK_MS = 100;

/** What main.ts renders instead of the live state while replaying. */
export interface ReplayView {
  state: OfficeState;
  /** Virtual "now" (ms epoch on the recording's time axis). */
  now: number;
  speed: number;
}

/**
 * Bottom timeline bar: play/pause, speed, scrubber, Live, export/import.
 * Owns the replay clock; main.ts only consumes the resulting view.
 * Live mode: the bar tracks the recording's growing range; any playback
 * interaction snapshots the recorder and detaches into replay mode (the
 * recorder keeps recording live events underneath).
 */
export function mountTimelineBar(
  root: HTMLElement,
  recorder: EventRecorder,
  onView: (view: ReplayView | null) => void,
  /** the office canvas to record — a getter, since the app swaps 2D/3D at runtime */
  canvas: HTMLCanvasElement | (() => HTMLCanvasElement),
): void {
  root.innerHTML = `
    <button id="rp-play" title="Replay">▶</button>
    <span class="speeds">${SPEEDS.map(
      (s) => `<button class="rp-speed" data-speed="${s}">${s}×</button>`,
    ).join("")}</span>
    <input id="rp-scrub" type="range" min="0" max="0" value="0" step="100" />
    <span id="rp-time"></span>
    <button id="rp-live" class="active" title="Quay về hiện tại">● LIVE</button>
    <button id="rp-export" title="Export phiên ra JSON">💾</button>
    <button id="rp-record" title="Quay timelapse WebM">🎬</button>
    <button id="rp-import" title="Import file replay JSON (hoặc kéo-thả vào trang)">📂</button>
    <input id="rp-file" type="file" accept=".json,application/json" hidden />
    <span id="rp-msg"></span>
  `;

  const playBtn = root.querySelector<HTMLButtonElement>("#rp-play")!;
  const scrub = root.querySelector<HTMLInputElement>("#rp-scrub")!;
  const timeEl = root.querySelector<HTMLElement>("#rp-time")!;
  const liveBtn = root.querySelector<HTMLButtonElement>("#rp-live")!;
  const fileInput = root.querySelector<HTMLInputElement>("#rp-file")!;
  const msgEl = root.querySelector<HTMLElement>("#rp-msg")!;

  let cursor: ReplayCursor | null = null; // null = live mode
  let t = 0;
  let speed = 4;
  let playing = false;
  let lastTick = 0; // performance.now() of the previous clock tick
  let msgTimer: ReturnType<typeof setTimeout> | null = null;

  function message(text: string): void {
    msgEl.textContent = text;
    if (msgTimer) clearTimeout(msgTimer);
    msgTimer = setTimeout(() => (msgEl.textContent = ""), 4000);
  }

  function syncButtons(): void {
    playBtn.textContent = playing ? "⏸" : "▶";
    liveBtn.classList.toggle("active", cursor === null);
    for (const btn of root.querySelectorAll<HTMLButtonElement>(".rp-speed")) {
      btn.classList.toggle("active", Number(btn.dataset.speed) === speed);
    }
  }

  function emitView(): void {
    if (!cursor) return;
    onView({ state: cursor.stateAt(t), now: t, speed });
    scrub.min = String(cursor.startMs);
    scrub.max = String(cursor.endMs);
    scrub.value = String(t);
    timeEl.textContent = `${fmt(t - cursor.startMs)} / ${fmt(cursor.endMs - cursor.startMs)}`;
  }

  /** Detach from live into replay over the given events (or a fresh snapshot). */
  function enterReplay(events?: ReturnType<EventRecorder["snapshot"]>, atMs?: number): boolean {
    const list = events ?? recorder.snapshot();
    if (list.length === 0) {
      message("Chưa có event nào để replay");
      return false;
    }
    cursor = new ReplayCursor(list);
    t = Math.min(Math.max(atMs ?? cursor.startMs, cursor.startMs), cursor.endMs);
    emitView();
    syncButtons();
    return true;
  }

  function goLive(): void {
    cursor = null;
    playing = false;
    onView(null);
    syncButtons();
  }

  playBtn.addEventListener("click", () => {
    if (!cursor) {
      if (!enterReplay()) return;
      playing = true;
    } else {
      playing = !playing;
      if (playing && t >= cursor.endMs) t = cursor.startMs; // replay again from the top
    }
    lastTick = performance.now();
    syncButtons();
  });

  for (const btn of root.querySelectorAll<HTMLButtonElement>(".rp-speed")) {
    btn.addEventListener("click", () => {
      speed = Number(btn.dataset.speed);
      syncButtons();
    });
  }

  scrub.addEventListener("input", () => {
    const value = Number(scrub.value);
    if (!cursor) {
      enterReplay(undefined, value);
    } else {
      t = value;
      emitView();
    }
  });

  liveBtn.addEventListener("click", goLive);

  root.querySelector("#rp-export")!.addEventListener("click", () => {
    if (recorder.size === 0) {
      message("Chưa có event nào để export");
      return;
    }
    const blob = new Blob([recorder.toJSON()], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `agent-office-replay-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    message(`Đã export ${recorder.size} event`);
  });

  // R10: record the canvas to a .webm timelapse (opt-in, degrades if unsupported)
  const recordBtn = root.querySelector<HTMLButtonElement>("#rp-record")!;
  const exporter = createVideoExporter(canvas);
  if (!exporter.supported) {
    recordBtn.disabled = true;
    recordBtn.title = "Trình duyệt không hỗ trợ quay video";
  } else {
    recordBtn.addEventListener("click", () => {
      if (exporter.recording()) {
        exporter.stop();
        recordBtn.textContent = "🎬";
        message("Đã tải timelapse");
      } else {
        exporter.start();
        recordBtn.textContent = "⏺";
        message("Đang quay — bật replay 60× rồi quay để có timelapse");
      }
    });
  }

  root.querySelector("#rp-import")!.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const file = fileInput.files?.[0];
    if (file) importFile(file);
    fileInput.value = "";
  });

  // drag-drop a replay JSON anywhere on the page
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file) importFile(file);
  });

  function importFile(file: File): void {
    file.text().then(
      (text) => {
        try {
          const events = parseReplayFile(text);
          if (events.length === 0) {
            message("File replay rỗng");
            return;
          }
          playing = false;
          enterReplay(events);
          message(`Đã nạp ${events.length} event — kéo timeline hoặc bấm ▶`);
        } catch (err) {
          message(err instanceof Error ? err.message : "Không đọc được file");
        }
      },
      () => message("Không đọc được file"),
    );
  }

  // replay clock + live-range tracking; 10 Hz is plenty (AgentLayer tweens
  // between states, and live state only changes when events arrive anyway).
  // Advance by real elapsed time × speed — background tabs throttle
  // setInterval, a fixed per-tick step would slow the replay clock down.
  setInterval(() => {
    if (!cursor) {
      scrub.min = String(recorder.startMs);
      scrub.max = String(recorder.endMs);
      scrub.value = scrub.max;
      timeEl.textContent = recorder.size ? `LIVE · ${recorder.size} event · ${fmt(recorder.endMs - recorder.startMs)}` : "LIVE · 0 event";
      return;
    }
    if (!playing) return;
    const now = performance.now();
    t += (now - lastTick) * speed;
    lastTick = now;
    if (t >= cursor.endMs) {
      t = cursor.endMs;
      playing = false;
      syncButtons();
    }
    emitView();
  }, TICK_MS);

  syncButtons();
}

function fmt(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
