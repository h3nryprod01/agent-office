# Art Direction — Agent Office

_Art Director session, 2026-07-04. Nguồn chân lý về visual style, kích thước, và pipeline asset._

## 1. Phong cách đã chọn: Pixel-art isometric

**Quyết định: pixel-art isometric 2:1** (kiểu Habbo Hotel / Stardew-ish, không phải prerendered 3D miniature).

Lý do:

- **Sản xuất được bằng tool/AI**: pixel art là style dễ generate/sửa nhất bằng script (Pillow/canvas), AI pixel-art generators, và Aseprite. Một người không phải họa sĩ vẫn iterate được.
- **Render nét trong PixiJS**: `scaleMode: 'nearest'` + kích thước integer → crisp ở mọi zoom level 1×/2×/3×, không blur.
- **Nhẹ**: cả bộ tileset + 2 nhân vật đầy đủ animation < 200KB PNG. Prerendered 3D (kiểu Kenney miniature 256×512/sprite) nặng hơn ~20×.
- **Dễ giữ coherence**: palette cố định (xem §3) áp cho mọi asset — asset từ nguồn khác nhau vẫn nhìn đồng bộ sau khi map palette.

Tradeoff đã cân nhắc:

| Hướng | Ưu | Nhược | Kết luận |
|---|---|---|---|
| **Pixel-art isometric** (chọn) | Sản xuất nhanh, nhẹ, crisp, dễ animate frame-by-frame | Kém "sang" hơn 3D-render; cần kỷ luật palette | ✅ |
| Prerendered 3D miniature (kiểu Kenney Library Pack, Teamflow) | Đẹp, có sẵn pack CC0 | Nhân vật custom + animation 8 trạng thái × 4 hướng gần như bất khả thi nếu không có pipeline Blender; asset nặng | Giữ làm **fallback props** (đã tải, xem §6) |
| Vector/flat 2D (kiểu Slack huddle) | Dễ vẽ SVG | Mất chất "văn phòng game" của Gather.town; isometric depth-sort phức tạp hơn với vector scale | ❌ |

> Nếu phase sau có budget art thật, có thể nâng cấp sang HD pixel art (tile 128×64) mà không đổi grid logic — mọi tọa độ tính theo tile, không theo px.

## 2. Grid & kích thước

| Thông số | Giá trị | Ghi chú |
|---|---|---|
| Tỉ lệ isometric | **2:1** (dimetric) | Chuẩn của Habbo/Gather-style, math đơn giản |
| Tile sàn | **64×32 px** (diamond) | 1 tile = 1 ô logic trong office map |
| Chiều cao tường | 96 px (3 "tầng" 32px) | Tường chỉ vẽ 2 cạnh sau (N, W) để không che nhân vật |
| Nhân vật | **32×48 px** / frame | Chibi ~1.5 tile cao, đầu to (~40% chiều cao), đứng gọn trong 1 tile |
| Nội thất 1 ô (ghế, kệ) | 64×~96 px | Anchor tại đáy diamond |
| Nội thất 2 ô (bàn, sofa, reception) | 128×~96 px | Chiếm 2×1 tile, anchor tại đáy tile gốc |
| Emote overlay (❗💬❌💤) | 16×16 px | Vẽ phía trên đầu nhân vật |

**Công thức world → screen** (renderer dùng thống nhất):

```
screenX = (tileX - tileY) * 32          // nửa bề rộng tile
screenY = (tileX + tileY) * 16          // nửa bề cao tile
zIndex  = tileX + tileY                  // depth-sort đơn giản
```

Anchor mọi sprite đặt tại **chân** (bottom-center của footprint diamond) — atlas JSON đã nhúng sẵn `anchor` per-frame, PixiJS `Spritesheet` tự đọc.

## 3. Palette

Nền màu đậm + nội thất ấm (theo brief Gather/Teamflow). Palette chủ đạo 24 màu, gốc từ không gian ấm:

| Nhóm | Màu | Hex |
|---|---|---|
| Nền / khoảng tối | deep navy | `#1a1c2c`, `#26283d` |
| Sàn gỗ | warm wood | `#c89f76`, `#b98a5e`, `#8a5f3d` |
| Thảm | teal đậm | `#2f6f68`, `#3ec5a7` |
| Tường | warm gray | `#4a4e69`, `#5d6180`, `#3a3d55` |
| Gỗ nội thất | oak/walnut | `#9c6b44`, `#7a5230`, `#5c3d24` |
| Vải sofa/ghế | coral / mustard | `#e2725b`, `#ffd166` |
| Màn hình / tech | screen glow | `#9bf6ff`, `#4cc9f0`, `#22223b` |
| Cây xanh | plant | `#588157`, `#3a5a40` |
| Da nhân vật | skin | `#f2c6a0`, `#d99e78` |
| Accent trạng thái | ok/warn/error | `#3ec5a7` / `#ffd166` / `#ff6b6b` |

Quy tắc shading pixel-art: mặt **top sáng nhất**, mặt **trái = base**, mặt **phải tối** (light từ trên-trái); outline 1px màu tối hơn base 2 nấc, không outline đen tuyệt đối.

## 4. Nhân vật & trạng thái animation

Mỗi nhân vật (agent) cần đủ bộ trạng thái sau — đây là contract với `docs/semantic-mapping.md` (trạng thái agent → animation):

| Trạng thái | Frames | Hướng | Mô tả |
|---|---|---|---|
| `idle` | 2 @ 1.2s | S | Đứng thở nhẹ (bob 1px) |
| `walk` | 4 @ 0.15s/frame | **N, E, S, W** | Đi giữa các vị trí trong office |
| `typing` | 2 @ 0.25s | E (ngồi bàn) | Gõ phím — tool call / đang code |
| `reading` | 2 @ 0.6s | S | Cầm tài liệu — đọc file/context |
| `blocked` | 2 @ 0.5s | S | Giơ tay ❗ — chờ permission/input |
| `error` | 1 | E (ngồi bàn) | Gục đầu xuống bàn — tool error/crash |
| `talking` | 2 @ 0.3s | S | Nói chuyện 💬 — agent teamwork/output |

Naming convention frame trong atlas: `{charId}/{state}_{dir}_{frameIdx}`, ví dụ `coder-teal/walk_E_2`. Key animation trong atlas `animations`: `{charId}/{state}_{dir}` (state không phân hướng dùng hướng mặc định ở bảng trên).

Emote overlays tách riêng (`emotes/*`): `exclaim` ❗, `chat` 💬, `error` ✕, `zzz` 💤 — renderer ghép, không bake vào frame nhân vật (trừ error đã có tư thế riêng).

Phân biệt nhân vật theo **màu áo + tóc** (mỗi agent role 1 colorway): v0 có `coder-teal` và `coder-coral`. Thêm role mới = thêm colorway trong script generator, không cần vẽ lại.

**Round 2 — skin theo vai + harness** (`gen_characters.py > COLORWAYS`):

| Colorway | Ai | Đặc điểm | Renderer chọn khi |
|---|---|---|---|
| `coder-teal`, `coder-coral` | Coder thường (Claude) | Áo teal/coral, tóc thường | mặc định, hash theo `agentId` |
| `exec-navy` | PM / CEO / orchestrator | Vest navy, áo trắng + cà vạt coral, tóc bạc | `role` khớp `pm/planner/orchestrator/coordinator/ceo/manager` |
| `robot-steel` | Codex agent | Vỏ thép, visor cyan thay mắt, ăng-ten đèn báo | `harness === "codex"` (field event) |

Skin mới dùng chung khung `_standing`/`_seated` nên tự có đủ 8 trạng thái × hướng như bảng §4 — không vẽ tay từng frame. `robot-steel` override `skin`/`skin_dark` = màu kim loại; `exec-navy` thêm key `tie`. Field `harness` là additive trên `agent_spawned` (protocol v0), reducer/model truyền qua, `AgentSprite.colorwayForAgent(model)` quyết định skin. Fallback graceful giữ nguyên: skin lạ / atlas lỗi → capsule Graphics.

## 5. Tilemap văn phòng — danh sách asset

Đã ship trong `assets/spritesheets/office-tileset.{png,json}`:

- Sàn: gỗ (2 biến thể checker), thảm teal
- Tường: cạnh N, cạnh W, góc NW
- Bàn làm việc + màn hình (facing E, W)
- Ghế văn phòng (4 hướng)
- Kệ sách
- Máy arcade
- Sofa (2 ô)
- Whiteboard (treo tường N)
- Bàn lễ tân (2 ô)
- Cây cảnh (deco)

**Round 2 — cụm CEO + decor** (chip pm-chat đặt nhân vật PM ở góc; multi-office nạp qua manifest, không hardcode):

- `ceo_desk_E`/`_W` — bàn giám đốc 2 ô: walnut slab trên side panel + đèn bàn đồng
- `chair_exec_E`/`_W` — ghế da lưng cao
- `coffee_table` — bàn trà thấp 1 ô, ghép với sofa
- `plant_big` — cây cảnh sàn cao (chậu to + tán lá nhiều lớp)
- `neon_sign` (+ `neon_sign_NW` mirror) — decor treo tường: panel gạch + neon sét cyan + vòng coral
- `bookshelf` nâng cấp — sách cao thấp + khoảng trống + top trim + chậu nhỏ trên nóc

## 6. Nguồn asset & pipeline

1. **Tự sinh (CC0, của dự án)** — `assets/tools/generate_placeholders.py` (Pillow) sinh toàn bộ tileset + nhân vật + emotes → spritesheet PNG + atlas JSON chuẩn PixiJS. Sửa asset = sửa script, chạy lại, commit. Deterministic.
2. **Kenney Library Pack (CC0)** — `assets/third_party/kenney/isometric-miniature-library/` giữ nguyên bản; subset hữu ích cho văn phòng được đóng gói lại thành `assets/spritesheets/kenney-library.{png,json}` làm **fallback/so sánh style** (prerendered miniature). Không trộn 2 style trong cùng 1 scene.
3. Mọi nguồn ghi tại `assets/CREDITS.md`. **Không** commit asset không rõ license.

Renderer nạp qua `assets/manifest.json` (PixiJS Assets bundle).
