import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSpeaker,
  createVoiceMachine,
  detectLang,
  splitSentences,
  stripForSpeech,
  type AudioLike,
  type RecognitionEventLike,
  type RecognitionLike,
  type VoiceStatus,
} from "../src/ui/voice";

class MockRecognition implements RecognitionLike {
  lang = "";
  interimResults = false;
  continuous = false;
  onresult: ((e: RecognitionEventLike) => void) | null = null;
  onerror: ((e: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  started = 0;
  stopped = 0;
  aborted = 0;
  start(): void {
    this.started++;
  }
  stop(): void {
    this.stopped++;
  }
  abort(): void {
    this.aborted++;
  }
  emitResult(items: Array<{ text: string; final: boolean }>, resultIndex = 0): void {
    this.onresult?.({
      resultIndex,
      results: items.map((i) => ({ isFinal: i.final, 0: { transcript: i.text } })),
    });
  }
  emitEnd(): void {
    this.onend?.();
  }
  emitError(error: string): void {
    this.onerror?.({ error });
  }
}

function harness(graceMs = 1500) {
  const recs: MockRecognition[] = [];
  const calls = {
    transcript: [] as string[],
    send: 0,
    status: [] as VoiceStatus[],
    errors: [] as string[],
  };
  const machine = createVoiceMachine(
    () => {
      const r = new MockRecognition();
      recs.push(r);
      return r;
    },
    {
      onTranscript: (t) => calls.transcript.push(t),
      onSend: () => calls.send++,
      onStatus: (s) => calls.status.push(s),
      onError: (c) => calls.errors.push(c),
      graceMs,
    },
  );
  const rec = () => recs[recs.length - 1]!;
  return { machine, recs, calls, rec };
}

describe("createVoiceMachine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("start() configures vi-VN continuous recognition and goes listening", () => {
    const { machine, rec, calls } = harness();
    machine.start();
    expect(machine.status()).toBe("listening");
    expect(rec().started).toBe(1);
    expect(rec().lang).toBe("vi-VN");
    expect(rec().interimResults).toBe(true);
    expect(rec().continuous).toBe(true);
    expect(calls.status).toEqual(["listening"]);
  });

  it("start() while listening is a no-op (single live recognition)", () => {
    const { machine, recs } = harness();
    machine.start();
    machine.start();
    expect(recs.length).toBe(1);
  });

  it("streams interim then final transcripts, only reading new results per event", () => {
    const { machine, rec, calls } = harness();
    machine.start();
    rec().emitResult([{ text: "xin ch", final: false }]);
    rec().emitResult([{ text: "xin chào", final: true }]);
    rec().emitResult([{ text: "xin chào", final: true }, { text: " PM", final: false }], 1);
    expect(calls.transcript).toEqual(["xin ch", "xin chào", "xin chào PM"]);
  });

  it("stop() with speech → pending, then auto-send after the grace window", () => {
    const { machine, rec, calls } = harness();
    machine.start();
    rec().emitResult([{ text: "trạng thái dự án", final: true }]);
    machine.stop();
    expect(rec().stopped).toBe(1);
    rec().emitEnd();
    expect(machine.status()).toBe("pending");
    vi.advanceTimersByTime(1499);
    expect(calls.send).toBe(0);
    vi.advanceTimersByTime(1);
    expect(calls.send).toBe(1);
    expect(machine.status()).toBe("idle");
  });

  it("stop() with no speech heard goes straight back to idle, no send", () => {
    const { machine, rec, calls } = harness();
    machine.start();
    machine.stop();
    rec().emitEnd();
    expect(machine.status()).toBe("idle");
    vi.advanceTimersByTime(5000);
    expect(calls.send).toBe(0);
  });

  it("interim-only speech still counts when the engine never finalizes", () => {
    const { machine, rec } = harness();
    machine.start();
    rec().emitResult([{ text: "chưa chốt", final: false }]);
    machine.stop();
    rec().emitEnd();
    expect(machine.status()).toBe("pending");
  });

  it("engine ends mid-hold (no release) → respawns and keeps listening, transcript continues", () => {
    const { machine, recs, calls } = harness();
    machine.start();
    recs[0]!.emitResult([{ text: "một hai", final: true }]);
    recs[0]!.emitEnd(); // Chrome ended on a pause, but the user has NOT let go
    expect(machine.status()).toBe("listening"); // stays listening, does not send early
    expect(recs.length).toBe(2); // a fresh recognition was launched
    recs[1]!.emitResult([{ text: " ba bốn", final: true }]);
    expect(calls.transcript.at(-1)).toBe("một hai ba bốn"); // earlier finals kept
    expect(calls.send).toBe(0);

    machine.stop(); // now the user releases
    recs[1]!.emitEnd();
    expect(machine.status()).toBe("pending"); // this end settles instead of respawning
  });

  it("cancel() during the grace window drops the send", () => {
    const { machine, rec, calls } = harness();
    machine.start();
    rec().emitResult([{ text: "gửi nhầm", final: true }]);
    machine.stop();
    rec().emitEnd();
    machine.cancel();
    vi.advanceTimersByTime(5000);
    expect(calls.send).toBe(0);
    expect(machine.status()).toBe("idle");
  });

  it("cancel() while listening aborts; the late onend is ignored", () => {
    const { machine, rec, calls } = harness();
    machine.start();
    const r = rec();
    r.emitResult([{ text: "hủy giữa chừng", final: false }]);
    machine.cancel();
    expect(r.aborted).toBe(1);
    r.emitEnd(); // browsers fire onend after abort()
    expect(machine.status()).toBe("idle");
    vi.advanceTimersByTime(5000);
    expect(calls.send).toBe(0);
  });

  it("touch() during the grace window restarts the countdown", () => {
    const { machine, rec, calls } = harness();
    machine.start();
    rec().emitResult([{ text: "sửa tay", final: true }]);
    machine.stop();
    rec().emitEnd();
    vi.advanceTimersByTime(1000);
    machine.touch();
    vi.advanceTimersByTime(1000);
    expect(calls.send).toBe(0); // old deadline passed but timer was re-armed
    vi.advanceTimersByTime(500);
    expect(calls.send).toBe(1);
  });

  it("start() during the grace window resumes dictation and keeps earlier finals", () => {
    const { machine, recs, calls } = harness();
    machine.start();
    recs[0]!.emitResult([{ text: "phần một", final: true }]);
    machine.stop();
    recs[0]!.emitEnd();
    expect(machine.status()).toBe("pending");

    machine.start(); // talk again before the 1.5s elapsed
    expect(recs.length).toBe(2);
    recs[1]!.emitResult([{ text: " phần hai", final: true }]);
    expect(calls.transcript.at(-1)).toBe("phần một phần hai");

    machine.stop();
    recs[1]!.emitEnd();
    vi.advanceTimersByTime(1500);
    expect(calls.send).toBe(1);
  });

  it("recognition error reports the code, resets to idle, and allows a fresh start", () => {
    const { machine, recs, calls } = harness();
    machine.start();
    recs[0]!.emitError("not-allowed");
    expect(calls.errors).toEqual(["not-allowed"]);
    expect(machine.status()).toBe("idle");
    recs[0]!.emitEnd(); // Chrome fires onend after onerror — must stay idle
    expect(machine.status()).toBe("idle");

    machine.start();
    expect(recs.length).toBe(2);
    expect(machine.status()).toBe("listening");
  });

  it("a fresh start() clears the previous transcript", () => {
    const { machine, recs, calls } = harness();
    machine.start();
    recs[0]!.emitResult([{ text: "cũ", final: true }]);
    machine.stop();
    recs[0]!.emitEnd();
    vi.advanceTimersByTime(1500); // sent → idle

    machine.start();
    recs[1]!.emitResult([{ text: "mới", final: false }]);
    expect(calls.transcript.at(-1)).toBe("mới");
  });

  it("unsupported browser (factory returns null) stays idle without crashing", () => {
    const calls: VoiceStatus[] = [];
    const machine = createVoiceMachine(() => null, {
      onTranscript: () => {},
      onSend: () => {},
      onStatus: (s) => calls.push(s),
    });
    machine.start();
    expect(machine.status()).toBe("idle");
    machine.stop();
    machine.cancel();
    expect(calls).toEqual([]);
  });
});

// ── wi-pm-ux: TTS language detection + markdown stripping ──────────────────
describe("detectLang", () => {
  it("Vietnamese diacritics → vi-VN", () => {
    expect(detectLang("Done 3 việc, còn 2 việc đang chạy nhé")).toBe("vi-VN");
    expect(detectLang("ổn")).toBe("vi-VN");
    expect(detectLang("ĐANG LÀM")).toBe("vi-VN");
  });

  it("plain English / ASCII → en-US", () => {
    expect(detectLang("All three work items are done.")).toBe("en-US");
    expect(detectLang("PR #24 merged")).toBe("en-US");
  });

  it("mixed text with any Vietnamese letter counts as Vietnamese", () => {
    expect(detectLang("PR #24 đã merge")).toBe("vi-VN");
  });
});

describe("stripForSpeech", () => {
  it("strips bold/italic/headers/bullets/inline code", () => {
    expect(stripForSpeech("## Status\n- **wi-a**: `done`\n- _wi-b_: chạy")).toBe(
      "Status wi-a: done wi-b: chạy",
    );
  });

  it("drops code blocks and URLs", () => {
    expect(stripForSpeech("Xem ```js\nconst x = 1;\n``` tại https://github.com/x/y nhé")).toBe(
      "Xem tại nhé",
    );
  });

  it("markdown table becomes 'bảng N dòng' instead of pipes", () => {
    const md = "Kết quả:\n| wi | status |\n|---|---|\n| a | done |\n| b | doing |";
    expect(stripForSpeech(md)).toBe("Kết quả: table, 2 rows");
  });

  it("plain text passes through untouched", () => {
    expect(stripForSpeech("Done hết rồi.")).toBe("Done hết rồi.");
  });
});

// ── wi-voice-vieneu: cắt câu + router VieNeu/system ────────────────────────

describe("splitSentences", () => {
  it("splits on sentence boundaries, keeps punctuation", () => {
    expect(splitSentences("Chào anh. Có 3 việc đang chạy! Cần gì không?")).toEqual([
      "Chào anh.",
      "Có 3 việc đang chạy!",
      "Cần gì không?",
    ]);
  });

  it("short text stays one chunk (colon is not a boundary)", () => {
    expect(splitSentences("Round 9: voice, office life và hiring hall")).toEqual([
      "Round 9: voice, office life và hiring hall",
    ]);
  });

  it("over-long sentence re-chunks at commas", () => {
    const long = `${"một cụm khá dài để dồn ký tự, ".repeat(9)}và phần chốt cuối cùng`;
    const parts = splitSentences(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(180);
    expect(parts.join(" ").replace(/\s+/g, " ")).toBe(long.replace(/\s+/g, " "));
  });
});

class FakeAudio implements AudioLike {
  static all: FakeAudio[] = [];
  onended: (() => void) | null = null;
  onerror: ((e?: unknown) => void) | null = null;
  played = 0;
  pausedCount = 0;
  constructor(public url: string) {
    FakeAudio.all.push(this);
  }
  play(): Promise<void> {
    this.played++;
    return Promise.resolve();
  }
  pause(): void {
    this.pausedCount++;
  }
}

function speakerHarness(opts: { fetchOk?: boolean; noFetcher?: boolean; hidden?: boolean } = {}) {
  const synth = {
    spoken: [] as Array<{ text: string; voiceName?: string; lang: string }>,
    canceled: 0,
    getVoices: () => [
      { name: "Linh", lang: "vi-VN" },
      { name: "Samantha", lang: "en-US" },
    ],
    speak(u: { text: string; voice?: { name: string }; lang: string; onend?: () => void }) {
      this.spoken.push({ text: u.text, voiceName: u.voice?.name, lang: u.lang });
    },
    cancel() {
      this.canceled++;
    },
  };
  vi.stubGlobal("window", { speechSynthesis: synth });
  vi.stubGlobal("localStorage", { getItem: () => "1", setItem: () => {} });
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      voice?: { name: string };
      lang = "";
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public text: string) {}
    },
  );
  FakeAudio.all = [];
  const fetched: string[] = [];
  const revoked: string[] = [];
  let hints = 0;
  const speaker = createSpeaker(undefined, {
    ...(opts.noFetcher
      ? {}
      : {
          fetchTtsUrl: async (text: string) => {
            fetched.push(text);
            return opts.fetchOk === false ? null : `blob:${text}`;
          },
        }),
    createAudio: (url) => new FakeAudio(url),
    revokeUrl: (url) => revoked.push(url),
    onFallbackHint: () => hints++,
    isHidden: () => opts.hidden === true,
  });
  return { speaker, synth, fetched, revoked, hints: () => hints };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createSpeaker — router VieNeu/system (wi-voice-vieneu)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tab ẩn thì im: mở nhiều tab office không còn chồng giọng", async () => {
    const { speaker, fetched } = speakerHarness({ hidden: true });
    speaker.speak("Chào anh. Done việc thứ nhất.");
    await tick();
    expect(fetched).toEqual([]); // không gọi /tts
    expect(FakeAudio.all.length).toBe(0); // không phát gì
  });

  it("tab đang nhìn thấy vẫn đọc bình thường", async () => {
    const { speaker, fetched } = speakerHarness({ hidden: false });
    speaker.speak("Chào anh.");
    await tick();
    expect(fetched).toEqual(["Chào anh."]);
    expect(FakeAudio.all.length).toBe(1);
  });

  it("reply Việt → VieNeu: fetch từng câu theo thứ tự, phát <audio>, không đụng speechSynthesis", async () => {
    const { speaker, synth, fetched, revoked } = speakerHarness();
    speaker.speak("Chào anh. Done việc thứ nhất.");
    await tick();
    expect(fetched).toEqual(["Chào anh.", "Done việc thứ nhất."]); // câu 2 prefetch ngay
    expect(FakeAudio.all.length).toBe(1);
    expect(FakeAudio.all[0]!.url).toBe("blob:Chào anh.");

    FakeAudio.all[0]!.onended?.();
    await tick();
    expect(FakeAudio.all.length).toBe(2);
    FakeAudio.all[1]!.onended?.();
    await tick();
    expect(synth.spoken).toEqual([]); // không rơi về giọng hệ thống
    expect(revoked).toEqual(["blob:Chào anh.", "blob:Done việc thứ nhất."]);
  });

  it("reply English cũng đi VieNeu (Đoan) — KHÔNG dùng speechSynthesis", async () => {
    const { speaker, synth, fetched } = speakerHarness();
    speaker.speak("All three work items are done.");
    await tick();
    expect(fetched).toEqual(["All three work items are done."]); // qua VieNeu/Đoan, không giọng hệ thống
    expect(synth.spoken).toEqual([]);
  });

  it("daemon /tts trả null → KHÔNG đè giọng hệ thống, chỉ hint đúng 1 lần (B2)", async () => {
    const { speaker, synth, hints } = speakerHarness({ fetchOk: false });
    speaker.speak("Chào anh. Có ba việc đang chạy.");
    await tick();
    expect(synth.spoken).toEqual([]); // VieNeu thiếu → bỏ phần còn lại, không đọc giọng hệ thống
    expect(hints()).toBe(1);

    speaker.speak("Vẫn lỗi tiếp.");
    await tick();
    expect(hints()).toBe(1); // hint không spam
    expect(synth.spoken).toEqual([]);
  });

  it("không có fetchTtsUrl (không daemon) → im lặng, KHÔNG rơi sang giọng hệ thống", async () => {
    const { speaker, synth } = speakerHarness({ noFetcher: true });
    speaker.speak("Chào anh nhé.");
    await tick();
    expect(synth.spoken).toEqual([]); // giọng hệ thống đã bị bỏ hẳn
  });

  it("cancel() giữa chừng: dừng audio, bỏ các câu còn lại, không fetch thêm", async () => {
    const { speaker, fetched } = speakerHarness();
    speaker.speak("Câu một nè. Câu hai nè. Câu ba nè.");
    await tick();
    expect(FakeAudio.all.length).toBe(1);
    const fetchedBefore = fetched.length;

    speaker.cancel();
    await tick();
    expect(FakeAudio.all[0]!.pausedCount).toBe(1);
    await tick();
    expect(FakeAudio.all.length).toBe(1); // không phát câu kế
    expect(fetched.length).toBe(fetchedBefore); // không fetch thêm sau cancel

    // speak mới sau cancel vẫn chạy bình thường (pump không bị kẹt)
    speaker.speak("Reply mới đây.");
    await tick();
    expect(FakeAudio.all.length).toBe(2);
    expect(FakeAudio.all[1]!.url).toBe("blob:Reply mới đây.");
  });

  it("clip phát lỗi (onerror) → bỏ phần còn lại, không đè giọng hệ thống (B2)", async () => {
    const { speaker, synth } = speakerHarness();
    speaker.speak("Câu một nè. Câu hai nè. Câu ba nè.");
    await tick();
    FakeAudio.all[0]!.onerror?.(new Error("decode"));
    await tick();
    expect(synth.spoken).toEqual([]); // clip hỏng → bỏ câu còn lại, không fallback giọng hệ thống
  });

  it("VI line → VieNeu (Đoan), không đụng speechSynthesis", async () => {
    const { speaker, synth, fetched } = speakerHarness();
    speaker.speak("Done việc.");
    await tick();
    expect(fetched).toContain("Done việc.");
    expect(synth.spoken).toEqual([]);
    expect(synth.canceled).toBe(0); // không còn giọng hệ thống nào để phải cancel
  });

  it("line ASCII cũng đi VieNeu (Đoan) — không cần line VI trước, resetTurn không đổi", async () => {
    const { speaker, synth, fetched } = speakerHarness();
    speaker.speak("PR merged OK"); // ASCII → VieNeu ngay, không rơi sang giọng hệ thống
    await tick();
    expect(fetched).toContain("PR merged OK");
    expect(synth.spoken).toEqual([]);
    FakeAudio.all[0]!.onended?.();
    await tick();

    speaker.resetTurn();
    speaker.speak("Another ASCII line"); // vẫn VieNeu — chỉ có 1 giọng
    await tick();
    expect(fetched).toContain("Another ASCII line");
    expect(synth.spoken).toEqual([]);
  });
});
