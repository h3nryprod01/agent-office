/**
 * Voice for the PM chatbox (Round 6, wi-voice) — zero dependencies.
 *
 * Input: Web Speech API (webkitSpeechRecognition, lang vi-VN). Hold the 🎤
 * button or the Space key (when not typing) to talk; the live transcript
 * lands in the chat input; releasing gives a 1.5s grace window to edit
 * (typing restarts it) or cancel with Esc before the message auto-sends.
 *
 * Output: PM replies are read aloud — 🔊 toggle, off by default, remembered
 * in localStorage. Markdown is stripped first (stripForSpeech), then the
 * reply routes by language (detectLang): English → speechSynthesis (system
 * voices are good); Vietnamese → VieNeu qua daemon POST /tts (wi-voice-vieneu:
 * giọng vi hệ thống duy nhất là Linh compact, đọc "như đánh vần" — user bác
 * 2 lần). Reply Việt được cắt theo câu (splitSentences), phát nối tiếp qua
 * <audio> với prefetch câu kế; daemon tắt/503 → tự fallback speechSynthesis
 * (Linh) kèm 1 dòng hint. Xem docs/voice-vi-status.md.
 *
 * createVoiceMachine() is the testable core: the recognition object is
 * injected so unit tests drive it with a mock. wireVoice() is DOM glue.
 */

export interface RecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0?: { transcript: string } }>;
}

/** The slice of (webkit)SpeechRecognition the machine actually uses. */
export interface RecognitionLike {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: RecognitionEventLike) => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export type VoiceStatus = "idle" | "listening" | "pending";

export interface VoiceMachineOpts {
  /** Live transcript (finals + trailing interim) — goes straight into the input. */
  onTranscript(text: string): void;
  /** Grace window elapsed — send whatever is in the input now. */
  onSend(): void;
  onStatus(status: VoiceStatus): void;
  /** Recognition error worth surfacing (mic blocked, …); quiet ones skipped by caller. */
  onError?(code: string): void;
  graceMs?: number;
}

export interface VoiceMachine {
  status(): VoiceStatus;
  /** Begin (or, during the grace window, resume) dictation. */
  start(): void;
  /** Release: settle final results, then auto-send after the grace window. */
  stop(): void;
  /** Esc: drop listening/pending without sending. */
  cancel(): void;
  /** User typed in the input during the grace window — restart the countdown. */
  touch(): void;
}

export function createVoiceMachine(
  createRecognition: () => RecognitionLike | null,
  opts: VoiceMachineOpts,
): VoiceMachine {
  const graceMs = opts.graceMs ?? 800;
  let status: VoiceStatus = "idle";
  let rec: RecognitionLike | null = null;
  let finalText = "";
  let heard = ""; // finals + trailing interim, as last pushed to the input
  let grace: ReturnType<typeof setTimeout> | null = null;
  let released = false; // the user let go of the mic (vs the engine ending on a pause)

  const setStatus = (s: VoiceStatus): void => {
    if (s === status) return;
    status = s;
    opts.onStatus(s);
  };
  const clearGrace = (): void => {
    if (grace) clearTimeout(grace);
    grace = null;
  };
  const armGrace = (): void => {
    clearGrace();
    grace = setTimeout(() => {
      grace = null;
      setStatus("idle");
      opts.onSend();
    }, graceMs);
  };

  // One recognition session. Extracted so onend can relaunch it: Chrome's
  // webkitSpeechRecognition often ends on its own after a short silence even
  // with continuous=true. If the user is still holding the mic, respawn and keep
  // listening instead of treating the pause as "done" and sending early.
  const spawn = (): boolean => {
    const r = createRecognition();
    if (!r) return false;
    r.lang = "vi-VN";
    r.interimResults = true;
    r.continuous = true;
    // `r !== rec` guards drop events from a replaced/cancelled recognition
    r.onresult = (e) => {
      if (r !== rec) return;
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (!res) continue;
        const t = res[0]?.transcript ?? "";
        if (res.isFinal) finalText += t;
        else interim += t;
      }
      heard = (finalText + interim).trim();
      opts.onTranscript(heard);
    };
    r.onerror = (e) => {
      if (r !== rec) return;
      rec = null;
      clearGrace();
      setStatus("idle");
      opts.onError?.(e.error ?? "unknown");
    };
    r.onend = () => {
      if (r !== rec) return;
      rec = null;
      if (status !== "listening") return; // already cancelled or errored
      if (!released) {
        spawn(); // engine paused but the user is still holding — keep listening
        return;
      }
      if (heard) {
        setStatus("pending");
        armGrace();
      } else {
        setStatus("idle");
      }
    };
    rec = r;
    r.start();
    return true;
  };

  const start = (): void => {
    if (status === "listening") return;
    const resuming = status === "pending"; // talk again during grace = keep dictating
    clearGrace();
    if (!resuming) {
      finalText = "";
      heard = "";
    }
    released = false;
    if (spawn()) setStatus("listening"); // stay idle if the browser has no recognition
  };

  const stop = (): void => {
    if (status !== "listening") return;
    released = true; // real release → onend settles, does not respawn
    rec?.stop(); // remaining finals arrive, then onend decides pending vs idle
  };

  const cancel = (): void => {
    if (status === "idle") return;
    clearGrace();
    const r = rec;
    rec = null;
    r?.abort();
    setStatus("idle");
  };

  const touch = (): void => {
    if (status === "pending") armGrace();
  };

  return { status: () => status, start, stop, cancel, touch };
}

// ── TTS: read PM replies aloud ─────────────────────────────────────────────

const TTS_KEY = "agent-office.tts";

/**
 * wi-pm-ux: a vi-VN voice reading an English reply spells it letter-by-letter.
 * Heuristic: any Vietnamese-specific letter → vi-VN, otherwise en-US.
 */
export function detectLang(text: string): "vi-VN" | "en-US" {
  return /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i.test(text)
    ? "vi-VN"
    : "en-US";
}

/**
 * wi-pm-ux: PM replies are markdown — reading `**`, `#`, `|`, URLs aloud is
 * noise. Strip to plain text; a markdown table collapses to "bảng N dòng".
 */
export function stripForSpeech(text: string): string {
  let t = text.replace(/```[\s\S]*?```/g, " ");
  const lines = t.split("\n");
  const isTableRow = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l);
  const tableRows = lines.filter(isTableRow);
  if (tableRows.length >= 2) {
    // header + separator + data rows → read a summary instead of pipes
    const dataRows = tableRows.filter((l) => !/^\s*\|[\s:|-]+\|\s*$/.test(l)).length - 1;
    t = [...lines.filter((l) => !isTableRow(l)), `bảng ${Math.max(dataRows, 0)} dòng`].join("\n");
  }
  return t
    .replace(/`([^`]*)`/g, "$1")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/(\*\*|__|~~|\*|_)/g, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * wi-voice-vieneu: reply Việt cắt theo câu để câu đầu vang lên sau ~2s thay vì
 * chờ VieNeu render cả reply (infer ~0.6× realtime, đo 2026-07-08). Câu quá
 * dài (bullet gộp) cắt thêm ở dấu phẩy/chấm phẩy cho từng clip ngắn lại.
 */
export function splitSentences(text: string): string[] {
  const MAX = 180;
  const out: string[] = [];
  for (const part of text.split(/(?<=[.!?…])\s+/)) {
    let rest = part.trim();
    while (rest.length > MAX) {
      const at = Math.max(rest.lastIndexOf(", ", MAX), rest.lastIndexOf("; ", MAX));
      if (at < 40) break; // không có chỗ cắt hợp lý — chấp nhận clip dài
      out.push(rest.slice(0, at + 1));
      rest = rest.slice(at + 1).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

/** The slice of HTMLAudioElement the speaker uses (mockable in tests). */
export interface AudioLike {
  play(): unknown;
  pause(): void;
  onended: (() => void) | null;
  onerror: ((e?: unknown) => void) | null;
}

export interface SpeakerDeps {
  /**
   * POST /tts cho MỘT câu → object URL của WAV, null khi daemon/VieNeu không
   * sẵn sàng (renderer sẽ fallback speechSynthesis). Không có dep này thì
   * tiếng Việt cũng đi đường speechSynthesis như trước.
   */
  fetchTtsUrl?(text: string): Promise<string | null>;
  createAudio?(url: string): AudioLike;
  revokeUrl?(url: string): void;
  /** Gọi đúng 1 lần khi VieNeu thiếu và phải dùng giọng hệ thống cho tiếng Việt. */
  onFallbackHint?(): void;
  /** Tab đang ẩn? Mặc định đọc document.hidden. */
  isHidden?(): boolean;
}

export interface Speaker {
  supported: boolean;
  enabled(): boolean;
  setEnabled(on: boolean): void;
  /** Queue one reply line; no-op while the toggle is off. */
  speak(text: string): void;
  /** User sent a new message — stop reading the old reply. */
  cancel(): void;
  /** PM finished a reply — next reply routes by its own language again (sticky VI doesn't carry over). */
  resetTurn(): void;
}

export function createSpeaker(
  onSpeaking?: (speaking: boolean) => void,
  deps: SpeakerDeps = {},
): Speaker {
  const supported = typeof window !== "undefined" && "speechSynthesis" in window;
  let enabled = supported && localStorage.getItem(TTS_KEY) === "1";
  let active = 0; // reply lines queued + đang đọc

  // HTMLAudioElement khớp AudioLike lúc runtime; khác nhau mỗi chữ ký handler
  // (DOM truyền Event, mình không dùng) — cast thay vì nới interface cho mock.
  const createAudio =
    deps.createAudio ?? ((url: string): AudioLike => new Audio(url) as unknown as AudioLike);
  const revokeUrl = deps.revokeUrl ?? ((url: string) => URL.revokeObjectURL(url));
  const isHidden = deps.isHidden ?? ((): boolean => typeof document !== "undefined" && document.hidden);

  const setActive = (n: number): void => {
    const was = active > 0;
    active = n;
    if (was !== active > 0) onSpeaking?.(active > 0);
  };

  // ── đường VieNeu qua daemon /tts (giọng Đoan, giọng đọc duy nhất) ─────────
  let gen = 0; // cancel() bumps — vòng pump cũ tự thoát
  let queue: string[] = [];
  let pumping = false;
  let hinted = false;
  let stopCurrent: (() => void) | null = null;

  const playUrl = (url: string): Promise<boolean> =>
    new Promise((resolve) => {
      const a = createAudio(url);
      const done = (ok: boolean): void => {
        stopCurrent = null;
        resolve(ok);
      };
      stopCurrent = () => {
        a.pause();
        done(false);
      };
      a.onended = () => done(true);
      a.onerror = () => done(false);
      // play() reject (autoplay policy…) → coi như câu này phát hỏng
      Promise.resolve(a.play()).catch(() => done(false));
    });

  const pump = async (): Promise<void> => {
    if (pumping) return;
    pumping = true;
    try {
      while (queue.length) {
        const myGen = gen;
        const text = queue.shift()!;
        const sentences = splitSentences(text);
        // prefetch câu kế trong lúc câu hiện tại đang phát — lấp độ trễ infer
        let next: Promise<string | null> | null = sentences.length
          ? deps.fetchTtsUrl!(sentences[0]!).catch(() => null)
          : null;
        for (let i = 0; i < sentences.length; i++) {
          const url = await next;
          next =
            i + 1 < sentences.length
              ? deps.fetchTtsUrl!(sentences[i + 1]!).catch(() => null)
              : null;
          if (myGen !== gen) {
            if (url) revokeUrl(url);
            break;
          }
          if (!url) {
            // VieNeu không sẵn sàng → bỏ phần còn lại, chỉ hiện hint (không đè giọng hệ thống)
            if (!hinted) {
              hinted = true;
              deps.onFallbackHint?.();
            }
            break;
          }
          const ok = await playUrl(url);
          revokeUrl(url);
          if (myGen !== gen) break;
          if (!ok) {
            // clip hỏng → bỏ qua phần còn lại, không đè giọng hệ thống lên VieNeu
            break;
          }
        }
        if (myGen === gen) setActive(Math.max(0, active - 1));
      }
    } finally {
      pumping = false;
      if (queue.length) void pump(); // speak() lọt vào đúng lúc đang thoát
    }
  };

  const cancel = (): void => {
    if (!supported) return;
    gen++;
    queue = [];
    stopCurrent?.(); // pause <audio> + release vòng pump đang await
    window.speechSynthesis.cancel(); // fires onend/onerror per utterance…
    setActive(0); // …but not on every engine — force the state down
  };

  return {
    supported,
    enabled: () => enabled,
    setEnabled(on: boolean) {
      enabled = supported && on;
      localStorage.setItem(TTS_KEY, enabled ? "1" : "0");
      if (!enabled) cancel();
    },
    speak(text: string) {
      if (!enabled || !text) return;
      const spoken = stripForSpeech(text);
      if (!spoken) return;
      // Giọng Đoan (VieNeu) là giọng đọc DUY NHẤT. Mọi câu — kể cả dòng tiếng
      // Anh (hash commit, path) — đều đi VieNeu; KHÔNG dùng speechSynthesis nữa
      // (giọng hệ thống Linh đọc "đánh vần", lại chồng giọng khi mở nhiều tab).
      if (!deps.fetchTtsUrl) return; // không có daemon VieNeu → im lặng, không rơi sang giọng hệ thống
      // Mỗi tab office mở là một client WS riêng, nên cùng một reply được N tab
      // đọc cùng lúc, lệch nhau vài trăm ms → nghe như mấy người nói chồng nhau.
      // Chỉ tab đang nhìn thấy mới đọc; tab nền im.
      if (isHidden()) return;
      setActive(active + 1);
      queue.push(spoken);
      void pump();
    },
    cancel,
    resetTurn() {
      // no-op: giọng đọc không còn phân nhánh theo ngôn ngữ (chỉ VieNeu/Đoan).
    },
  };
}

// ── DOM glue for the chatbox ───────────────────────────────────────────────

export interface WireVoiceOpts {
  input: HTMLInputElement;
  micBtn: HTMLButtonElement;
  speakerBtn: HTMLButtonElement;
  /** Trigger the chatbox send (it reads the input itself). */
  send(): void;
  appendSystemLine(text: string): void;
  /** speechSynthesis started/stopped reading (for the PM bubble glow). */
  onSpeaking?(speaking: boolean): void;
  /** Endpoint VieNeu của daemon (mặc định /tts). */
  ttsUrl?: string;
}

export interface VoiceHandle {
  /** PM reply line arrived — read it aloud if 🔊 is on. */
  speak(text: string): void;
  /** User sent a message — cut off any ongoing read-out. */
  cancelSpeech(): void;
  /** PM finished a reply — let the next reply route by its own language. */
  speakerResetTurn(): void;
}

export function wireVoice(o: WireVoiceOpts): VoiceHandle {
  type RecognitionCtor = new () => RecognitionLike;
  const w = window as unknown as Record<string, unknown>;
  const Ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as RecognitionCtor | undefined;

  // Reply Việt đi qua VieNeu của daemon; mọi lỗi (daemon tắt, 503, mạng) trả
  // null để speaker fallback speechSynthesis — voice không bao giờ chết hẳn.
  const ttsUrl = o.ttsUrl ?? "/tts";
  const fetchTtsUrl = async (text: string): Promise<string | null> => {
    try {
      const res = await fetch(ttsUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) return null;
      return URL.createObjectURL(await res.blob());
    } catch {
      return null;
    }
  };
  const speaker = createSpeaker(o.onSpeaking, {
    fetchTtsUrl,
    onFallbackHint: () =>
      o.appendSystemLine("🗣️ Giọng đọc (VieNeu) tạm lỗi ở câu này — thử lại hoặc tải lại trang."),
  });

  const machine = createVoiceMachine(() => (Ctor ? new Ctor() : null), {
    onTranscript: (text) => {
      o.input.value = text;
    },
    onSend: () => o.send(),
    onStatus: (s) => {
      o.micBtn.classList.toggle("listening", s === "listening");
      o.micBtn.classList.toggle("pending", s === "pending");
    },
    onError: (code) => {
      if (code === "not-allowed" || code === "service-not-allowed") {
        o.appendSystemLine("Mic bị chặn — cấp quyền microphone cho trang này rồi thử lại.");
        return;
      }
      // "aborted" = user tự huỷ, "no-speech" = không nói gì: im lặng là đúng.
      // Còn lại phải hiện ra. Nuốt hết như trước thì lỗi "network" (Web Speech
      // của Chrome gọi server Google — VPN/tường lửa chặn là hỏng) trông y hệt
      // "mic không chạy" mà không có lấy một dòng nào để lần ra.
      if (code === "aborted" || code === "no-speech") return;
      o.appendSystemLine(
        code === "network"
          ? "Nhận giọng nói lỗi mạng — Web Speech của Chrome cần gọi server Google; kiểm tra VPN/tường lửa."
          : `Nhận giọng nói lỗi: ${code}`,
      );
    },
  });

  if (!Ctor) {
    o.micBtn.disabled = true;
    o.micBtn.title = "Trình duyệt không hỗ trợ Web Speech API — thử Chrome/Edge";
  } else {
    o.micBtn.title = "Bấm để nói (hoặc giữ Space khi không gõ) — thả ra là gửi, Esc để hủy";
    o.micBtn.addEventListener("click", () => {
      if (machine.status() === "listening") machine.stop();
      else machine.start();
      o.micBtn.blur(); // keep Space-PTT from re-clicking the focused button
    });
  }

  if (!speaker.supported) {
    o.speakerBtn.disabled = true;
    o.speakerBtn.title = "Trình duyệt không hỗ trợ speechSynthesis";
  } else {
    const paint = (): void => {
      o.speakerBtn.classList.toggle("on", speaker.enabled());
      o.speakerBtn.title = speaker.enabled()
        ? "Đang đọc to reply của PM — bấm để tắt"
        : "Bấm để PM đọc to reply (mặc định tắt)";
    };
    paint();
    o.speakerBtn.addEventListener("click", () => {
      speaker.setEnabled(!speaker.enabled());
      paint();
      o.speakerBtn.blur();
    });
  }

  const typingSomewhere = (): boolean => {
    const el = document.activeElement;
    // Ô chat giữ focus sau MỌI lần gửi (send() không blur), nên nếu chặn vô điều
    // kiện thì Space-PTT chết hẳn từ tin nhắn thứ hai trở đi — bấm giữ Space chỉ
    // gõ dấu cách. Ô chat rỗng = không ai đang gõ dở → cho PTT chạy; có chữ rồi
    // thì Space vẫn là dấu cách như bình thường.
    if (el === o.input) return o.input.value !== "";
    return (
      el instanceof HTMLInputElement ||
      el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLElement && el.isContentEditable)
    );
  };

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      machine.cancel();
      return;
    }
    if (e.code !== "Space" || e.repeat || !Ctor || typingSomewhere()) return;
    e.preventDefault(); // hold-to-talk must not scroll the office
    machine.start();
  });
  document.addEventListener("keyup", (e) => {
    if (e.code !== "Space" || machine.status() !== "listening") return;
    machine.stop();
  });

  // typing during the grace window restarts the 1.5s countdown
  o.input.addEventListener("input", () => machine.touch());

  // Prime autoplay. The reply's Đoan clip is fetched and played ~10s after the
  // send click, in an async callback OFF the gesture call stack — Chrome then
  // silently blocks <audio>.play() and there is no voice at all. (The old
  // speechSynthesis path masked this; VieNeu-only exposes it.) Playing a tiny
  // silent clip on the first real user gesture unlocks media for the session so
  // later clips play. `once` per event; double-firing is harmless.
  const unlockAudio = (): void => {
    void new Audio(
      "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=",
    )
      .play()
      .catch(() => {});
  };
  addEventListener("pointerdown", unlockAudio, { once: true });
  addEventListener("keydown", unlockAudio, { once: true });

  return {
    speak: (t) => speaker.speak(t),
    cancelSpeech: () => speaker.cancel(),
    speakerResetTurn: () => speaker.resetTurn(),
  };
}
