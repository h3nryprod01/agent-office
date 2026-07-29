# wi-pm-ux — 4 vấn đề UX do user báo trực tiếp

_Trạng thái: DONE · branch `fix/pm-ux` · 2026-07-08_

## Phạm vi

4 vấn đề user báo (kèm screenshot) sau makeover #24 + voice #16:

1. Bảng tường SCRUM BOARD / TEAM VELOCITY nổi lệch khỏi mặt tường, đè góc tường.
2. Voice đọc reply sai ngôn ngữ (PM trả lời tiếng Anh, giọng vi-VN đánh vần từng chữ) + đọc cả ký tự markdown.
3. Không có cách dừng PM turn đang chạy ("PM đang gõ…" phải chờ đến timeout 5 phút).
4. Không có cách tiếp tục phiên PM trong Claude Code thật.

## Đã làm

### 1. Bảng tường áp phẳng vào mặt tường iso

- `wallBoards.ts`: cả WallBoardView (sprite mount + text) được skew theo mặt phẳng tường — đường dọc giữ dọc, đường ngang theo dốc tường `±atan(TILE_H/TILE_W)` (~26.57°); chiều skew chọn theo hậu tố frame `_NE`/`_NW`.
- `layout.ts`: scrum chuyển sang khoảng tường NE trống (gx 5.5, giữa cửa sổ gx2 và đồng hồ gx8); velocity sang tường NW sau cửa ra vào (gy 10.5). Bảng rộng ~3.7 tile nên khe cũ (giữa cửa sổ gy3 và cửa gy7) không đủ chỗ.
- `OfficeView.ts`: zIndex bảng = y + TILE_H — bảng phủ ~±2 tile tường, không cộng thêm thì các đoạn tường phía dốc xuống che mất nửa bảng (nguyên nhân chính của ảnh user chụp).
- Verify bằng mắt (vite worktree port 5302, zoom 3×): 2 bảng áp phẳng đúng mặt tường, chữ đọc được, không che cửa sổ/cửa/đồng hồ/poster.

### 2. Voice đúng ngôn ngữ + không đọc markdown

- Phía prompt (`chat-session.js`): cả 2 system prompt PM thêm "LUÔN trả lời bằng đúng ngôn ngữ user dùng trong tin nhắn". Quan trọng: `--append-system-prompt` giờ được đẩy MỖI turn (trước đây chỉ turn đầu) — vì flag này là per-run, không lưu vào transcript, nên các phiên PM cũ resume sẽ không bao giờ nhận prompt fix nếu chỉ append lần đầu.
- Phía TTS (`voice.ts`): `detectLang()` (có dấu tiếng Việt → vi-VN, không → en-US) chọn voice khớp reply thay vì hardcode vi-VN; `stripForSpeech()` bỏ code block, URL, `**` `#` `|`, bullet; bảng markdown đọc thành "bảng N dòng".

### 3. Nút ⏹ dừng PM turn

- Daemon: `ChatSessionManager.stop(repo?)` — SIGTERM child `claude -p`, leo thang SIGKILL sau 3s; exit handler emit frame cuối `{done:true, error:false, text:"(đã dừng theo yêu cầu)"}`. Route mới `POST /chat/stop {repo?}`.
- UI: nút "⏹ dừng" hiện cạnh "PM đang gõ…" khi đang stream.
- **Phạm vi trung thực** (ghi trong tooltip): chỉ dừng được PM chat turn do daemon spawn — KHÔNG dừng được các session Claude khác của user (việc của app gốc).

### 4. Hand-over phiên PM sang Claude Code

- `GET /chat` trả thêm `repos` (map repo → {sessionId, cwd} từ pm-session.json).
- Chatbox: nút 🔗 cạnh nút voice — fetch sessionId mới nhất (mỗi turn fork id mới nên phải fetch lúc bấm), copy `cd "<cwd>" && claude --resume <sessionId>` vào clipboard + hiện dòng "đã copy …".
- Side panel của nhân vật PM: thêm hàng "Tiếp tục trong Claude" với đúng lệnh đó + nút copy.
- Chỉ copy-to-clipboard, không launch terminal (theo brief).

## Test

- Daemon: 85/85 pass (4 test stop mới: đang chạy / idle / double stop / sai repo; 2 test cũ cập nhật theo hành vi append-prompt-mỗi-turn). Smoke `DAEMON_WS_PORT=8788`: GET /chat trả repos, POST /chat/stop idle → `{stopped:false,reason:"idle"}`.
- Renderer: 135/135 pass (10 test mới cho `detectLang` + `stripForSpeech`), `tsc --noEmit` sạch.

## Ghi chú vận hành

- **Coordinator kickstart daemon sau merge** (launchd service sở hữu port 8787; code daemon mới chỉ chạy sau restart service).
- `.claude/launch.json` thêm entry `pm-ux-wt` (vite worktree port 5302) — cùng pattern `anim-wt`; có thể dọn khi worktree bị xoá.
- Voice fix (a) chỉ hiệu lực từ turn kế tiếp sau khi daemon restart; fix (b) phía renderer hiệu lực ngay khi reload trang.
