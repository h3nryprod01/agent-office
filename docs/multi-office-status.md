# Multi-office status — `wi-multi-office`

_Cập nhật: 2026-07-07 · branch `feat/multi-office` · assignee: office-architect_

## Đã làm

1. **Daemon — field `repo` (additive, schema v1 giữ nguyên)**
   - `deriveRepo(cwd)` trong `packages/daemon/src/event-schema.js`, gắn vào `makeEvent` nên
     MỌI emitter (claude normalize, codex normalize, hook signal, session end) đều có `repo`.
   - Quy tắc: cwd trong `<root>/.claude/worktrees/<x>` → repo gốc (sửa tiền lệ nhân vật
     worktree hiện sai chỗ); còn lại đi lên tìm `.git` (dir hoặc file) → basename; không
     tìm thấy / cwd null → `"other"`. Memoize theo cwd — 1 lần fs walk cho mỗi cwd.
   - Event cũ không đổi; `repo` là field mới optional với consumer.

2. **Renderer — office tabs (`ui/officeTabs.ts`, mới)**
   - Tab bar trên đầu màn hình: **All** (hành vi cũ — mọi agent 1 phòng) + 1 tab mỗi repo
     có nhân vật sống. Badge = số nhân vật sống; chấm đỏ khi repo có agent ở
     `waiting_permission`/`error`/`blocked`.
   - Tab tự đóng khi repo hết nhân vật quá `TAB_LINGER_MS` = 5 phút (`sim/selectors.ts`).
   - Mỗi tab = 1 office instance riêng (cặp `OfficeView`+`AgentLayer`, desk/slot riêng);
     chỉ office đang hiển thị được tick → 60fps không phụ thuộc số office. Office của tab
     đã đóng bị destroy trong vòng 4 Hz.
   - DOM tab chỉ rebuild khi TẬP repo đổi; badge/dot/active update in-place — tránh race
     click-vào-node-vừa-detach (cùng chiêu với intervention queue).

3. **Hàng đợi "cần can thiệp" XUYÊN office** (yêu cầu quan trọng nhất)
   - Queue vẫn đọc full state (không filter theo tab) → đứng tab A vẫn thấy alert repo B.
   - Click item: nếu agent thuộc repo khác tab hiện tại → tự chuyển tab, rồi pan camera
     tới nhân vật + mở side panel (đang ở All thì chỉ pan, không chuyển).

4. **Repo của agent trong sim** — `AgentModel.repo`: ưu tiên `event.repo` (daemon) →
   derive từ cwd (string rule, cho mock/recording cũ) → **thừa hưởng repo của parent**
   (sub-agent spawn không có cwd) → `"other"`.

5. **Replay/time-lapse per-tab** — không cần code riêng: replay state chảy qua đúng
   pipeline `current()` → filter theo tab active, tab bar phản ánh thời điểm replay.

## Verified

- Daemon: `npm test` **30/30** (6 test mới cho `deriveRepo`/`makeEvent`: repo thường,
  worktree string-rule, worktree `.git` file, ngoài repo → other, null → other, explicit
  repo thắng).
- Renderer: `vitest` **60/60** (11 test mới: `repoFromCwd`, gán repo trong reducer +
  thừa kế parent, `repoTabs` count/alert/linger-window, `filterStateByRepo` immutable);
  `tsc --noEmit` sạch.
- Chạy thật (mock scenario có repo thứ 2 `demo-app`): tabs render đúng badge; đứng tab
  `acme-web` click alert của demo-app trong queue → chuyển tab + pan + side panel mở đúng
  agent; alert dot bật/tắt theo trạng thái; tab lingering badge 0 rồi tự đóng;
  **60fps với 3 office / 36 nhân vật** (`?stress=30`), replay không crash.

## Giới hạn biết trước

- `TAB_LINGER_MS` cố định 5 phút (ponytail: thành setting khi có nhu cầu).
- Office ẩn không được tick — nhân vật "đứng im" khi tab ẩn, walk bù khi mở lại (đánh đổi
  có chủ đích cho 60fps).
- Recording cũ (trước field `repo`/`cwd`) dồn về office `other`.

## Blockers

Không.

## Next (đề xuất)

- Side panel hiện tên repo của agent (1 dòng, sau khi PR deeplinks merge để tránh conflict).
- Daemon `GET /work-items` (wi-deeplinks) có thể join `repo` để kanban lọc theo office.
