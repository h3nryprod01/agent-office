# Office Makeover — Status (wi-office-makeover)

_Branch `feat/office-makeover`. Brief: 2 ảnh pixel-art (văn phòng có tường, agent ngồi kín bàn, props dày, bảng SCRUM/SPRINT trên tường, ánh sáng ấm). Nguyên tắc: theo tinh thần ảnh nhưng ưu tiên đọc-được-trạng-thái hơn mật độ._

## Phase 1 — Asset production (✅ xong, chỉ đụng `assets/`)

Toàn bộ asset mới sinh deterministic qua `assets/tools/gen_makeover.py`
(+ chỉnh nhỏ `gen_tileset.py`, `gen_characters.py`), pack vào 2 atlas cũ —
không đổi manifest, không đổi tên frame nào có sẵn.

| Nhóm | Frames |
|---|---|
| Tường | baseboard + crown trim cho `wall_NE/NW/corner` (giữ tên/anchor); `wall_NE_win`, `wall_NW_win` (cửa sổ đêm) |
| Seat system | `chair_office_E/W` (ghế xoay); nhân vật `typing_W_{0,1}`, `error_W_0` (mirror E) cho cả 4 skin |
| Desk clutter | `clutter_lamp`, `clutter_mug`, `clutter_papers` (đặt lên mặt bàn bằng dy offset) |
| Props | `water_cooler`, `server_rack`, `wall_clock_NE/NW`, `poster_NE/NW`, `rug_big` |
| Bảng data | `wall_board_NE/NW` — khung + header strip, thân TRỐNG: renderer vẽ nội dung live (Scrum/Velocity); daemon tắt → vẫn là bảng trống gọn |
| Ánh sáng ấm | `glow_warm` (halo tròn, ADD blend), `light_pool` (vũng sáng iso trên sàn) |

Kết quả atlas: office-tileset **44 frames** (trước 26), characters **120 frames** (trước 108).

Verify: `assets/preview/makeover-preview.png` (scene ghép mọi asset mới —
ngồi ghế 2 hướng khớp bàn, board/clock/poster đúng slope mặt tường, clutter
trên mặt bàn) + `assets/tools/preview.html` xem atlas nhanh. `tsc --noEmit`
sạch, 106/106 renderer test pass với atlas mới.

Ghi chú kỹ thuật: mặt tường NE có slope **+1/2** (image coords) — mọi prop
treo tường round 3 theo slope này; `neon_sign` (round 2) dùng slope ngược,
để nguyên (decor nhỏ, không sửa ngoài scope).

## Phase 2 — Tích hợp renderer (✅ xong, sau khi anim-round3 merge)

Rebase main (sạch, không conflict), đọc code walk/z-sort/pin của chip anim
trước khi sửa (`AgentLayer` z-sort `zIndex = y + 0.5`, furniture vào
`layer.depth`, `pinAgent`, `standingPosition`/`deskSlot`). Tất cả bổ sung
tái dùng hạ tầng đó, không viết đè.

- **(a) Room shell** — `OfficeView.drawWalls()`: vòng tường bao 2 cạnh sau
  (NE gy=0, NW gx=0) + góc, xen `wall_*_win`, chừa lỗ ở cửa (gy=7). Vào
  `layer.depth` nên sort ra sau, nhân vật đi trước tường đúng.
- **(b) Seat system** — mỗi bàn thêm `chair_office_E` tại `deskSlot(i)`.
  Agent làm việc = pose `typing_E` (ngồi) sẵn có, `zIndex y+0.5` thắng ghế
  (`y`) → ngồi trên ghế quay mặt vào màn hình. Không đổi `deskSlot`/walk.
- **(c) Props** — DECOR thêm water_cooler, server_rack, rug (dưới sofa),
  plant_big, wall_clock, poster; đặt ở khoảng sàn trống, KHÔNG thêm bàn.
- **(d) Bảng tường DATA THẬT** — `render/wallBoards.ts` `WallBoardView`
  (panel màn hình phẳng, chữ thẳng đọc rõ) + `ui/wallBoardData.ts` (pure,
  unit-test). main.ts refresh 45s: `GET /work-items`→Scrum (To Do/In
  Progress/Done + vài title), `GET /costs?window=24h`→Velocity (USD 24h);
  push snapshot vào mọi office. Đặt trên tường NW (span trống duy nhất,
  không bàn/kệ che). **Daemon tắt / mock mode → bảng hiện "— daemon
  offline —"** (đã verify cả 2 nhánh null).
- **(e) Ánh sáng ấm** — `glow_warm` (ADD halo) + `light_pool` (vũng sáng
  sàn) tại các điểm đèn; KHÔNG shader. Đặt sau agents nên không giảm
  contrast badge.

### Verify (live, port 5302)
- `tsc --noEmit` sạch; **122/122 test** pass (thêm `wallBoards.test.ts`).
- Live mode: Scrum 4/4/16 khớp panel "Board · 4 làm · 0 kẹt · 16 xong";
  Velocity khớp panel "Chi phí" ($8xx). Bảng refresh 45s.
- **Perf: 60 FPS @ 30–34 nhân vật** (mock `?stress`), đạt mục tiêu.
- Badge/label vẫn đọc được; mật độ bàn giữ nguyên (16 bàn cũ); mock mode
  chạy; fallback graceful (thiếu atlas → Graphics; daemon tắt → bảng trống).
- Screenshot asset scene: `docs/media/makeover/asset-preview.png`.

### So với 2 ảnh brief
- **Giống**: tường bao + cửa sổ, agent ngồi ghế tại bàn, props dày
  (cooler/server/kệ/cây/sofa/thảm/đồng hồ/poster), bảng SCRUM trên tường,
  ánh sáng ấm.
- **Vượt ảnh mẫu**: bảng tường là DATA THẬT real-time (Scrum từ
  `/work-items`, Velocity từ `/costs`), không phải trang trí tĩnh.
- **Cố ý khác** (đọc-được-trạng-thái > mật độ): giữ 16 bàn thay vì nhồi
  30 bàn; bảng đặt tường NW trống để chữ không bị bàn/kệ che (tường NE sau
  dãy bàn + kệ sách không đủ chỗ cho panel đọc-được).
