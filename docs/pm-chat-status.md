# PM Chat — status (wi-pm-chat)

Chatbox nói chuyện trực tiếp với nhân vật PM trong Agent Office. Mỗi chatbox ↔ đúng 1 conversation Claude Code (PM session), mỗi tin nhắn = **1 turn Claude thật (tốn tiền thật)**.

## Đã làm

### Daemon (`packages/daemon`)
- **`src/chat-session.js`** (mới): `ChatSessionManager` + HTTP handler cho `POST /chat` (`{text, targetSessionId?}`).
  - Spawn `claude -p "<text>" --output-format stream-json --verbose` (flag verify bằng `claude --help` thật; `--verbose` là bắt buộc với stream-json ở print mode).
  - Mặc định target = PM. Lần đầu: spawn mới + `--append-system-prompt` kích hoạt hành vi company-pm (đọc `docs/company-protocol.md` + registry trước khi trả lời). Các lần sau: `--resume <id>` từ `.claude/memory/pm-session.json`.
  - **Gotcha đã xử lý**: `-p --resume` fork ra session id MỚI mỗi turn → manager luôn ghi lại id mới nhất từ `init`/`result` vào `pm-session.json`; conversation liền mạch, id thì không.
  - Reply stream về mọi WS client qua event **additive v1 `chat_message`** (`meta: {role, text, targetSessionId, done, error}`); schema cũ không đổi.
  - Timeout (mặc định 5 phút, `CHAT_TIMEOUT_MS` để đổi) → kill child + event lỗi thân thiện; child crash/exit lỗi cũng vậy — daemon không bao giờ crash theo.
  - 1 turn in-flight tại 1 thời điểm → gửi chồng bị 429 "PM đang trả lời".
  - `CHAT_CLAUDE_BIN` (dev/test): trỏ sang binary giả lập.
- Điểm đăng ký: `ws-server.js` thêm option `extraHttp` (hook route phụ, additive); `index.js` khởi tạo manager + handler. Vẫn chỉ bind `127.0.0.1`.

### Renderer (`packages/renderer`)
- **`src/ui/chatBox.ts`** (mới): dock chat dưới giữa màn hình — input + nút Gửi (Enter), transcript cuộn được (cap 60 dòng), "PM đang gõ…" khi chờ, dòng lỗi thân thiện khi daemon tắt/bận. Dùng WS connection riêng để nhận raw `chat_message` frames (source chính chỉ forward protocol events). Backlog của daemon tự phục hồi transcript sau khi reload trang.
- `main.ts` (điểm đăng ký, chỉ live mode `?ws=1`): mount chatbox; pin nhân vật PM về **bàn CEO ở góc văn phòng** (grid 1.5, 1.5 — art round 2 vẽ bàn thật); text reply đang stream được bơm vào reducer dạng `agent_message` → speech bubble hiện đoạn đầu câu trả lời.
- `AgentLayer.ts`: thêm `pinAgent(agentId, pos)` (additive, ngoài vùng khai báo — đã nêu trong PR). PM đổi session id mỗi turn nên mỗi id mới đều được pin lại về cùng bàn.

## Ranh giới trung thực
- **Chatbox KHÔNG duyệt được permission của bất kỳ session nào** — alert `waiting_permission` vẫn phải xử lý ở app Claude Code gốc. Ghi ngay trong tooltip footer của chatbox + system prompt của PM (PM sẽ tự nói điều này nếu được nhờ).
- Mỗi tin nhắn = 1 turn Claude thật → có chi phí; cũng ghi trong tooltip.
- Session PM cũ (turn trước) despawn theo inactivity timeout — có thể thấy 2 nhân vật ở bàn CEO trong ~5 phút sau 2 turn liên tiếp. Cosmetic.

## Kiến trúc mở (v2/v3, chưa làm)
- `targetSessionId` đã nhận từ API → v2 click nhân vật bất kỳ để chat thẳng chỉ cần UI truyền id (daemon xong rồi).
- Voice = STT trước input / TTS sau `chat_message` — bọc ngoài 2 đầu, không cần đổi schema.

## Verify
- Unit: `packages/daemon` **30/30 pass** (6 test mới cho chat manager: tạo mới vs resume vs explicit target, persist fork id, timeout kill, busy reject, exit lỗi). Renderer: `tsc --noEmit` sạch, vitest **49/49 pass**.
- E2E child-process thật (daemon thật port test + binary stream-json): round 1 spawn mới + lưu session id; round 2 `--resume` đúng id cũ + re-persist id fork; backlog replay sau reconnect chạy đúng.
- UI verify trong browser: gửi → transcript user/PM, typing indicator, nhân vật PM spawn + đứng đúng bàn CEO (screenshot trong PR), speech bubble có nội dung reply; error path hiện dòng system thân thiện.
- **Chưa verify được 1 vòng hỏi-đáp với PM THẬT trên máy này**: `claude -p` từ shell headless bị 401 kể cả với env sạch (credential nằm trong app desktop). Cần user chạy thử 1 lần từ terminal thường (nơi `claude` login sẵn): `npm --prefix packages/daemon start` → mở renderer `?ws=1` → hỏi "trạng thái các work item?". Pipeline còn lại đã chứng minh bằng binary giả lập stream-json 1:1 format thật.
