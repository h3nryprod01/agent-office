import { t } from "../i18n";
/**
 * PM chatbox — bottom-center dock. Round 5: one PM PER REPO — the box talks
 * to the PM of the currently active office tab (tab "All" → the daemon's
 * default repo, i.e. Acme Web). Sends POST /chat {text, repo}; the reply
 * streams back as additive daemon-v1 "chat_message" frames whose top-level
 * `repo` routes each line into that repo's own transcript (kept in page
 * memory, swapped on tab change).
 *
 * Uses its OWN WebSocket connection: the shared WebSocketEventSource only
 * forwards adapted protocol events and drops raw frames, and the daemon
 * happily serves multiple clients. All transcript lines (including the
 * user's own) come from WS frames — one source of truth, and the daemon's
 * per-session backlog repopulates the chat after a page reload.
 *
 * Honest boundary (also in the footer tooltip): this chat CANNOT approve
 * permission prompts — waiting_permission alerts are handled in the app
 * that owns the session.
 */

import { wireVoice } from "./voice";
import { wsBase } from "../events/WebSocketEventSource";

interface ChatMeta {
  role: "user" | "assistant" | "system";
  text: string;
  targetSessionId: string | null;
  done: boolean;
  error?: boolean;
}

interface ChatFrame {
  v?: number;
  id?: string;
  type?: string;
  sessionId?: string;
  repo?: string;
  meta?: ChatMeta | null;
}

export interface ChatBoxHooks {
  /** Reply arrived from a (new) PM session id — pin the character in that repo's office. */
  onPmSession?: (repo: string, sessionId: string, isDefaultRepo: boolean) => void;
  /** Streaming assistant text, for the speech bubble over the PM character. */
  onAssistantText?: (sessionId: string, text: string) => void;
  /** TTS started/stopped reading that PM's reply aloud — keep its bubble lit. */
  onPmSpeaking?: (sessionId: string, speaking: boolean) => void;
}

export interface ChatBoxHandle {
  /** Active office tab changed; null = tab "All" → the daemon's default repo. */
  setRepo(repo: string | null): void;
  /** Pre-fill the input with a draft (e.g. "Giao cho PM" from a kanban idea) and
   *  focus it — does NOT send; the user reviews then hits Enter/Gửi. */
  prefill(text: string): void;
}

const HTTP_BASE = "";
const WS_URL = wsBase();

const STYLE = `
#chat-box {
  position: fixed; left: 50%; bottom: 44px; transform: translateX(-50%);
  width: min(520px, calc(100vw - 24px)); z-index: 30;
  font: 12px/1.45 ui-monospace, "SF Mono", Menlo, monospace;
  color: #cbd5e1; background: rgba(15, 18, 28, 0.92);
  border: 1px solid #2b3245; border-radius: 10px; padding: 8px;
}
#chat-box .chat-log {
  max-height: 160px; overflow-y: auto; display: flex; flex-direction: column;
  gap: 4px; margin-bottom: 6px; scrollbar-width: thin;
}
#chat-box .chat-log:empty, #chat-box .chat-log[hidden] { display: none; }
#chat-box .chat-line { white-space: pre-wrap; word-break: break-word; }
#chat-box .chat-line.user { color: #93c5fd; }
#chat-box .chat-line.user::before { content: t("chat.youPrefix"); color: #475569; }
#chat-box .chat-line.assistant::before { content: "PM › "; color: #f59e0b; }
#chat-box .chat-line.system { color: #f87171; font-style: italic; }
#chat-box .chat-line.info { color: #94a3b8; font-style: italic; }
#chat-box .chat-typing {
  color: #64748b; font-style: italic; margin-bottom: 6px;
  display: flex; align-items: center; gap: 8px;
}
#chat-box .chat-typing[hidden] { display: none; }
#chat-box button.stop {
  background: #7f1d1d; color: #fecaca; border: 1px solid #ef4444;
  font-weight: 400; padding: 1px 8px; font-size: 11px;
}
#chat-box .chat-row { display: flex; gap: 6px; }
#chat-box input {
  flex: 1; background: #10131c; color: #e2e8f0; border: 1px solid #2b3245;
  border-radius: 6px; padding: 6px 8px; font: inherit; outline: none;
}
#chat-box input:focus { border-color: #f59e0b; }
#chat-box button {
  background: #f59e0b; color: #10131c; border: 0; border-radius: 6px;
  padding: 6px 12px; font: inherit; font-weight: 700; cursor: pointer;
}
#chat-box button:disabled { opacity: 0.4; cursor: default; }
#chat-box button.mic, #chat-box button.tts, #chat-box button.handover {
  background: #1c2130; color: #cbd5e1; border: 1px solid #2b3245;
  font-weight: 400; padding: 6px 8px;
}
#chat-box button.mic.listening {
  background: #7f1d1d; border-color: #ef4444; animation: chat-mic-pulse 1s infinite;
}
#chat-box button.mic.pending { background: #78350f; border-color: #f59e0b; }
#chat-box button.tts.on { background: #14532d; border-color: #22c55e; color: #dcfce7; }
@keyframes chat-mic-pulse { 50% { opacity: 0.5; } }
#chat-box .chat-note { margin-top: 5px; color: #475569; font-size: 10px; cursor: help; }
/* collapse (R10-b): tiny toggle at the top-right corner. Collapsed hides every
   child except this button — the box shrinks to a thin bar you can pop open. */
#chat-box .chat-collapse {
  position: absolute; top: 2px; right: 4px;
  width: 22px; height: 18px; padding: 0;
  background: #1c2130; color: #cbd5e1; border: 1px solid #2b3245;
  border-radius: 6px; font-size: 11px; line-height: 1; cursor: pointer;
}
#chat-box.collapsed { padding: 4px; }
#chat-box.collapsed .chat-logs,
#chat-box.collapsed .chat-typing,
#chat-box.collapsed .chat-row,
#chat-box.collapsed .chat-note { display: none; }
`;

export function mountChatBox(hooks: ChatBoxHooks = {}): ChatBoxHandle {
  const style = document.createElement("style");
  style.textContent = STYLE;
  document.head.appendChild(style);

  const root = document.createElement("div");
  root.id = "chat-box";
  root.innerHTML = `
    <button type="button" class="chat-collapse" title="${t("chat.toggleTitle")}">▾</button>
    <div class="chat-logs"></div>
    <div class="chat-typing" hidden><span>${t("chat.typing")}</span><button type="button" class="stop" title="${t("chat.stopTitle")}">${t("chat.stop")}</button></div>
    <div class="chat-row">
      <input type="text" placeholder="${t("chat.placeholder")}" />
      <button type="button" class="mic">🎤</button>
      <button type="button" class="tts" title="${t("chat.ttsTitle")}">🗣️</button>
      <button type="button" class="handover" title="${t("chat.resumeTitle")}">🔗</button>
      <button type="button" class="send">${t("chat.send")}</button>
    </div>
    <div class="chat-note" title="${t("chat.hint")}">${t("chat.note")}</div>
  `;
  document.body.appendChild(root);

  const logsRoot = root.querySelector<HTMLElement>(".chat-logs")!;
  const typing = root.querySelector<HTMLElement>(".chat-typing")!;
  const input = root.querySelector<HTMLInputElement>("input")!;
  const button = root.querySelector<HTMLButtonElement>("button.send")!;

  // collapse (R10-b): ▾ hides the logs/row, 💬 pops them back. Persists in
  // localStorage so a reload keeps the dock tucked away.
  const COLLAPSE_KEY = "ao-chat-collapsed";
  const collapseBtn = root.querySelector<HTMLButtonElement>(".chat-collapse")!;
  const paintCollapse = (collapsed: boolean): void => {
    root.classList.toggle("collapsed", collapsed);
    collapseBtn.textContent = collapsed ? "💬" : "▾";
  };
  paintCollapse(localStorage.getItem(COLLAPSE_KEY) === "1");
  collapseBtn.addEventListener("click", () => {
    const collapsed = !root.classList.contains("collapsed");
    paintCollapse(collapsed);
    localStorage.setItem(COLLAPSE_KEY, collapsed ? "1" : "0");
    collapseBtn.blur();
  });

  const seenFrameIds = new Set<string>();
  // Daemon phát lại TOÀN BỘ lịch sử chat cho mỗi client vừa nối, mà seenFrameIds
  // trống sau mỗi lần nạp trang → không chặn thì mỗi lần F5 là đọc to lại mọi
  // reply cũ (đo được 5 câu; nhân số tab đang mở = một tràng giọng chồng nhau).
  // Backlog về ngay trong vài ms sau khi nối, nên chờ nó chảy hết rồi mới đọc.
  // Dùng độ trễ thay vì so frame.ts: qua tunnel thì đồng hồ hai bên lệch nhau.
  let speakLive = false;
  setTimeout(() => {
    speakLive = true;
  }, 1500);
  /** one transcript per repo, kept alive across tab switches */
  const logs = new Map<string, HTMLElement>();
  /** repo -> last seen PM session id (each -p --resume turn forks a new one) */
  const lastPmSessionIds = new Map<string, string>();
  let activeRepo: string | null = null; // null = tab "All"
  let defaultRepo: string | null = null;

  const activeKey = () => activeRepo ?? defaultRepo ?? "";

  const logFor = (key: string): HTMLElement => {
    let log = logs.get(key);
    if (!log) {
      log = document.createElement("div");
      log.className = "chat-log";
      log.hidden = key !== activeKey();
      logsRoot.appendChild(log);
      logs.set(key, log);
    }
    return log;
  };

  const syncUi = () => {
    const key = activeKey();
    for (const [k, log] of logs) log.hidden = k !== key;
    const label = activeRepo ?? defaultRepo;
    input.placeholder = label ? t("chat.placeholderRepo", { repo: label }) : t("chat.placeholder");
    const log = logs.get(key);
    if (log) log.scrollTop = log.scrollHeight;
  };

  const ensureDefaultRepo = async (): Promise<void> => {
    if (defaultRepo) return;
    try {
      const res = await fetch(`${HTTP_BASE}/chat`);
      if (res.ok) {
        const body = await res.json();
        if (typeof body?.defaultRepo === "string" && body.defaultRepo) {
          defaultRepo = body.defaultRepo;
          syncUi();
        }
      }
    } catch {
      // daemon not up (or pre-Round-5 daemon without GET /chat) — labels
      // degrade to plain "PM", sending still works
    }
  };
  void ensureDefaultRepo();

  const appendLine = (key: string, role: string, text: string) => {
    if (!text) return;
    const log = logFor(key);
    const line = document.createElement("div");
    line.className = `chat-line ${role}`;
    line.textContent = text;
    log.appendChild(line);
    // keep each transcript short — it's a chat dock, not a history viewer
    while (log.childElementCount > 60) log.firstElementChild!.remove();
    log.scrollTop = log.scrollHeight;
  };

  const setWaiting = (waiting: boolean) => {
    typing.hidden = !waiting;
    button.disabled = waiting;
  };

  const send = async () => {
    const text = input.value.trim();
    if (!text || button.disabled) return;
    voice.cancelSpeech(); // new turn — stop reading the previous reply
    input.value = "";
    setWaiting(true);
    await ensureDefaultRepo();
    try {
      const res = await fetch(`${HTTP_BASE}/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, ...(activeRepo ? { repo: activeRepo } : {}) }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        appendLine(activeKey(), "system", body?.error ?? t("chat.sendFailed", { status: res.status }));
        setWaiting(false);
      }
      // on 202 the user line + reply arrive as WS frames
    } catch {
      appendLine(activeKey(), "system", t("chat.noDaemon", { url: location.host }));
      setWaiting(false);
    }
  };

  button.addEventListener("click", send);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") send();
  });

  // ⏹ (wi-pm-ux): stop the in-flight PM turn. Only THIS chat's turn — the
  // daemon SIGTERMs its own `claude -p` child; other Claude sessions are the
  // origin app's business. The daemon's final "(đã dừng…)" frame clears the
  // typing state, so no local state change here.
  const stopBtn = root.querySelector<HTMLButtonElement>("button.stop")!;
  stopBtn.addEventListener("click", async () => {
    stopBtn.disabled = true;
    try {
      await fetch(`${HTTP_BASE}/chat/stop`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(activeRepo ? { repo: activeRepo } : {}),
      });
    } catch {
      appendLine(activeKey(), "system", t("chat.stopFailed"));
    }
    stopBtn.disabled = false;
  });

  // 🔗 (wi-pm-ux): hand the PM session over to a real Claude Code terminal —
  // copy `cd <repo> && claude --resume <pmSessionId>` (fetched fresh: every
  // turn forks a new session id). Copy-to-clipboard only, no terminal launch.
  const handoverBtn = root.querySelector<HTMLButtonElement>("button.handover")!;
  handoverBtn.addEventListener("click", async () => {
    await ensureDefaultRepo();
    const key = activeKey();
    try {
      const res = await fetch(`${HTTP_BASE}/chat`);
      const body = await res.json();
      const entry = body?.repos?.[key] as { sessionId?: string; cwd?: string } | undefined;
      if (!entry?.sessionId || !entry.cwd) {
        appendLine(key, "system", t("chat.noSession"));
        return;
      }
      const cmd = `cd "${entry.cwd}" && claude --resume ${entry.sessionId}`;
      try {
        await navigator.clipboard.writeText(cmd);
        appendLine(key, "info", `${t("panel.copied")} 🔗 ${cmd}`);
      } catch {
        appendLine(key, "info", t("chat.copyManually", { cmd }));
      }
    } catch {
      appendLine(key, "system", t("chat.daemonUnreachable", { url: location.host }));
    }
    handoverBtn.blur();
  });

  // voice (R6): 🎤 push-to-talk into the input, 🔊 reads PM replies aloud
  let spokenSessionId: string | null = null; // PM session the TTS is reading for
  const voice = wireVoice({
    input,
    micBtn: root.querySelector<HTMLButtonElement>("button.mic")!,
    speakerBtn: root.querySelector<HTMLButtonElement>("button.tts")!,
    send: () => void send(),
    appendSystemLine: (text) => appendLine(activeKey(), "system", text),
    onSpeaking: (speaking) => {
      if (spokenSessionId) hooks.onPmSpeaking?.(spokenSessionId, speaking);
    },
    ttsUrl: `${HTTP_BASE}/tts`,
  });

  const onFrame = (frame: ChatFrame) => {
    if (frame.type !== "chat_message" || !frame.meta) return;
    if (frame.id) {
      if (seenFrameIds.has(frame.id)) return; // WS backlog replay dedup
      seenFrameIds.add(frame.id);
    }
    const { role, text, done, error } = frame.meta;
    const repoKey = frame.repo ?? defaultRepo ?? "";

    if (role === "assistant") {
      appendLine(repoKey, "assistant", text);
      const sessionId = frame.sessionId ?? null;
      if (sessionId && sessionId !== "pm-pending") {
        // -p --resume forks a new session id per turn → re-pin every change
        if (lastPmSessionIds.get(repoKey) !== sessionId) {
          lastPmSessionIds.set(repoKey, sessionId);
          hooks.onPmSession?.(repoKey, sessionId, repoKey === defaultRepo);
        }
        if (text) {
          hooks.onAssistantText?.(sessionId, text);
          spokenSessionId = sessionId;
          if (speakLive) voice.speak(text); // no-op unless the 🔊 toggle is on
        }
      }
      if (done) {
        setWaiting(false);
        voice.speakerResetTurn(); // B4: reply xong — reply kế route theo ngôn ngữ riêng
      }
    } else if (role === "user") {
      appendLine(repoKey, "user", text);
    } else {
      appendLine(repoKey, "system", text);
      if (done || error) setWaiting(false);
    }
  };

  // ponytail: bare reconnect-on-close loop; the daemon is local and either
  // there or not — no backoff ceremony needed.
  const connect = () => {
    const ws = new WebSocket(WS_URL);
    ws.onmessage = (msg) => {
      try {
        onFrame(JSON.parse(String(msg.data)) as ChatFrame);
      } catch {
        // non-JSON frame — not ours to worry about
      }
    };
    ws.onclose = () => {
      setTimeout(connect, 2000);
    };
  };
  connect();

  return {
    setRepo(repo: string | null) {
      activeRepo = repo;
      syncUi();
    },
    prefill(text: string) {
      input.value = text;
      input.focus();
    },
  };
}
