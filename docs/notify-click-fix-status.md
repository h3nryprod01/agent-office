# wi-notify-click-fix — click notification mở Finder thay vì office

> **Ghi chú bản public:** hai ảnh chụp e2e (`docs/img/notify-click-fix-e2e*.png`,
> ~4MB) đã lược khỏi repo để giữ kích thước clone nhỏ.


_Cập nhật: 2026-07-08 · branch `fix/notify-click` · assignee notify-fixer_

## Root cause (khác chẩn đoán ban đầu — đã thí nghiệm thật)

Chẩn đoán ban đầu nghi `terminal-notifier -open` với URL chết/thiếu scheme mở
Finder. **Thí nghiệm thật trên máy bác bỏ cả hai**:

1. Click banner `terminal-notifier -open "http://localhost:5173"` (port chết)
   → Chrome mở trang lỗi kết nối, KHÔNG phải Finder.
2. `terminal-notifier -open "localhost:5199"` (thiếu scheme) → bị từ chối ngay
   lúc bắn (`'localhost:5199' is not a valid URI`), không tạo notification
   có action.
3. Click banner với URL sống có query
   (`http://localhost:5199/?focus=test-agent-123`) → Chrome mở đúng, query
   param sống sót nguyên vẹn.

**Root cause thật — chuỗi 2 tầng:**

- Daemon chạy dưới **launchd** với PATH mặc định
  (`/usr/bin:/bin:/usr/sbin:/sbin`) — KHÔNG có `/opt/homebrew/bin`, nên
  `execFile("terminal-notifier")` ENOENT trong production (dù máy có cài tại
  `/opt/homebrew/bin/terminal-notifier`). Đã tái hiện: chạy node với PATH
  launchd → ENOENT.
- Notifier rơi vào fallback `osascript display notification` — banner này
  **không có click action**, và macOS gán nó cho **Script Editor**. Click
  banner → mở Script Editor, app này khởi động bằng **hộp thoại chọn file**
  — chính là "cửa sổ Finder/file dialog" trong screenshot của user. Đã tái
  hiện bằng click thật: frontmost sau click = Script Editor.
- Port 5173 sai là bug thứ nhì (URL chỉ nằm trong text của fallback nên
  chưa ai click ra nó).

## Đã sửa (3 file)

1. **`packages/daemon/src/notifier.js`**:
   - `DEFAULT_OFFICE_URL` → `http://localhost:5199` (giữ override
     `AGENT_OFFICE_URL`).
   - Probe `terminal-notifier` qua danh sách ứng viên: tên trần →
     `/opt/homebrew/bin/…` → `/usr/local/bin/…` → mới rơi về osascript.
     Đây là fix gốc cho hành vi Finder: production giờ dùng terminal-notifier
     clickable thay vì fallback.
   - `buildOfficeUrl(officeUrl, agentId)` (export mới): gắn
     `?focus=<agentId>` vào URL notification — deep-link tới đúng nhân vật.
2. **`packages/renderer/src/main.ts`**: đọc `?focus=<agentId>` lúc boot;
   trong vòng 4 Hz sẵn có, khi agent xuất hiện trong state (daemon backlog
   đổ về ngay sau connect) → chuyển tab repo của agent + pan camera
   (`focusAgentId` — tái dùng cơ chế của intervention queue) + mở side
   panel. Hết hạn sau 30s để link cũ không giật camera muộn.
3. **`packages/daemon/test/notifier.test.js`**: +4 test (buildOfficeUrl có/
   không agentId, merge query sẵn có + encode, composeNotification deep-link);
   sửa 1 assertion URL cũ theo format mới.

## Verify

- **Unit**: daemon `npm test` **81/81 xanh** (worktree, gồm 4 test mới).
  Renderer: `tsc --noEmit` sạch + vitest **106/106 xanh**.
- **Thí nghiệm click thật** (AppleScript AXPress lên banner Notification
  Center): 5 lần click với 5 cấu hình URL khác nhau — kết quả ở phần root
  cause, mỗi kết luận đều từ hành vi thật, không suy đoán.
- **E2E pipeline thật**: Vite worktree port 5299 + daemon worktree port 8788
  (`AGENT_OFFICE_URL=http://localhost:5299`) cùng tail hook log production →
  bơm `PreToolUse` không PostToolUse (sessionId `wi-notify-e2e-click-2`, cwd
  `/tmp/notify-e2e-repo`) → sau grace 2s + threshold 30s, terminal-notifier
  bắn banner thật → click banner thật → Chrome mở
  `localhost:5299/?focus=wi-notify-e2e-click-2` → office **tự chuyển tab
  "other"** (repo của agent) + **camera pan tới nhân vật** + **side panel mở
  đúng agent** (trạng thái waiting_permission). Screenshot:
  `docs/img/notify-click-fix-e2e.png` (sau click, URL bar + tab + queue) và
  `docs/img/notify-click-fix-e2e-focus.png` (load lại bằng deep-link, pan +
  tab hoạt động cả trên page load mới).
- **Đường osascript fallback**: xác nhận hành vi hiện tại (URL append vào
  text, không click được) — chấp nhận theo spec; giờ chỉ còn xảy ra khi máy
  thật sự không có terminal-notifier ở cả 3 vị trí probe.
- **Dọn sạch**: 2 agent giả đã clear khỏi queue live (bơm PreToolUse chờ >2s
  grace rồi PostToolUse — xem gotcha bên dưới), Vite 5299 + daemon 8788 đã
  kill, không còn tiến trình nền.

## Deviation / ghi chú thành thật

- Chẩn đoán ban đầu của coordinator (URL chết → Finder) **sai**: URL chết
  vẫn mở browser. Thủ phạm là PATH của launchd + fallback osascript. Nếu chỉ
  sửa port như đề bài gợi ý thì bug Finder VẪN CÒN NGUYÊN (production vẫn
  ENOENT → osascript → Script Editor).
- Trong lúc test, vài tab Chrome rác đã mở trên máy user (trang lỗi 5173,
  vài tab Agent Office) — không tự đóng được vì browser ở tier read-only.
- Gotcha tái xác nhận từ wi-notify: muốn clear agent kẹt giả phải bơm
  PreToolUse **chờ quá grace 2s** rồi mới PostToolUse — PostToolUse trong
  grace chỉ hủy timer, không phát tín hiệu "working".
- Screenshot của user (Finder window) khớp hành vi Script Editor file
  dialog; không tái tạo được đúng 100% cửa sổ trong screenshot gốc nhưng
  chuỗi nhân quả đã tái hiện được bằng click thật.

## Sau merge (coordinator cầm)

- `launchctl kickstart -k gui/$(id -u)/com.agentoffice.daemon` để daemon
  production nhận code mới — sau đó notification sẽ là terminal-notifier
  clickable, click mở `http://localhost:5199/?focus=<agentId>`.
- Không cần sửa plist (fix probe absolute path đã né vấn đề PATH), nhưng nếu
  muốn sạch hơn về sau có thể thêm `EnvironmentVariables.PATH` vào plist.
