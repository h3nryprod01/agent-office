# wi-multi-harness — Nguồn thứ 3: Gemini CLI

**Trạng thái: DONE.** Branch `feat/harness-3`. Daemon giờ tail 3 nguồn: Claude Code, Codex CLI, **Gemini CLI**.

## Khảo sát (bước quan trọng nhất — chọn theo LOG THẬT, không đoán)

Quét `~/.cursor`, `~/.aider*`, `~/.gemini`, `~/.opencode`, `~/.local/share/opencode`, Windsurf, Cline, Continue, `~/.copilot`, `~/.qwen`:

| Harness | Log session thật? | Kết luận |
|---|---|---|
| **Gemini CLI** | ✅ 4 file `~/.gemini/tmp/*/chats/session-*.json`, có `toolCalls` + `thoughts` + `tokens` + `model` | **CHỌN** — `gemini 0.29.5` còn cài, sinh log mới được để đối chiếu format hiện hành |
| Qwen Code | ⚠️ 1 session / 2 dòng, lượt assistant duy nhất là lỗi 401 | Loại — không có assistant text lẫn tool call để verify; `qwen` không còn trên PATH |
| Cursor | ❌ chỉ config MCP + `ai-tracking/*.db` | Loại |
| Cline / Copilot CLI | ❌ chỉ Rules/Workflows, `skills/` | Loại |
| Aider / OpenCode / Windsurf / Continue | ❌ không cài | Loại |

Log Gemini cũ nhất có từ 2026-02 → **đã chạy `gemini -p` thật** để xác nhận `0.29.5` vẫn ghi cùng format (giống hệt), và để có data tươi làm fixture.

## Đã làm (chỉ THÊM file, không sửa nguồn Claude/Codex)

- `packages/daemon/src/gemini-tailer.js` — poll `~/.gemini/tmp/<slug>/chats/session-*.json`, `cwd` lấy từ `<slug>/.project_root`.
- `packages/daemon/src/gemini-normalize.js` — message → event schema v1, `harness: "gemini"`.
- `packages/daemon/test/gemini-{tailer,normalize}.test.js` + `test/fixtures/gemini-session.json` (session THẬT, thay path + rút gọn payload).
- `docs/gemini-adapter.md` — spec format thật + bảng ánh xạ + verify.
- `packages/daemon/src/index.js` — chỉ thêm điểm đăng ký + `geminiTailer.stop()` trong shutdown + evict normalizer ở `session_end`.
- `packages/daemon/src/event-schema.js` — 1 dòng comment: `harness` giờ là `"claude-code" | "codex" | "gemini"`.

## Cái khó thật sự (khác hẳn 2 nguồn cũ)

Gemini **không ghi JSONL append-only**. Mỗi session là MỘT document JSON bị ghi đè toàn bộ sau mỗi message → byte offset vô nghĩa. Đọc source `chatRecordingService.js` để biết chính xác:

1. `recordMessage()` luôn push message ĐÃ hoàn chỉnh → text không stream vào dần.
2. `recordToolCalls()` **append `toolCalls` vào message `gemini` cuối cùng** → message cuối phình ra SAU KHI ta đã forward nó. Nếu chỉ đếm số message thì mất tool call.
3. `rewindTo()` / `deleteSession()` cắt ngắn `messages[]`.

Vì vậy tailer giữ per-file `{mtimeMs, messages, lastToolCalls}` (bản O(1) tương đương byte-offset của Codex) và emit lại message cuối kèm `toolCallOffset` khi nó phình. Đọc rách file giữa lúc ghi đè → bỏ qua im lặng, **không cập nhật `mtimeMs`**, tick sau đọc lại.

Bookkeeping "đã emit" nằm ở **tailer**, không ở normalizer — nên `index.js` vẫn evict `geminiNormalizers` lúc `session_end` (kỷ luật wi-daemon-leak) mà không bao giờ replay lịch sử.

## Verify (data thật, không fixture bịa)

- Replay **4 file session thật** → **29 events, 0 vi phạm schema, 0 id trùng, 0 event thiếu `cwd`**. 3 `session_start` (file thứ 4 chỉ có message `info` → đúng: không sinh nhân vật), 12 `speak`, 14 `tool_call` (7 cặp, 6 `ok` + 1 `error`). Event `error` là lỗi THẬT `Path not in workspace`.
- **3 nguồn song song**: `DAEMON_WS_PORT=8788 node src/index.js` → boot sạch, chạy `gemini -p` sinh session mới → daemon bắt `session_start` + `glob` + `read_file` + `speak "FINISHED"` trong 1 poll tick, cùng lúc 2.296 event claude-code + 2 event codex trên cùng WebSocket. 0 lỗi tailer. SIGTERM shutdown sạch.
- **Test: 123/123 pass** (`npm test` trong `packages/daemon`; 107 baseline + 16 mới). Lưu ý: worktree mới phải `npm install` trước, nếu không 4 file test import `ws` sẽ fail — không liên quan code.

## Điều renderer nên biết

- `harness: "gemini"` → skin riêng (renderer đã đổi skin theo harness).
- Gemini **có bong bóng thinking thật** (`meta.kind: "thinking"`, từ `thoughts[].subject`) — Codex không có vì `reasoning` bị mã hoá.
- **Không có sub-agent** (`parentId` luôn `null`) và **không có tín hiệu chờ phê duyệt** → chấm đỏ Mission Control chưa áp dụng cho Gemini, giống Codex.

## Sau merge

**Coordinator phải kickstart lại daemon service** để nguồn Gemini vào chạy thật:

```
launchctl kickstart -k gui/$(id -u)/com.agentoffice.daemon
```

Service đang KHÔNG chạy lúc viết doc này. Env knobs mới: `GEMINI_TMP_ROOT`, `GEMINI_BACKFILL_MAX_AGE_MS`.

## Backlog nhỏ

- Re-parse cả file JSON mỗi lần `mtime` đổi (session thật vài KB nên rẻ). Nếu gặp file hàng chục MB → parse tăng dần theo `lastUpdated`. Đã ghi `ponytail:` comment tại `gemini-tailer.js`.
- `tokens` của Gemini (`input/output/cached/total`) chưa đưa vào `/costs` — `usage-costs.js` hiện chỉ đọc transcript Claude Code. Việc riêng nếu muốn dashboard chi phí đa-harness.
