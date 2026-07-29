# Asset Credits & Licenses

Mọi asset trong `assets/` phải có dòng tương ứng ở đây. Không commit asset
không rõ nguồn gốc/license.

| Asset | Nguồn | License | Ghi chú |
|---|---|---|---|
| `spritesheets/office-tileset.{png,json}` | Tự sinh bởi `assets/tools/generate_placeholders.py` (dự án này) | CC0 | Pixel-art isometric. Round 2 thêm: ceo_desk, chair_exec, coffee_table, plant_big, neon_sign (+ mirror), bookshelf nâng cấp. Round 3 (`gen_makeover.py`): tường có baseboard/crown, tường cửa sổ, chair_office, desk clutter (lamp/mug/papers), water_cooler, server_rack, wall_clock, poster, wall_board (bảng data trống — renderer vẽ nội dung live), rug_big (+ mirror NW/W) |
| `spritesheets/characters.{png,json}` | Tự sinh bởi `assets/tools/generate_placeholders.py` (dự án này) | CC0 | Round 2: 4 skin (coder-teal, coder-coral, exec-navy = PM/CEO, robot-steel = Codex) × 8 trạng thái + 4 emote. Round 3: thêm typing_W / error_W (ngồi hướng W, mirror của E) cho cả 4 skin |
| `spritesheets/kenney-library.{png,json}` | Repack từ Kenney Library Pack bởi `assets/tools/pack_kenney.py` | CC0 | Fallback style prerendered 3D |
| `third_party/kenney/isometric-miniature-library/` | [Kenney — Isometric Miniature Library](https://kenney.nl/assets/isometric-miniature-library) (Library Pack 2.1) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) | Bản gốc giữ nguyên, license text trong `License.txt` của pack |
| `preview/office-preview.png` | Render bởi `assets/tools/generate_placeholders.py` từ các asset trên | CC0 | Ảnh preview cho PR/docs |
| `../docs/media/art-round2/*.png` | Render bởi `assets/tools/preview_round2.py` (dự án này) | CC0 | Ảnh so sánh trước/sau round 2 (characters / ceo-corner / decor / overview) |
| `preview/makeover-preview.png` | Render bởi `assets/tools/preview_makeover.py` (dự án này) | CC0 | Scene verify asset round 3 (wi-office-makeover) |
| `../docs/media/makeover/asset-preview.png` | Copy của `preview/makeover-preview.png` cho status doc/PR | CC0 | Ảnh minh hoạ makeover (wi-office-makeover) |

Kenney assets không bắt buộc credit nhưng khuyến khích: **kenney.nl**.
