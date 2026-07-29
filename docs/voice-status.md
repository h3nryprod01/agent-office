# wi-voice — Nói chuyện với PM bằng giọng nói (R6)

_Cập nhật: 2026-07-08 · branch `feat/voice` · vùng file: `ui/voice.ts` (mới) + `ui/chatBox.ts` + `main.ts`. Daemon KHÔNG đụng._

## Đã làm

**Voice input — Web Speech API, zero dependency**
- Nút 🎤 cạnh ô chat (click = bật/tắt nghe) + giữ phím **Space** khi không focus ô nhập nào (push-to-talk, `preventDefault` để không cuộn trang).
- `webkitSpeechRecognition` lang `vi-VN`, `interimResults` + `continuous`: transcript hiện **live** vào ô input trong lúc nói (interim + final gộp).
- Thả ra → chờ **1.5s** rồi tự gửi. Trong 1.5s đó: gõ phím vào input = reset đếm ngược (sửa xong ngưng gõ 1.5s là gửi), **Esc** = hủy (text vẫn nằm trong input), nói tiếp (Space/🎤) = nối tiếp câu cũ.
- Browser không hỗ trợ (Safari cũ/Firefox) → nút 🎤 disabled + tooltip "thử Chrome/Edge", không crash. Mic bị chặn quyền → system line hướng dẫn, máy trạng thái tự reset.

**Voice output — speechSynthesis**
- Toggle 🔊, **mặc định TẮT**, nhớ lựa chọn ở `localStorage["agent-office.tts"]`.
- Mỗi dòng reply của PM được enqueue đọc to; chọn voice `vi-VN` nếu máy có (macOS: **Linh**), fallback voice mặc định + hint `lang=vi-VN`.
- User gửi tin mới → `speechSynthesis.cancel()` cắt ngay bài đọc cũ. Tắt toggle cũng cắt.

**Trải nghiệm trong office**
- Khi PM "đang nói" (TTS active), main.ts re-inject `agent_message` (API bubble sẵn có của AgentLayer/AgentSprite) mỗi 3s → **speech bubble của nhân vật PM sáng suốt thời gian đọc** thay vì tắt sau 4s; TTS xong thì bubble fade tự nhiên. Không thêm API render mới.

**Kiến trúc test được**: `createVoiceMachine(createRecognition, opts)` — recognition inject qua factory, state machine `idle → listening → pending(grace) → idle` thuần logic; `createSpeaker()` tách riêng; `wireVoice()` chỉ là DOM glue.

## Verified

- **Unit: 13 test mới** trong `test/voice.test.ts` (mock SpeechRecognition): start/config vi-VN, interim+final tích lũy theo `resultIndex`, stop→pending→auto-send đúng 1500ms, stop không có tiếng → idle không gửi, interim-only vẫn gửi, Esc hủy khi listening (abort + bỏ qua onend trễ) và khi pending, touch() reset grace, nói tiếp giữ finals cũ, error → onError + start lại được, transcript mới xóa cũ, factory null không crash. **Suite renderer 89/89 pass, `tsc --noEmit` sạch.**
- **Browser thật (Chromium, vite worktree + daemon live ws://127.0.0.1:8787):**
  - 🎤/🔊 render cạnh Gửi; recognition ctor có; `getVoices()` 180 voice, pick đúng **Linh|vi-VN**.
  - Toggle 🔊: class `on` + localStorage `"1"` persist; mặc định tắt xác nhận (key null lúc đầu).
  - Import module `voice.ts` thật qua vite trong page: `speak("Xin chào…")` → `onSpeaking(true)` + `speechSynthesis.speaking === true`; `cancel()` → `onSpeaking(false)` — chuỗi bubble-glow chạy đúng.
  - Click 🎤 → class `listening` (pulse đỏ); headless không có quyền mic → onerror `not-allowed` → reset về idle + system line "Mic bị chặn — cấp quyền microphone…" (error path sống, không crash).
  - Gửi tin qua UI → user frame + system frame render từ WS, typing indicator reset đúng.

## Chưa verify được trên máy này (nêu thật)

- **Độ chính xác nhận dạng tiếng Việt thực tế**: phiên chạy headless không có microphone/quyền mic nên **chưa đo được** accuracy bằng giọng nói thật. Cách đo khi user thử: mở office trong Chrome, cấp quyền mic, giữ Space nói 5–10 câu lệnh thường dùng ("trạng thái dự án", "review PR số mười lăm"…), so transcript với ý định. Web Speech API tiếng Việt của Chrome (server-side Google) thường ổn với câu ngắn rõ; danh từ riêng/tên branch sẽ sai nhiều — đó là lý do có cửa sổ 1.5s sửa tay trước khi gửi.
- **Vòng khép kín "PM trả lời → đọc to"**: daemon đang chạy trên máy không spawn được `claude` CLI (`spawn claude ENOENT` — PATH của process supervisor thiếu `~/.local/bin`; lỗi hạ tầng có sẵn, mọi repo đều dính, KHÔNG liên quan diff này — diff không đụng daemon). Chuỗi phía renderer đã verify từng khớp nối bằng module thật như trên; khi daemon được start từ shell có claude trong PATH, reply sẽ tự được đọc.

## Nâng cấp tương lai (đừng làm bây giờ)

- **VieNeu TTS server-side**: giọng Việt tự nhiên hơn hẳn voice hệ thống (Linh hơi robotic). Làm ở daemon: endpoint TTS trả audio, renderer phát `<audio>` thay `speechSynthesis`. Repo demo-app-docs đã có sẵn `vieneu_speech_service.py` tái dùng được.
- Nút "đọc lại reply cuối" nếu user hay lỡ; chưa thấy nhu cầu thật.

## Next

- Coordinator: fix cách start daemon (PATH có claude) rồi thử vòng voice khép kín bằng mic thật.
- Merge squash qua PR; xóa worktree `.claude/worktrees/voice` sau merge.
