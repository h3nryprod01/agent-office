import { afterEach, describe, expect, it, vi } from "vitest";
import { createVideoExporter, type MediaRecorderLike } from "../src/replay/videoExport";

/** Minimal MediaRecorder mock — records start/stop and fires onstop synchronously. */
class MockRecorder implements MediaRecorderLike {
  state: "inactive" | "recording" | "paused" = "inactive";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  started = 0;
  stopped = 0;
  start(): void {
    this.started++;
    this.state = "recording";
  }
  stop(): void {
    this.stopped++;
    this.state = "inactive";
    this.onstop?.();
  }
  emitChunk(data: Blob): void {
    this.ondataavailable?.({ data });
  }
}

function videoHarness(opts: { capture?: boolean } = {}) {
  // Stub MediaRecorder so `supported` is true and pickMime resolves "video/webm".
  vi.stubGlobal("MediaRecorder", class {
    static isTypeSupported(m: string): boolean {
      return m === "video/webm";
    }
  });
  const rec = new MockRecorder();
  const downloaded: Array<{ blob: Blob; name: string }> = [];
  const canvas = (opts.capture === false ? {} : { captureStream: () => ({}) }) as unknown as HTMLCanvasElement;
  const exporter = createVideoExporter(canvas, {
    makeRecorder: () => rec,
    download: (blob, name) => downloaded.push({ blob, name }),
  });
  return { exporter, rec, downloaded };
}

describe("createVideoExporter — timelapse WebM (R10)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("không có captureStream → supported=false, start() không ném", () => {
    const { exporter } = videoHarness({ capture: false });
    expect(exporter.supported).toBe(false);
    expect(() => exporter.start()).not.toThrow();
    expect(exporter.recording()).toBe(false);
  });

  it("start() → recording=true và MediaRecorder.start được gọi đúng 1 lần", () => {
    const { exporter, rec } = videoHarness();
    expect(exporter.supported).toBe(true);
    exporter.start();
    expect(exporter.recording()).toBe(true);
    expect(rec.started).toBe(1);
  });

  it("stop() sau khi có chunk → recording=false, download 1 lần blob mime video/webm", () => {
    const { exporter, rec, downloaded } = videoHarness();
    exporter.start();
    rec.emitChunk(new Blob(["chunk"], { type: "video/webm" }));
    exporter.stop();
    expect(exporter.recording()).toBe(false);
    expect(downloaded).toHaveLength(1);
    expect(downloaded[0]!.blob.type.startsWith("video/webm")).toBe(true);
    expect(downloaded[0]!.name.endsWith(".webm")).toBe(true);
  });
});
