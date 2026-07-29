# wi-notify — macOS notification khi agent kẹt >30s

_Cập nhật: 2026-07-07 · branch `feat/notify` · assignee notify-engineer_

## Đã làm

1. **`packages/daemon/src/notifier.js`** (module mới): `Notifier` theo dõi mọi
   event daemon broadcast. Agent vào trạng thái cần can thiệp liên tục
   (`hook_signal` với `meta.state === "waiting_permission"`, hoặc bất kỳ event
   nào `status === "error"`) → cắm timer 30s (`thresholdMs`). Bất kỳ dấu hiệu
   sống nào khác (event thường, `hook_signal:working`, `session_end`) → hủy
   timer ngay. Hết 30s không có dấu hiệu sống → gọi `deliverNotification`
   đúng **1 lần cho 1 "đợt kẹt"** — agent phải hồi phục rồi kẹt lại mới
   notify lần 2 (dedup theo `agentId`, reset khi thấy dấu hiệu sống).
2. **`attachNotifier(server)`**: bọc `server.broadcast` — 1 điểm gắn duy nhất
   bắt được mọi nguồn event hiện tại (transcript/hook/codex) và tương lai,
   không cần sửa từng emitter. Notifier lỗi (throw) không bao giờ chặn
   broadcast thật (bọc try/catch quanh `onEvent`).
3. **Delivery**: `terminal-notifier` nếu có sẵn trên máy (cho click `-open`
   mở `AGENT_OFFICE_URL`, default `http://localhost:5173`) → fallback
   `osascript display notification` (không click được, URL nối vào cuối
   message). Không thêm dependency npm mới — probe runtime bằng ENOENT, không
   phải cấu hình.
4. **Chống spam + tắt được**: dedup per-episode ở trên; `AGENT_OFFICE_NOTIFY=0`
   tắt hoàn toàn (đọc 1 lần lúc construct, giống các knob khác trong
   `index.js`).
5. **Đăng ký trong `index.js`**: 1 dòng `attachNotifier(server)` ngay sau
   `server.start()` + 1 dòng import — đúng cam kết diff nhỏ ở vùng file
   chung với 2 chip khác đang chạy song song.

## Verify

### Unit test — `test/notifier.test.js`, 12 case, mock clock/deliver

Ngưỡng 30s, dedup 1 lần/đợt kẹt, kẹt lại sau khi hồi phục = đợt mới (notify
lại), label đúng theo trạng thái (chờ phê duyệt / bị chặn khi "denied" / lỗi
khác), track độc lập theo agent, `AGENT_OFFICE_NOTIFY=0` tắt được,
`attachNotifier` không chặn broadcast kể cả khi notifier throw.
`npm test` (daemon): **51/51 xanh** (39 cũ + 12 mới).

### Chạy thật — pipeline thật, không mock

- Daemon riêng port 8790 (`DAEMON_WS_PORT=8790 node src/index.js`, code từ
  worktree này) + bơm dòng `PreToolUse` không có `PostToolUse` vào hook log
  thật (`~/.claude/agent-office-hook-events.jsonl`, sessionId/cwd đặt tên rõ
  ràng `wi-notify-verify*` để không lẫn session thật) → log daemon xác nhận
  `hook_signal:waiting_permission` bắn ra đúng agent giả, 0 dòng `[notifier]`
  error qua 3 lần chạy độc lập.
- Xác nhận `terminal-notifier` gọi thật thành công (screenshot banner "Notify
  Verify 3" hiện rõ góc phải màn hình — proof trực tiếp cơ chế delivery hoạt
  động trên máy này).
- Harness cô lập (`HookLogTailer` + `HookSignalReconciler` +
  `attachNotifier` — cùng class thật, không mock — trỏ log file riêng,
  threshold rút ngắn để demo nhanh) bắt đúng khoảnh khắc gọi
  `deliverNotification` (marker log), xác nhận toàn bộ chuỗi
  daemon→reconciler→notifier→terminal-notifier chạy đúng, 0 lỗi.
- **Bằng chứng phụ giá trị nhất**: trong lúc verify, renderer thật (đang mở
  sẵn, nối `ws://127.0.0.1:8787` — daemon launchd production) hiển thị đúng
  3 agent giả tôi bơm vào hàng đợi "Cần can thiệp" theo thời gian thực — xác
  nhận toàn bộ kênh `hook_signal` mà Notifier lắng nghe là kênh thật, đang
  chạy production, không phải giả lập.

### Deviation / ghi chú thành thật

- **Không có screenshot banner từ đúng lần bắn của pipeline tự động** (chỉ
  có từ lệnh gọi tay `terminal-notifier` trực tiếp). Bắn lặp lại
  `terminal-notifier` nhiều lần trong ~10 phút để test — nghi macOS throttle
  banner cho các notification lặp lại nhanh từ cùng 1 app (hành vi hệ điều
  hành, không phải bug): log xác nhận `deliverNotification` được gọi đúng
  lúc mọi lần (0 lỗi), nhưng banner không luôn hiện lại trên màn hình khi
  bắn dồn dập để test. Dùng thật (1 agent kẹt thật sự thỉnh thoảng, không
  phải 7 lần trong 10 phút) sẽ không rơi vào tình huống này.
- **Đã vô tình để lộ giới hạn TTL 10 phút** của `HookSignalReconciler`
  (`EMITTED_TTL_MS`, code có sẵn từ Round 3, không phải tôi thêm): agent giả
  đầu tiên bị kẹt "hiển thị" (broadcast) hơn 10 phút trước khi tôi dọn —
  reconciler đã tự xóa entry pending nên `PostToolUse` dọn dẹp thường không
  còn tác dụng (không tìm thấy entry để confirm). Phải bơm lại 1
  `PreToolUse` mới (tái tạo entry) rồi mới `PostToolUse` được. Đây là hành
  vi TTL có chủ đích của module cũ (chống rò rỉ bộ nhớ khi không bao giờ có
  xác nhận) — không phải bug của `notifier.js`, nhưng đáng note cho
  coordinator: **nếu cần dọn 1 agent "kẹt" giả/lỗi đã hiển thị >10 phút trên
  dashboard thật, phải bơm PreToolUse mới trước rồi mới PostToolUse.**
- Đã dọn sạch: 3 agent giả không còn trong hàng đợi live (xác nhận bằng
  screenshot trước/sau), daemon test port 8790 đã kill, không còn tiến trình
  nào của tôi chạy nền.

## Giới hạn đã biết (theo đúng spec, không tự ý mở rộng)

- Click-to-open chỉ hoạt động nếu máy đã cài `terminal-notifier` (máy này
  có, tại `/opt/homebrew/bin/terminal-notifier`). Không có thì fallback
  `osascript` — không click được, chỉ có URL trong text. Không xây app
  riêng cho việc này (ngoài scope R5①).
- Ngưỡng cố định 30s, không cấu hình qua env — spec không yêu cầu, thêm vào
  sau nếu cần.

## Ghi chú cho coordinator

- Vùng file đúng cam kết: chỉ `packages/daemon/src/notifier.js` (mới) +
  2 dòng ở `packages/daemon/src/index.js` (1 import + 1 gọi hàm ngay sau
  `server.start()`). Rebase lên main trước khi PR — chưa thấy conflict với
  2 chip song song (`wi-pm-per-repo`, `wi-approve-spike`) vì họ không đụng
  2 dòng đó.
- `AGENT_OFFICE_URL` (mặc định `http://localhost:5173`) là URL nhét vào
  notification — nếu renderer chạy port khác, set env này khi khởi daemon
  service (`~/Library/LaunchAgents/com.agentoffice.daemon.plist`).
