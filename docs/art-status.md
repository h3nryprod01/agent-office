# Art Status — Agent Office

_File status riêng của Art Director session. PM session không cần sửa file này;
Art Director chỉ append vào đây, không đụng activeContext.md._

---

## [2026-07-04] Initial assets — branch `art/initial-assets`

**Đã xong:**

- `docs/art-direction.md` — chốt pixel-art isometric 2:1, tile 64×32, nhân vật 32×48, palette 24 màu nền đậm/nội thất ấm, contract 8 trạng thái animation.
- `assets/spritesheets/office-tileset.{png,json}` — 18 sprite: sàn gỗ ×2 + thảm, tường NE/NW/góc, bàn làm việc E/W, ghế 4 hướng, kệ sách, arcade, sofa, whiteboard, lễ tân, cây.
- `assets/spritesheets/characters.{png,json}` — 2 nhân vật (`coder-teal`, `coder-coral`) × đủ trạng thái: idle, walk N/E/S/W, typing, reading, blocked, error, talking (54 frames, 20 animation keys) + 4 emote (❗💬✕💤). Anchor chân nhúng per-frame, PixiJS đọc trực tiếp.
- `assets/spritesheets/kenney-library.{png,json}` — 44 frames repack từ Kenney Library Pack (CC0), fallback style prerendered 3D.
- `assets/manifest.json` — PixiJS Assets bundles (`office`, `office-kenney-fallback`).
- `assets/tools/*.py` — generator deterministic (Pillow), sửa script → chạy lại là ra asset mới.
- `assets/CREDITS.md` — license đầy đủ (toàn bộ CC0).
- `assets/preview/office-preview.png` — scene demo 8×8 đủ nội thất + 6 nhân vật ở các trạng thái.

**Còn thiếu (phase sau):**

- Walk animation mới có 1 kiểu chân 4-frame cơ bản; chưa có transition/tween frames.
- Chưa có: cửa ra vào, cửa sổ, đèn, tủ lạnh/pantry, bàn họp lớn, decal sàn.
- Typing/error mới có hướng E (mirror W dùng được, N/S chưa có).
- Nhân vật phân biệt bằng colorway; chưa có phụ kiện theo role (kính PM, tai nghe...).
- Palette swap runtime (shader/tint) để sinh vô hạn colorway — hiện phải thêm vào script.
- Asset độ phân giải cao hơn (tile 128×64) nếu sau này cần zoom cận.
