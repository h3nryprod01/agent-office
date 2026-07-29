# wi-ceo-avatar — CEO character + agent xếp hàng chờ duyệt

_Cập nhật: 2026-07-08 · branch `feat/ceo-avatar` · assignee avatar-engineer_

## Đã làm

Vùng file đúng cam kết: chỉ `packages/renderer/src/render/*` + `packages/renderer/src/sim/selectors.ts` + test. Không đụng `ui/`, không đụng `main.ts` — CEO puppet sống hoàn toàn bên trong `AgentLayer`, tự xuất hiện ở **mọi** office tab vì mỗi tab có 1 `AgentLayer` instance riêng.

1. **`sim/selectors.ts` — `ceoQueue(state, now)`**: selector thuần mới, cùng nguồn `OfficeState` với `interventionQueue` đã có (không tự chế state riêng). Khác `interventionQueue` ở 2 điểm có chủ đích:
   - Chỉ `waiting_permission`/`blocked` — bỏ `error` (lỗi không phải "chờ CEO quyết định", không cần xếp hàng).
   - Debounce `CEO_QUEUE_DELAY_MS = 10_000`: phải đứng ở trạng thái đó ≥10s mới vào hàng, tránh nhân vật chạy lung tung vì một block chớp nhoáng.
   - Sắp theo FIFO (`statusSince` tăng dần) — hàng đợi vật lý xếp theo thời gian tới, khác với `interventionQueue` ưu tiên theo loại alert (dùng cho panel chữ, không phải hàng người đứng).

2. **`render/layout.ts`**: `CEO_CHAIR` (chỗ ngồi cố định của CEO, tách khỏi `CEO_SPOT`/`PM_DESK` đã có từ pm-chat để 2 nhân vật không đè nhau) + `CEO_QUEUE_SLOTS` (5 vị trí, hàng dọc, cách nhau 1.2 tile để không chồng lên nhau khi vẽ) + `ceoQueueSlot(index)` clamp vào slot cuối khi quá 5 người ("đứng dồn" đúng yêu cầu).

3. **`render/AgentSprite.ts`** — 2 bổ sung tối thiểu, không đổi hành vi nhân vật thật nào:
   - `opts?: { colorway?: Colorway; tint?: number }` trong constructor — cho phép ép skin `exec-navy` + tint khác PM mà không cần sinh sprite mới (tối thiểu theo đúng spec, xem "Giới hạn" bên dưới).
   - Tách phần vẽ badge-pill ra `setBadgeText()` dùng chung, thêm `setBadgeCount(count)` public — override badge trạng thái bằng số đếm thuần (CEO không có "trạng thái" thật để hiện pill "Focusing/Available").

4. **`render/AgentLayer.ts`** — phần việc chính:
   - CEO là 1 `AgentSprite` dựng 1 lần trong constructor (`ceoModel(false)`, skin `exec-navy` + tint `0xffd166` mustard — màu đã có sẵn trong palette `docs/art-direction.md` §3), đứng cố định tại `CEO_CHAIR`, **không** nằm trong `puppets` Map (không có agentId thật trong `state.agents`) nên không bị `cullRemoved` dọn nhầm. `reset()` re-attach lại CEO sau `sprites.removeChildren()` vì nó không phải puppet.
   - Mỗi tick: tính `ceoQueue(state, now)`, gán slot theo thứ tự (agent bị pin — PM — loại khỏi việc gán slot để hàng không có "lỗ trống" ở đầu, nhưng vẫn tính vào số đếm badge). `movePuppet` chỉ thêm đúng 1 tham số optional (`queueSlot`) chen vào chuỗi fallback có sẵn: `pinned → queueSlot → standingPosition` — toàn bộ cơ chế đi bộ (lerp, hướng, animation walk, teleport ở replay ≥4×) là code **có sẵn**, dùng lại 100%, không viết state machine mới. Khi agent rời hàng (được duyệt/hết hạn), tick sau nó không còn trong `queuePositions` → tự động fallback về `standingPosition` như đi tới station khác — không cần code "đi về" riêng.
   - CEO phản ứng: baseline (hàng trống) = animation `working` (typing tại bàn, "gõ phím bình thường"). Có người chờ = animation `idle` (quay ra nhìn, S-facing) + `setBadgeCount(queueLength)` hiện số ngay trên đầu.

## Verify

### Unit — `test/selectors.test.ts`, 6 case mới cho `ceoQueue`

Hàng trống khi không ai alert; giữ lại đến khi đủ `CEO_QUEUE_DELAY_MS` (test đúng biên `delay-1` vs `delay`); loại `error`; loại agent đã despawn; FIFO đúng theo `statusSince` bất kể waiting_permission hay blocked; rời hàng khi status hồi phục. `npm test` (renderer): **82/82 xanh** (76 cũ + 6 mới), `tsc --noEmit` sạch.

### Verify thật — pipeline thật, daemon cô lập port 8790 (không phải mock)

Daemon production (`com.agentoffice.daemon`, port 8787) đang **crash-loop OOM thật** lúc tôi verify (xem "Phát hiện phụ" bên dưới) — không tin cậy được cho 1 chuỗi test cần giữ trạng thái ổn định >15s, nên tôi dựng **daemon riêng port 8790** (code y hệt, chưa đổi gì ở `packages/daemon`) với `CLAUDE_PROJECTS_ROOT`/`CODEX_SESSIONS_ROOT` trỏ vào thư mục rỗng (tránh đúng nguyên nhân OOM), renderer trỏ tạm sang 8790 (sửa 1 dòng default trong `WebSocketEventSource.ts`, **đã revert trước khi commit** — `git diff` xác nhận file này 0 thay đổi trong PR).

Bơm `PreToolUse` giả vào hook log thật (`~/.claude/agent-office-hook-events.jsonl`, sessionId đặt tên rõ `wi-ceo-avatar-verify2-*` để không lẫn session thật, cùng kỹ thuật `wi-notify` đã dùng):

- 6 agent giả → sau 2s grace (reconciler có sẵn) + 10s debounce (`CEO_QUEUE_DELAY_MS`) mới bắt đầu đi. Do headless preview tab có `document.hidden = true` (rAF ticker bị trình duyệt đóng băng hoàn toàn — xác nhận bằng `performance.now()` vs `ticker.lastTime` lệch >100s), tôi gọi `layer.tick()` trực tiếp qua `preview_eval` để đẩy animation tới đích thay vì chờ ticker tự chạy — test đúng logic thật (`movePuppet`/`ceoQueue` không đổi gì khi gọi tay vs ticker tự gọi).
- Kết quả đọc trực tiếp từ `layer.puppets` (không đoán qua ảnh chụp): 5 agent đầu (`alpha…echo`) khớp **chính xác** `CEO_QUEUE_SLOTS[0..4]` theo đúng thứ tự tới trước; agent thứ 6 (`foxtrot`) **trùng vị trí** slot cuối với `echo` — đúng hành vi "đứng dồn". Badge CEO hiện `●6`. 1 agent thật khác (repo này, không phải giả) đang `running_command` vẫn đứng đúng chỗ arcade — xác nhận **không** kéo nhầm agent không-alert vào hàng.
- Bơm `PostToolUse` cho cả 6 → agent chuyển `running_command`, tick lại → cả 6 đi thẳng về slot arcade cũ (không còn ở `CEO_QUEUE_SLOTS`), badge CEO giảm về đúng số agent thật còn lại đang alert (`●1`, agent thật kể trên) — xác nhận rời hàng đúng, không rơi rớt agent.
- Ảnh chụp preview đã xem trực tiếp trong lúc verify (queue hình thành, CEO đổi tư thế + badge, dọn về) nhưng **không lưu được file vào `docs/media/`** — công cụ `preview_screenshot` không có đường dẫn cục bộ để copy ra khỏi phiên; khác `art-round2` (có ảnh before/after thật trong repo), lần này bằng chứng là dữ liệu tọa độ đọc trực tiếp từ `layer.puppets` (in ở trên) — chính xác hơn ảnh chụp mắt thường, nhưng ghi nhận thiếu sót thành thật thay vì giả vờ có ảnh.

Đã dọn: daemon test port 8790 kill sạch (xác nhận `lsof -i :8790` rỗng), `WebSocketEventSource.ts` revert về `8787` (git diff rỗng), preview server tắt.

## Phát hiện phụ (ngoài vùng file, đã báo riêng)

Trong lúc verify phát hiện **daemon production OOM crash-loop thật** (`FATAL ERROR: Reached heap limit... 768MB`, RSS chạm ~870MB chỉ sau ~20-30s mỗi lần restart) — không liên quan tới thay đổi của tôi (chỉ sửa `packages/renderer`, đã xác nhận qua `git diff --stat`; `HookLogTailer` dùng `startAtEnd:true` nên dòng test tôi bơm không hề được replay lúc daemon restart). Nghi nguyên nhân: `TranscriptTailer` tail `~/.claude/projects` — thư mục này hiện **2.5GB / 4092 file** JSONL. Đã dùng `spawn_task` báo riêng (task_id `task_d9c87fc3`), không tự sửa vì ngoài vùng file được giao. **Update**: đến lúc mở PR, `main` đã có `c84e970 fix(daemon): stop 9GB log growth + 768MB heap guardrail` + work item `wi-daemon-leak` — đã fix trước khi tôi merge, không còn chặn gì.

## Giới hạn đã biết (theo đúng spec, không tự ý mở rộng)

- **Phân biệt CEO/PM = tint, không phải kính/tóc riêng**: spec cho phép "tối thiểu là tint khác" — tôi dùng tint mustard `0xffd166` (màu có sẵn trong palette, không sinh asset mới qua `assets/tools/*.py`) thay vì vẽ sprite riêng. Nâng cấp lên sprite khác biệt thật (kính/tóc) cần chạy lại generator + thêm colorway mới trong `docs/art-direction.md` §4 — để dành nếu user muốn rõ hơn.
- **Agent bị pin (PM) không bao giờ xếp hàng**: nếu chính PM rơi vào `waiting_permission` >10s, PM vẫn đứng yên ở `PM_DESK` (không đi ra xếp hàng) nhưng **vẫn được tính vào badge số** — tránh hàng có "lỗ trống" ở đầu (agent được gán slot 0 nhưng không di chuyển tới). Trade-off nhỏ, không thấy đáng để phức tạp hoá thêm.
- **CEO không click được**: spec không yêu cầu; click nhân vật *xếp hàng* (agent thật) mở side panel như bình thường vì đó vẫn là sprite thật đã có `onAgentClick` từ trước — không cần code thêm.
- **Toạ độ `CEO_CHAIR`/`CEO_QUEUE_SLOTS` là ước lượng mắt thường** qua ảnh chụp preview (không có nhân vật hàng xóm/asset nào để căn chỉnh pixel-perfect theo `ceo_desk_E`) — hợp lý về mặt bố cục, có thể cần user tinh chỉnh 1 lần nhìn thấy office thật chạy production.
- **60fps: suy luận, không đo trực tiếp phiên này**: tab preview headless có `document.hidden = true` nên trình duyệt đóng băng hẳn `requestAnimationFrame` (đây là lý do phải gọi `layer.tick()` tay qua `preview_eval` thay vì để ticker tự chạy) — không có cách đo FPS thật trong điều kiện đó. Suy luận an toàn: `ceoQueue()` là O(n) trên số agent, cùng độ phức tạp với `interventionQueue()` đã chạy sẵn mỗi 250ms; CEO chỉ thêm đúng 1 sprite. Nên đo lại FPS thật (giống cách `wi-multi-office` đã làm — "60fps @ 3 office/36 nhân vật") khi có điều kiện chạy browser thật, không chỉ suy luận.

## Ghi chú cho coordinator

- Merge sau `feat/voice` nếu 2 nhánh cùng cửa sổ (theo đúng dặn dò ban đầu) — diff của tôi hoàn toàn không đụng `ui/chatBox.ts`/`ui/voice.ts`, rebase lên main không có conflict dự kiến.
- Daemon OOM (mục "Phát hiện phụ") là vấn đề vận hành thật, độc lập với work item này — đã tách task riêng, đừng chặn merge PR này vì nó.
- Worktree `.claude/worktrees/ceo-avatar` còn sống — xóa sau merge.
