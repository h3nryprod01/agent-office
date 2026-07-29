# Art Round 2 — Status

_Art Director round 2 · work item `wi-art-round2` · branch `art/round-2`_

Nâng cấp visual giữ nguyên pixel-art isometric 2:1 đã chốt round 1
(`docs/art-direction.md`). Không đổi grid/anchor/palette; mọi asset tự sinh
deterministic + ghi license.

## Đã làm

### 1. Skin nhân vật theo vai + harness (`assets/tools/gen_characters.py`)
- Thêm 2 colorway: **`exec-navy`** (PM/CEO — vest navy, áo trắng + cà vạt coral,
  tóc bạc) và **`robot-steel`** (Codex — vỏ thép, visor cyan, ăng-ten đèn báo).
- Cả 2 dùng chung khung `_standing`/`_seated` → tự có đủ 8 trạng thái
  (idle, walk N/E/S/W, typing, reading, blocked, error, talking). Tổng 108 frame
  (4 skin × 27 frame) — không vẽ tay từng frame.
- `robot-steel` override skin/skin_dark = màu kim loại + visor thay mắt;
  `exec-navy` thêm key `tie`.

### 2. Bàn CEO/PM (`assets/tools/gen_tileset.py`)
- `ceo_desk_E`/`_W` (walnut slab + đèn bàn), `chair_exec_E`/`_W` (ghế da lưng cao).
- Đủ để chip pm-chat đặt PM ở góc văn phòng.

### 3. Decor kiểu Teamflow/Gather
- `coffee_table` (ghép sofa), `plant_big` (cây sàn cao),
  `neon_sign` + `neon_sign_NW` (panel gạch + neon sét cyan + vòng coral),
  `bookshelf` nâng cấp (sách cao thấp + khoảng trống + top trim + chậu trên nóc).
- Mỗi item = 1 sprite trong atlas `office-tileset`, renderer nạp qua
  `manifest.json` bằng frame name — không hardcode.

### 4. Polish trạng thái (`packages/renderer/src/render/AgentSprite.ts`)
- Badge → **pill kiểu Gather**: capsule tối + chấm màu trạng thái + chữ sáng,
  viền màu theo status. ❗ đỏ nảy giữ nguyên (đã có từ round 3).
- Speech bubble bo tròn hơn (radius theo chiều cao) + đuôi mềm.

### 5. Nguồn/pipeline
- Tất cả tự sinh CC0, ghi tại `assets/CREDITS.md`. Chạy lại:
  `python3 assets/tools/generate_placeholders.py` (deterministic).
- `assets/tools/preview_round2.py` render ảnh so sánh trước/sau (tolerant với
  frame chưa tồn tại → cùng script dựng cả before lẫn after).

## Plumbing tối thiểu trong renderer (giữ diff nhỏ — nhóm renderer merge cuối)
`harness` là field **additive** trên `agent_spawned`:
`protocol/events.ts` → `daemonV1Adapter.ts` (map `e.harness`) →
`sim/model.ts` + `sim/reducer.ts` (spawn + implicit) →
`AgentSprite.colorwayForAgent(model)`. Scenario mock cho Coder B `harness:"codex"`
để thấy robot skin live.

## Verify
- `npx tsc --noEmit` sạch; `npm test` (renderer) **49/49 pass**.
- Atlas JSON: 4 skin đều đủ 10 animation key; tileset 26 frame (9 frame mới).
- Chạy renderer thật (mock mode, port 5299): PM = vest exec, Coder B = robot,
  pill badge hiển thị đúng, error emote + banner "Cần can thiệp" hoạt động,
  120fps, **không lỗi console / không cảnh báo asset**.
- Fallback graceful giữ nguyên: skin lạ hoặc atlas lỗi → capsule Graphics.

## Ảnh so sánh — `docs/media/art-round2/`
`before-*` / `after-*` × {characters, ceo-corner, decor, overview}.

## Vùng file
`assets/**`, `docs/art-*`, `docs/media/art-round2/**`, và plumbing tối thiểu
trong `packages/{protocol,renderer}/src` (harness field + skin chọn). Không đụng
`layout.ts`/`OfficeView.ts` (multi-office & pm-chat sở hữu bố cục scene).

## Next
- Nhóm renderer: rebase 3 chip (deeplinks/multi-office/pm-chat) + art round 2
  lên main rồi merge theo thứ tự đã định, art merge trong nhóm renderer.
- Khi multi-office/pm-chat dựng phòng CEO: gọi frame `ceo_desk_E`, `chair_exec_E`,
  `neon_sign`, `plant_big`, `coffee_table` từ atlas (đã sẵn).
