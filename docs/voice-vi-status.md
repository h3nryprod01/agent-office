# wi-voice-vieneu — Voice tiếng Việt hết "đánh vần": VieNeu qua daemon /tts

_Trạng thái: DONE · branch `fix/voice-vi` · 2026-07-08 · voice-engineer_

## Bug (user báo lần 2)

TTS đọc tiếng Anh OK nhưng tiếng Việt vẫn như đánh vần — dù PR #27 đã detect
ngôn ngữ và chọn voice vi-VN.

## Chuỗi bằng chứng (đo thật trên máy này, 2026-07-08)

1. `say -v '?'` → macOS **có** giọng `Linh vi_VN` (đã cài sẵn).
2. Chrome thật (`speechSynthesis.getVoices()` qua extension): 199 voices,
   trong đó đúng 1 giọng Việt — `Linh [vi-VN] local:true`. Default = Samantha (en-US).
3. Chạy y hệt logic `.find()` của PR #27 trong Chrome → chọn **đúng Linh**.
   → Giả thuyết "máy thiếu giọng vi / code match sai" **loại**. Thứ user nghe LÀ Linh.
4. **Root cause: Linh là compact voice chất lượng quá thấp** — đọc tiếng Việt
   rời rạc từng âm tiết, cảm nhận "như đánh vần". Đường "cài thêm giọng xịn"
   không tồn tại: tiếng Việt trên macOS chỉ có Linh (compact) + giọng Siri
   (Apple không expose Siri voice ra API cho app/web).
5. VieNeu TTS (hạ tầng demo-app có sẵn, giọng Đoan) đo thật: model load 5.4s
   (1 lần), infer ~0.6× realtime (câu 33-46 ký tự: 1.5-2.2s; câu 95 ký tự: 3.7s).

Nghe so sánh (cùng nội dung): [voice-vi-vieneu-doan.m4a](media/voice-vi-vieneu-doan.m4a)
vs [voice-vi-linh-macos.m4a](media/voice-vi-linh-macos.m4a).

## Bảng so sánh A vs B

| Tiêu chí | A — giọng vi hệ thống (Linh) | B — VieNeu qua daemon /tts |
|---|---|---|
| Chất lượng nghe | Compact, robotic, "như đánh vần" — **user đã bác 2 lần**; không có bản Enhanced để cài | Neural giọng Đoan, tự nhiên (đã duyệt qua hàng chục video demo-app) |
| Độ trễ | ~0s | Câu đầu ~2s (warm), cold start 8s lần đầu sau idle; các câu sau phát nối tiếp không hở nhờ prefetch |
| Phụ thuộc | Không | venv demo-app local (`VIENEU_PYTHON` override được); daemon bản mới |
| Offline | ✅ | ✅ (model local) |

**Chọn B**, giữ A nguyên vẹn làm fallback tự động (daemon tắt/503/venv thiếu →
speechSynthesis + Linh như trước, kèm 1 dòng hint trong chatbox — không bao giờ
mất tiếng hoàn toàn). EN giữ nguyên speechSynthesis (Samantha tốt sẵn).

## Đã làm

### Daemon — `POST /tts {text}` → `audio/wav`

- `tts.js`: `VieNeuTts` quản lý worker Python giữ ấm (`tts_worker.py` chạy bằng
  python venv demo-app — mặc định hardcode path máy này, override `VIENEU_PYTHON`).
  Spawn lười ở request đầu; line-delimited JSON qua stdin/stdout (bỏ qua dòng
  log không phải JSON của thư viện); timeout 30s/câu → kill + respawn sạch;
  idle 30 phút → tự tắt trả RAM; per-request error không giết worker.
- `createTtsHttpHandler`: 200 `audio/wav` · 400 thiếu text · 503 khi VieNeu
  không sẵn sàng (renderer hiểu 503 = "fallback đi") · OPTIONS 204 (CORS).
- Wire vào `index.js` (extraHttp chain) + log endpoint lúc boot + dispose lúc shutdown.

### Renderer — router theo ngôn ngữ trong `voice.ts`

- `speak()`: `detectLang` → **vi-VN** đi VieNeu (nếu có `fetchTtsUrl` dep),
  **en-US** đi speechSynthesis như cũ.
- Đường VieNeu: `splitSentences()` cắt reply theo câu (câu >180 ký tự cắt thêm
  ở dấu phẩy) → POST /tts từng câu, **prefetch câu kế trong lúc câu hiện tại
  đang phát** → TTFB ~2s warm thay vì chờ render cả reply → phát nối tiếp qua
  `<audio>` (objectURL, revoke sau khi phát).
- Fallback 3 tầng, không nuốt reply: fetch fail/503 → phần còn lại đọc bằng
  speechSynthesis (Linh) + hint 1 lần; clip phát lỗi (decode/autoplay) → phần
  còn lại cũng về speechSynthesis; không có dep (test/embed cũ) → nguyên đường cũ.
- `cancel()` (user gửi tin mới / tắt 🔊): bump generation + pause audio + xả
  queue — vòng pump cũ tự thoát, không kẹt (có test).
- `chatbox.ts`: truyền `ttsUrl: ${HTTP_BASE}/tts` (1 dòng).

## Số liệu E2E (daemon worktree, `DAEMON_WS_PORT=8788`)

| Request | Thời gian | Kết quả |
|---|---|---|
| POST /tts câu 46 ký tự (cold: spawn+load+infer) | 8.0s | 200, WAV 330KB (3.4s audio) |
| POST /tts câu 33 ký tự (warm) | **1.09s** | 200, WAV 253KB |
| fetch từ origin renderer thật (localhost:5199) | 1.9s | 200, CORS + PNA OK, blob audio/wav |
| POST thiếu text / OPTIONS | — | 400 / 204 |

## Test

- Daemon: **96/96** pass (11 mới: worker lifecycle spawn-lười/ready/log-noise/
  error-per-request/chết-respawn/timeout-kill/idle-kill + handler 200/400/503/
  OPTIONS/405/fall-through).
- Renderer: **144/144** pass (9 mới: splitSentences ×3; router vi→VieNeu đúng
  thứ tự câu + không đụng speechSynthesis; en→system không gọi VieNeu; 503→
  fallback Linh + hint đúng 1 lần; thiếu dep→đường cũ; cancel giữa chừng không
  kẹt pump; clip lỗi→phần còn lại vẫn được đọc). `tsc --noEmit` sạch.

## Ghi chú vận hành

- **Coordinator kickstart `com.agentoffice.daemon` sau merge** — /tts chỉ có ở
  bản daemon mới. Trước đó renderer tự fallback Linh + hiện hint (không hỏng gì).
- Verify tai thật cuối: sau kickstart, bật 🔊 trong chatbox, hỏi PM 1 câu tiếng
  Việt → nghe giọng Đoan. (Session này đã phát thật giọng Đoan + Linh qua loa
  bằng `afplay` để so sánh, và đã lưu 2 file mẫu ở docs/media/.)
- Autoplay: Chrome yêu cầu user activation — luôn có vì user phải bấm 🔊 mới
  bật TTS. Trong môi trường test CDP (eval không có activation thật) play() bị
  chặn → code coi như clip hỏng và fallback speechSynthesis, không im lặng.
- Cold start 8s cho câu đầu sau >30 phút im lặng (model load lại). Upgrade path
  nếu khó chịu: prewarm worker lúc daemon boot hoặc khi user bật 🔊 (thêm
  `GET /tts/warm`), hoặc tăng `idleMs`. Chưa làm — chờ cảm nhận thực tế.
- Path venv demo-app nằm 1 chỗ trong `tts.js` (`DEFAULT_PYTHON`) — máy khác đặt
  `VIENEU_PYTHON`. venv thiếu → available()=false → 503 → fallback, không crash.
