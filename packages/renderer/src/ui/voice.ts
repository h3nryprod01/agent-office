/**
 * Voice for the PM chat box — no dependencies.
 *
 * Input: the Web Speech API. Hold the 🎤 button, or Space when you aren't
 * typing, to talk. The live transcript lands in the chat input; releasing gives
 * a short grace window to edit (typing restarts it) or cancel with Esc before
 * the message sends itself.
 *
 * Output: replies are read aloud behind a toggle that is off by default and
 * remembered. Markdown is stripped first (stripForSpeech), then the reply is
 * split into sentences and played back to back through <audio>, prefetching the
 * next clip while the current one plays.
 *
 * There is exactly one voice, served by the daemon at POST /tts. The browser's
 * own speechSynthesis is deliberately not a fallback: the only system
 * Vietnamese voice reads word by word, and it doubled up across tabs. Without
 * the daemon the speaker stays silent and says so once. See
 * docs/voice-vi-status.md.
 *
 * createVoiceMachine() is the testable core — the recognition object is
 * injected so unit tests drive it with a mock. wireVoice() is the DOM glue.
 */

import { t } from "../i18n";

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
 * noise. Strip to plain text; a markdown table collapses to "table, N rows".
 */
export function stripForSpeech(text: string): string {
  let out = text.replace(/```[\s\S]*?```/g, " ");
  const lines = out.split("\n");
  const isTableRow = (l: string): boolean => /^\s*\|.*\|\s*$/.test(l);
  const tableRows = lines.filter(isTableRow);
  if (tableRows.length >= 2) {
    // header + separator + data rows → read a summary instead of pipes
    const dataRows = tableRows.filter((l) => !/^\s*\|[\s:|-]+\|\s*$/.test(l)).length - 1;
    out = [...lines.filter((l) => !isTableRow(l)), t("voice.tableSummary", { rows: Math.max(dataRows, 0) })].join("\n");
  }
  return out
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
 * Split a reply into sentences so the first one is audible after ~2s instead of
 * waiting for the whole reply to render (inference measured at ~0.6× realtime).
 * An over-long sentence — a run of merged bullets — splits again at commas and
 * semicolons so no single clip is long.
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
   * POST /tts for ONE sentence → an object URL for the WAV, or null when the
   * daemon's voice is unavailable. Without this dependency the speaker stays
   * silent rather than falling back to a system voice.
   */
  fetchTtsUrl?(text: string): Promise<string | null>;
  createAudio?(url: string): AudioLike;
  revokeUrl?(url: string): void;
  /** Called exactly once when the voice backend is missing. */
  onFallbackHint?(): void;
  /** Is the tab hidden? Reads document.hidden by default. */
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

  // HTMLAudioElement satisfies AudioLike at runtime; only the handler signatures
  // differ (the DOM passes an Event we don't use), so cast rather than widening
  // the interface just to fit a mock.
  const createAudio =
    deps.createAudio ?? ((url: string): AudioLike => new Audio(url) as unknown as AudioLike);
  const revokeUrl = deps.revokeUrl ?? ((url: string) => URL.revokeObjectURL(url));
  const isHidden = deps.isHidden ?? ((): boolean => typeof document !== "undefined" && document.hidden);

  const setActive = (n: number): void => {
    const was = active > 0;
    active = n;
    if (was !== active > 0) onSpeaking?.(active > 0);
  };

  // ── the daemon /tts path — the only voice the office speaks with ─────────
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
      // play() rejecting (autoplay policy, …) counts as this clip failing
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
        // prefetch the next sentence while this one plays, hiding inference latency
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
            // voice backend unavailable → drop the rest and show the hint once
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
            // a broken clip ends the reply rather than switching voices mid-sentence
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
      // One voice, always. Every line — including the English ones (commit
      // hashes, paths) — goes through the daemon. speechSynthesis is gone: the
      // system Vietnamese voice spells words out, and it doubled up across tabs.
      if (!deps.fetchTtsUrl) return; // không có daemon VieNeu → im lặng, không rơi sang giọng hệ thống
      // Every open office tab is its own WS client, so one reply gets read by N
      // tabs a few hundred ms apart — it sounds like several people talking over
      // each other. Only the visible tab speaks; background tabs stay quiet.
      if (isHidden()) return;
      setActive(active + 1);
      queue.push(spoken);
      void pump();
    },
    cancel,
    resetTurn() {
      // no-op: the speaker no longer branches by language.
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
  /** The daemon's voice endpoint (defaults to /tts). */
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

  // Replies go through the daemon's voice; any failure — daemon down, 503,
  // network — returns null, and the speaker stays silent rather than crashing.
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
      o.appendSystemLine(t("voice.ttsGlitch")),
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
        o.appendSystemLine(t("voice.micBlocked"));
        return;
      }
      // "aborted" is the user cancelling and "no-speech" is silence — staying
      // quiet is right for both. Everything else must surface. Swallowing them
      // all, as this used to, made a "network" failure (Chrome's Web Speech
      // calls Google's servers, so a VPN or firewall breaks it) look exactly
      // like a dead microphone, with nothing to trace it by.
      if (code === "aborted" || code === "no-speech") return;
      o.appendSystemLine(
        code === "network"
          ? t("voice.networkError")
          : t("voice.error", { code }),
      );
    },
  });

  if (!Ctor) {
    o.micBtn.disabled = true;
    o.micBtn.title = t("voice.unsupported");
  } else {
    o.micBtn.title = t("voice.micTitle");
    o.micBtn.addEventListener("click", () => {
      if (machine.status() === "listening") machine.stop();
      else machine.start();
      o.micBtn.blur(); // keep Space-PTT from re-clicking the focused button
    });
  }

  if (!speaker.supported) {
    o.speakerBtn.disabled = true;
    o.speakerBtn.title = t("voice.ttsUnsupported");
  } else {
    const paint = (): void => {
      o.speakerBtn.classList.toggle("on", speaker.enabled());
      o.speakerBtn.title = speaker.enabled()
        ? t("voice.ttsOn")
        : t("voice.ttsOff");
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
    // The chat input keeps focus after EVERY send (send() doesn't blur), so
    // blocking unconditionally kills push-to-talk from the second message on —
    // holding Space would only type a space. An empty input means nobody is
    // mid-sentence, so Space belongs to PTT; with text in it, Space is a space.
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

  // Prime autoplay. The reply's audio clip is fetched and played ~10s after the
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
