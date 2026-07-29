# wi-pm-per-repo — PM riêng cho mỗi repo, chatbox nói với PM của tab đang mở

Trạng thái: **DONE** · Branch `feat/pm-per-repo` · Chip: chat-engineer-2 · 2026-07-07

## Vấn đề

User xem tab demo-app, gõ chatbox → tin đi vào PM duy nhất của Acme Web (cwd cố định). Sai trực giác: chatbox phải nói với PM của repo đang nhìn.

## Đã làm

### Daemon (`packages/daemon`)

- `pm-session.json` đổi sang map per-repo: `{version: 2, repos: {"<repo>": {sessionId, cwd, updatedAt}}}`. Format cũ `{sessionId}` được **migrate khi đọc** (thành PM của repo mặc định) — không cần bước chuyển đổi tay, file được ghi lại dạng v2 ở lần chat kế tiếp.
- `POST /chat` nhận thêm `repo` (optional — thiếu thì là repo mặc định của daemon). PM của repo được spawn/resume với **cwd = root thật của repo đó**:
  - repo mặc định → `AGENT_OFFICE_REPO`/repo root của daemon;
  - repo khác → cwd đã persist trong map, fallback sang `getRepoRoot()` (event-schema ghi lại root như phụ phẩm của `deriveRepo()` walk — tailer đọc transcript từ byte 0 lúc boot nên map tự đầy);
  - repo daemon chưa từng thấy → **404 + lời nhắn thân thiện**, không spawn.
- PM repo khác Acme Web dùng `GENERIC_PM_SYSTEM_PROMPT` (đọc git log/status + sessions, KHÔNG ép registry/company-protocol vì repo đó không có).
- `GET /chat` → `{ok, defaultRepo}` để renderer gắn nhãn tab All.
- Event `chat_message` mang `repo` ở top-level để renderer route transcript.
- Chi phí: PM một repo **chỉ spawn khi user chat vào repo đó lần đầu** — không spawn sẵn hàng loạt. Mỗi tin = 1 turn Claude thật (`claude -p --resume`).
- Vẫn 1 turn in-flight toàn cục (`busy`) — per-repo queue để dành khi có nhu cầu thật.

### Renderer (`packages/renderer`)

- chatBox gửi kèm `repo` của tab đang active; tab **All → PM mặc định** (Acme Web), placeholder ghi rõ đang nhắn cho ai: `Nhắn cho PM · <repo>…`.
- Transcript **per-repo trong bộ nhớ trang** — đổi tab là transcript đổi theo, quay lại vẫn còn.
- PM mỗi repo pin ở bàn CEO của **office repo đó**; PM mặc định giữ luôn bàn CEO của office All.
- Degrade sạch với daemon cũ (chưa có GET /chat): label rơi về "PM", gửi vẫn chạy.
- `vite.config.ts` tôn trọng `PORT` env + `launch.json` bật `autoPort` — để các worktree session preview song song không giành port 5199.

## Verified (chạy thật, daemon nhánh mới trên port 8788)

1. **Unit**: daemon 43/43 (mới: migrate v1→v2, chọn cwd theo repo, persisted-cwd sau restart, unknown repo, event mang repo, generic prompt); renderer `tsc` sạch + 67/67.
2. **GET /chat** → `{"ok":true,"defaultRepo":"Acme Web"}`.
3. **Repo lạ** → 404 `Chưa biết repo "repo-khong-ton-tai" nằm ở đâu…`.
4. **PM Acme Web** (resume session cũ `dd470c64` từ file v1 — migration sống): hỏi trạng thái `wi-pm-per-repo`/`wi-notify` → trả lời đúng registry thật (16 item, cả 2 `in_progress`, đúng assignee/branch). Lưu ý: turn đầu PM trả lời theo trí nhớ conversation cũ (stale), phải nhắc "đọc lại file" mới đúng — đó là hành vi resume của PM, không phải lỗi routing; xem "Đề xuất".
5. **PM demo-app** (spawn lần đầu, cwd = `/Users/…/Projects/demo-app`): hỏi "repo này đang có gì" → tóm tắt khớp chính xác `git log -5` thật của demo-app (0672b2f fix video Vật lí, Địa 12, Tin 11, Sử 12 ASEAN). `pm-session.json` sau đó có đúng 2 entry riêng biệt.
6. **UI (vite preview + daemon live)**: click tab demo-app → placeholder `Nhắn cho PM · demo-app…`; tab All → generic; tab Acme Web → `Nhắn cho PM · Acme Web…`. Screenshot trong PR.

## Lưu ý vận hành

- `pm-session.json` thật đã được migrate sang v2 trong lúc verify (giữ nguyên sessionId cũ — hội thoại PM Acme Web không mất). Daemon launchd đang chạy code cũ đọc file v2 sẽ không thấy `sessionId` → nếu user chat trước khi restart, PM Acme Web sẽ spawn mới (mất thread cũ, không mất data). **Sau merge chạy: `launchctl kickstart -k gui/$(id -u)/com.agentoffice.daemon`.**
- Repo mới toanh (chưa có session Claude nào từ lúc daemon boot) sẽ bị 404 khi chat — mở 1 session Claude trong repo đó trước là xong.

## Đề xuất (không làm trong item này)

- PM resume hay trả lời theo trí nhớ cũ thay vì đọc lại registry → cân nhắc system prompt nhấn mạnh "luôn Read lại file trước khi trả lời trạng thái", hoặc PM stateless hoàn toàn (mỗi turn session mới + context tự đọc).
- Per-repo queue nếu muốn chat 2 PM song song (hiện 1 turn in-flight toàn cục).
