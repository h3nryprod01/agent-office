# wi-office-life — CEO sống động, tủ hồ sơ, see-more

_Trạng thái: DONE · branch `feat/office-life` · 2026-07-08_

## Phạm vi

3 việc theo brief R9:

1. CEO idle behavior: đi lại giữa vài waypoint, nghe điện thoại, đứng nhìn scrum board — không bao giờ che agent đang alert, quay về bàn ngay khi có agent chờ duyệt.
2. Tủ hồ sơ: sprite mới cạnh kệ sách, click mở panel liệt kê output thật (`docs/media/**` + local path trong work-items.json), nút Mở / Hiện trong Finder qua daemon.
3. See-more trong side panel: toggle ▸/▾ xổ toàn bộ nội dung mỗi entry hoạt động; transcript có nút "Xem thêm" tải dần 20→100→500.

## Đã làm

### 1. CEO sống động

- `render/ceoActivity.ts` (mới, pure — cùng lý do với `anim.ts`): `pickCeoActivity`/`ceoActivityDelay` (rand-seeded, 20-60s/lần) + `CEO_ACTIVITY_SPOT` (desk/cooler/sofa/window/board) + `nextCeoActivity(current, blocked, changeDue, rand)` — quyết định cốt lõi: **`blocked` luôn thắng, trả về "desk" bất kể đang làm gì** (blocked = có agent trong hàng chờ CEO HOẶC bất kỳ agent nào đang alert, tái dùng `interventionQueue` có sẵn — không tự viết lại logic "thế nào là alert").
- `AgentLayer.ts`: `tickCeo` viết lại — gọi `moveCeo` (tween điểm-tới-điểm giống `movePuppet` nhưng không có exit-to-door/queue-slot) mỗi tick, khi đến nơi mới gọi `setActivityPose`. CEO không còn cố định tại `CEO_CHAIR`.
- `AgentSprite.ts`: thêm `setActivityPose("phone"|"standing"|null)` — đè pose theo status khi CEO đang wander/nghe điện thoại; `stopWalking()` reset pose này để lần đến nơi kế tiếp không bị "guard" bỏ qua.
- Frame mới `phone_S` (1 frame, giống cách `error_E` chỉ có 1 frame) trong `gen_characters.py`, sprite tủ hồ sơ mới trong `gen_tileset.py` — cả hai regenerate qua `python3 assets/tools/generate_placeholders.py` (deterministic, chỉ atlas 2 file characters + office-tileset đổi, các frame khác giữ nguyên nội dung).
- Verify sống (vite worktree port 5304, daemon `DAEMON_WS_PORT=8788`): drive `app.ticker.update()` thủ công qua `setInterval` (tab preview bị background → rAF pause, xem note trong vault "verify PixiJS app trong preview tab bị background"). Ép CEO đi ra sofa (`walk_S`) — một event alert thật đến giữa đường → **CEO tự quay đầu `walk_N` về bàn ngay lập tức, đúng nhiều tick liên tiếp, tới nơi resume `typing_E`** — bằng chứng sống cho rule "không bao giờ che agent alert".

### 2. Tủ hồ sơ

- `packages/daemon/src/outputs.js` (mới): `OutputsIndex` — whitelist roots = `docs/media/` (thư mục, quét đệ quy, bỏ dotfile) + mọi field `pr`/`obsidianNote` trong work-items.json là absolute path tồn tại thật (hiện tại chưa có item nào khớp, chỉ là safety net theo đúng spec). `isAllowed()` check containment qua **realpath** (chặn `../`, chặn symlink trỏ ra ngoài, chặn kiểu `docs/media-evil` chỉ trùng tiền tố chuỗi). `POST /open`: resolve realpath trước, whitelist-check, rồi `execFile("open", ...)` — không bao giờ ghép chuỗi shell.
- `GET /outputs`, `POST /open {path, reveal?}` gắn vào `extraHttp` chain trong `index.js` (pattern giống `costsHttp`/`approvalHttp`).
- `ui/outputs.ts` (mới): panel overlay giống `orgchart.ts` (không có nút toggle riêng — chỉ mở qua click sprite, đúng tinh thần "tủ hồ sơ = cổng ra"). `OfficeView.onFurnitureClick` + `DecorDef.id` (mới) cho phép 1 decor có `eventMode`/click, sprite `filing_cabinet` đặt cạnh kệ sách trong `layout.ts`.
- Verify sống: click tủ hồ sơ thật (tìm sprite qua `layer.sprites.children`, dispatch PointerEvent) → panel hiện đủ file thật kể cả `agent-office-promo-16x9.mp4`/`9x16.mp4`; `POST /open {reveal:true}` trên file thật → **Finder mở cửa sổ `promo` thật** (verify qua `osascript` list window). 403 cho path ngoài whitelist, symlink-escape bị chặn (test + curl tay).
- Bug tìm thấy khi verify: `.orgchart .orgchart-toggle {` trong `style.css` thiếu dấu `}` đóng — **lỗi có sẵn từ trước (đã confirm qua `git show HEAD`), không phải do round này** — khiến toàn bộ nửa sau file CSS (costs, orgchart panel, board, và tủ hồ sơ mới của tôi) parse hỏng, style rơi về mặc định trình duyệt. Đã vá (điền lại đúng property giống `.board-toggle`/`.costs-toggle` — 3 nút toggle này vốn giống hệt nhau).
- Bug nhỏ khác: `.DS_Store` lọt vào danh sách khi Finder ghé qua `docs/media/` — thêm filter bỏ file bắt đầu bằng `.`.

### 3. See-more

- `normalize.js`: `MAX_DETAIL_LENGTH` 140 → 2000 — đây là nguyên nhân thật của "cắt cụt" (timeline lẫn transcript đều lấy thẳng `event.detail`). Vẫn có trần cứng để không lặp lại OOM #17: worst case ~50MB ở mức trần `perSessionLimit` mới, còn xa mức cap heap 768MB.
- `index.js`: `perSessionLimit: 500` (chỉ ở entrypoint thật, không đổi default của `EventBroadcastServer` — tránh ảnh hưởng test/caller khác) — nếu không tăng, tier "Xem thêm (500)" chỉ trả lại đúng 100 dòng cũ, vô nghĩa.
- `sidePanel.ts`: `timelineHtml()` (export, pure) — mỗi entry có nút ▸/▾ (`data-toggle-timeline-ts`), CSS `-webkit-line-clamp: 2` mặc định, `.expanded` bỏ clamp. `transcriptHtml()` (export, pure) — cùng cơ chế toggle theo dòng + nút "Xem thêm (tier kế)" khi `transcript.length >= limit` và còn tier cao hơn (tự ẩn khi daemon đã trả hết, không mời bấm vô ích). `fetchTranscript` nhận thêm `limit`, `main.ts` cập nhật URL tương ứng.
- Escape: giữ nguyên convention `esc()` (HTML-entity escape trước khi interpolate vào `innerHTML`) — đã là pattern chuẩn xuyên suốt mọi file `ui/*.ts` trong repo này, tương đương an toàn với `textContent`; không viết lại toàn bộ panel sang DOM-node-by-node cho riêng phần mới (sẽ tạo 2 style trộn lẫn trong 1 file).
- Verify sống: mở side panel 1 agent thật, click ▸ → chiều cao đo qua `getBoundingClientRect()` **37.7px (thu gọn) → 885.7px (xổ full)** — chênh lệch xác nhận cả clamp lẫn nội dung dài (nhờ MAX_DETAIL_LENGTH mới) đều hoạt động. Click "Xem thêm" → network log thấy `GET /transcript?...&limit=100` bắn ra đúng như kỳ vọng.

## Test

- Daemon: 91/91 pass (6 test mới `outputs.test.js`: whitelist path escape, symlink-outside-root, string-prefix-sibling, work-item local-path pickup, HTTP 400/404/403/200 đủ mã).
- Renderer: 156/156 pass (`ceoActivity.test.ts` 6 test cho rule blocked-luôn-thắng + phân phối activity; `outputs.test.ts` 5 test cho HTML builder + escape; `sidePanel.test.ts` 10 test mới — file này trước đây chưa có test nào). `tsc --noEmit` sạch.
- Không unit-test trực tiếp `AgentLayer`/`AgentSprite` (Pixi-coupled, đúng quy ước sẵn có của repo — không file nào khác test 2 class này) — verify hành vi CEO qua worktree preview sống thay vì mock.

## Ghi chú vận hành

- **Coordinator kickstart daemon sau merge** — launchd service sở hữu port 8787, code mới (outputs endpoint, MAX_DETAIL_LENGTH, perSessionLimit) chỉ có hiệu lực sau khi restart service.
- Regenerate asset qua `python3 assets/tools/generate_placeholders.py` sau merge nếu ai đó sửa tiếp `gen_characters.py`/`gen_tileset.py` — deterministic, chạy lại an toàn.
- `.claude/launch.json`: entry `office-life-wt` dùng để verify (port 5304) đã bị session khác dọn mất giữa chừng (nhiều chip cùng sửa 1 file) — không sao, chỉ là tooling local, thêm lại khi cần re-test.
