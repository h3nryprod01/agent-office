# assets/

Asset pipeline cho renderer PixiJS. Style & grid: xem [docs/art-direction.md](../docs/art-direction.md).

## Cấu trúc

```
assets/
├── manifest.json          # PixiJS Assets bundle — renderer nạp file này
├── spritesheets/          # atlas PNG + JSON (format PixiJS Spritesheet)
│   ├── office-tileset.*   # sàn/tường/nội thất pixel-art (primary style)
│   ├── characters.*       # 2 nhân vật × 8 trạng thái + emotes, có "animations"
│   └── kenney-library.*   # fallback prerendered 3D (không trộn với pixel-art)
├── tools/                 # generator scripts (Python 3 + Pillow)
├── third_party/           # pack gốc tải về, giữ nguyên (license đi kèm)
├── preview/               # ảnh preview render sẵn
└── CREDITS.md             # nguồn gốc + license của MỌI asset
```

## Nạp trong PixiJS

```js
import { Assets, AnimatedSprite } from "pixi.js";

await Assets.init({ manifest: "assets/manifest.json", basePath: "assets" });
const { characters } = await Assets.loadBundle("office");

// frame tĩnh: sheet.textures["desk_E"] — anchor chân đã nhúng sẵn per-frame
// animation:  key dạng "{char}/{state}_{dir}" (docs/art-direction.md §4)
const sprite = new AnimatedSprite(characters.animations["coder-teal/walk_E"]);
sprite.animationSpeed = 0.11;
sprite.play();
```

Lưu ý: đặt `TextureStyle.defaultOptions.scaleMode = "nearest"` (Pixi v8) để
pixel art nét khi zoom.

## Tái sinh asset

```bash
python3 assets/tools/generate_placeholders.py   # tileset + characters + preview
python3 assets/tools/pack_kenney.py             # repack Kenney fallback atlas
```

Output deterministic — sửa `gen_*.py` rồi chạy lại, không sửa PNG bằng tay.
Thêm agent role mới = thêm colorway vào `COLORWAYS` trong `gen_characters.py`.
