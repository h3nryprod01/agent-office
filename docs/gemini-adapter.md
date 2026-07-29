# Gemini Adapter — Gemini CLI chat session → event schema v1

_Nguồn dữ liệu: file chat session THẬT dưới `~/.gemini/tmp/<slug>/chats/session-<iso-ts>-<short-id>.json` — đọc trực tiếp 4 file thật trên máy này, trong đó 3 file do chính `gemini-cli 0.29.5` sinh ra trong lúc làm việc này (chạy `gemini -p` để đối chiếu format hiện hành, vì 1 file cũ có từ 2026-02). Format 2026-02 và 0.29.5 GIỐNG NHAU. Các điểm không quan sát được trực tiếp thì đọc thẳng source `@google/gemini-cli-core/dist/src/services/chatRecordingService.js` và ghi rõ ở dưới. Không đoán format._

## 0. Vì sao chọn Gemini CLI làm nguồn thứ 3

Khảo sát harness ĐÃ CÀI + CÓ LOG THẬT trên máy:

| Harness | Có log session thật? | Kết luận |
|---|---|---|
| **Gemini CLI** (`~/.gemini/tmp/*/chats/*.json`) | ✅ 4 session, có `toolCalls`, `thoughts`, `tokens`, `model` | **ĐÃ CHỌN** — binary `gemini 0.29.5` còn cài, sinh log mới được |
| Qwen Code (`~/.qwen/projects/*/chats/*.jsonl`) | ⚠️ 1 session / 2 dòng, dòng assistant duy nhất là lỗi 401 | Loại: không có assistant text lẫn tool call để verify; binary `qwen` cũng không còn trên PATH |
| Cursor (`~/.cursor/`) | ❌ chỉ config MCP + `ai-tracking/*.db` (SQLite), không có transcript | Loại |
| Cline (`~/Documents/Cline/`) | ❌ chỉ Rules/Workflows | Loại |
| Copilot CLI (`~/.copilot/`) | ❌ chỉ `ide/`, `skills/` | Loại |
| Aider / OpenCode / Windsurf / Continue | ❌ không cài | Loại |

## 1. Shape dữ liệu thật đã xác nhận

- Layout: `~/.gemini/tmp/<slug>/chats/session-<iso-ts>-<8-hex>.json`, kèm `~/.gemini/tmp/<slug>/.project_root` chứa **đường dẫn tuyệt đối của project** → đây là nguồn `cwd` (bản thân file chat KHÔNG chứa cwd; nó chỉ có `projectHash` = sha256 của path).
- **KHÁC CƠ BẢN với Claude Code + Codex: file KHÔNG phải JSONL append-only.** Nó là MỘT document JSON `{sessionId, projectHash, startTime, lastUpdated, messages: [...]}` bị **ghi đè toàn bộ** sau mỗi message. Byte offset vô nghĩa → phải re-parse cả file khi `mtime` đổi.
- **Ghi tăng dần trong lúc session còn sống** (đo thật: file xuất hiện với 1 message, lớn dần lên 3 message trong lúc turn đang chạy) → tail real-time được, không phải đợi session kết thúc.
- `messages[]` phần tử: `{id: uuid, timestamp: iso, type, content}` với `type` ∈ `user` | `gemini` | `info` | `error`.
  - `user.content` = mảng `[{text}]`.
  - `gemini.content` = **string** (rỗng `""` khi turn đó chỉ gọi tool), thêm `model`, `tokens {input,output,cached,thoughts,tool,total}`, `thoughts[]`, `toolCalls[]`.
  - `info`/`error`.content = string — đây là log CLI (usage của slash-command, kết quả scan skill), KHÔNG phải hoạt động của agent.
- **`thoughts[]` đọc được** (khác Codex — `reasoning` của Codex bị mã hoá): `[{subject, description, timestamp}]`, thực tế 1–2 thought/message.
- **`toolCalls[]`**: `{id, name, args, result, status, timestamp, resultDisplay, displayName, description, renderOutputAsMarkdown}`. `args` là **object thật** (Codex JSON-encode thành string). Tool names thật: `list_directory` (`dir_path`), `read_file` (`file_path`), `glob` (`pattern`), `run_shell_command` (`command`).
- **Tool call mang CẢ request lẫn result trong một record.** Đọc source: `geminiChat.recordCompletedToolCalls()` là đường ghi duy nhất → `status` LUÔN là trạng thái cuối: `success` | `error` | `cancelled`. Không quan sát được `pending`/`executing`/`awaiting_approval` trong file (dù enum có), nên **không có tín hiệu "chờ phê duyệt"** cho Mission Control — giống Codex.
- **`resultDisplay` có thể là chuỗi RỖNG khi thành công** (`read_file` làm vậy) và source khai báo kiểu `string | object` (FileDiff / error display) → phải có fallback.
- **Hai kiểu mutation** (đọc source `chatRecordingService.js`, quyết định thiết kế tailer):
  1. `recordMessage()` luôn **push** message đã hoàn chỉnh → **text không stream vào dần**, message là final ngay lần ghi đầu.
  2. `recordToolCalls()` **append vào `toolCalls[]` của message `gemini` cuối cùng** thay vì tạo message mới → **message cuối có thể phình ra sau khi ta đã forward nó.**
  3. `rewindTo()` / `deleteSession()` có thể **cắt ngắn** `messages[]`.
- **Không có sub-agent**: 0.29.5 không ghi bất kỳ liên kết cha–con nào vào file chat → `parentId` luôn `null`.

## 2. Bảng ánh xạ → event schema v1

Tái dùng đúng `EventType` hiện có (`session_start`/`session_end`/`speak`/`tool_call`), không thêm type mới. Mọi event từ nguồn này có `harness: "gemini"` (additive; `"claude-code"` vẫn là mặc định) — renderer đã đổi skin theo `harness`.

| Gemini record (field thật) | Event v1 | Ghi chú |
|---|---|---|
| message `user` hoặc `gemini` đầu tiên | `session_start`, status `start` | `sessionId`/`agentId` = `doc.sessionId`; `cwd` từ `.project_root`; `meta.model`. Giống `normalize.js` (mở nhân vật ở lượt thật đầu tiên, bất kể ai nói) |
| message `user` | (không emit gì thêm) | Prompt của người không phải hoạt động nhân vật — đúng chính sách `normalize.js` (chỉ đọc `tool_result` từ dòng user) |
| message `info` / `error` | (không emit) | Bookkeeping CLI. Session chỉ có `info` → **không sinh nhân vật nào** |
| `gemini.thoughts[]` (thought cuối) | `speak`, `meta.kind: "thinking"` | `detail` = `subject`. 1–2 thought/message → chỉ lấy cái mới nhất, tránh spam bong bóng. Đây là thứ Codex KHÔNG có |
| `gemini.content` (khác rỗng) | `speak`, `meta.kind: "text"` | `detail` truncate 140; id = `<message.id>:speak` |
| `gemini.toolCalls[i]` | **cặp** `tool_call` `start` + `end` | id = `<toolCall.id>:start` / `:end`. `start.ts` = timestamp của message, `end.ts` = `toolCall.timestamp` — **cả hai đều là field thật**. Cặp start/end là để renderer có animation working→idle, dù record đã completed sẵn |
| `toolCall.status` | `ok` khi `success`, ngược lại `error` | `cancelled` và `error` đều = không có kết quả. Giữ nguyên giá trị gốc ở `meta.geminiStatus` |
| `toolCall.resultDisplay` | `detail` của event `end` | Rỗng → fallback về mô tả lời gọi (`read_file: a.txt`) thay vì trơ tên tool |
| (không có dòng "session closed") | `session_end` | Tái dùng `SessionEndMonitor` inactivity timeout chung, y như 2 nguồn kia |

## 3. Khác biệt với 2 nguồn cũ (điều renderer/daemon nên biết)

1. **Không phải JSONL.** `GeminiTailer` giữ per-file `{mtimeMs, messages, lastToolCalls}` — bản O(1) tương đương byte-offset của `CodexTailer`:
   - message mới → emit với `toolCallOffset: 0`;
   - message cuối phình thêm `toolCalls` → **emit lại message đó với `toolCallOffset` = số tool call đã gửi**, nên `speak`/`thinking` không lặp và tool call cũ không replay;
   - `messages[]` ngắn đi (rewind) → reset, replay từ đầu; event id ổn định theo nội dung nên renderer dedup được.
2. **Đọc rách file (torn read).** File bị ghi đè giữa chừng → `JSON.parse` fail → **bỏ qua im lặng và KHÔNG cập nhật `mtimeMs`**, tick sau đọc lại. Không emit `error` (sẽ spam).
3. **Bookkeeping "đã emit" nằm ở tailer, không ở normalizer.** Nhờ vậy `index.js` vẫn được phép evict `geminiNormalizers` lúc `session_end` (theo lối wi-daemon-leak) mà không bao giờ replay lịch sử — session resume chỉ phát lại `session_start` (id idempotent).
4. **Không có sub-agent, không có approval prompt** → nhân vật Gemini luôn là root, chấm đỏ Mission Control chưa áp dụng được (giống Codex).
5. **Có bong bóng "thinking" thật** (Codex không có, Claude Code có) — `thoughts[].subject`.
6. **Backfill cutoff khi boot**: file idle lâu hơn `backfillMaxAgeMs` (mặc định 5 phút = session inactivity timeout) khi thấy lần đầu sẽ được "nhận" ở trạng thái hiện tại mà không emit — tránh nhân vật sinh ra rồi `session_end` ngay. Env override: `GEMINI_BACKFILL_MAX_AGE_MS`. Env đổi thư mục: `GEMINI_TMP_ROOT`.
7. **ponytail / trần đã biết**: mỗi lần `mtime` đổi là re-parse cả file JSON. Session thật trên máy này chỉ vài KB nên rẻ. Nếu về sau có file hàng chục MB → chuyển sang parse tăng dần theo `lastUpdated`. Đã ghi comment tại `gemini-tailer.js`.

## 4. Verify

- **Data thật**: replay cả **4 file session thật** trên máy qua `GeminiSessionNormalizer` → **29 events, 0 vi phạm schema, 0 id trùng, 0 event thiếu `cwd`**. Đếm: 3 `session_start` (file thứ 4 chỉ có message `info` → đúng kỳ vọng, không sinh nhân vật), 12 `speak`, 14 `tool_call` (7 cặp start/end: 6 `ok` + 1 `error`). Event `error` duy nhất là lỗi THẬT (`Path not in workspace`), không phải fixture bịa.
- **Format hiện hành**: sinh session mới bằng `gemini -p` trên `gemini-cli 0.29.5` → cùng shape với file 2026-02. Xác nhận ghi tăng dần khi session còn sống (1 → 2 → 3 message).
- **3 nguồn chạy song song**: `DAEMON_WS_PORT=8788 node src/index.js` với cả Claude Code + Codex + Gemini → daemon boot sạch, chạy `gemini -p` sinh session mới → daemon bắt được `session_start` + `glob` + `read_file` + `speak "FINISHED"` (gemini) trong 1 poll tick, song song 2.296 event claude-code và 2 event codex trên cùng WebSocket. `0` lỗi tailer. `SIGTERM` shutdown sạch.
- **Unit tests**: `packages/daemon/test/gemini-normalize.test.js` + `gemini-tailer.test.js` (16 test, gồm append tool call vào message cuối, rewind, torn read, backfill cutoff). Fixture `test/fixtures/gemini-session.json` là session THẬT (đã thay path + rút gọn payload). Toàn bộ daemon suite: **123/123 pass**.
