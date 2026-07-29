# Mission Control MVP — Status (Frontend Engineer chip)

_Cập nhật: 2026-07-07. Branch `feat/mission-control` (worktree `.claude/worktrees/mission-control`). PR đã mở, chờ PM review._

## ✅ HOOK VERIFICATION — HOOK ĐÃ FIRE THẬT

Session chip (sessionId `3c00fd13-fdd2-4691-b105-6036f57120ed`) là session đầu tiên load `.claude/settings.local.json` từ lúc start. Kết quả kiểm tra `~/.claude/agent-office-hook-events.jsonl`:

- **7+ record mới với đúng sessionId của session này** ngay sau vài tool call đầu.
- PreToolUse và PostToolUse fire **đủ cặp**, đủ field: `{v:1, hook, ts, sessionId, cwd, toolName, toolUseId}`.
- `cwd` đúng repo Acme Web, `toolName` khớp tool thật, `toolUseId` là id thật (`toolu_...`).
- Cặp pre→post cho Read cách nhau ~120ms — hook không chặn đáng kể.
- Tool call song song trong 1 message → nhiều record pre cùng ts, phân biệt được bằng `toolUseId`.

**Kết luận: hook pilot hoạt động đúng thiết kế → PM có thể cân nhắc nâng lên global (`decisions.md`).**

## ✅ Đã ship trong PR `feat/mission-control`

1. **Daemon — `hook_signal` real-time (additive v1)**: wire `hook-log-tailer` + `hook-signal-reconciler` vào `index.js`. Reconciler đổi sang **grace window 2s**: PreToolUse chỉ phát `waiting_permission` nếu sau 2s không có PostToolUse/transcript xác nhận (data thật cho thấy tool auto-allowed pre→post ~120ms-2s — emit ngay sẽ làm mọi tool call nháy đỏ, thành nhiễu). Khi call được xác nhận sau khi đã cảnh báo → phát downgrade `working`. `HookLogTailer` thêm `startAtEnd` để không replay log cũ vào backlog WS. 7 unit test (`npm test` trong packages/daemon).
2. **Renderer — Mission Control UI**:
   - Click nhân vật → **side panel**: tên/role, trạng thái + đã bao lâu, chi tiết, tool đang chạy, cwd, session/agent id, timeline ~30 hoạt động gần nhất.
   - **Hàng đợi "Cần can thiệp"**: `waiting_permission`/`error`/`blocked`, xếp theo mức khẩn rồi thời gian kẹt; click → camera pan + mở panel. ❗ đỏ nhún nhảy trên đầu nhân vật alert.
   - Adapter v1→v0 dùng `agentId`/`parentId` thật (sub-agent = nhân vật riêng) + map `hook_signal`.
   - Protocol: thêm field optional `cwd` vào `agent_spawned` (additive, đã cập nhật JSON schema).
3. **Verified end-to-end** (daemon thật + renderer `?ws=1`): bơm PreToolUse giả → queue đỏ sau ~2.5s; PostToolUse → hết đỏ sau ~0.5s. Queue cũng bắt được 2 session Acme Web THẬT đang kẹt (trong đó có PM session chờ duyệt `mcp__ccd_session_mgmt__send_message` 2m+). Perf: 35 nhân vật ~2.1ms/frame.

## ✅ Endpoint transcript — ĐÃ TÍCH HỢP (PM ship 048f951)

- Rebase `main`, wire side panel `fetch GET /transcript?sessionId=<id>&limit=20` (chỉ live mode `?ws=1`; mock giữ placeholder). Fetch 1 lần/lần chọn agent, 3 trạng thái: loading / lines / empty.
- **Thêm 1 dòng CORS vào `ws-server.js`** (`access-control-allow-origin: *`): renderer ở origin `localhost:5199` khác `127.0.0.1:8787`, thiếu header thì browser chặn đọc body (`TypeError: Failed to fetch`). localhost-only PoC nên wildcard ok. Đây là chỗ duy nhất mình động vào file PM — báo để PM nắm.
- Verified live: panel hiện timeline + transcript thật của session đang chạy; positive render path 6 dòng thật; empty-state đúng.

## ⏳ Cần PM quyết

- **Buffer chung 200-event**: xác nhận đúng như PM cảnh báo — khi 1 session ồn ào (mình gặp 1 session spam 401-error) buffer bị chiếm hết, session khác trả về rỗng. Side panel hiện "Chưa có message nào trong buffer" (đúng, không crash). **Đề nghị PM cân nhắc per-session buffer** vì đây chính là data side panel cần — nhưng để PM quyết, không chặn MVP.
- **Grace window 2s** của reconciler: chip đổi semantics so với bản nháp round trước (emit-ngay → emit-sau-2s). Lý do + test trong PR. PM ok thì giữ.
- Hook chỉ biết root `sessionId` → tool call của sub-agent hiển thị cảnh báo trên nhân vật root. Chấp nhận ở MVP.
