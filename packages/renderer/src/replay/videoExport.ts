/**
 * Timelapse video export (R10) — records the Pixi canvas to a .webm via
 * captureStream + MediaRecorder. Opt-in (user hits 🎬 in the timeline bar);
 * degrades silently (supported=false → button disabled) when the browser
 * lacks either API. No asset, no post-processing — the canvas IS the source.
 *
 * createVideoExporter(canvas, deps?) is the testable core: the recorder and
 * the download sink are injected so unit tests drive it with mocks, mirroring
 * the Audio / AudioContext injection in ui/voice.ts and audio/sfx.ts.
 */

export interface MediaRecorderLike {
  state: "inactive" | "recording" | "paused";
  start(): void;
  stop(): void;
  ondataavailable: ((e: { data: Blob }) => void) | null;
  onstop: (() => void) | null;
}

export interface VideoExporterDeps {
  /** Override the MediaRecorder factory (tests). Default: `new MediaRecorder(stream, { mimeType })`. */
  makeRecorder?(stream: MediaStream, mime: string): MediaRecorderLike;
  /** Override the download sink (tests). Default: build an `<a download>` and click it. */
  download?(blob: Blob, filename: string): void;
}

export interface VideoExporter {
  supported: boolean;
  recording(): boolean;
  start(): void;
  stop(): void;
}

const MIME_CANDIDATES = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];

export function createVideoExporter(
  /** the canvas to record, or a getter — the app has two (2D/3D) and swaps at runtime,
   *  so the source is resolved when recording starts, not when this is built. */
  canvasOrGet: HTMLCanvasElement | (() => HTMLCanvasElement),
  deps: VideoExporterDeps = {},
): VideoExporter {
  const getCanvas = typeof canvasOrGet === "function" ? canvasOrGet : (): HTMLCanvasElement => canvasOrGet;
  const supported =
    typeof getCanvas().captureStream === "function" && typeof MediaRecorder !== "undefined";

  let recorder: MediaRecorderLike | null = null;
  let chunks: Blob[] = [];
  let mime = "video/webm";

  const pickMime = (): string => {
    if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
      return "video/webm";
    }
    return MIME_CANDIDATES.find((c) => MediaRecorder.isTypeSupported(c)) ?? "video/webm";
  };

  const makeRecorder =
    deps.makeRecorder ??
    ((stream: MediaStream, m: string): MediaRecorderLike =>
      new MediaRecorder(stream, { mimeType: m }) as unknown as MediaRecorderLike);

  const download =
    deps.download ??
    ((blob: Blob, filename: string): void => {
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
    });

  return {
    supported,
    recording: () => recorder !== null && recorder.state === "recording",
    start() {
      if (!supported || recorder) return;
      const stream = getCanvas().captureStream(30);
      mime = pickMime();
      recorder = makeRecorder(stream, mime);
      chunks = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mime });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        download(blob, `agent-office-timelapse-${stamp}.webm`);
        recorder = null;
        chunks = [];
      };
      recorder.start();
    },
    stop() {
      recorder?.stop();
    },
  };
}
