"""Generate all placeholder assets: office tileset, characters, emotes,
PixiJS atlases, manifest and a composed preview scene.

Usage:  python3 assets/tools/generate_placeholders.py
Output: assets/spritesheets/*.{png,json}, assets/manifest.json,
        assets/preview/office-preview.png
All output is deterministic — rerun after editing the gen_* modules.
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image
from iso import PAL, HTW, HTH
from atlaslib import write_atlas
from gen_tileset import build_tileset
from gen_makeover import build_makeover
from gen_characters import build_characters, build_emotes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHEETS = os.path.join(ROOT, "spritesheets")
PREVIEW = os.path.join(ROOT, "preview")

ROOM = 8  # preview room size in tiles


def tile_to_screen(u, v, ox, oy):
    return ox + (u - v) * HTW, oy + (u + v) * HTH


def compose_preview(tiles, chars, emotes):
    t = {name: (img, anchor) for name, img, anchor in tiles}
    c = {name: (img, anchor) for name, img, anchor in chars}
    e = {name: (img, anchor) for name, img, anchor in emotes}

    w, h = 620, 420
    ox, oy = w // 2, 90
    scene = Image.new("RGBA", (w, h), PAL["bg_deep"])

    def blit(key, u, v, src, dy=0):
        img, (ax, ay) = src[key]
        x, y = tile_to_screen(u, v, ox, oy)
        scene.alpha_composite(img, (int(x - ax), int(y - ay + dy)))

    # floor
    for u in range(ROOM):
        for v in range(ROOM):
            if 4 <= u <= 6 and 4 <= v <= 6:
                key = "floor_carpet"
            else:
                key = "floor_wood_a" if (u + v) % 2 == 0 else "floor_wood_b"
            blit(key, u + 1, v + 1, t)  # +1: bottom vertex of tile (u,v)

    # entities: (key, u, v, src[, dy[, z]]) — z overrides the u+v sort key
    # (wall-mounted decor, characters seated on furniture)
    ents = [
        ("wall_corner", 0.18, 0.18, t),
        *[("wall_NE", k + 1, 0.18, t) for k in range(ROOM)],
        *[("wall_NW", 0.18, k + 1, t) for k in range(ROOM)],
        ("neon_sign", 3.5, 0.3, t, 0, 8.5),
        ("whiteboard", 0.5, 1.6, t),
        ("bookshelf", 0.6, 3.2, t),
        ("bookshelf", 0.6, 4.3, t),
        ("plant", 0.7, 7.6, t),
        ("plant", 7.7, 0.8, t),
        ("plant_big", 7.6, 2.0, t),
        ("arcade", 6.5, 0.9, t),
        ("desk_E", 3.4, 1.6, t),
        ("coder-teal/typing_E_0", 2.9, 2.2, c),
        ("desk_E", 5.9, 1.6, t),
        ("coder-coral/error_E_0", 5.2, 2.1, c),
        ("emotes/error", 5.2, 2.1, e, -46),
        ("ceo_desk_E", 1.6, 5.9, t),
        ("chair_exec_E", 0.6, 6.4, t),
        ("exec-navy/typing_E_0", 0.6, 6.35, c, 0, 7.2),
        ("coffee_table", 4.8, 4.5, t),
        ("sofa", 6.4, 5.0, t),
        ("coder-teal/reading_S_0", 5.7, 5.4, c, -8),
        ("reception", 4.3, 7.2, t),
        ("plant", 2.5, 7.6, t),
        ("coder-coral/talking_S_0", 5.4, 7.0, c),
        ("emotes/chat", 5.4, 7.0, e, -46),
        ("coder-teal/blocked_S_0", 2.4, 4.6, c),
        ("emotes/exclaim", 2.4, 4.6, e, -46),
        ("robot-steel/walk_S_0", 6.6, 3.4, c),
    ]
    for ent in sorted(ents, key=lambda x: x[5] if len(x) > 5 else x[1] + x[2]):
        key, u, v, src = ent[:4]
        blit(key, u, v, src, dy=ent[4] if len(ent) > 4 else 0)

    scene = scene.resize((w * 2, h * 2), Image.NEAREST)
    os.makedirs(PREVIEW, exist_ok=True)
    scene.save(os.path.join(PREVIEW, "office-preview.png"), optimize=True)


def main():
    os.makedirs(SHEETS, exist_ok=True)

    tiles = build_tileset() + build_makeover()
    write_atlas(tiles, os.path.join(SHEETS, "office-tileset.png"),
                os.path.join(SHEETS, "office-tileset.json"))

    chars, anims = build_characters()
    emotes = build_emotes()
    write_atlas(chars + emotes, os.path.join(SHEETS, "characters.png"),
                os.path.join(SHEETS, "characters.json"), animations=anims)

    manifest = {
        "bundles": [{
            "name": "office",
            "assets": [
                {"alias": "office-tileset",
                 "src": "spritesheets/office-tileset.json"},
                {"alias": "characters", "src": "spritesheets/characters.json"},
            ],
        }, {
            "name": "office-kenney-fallback",
            "assets": [{"alias": "kenney-library",
                        "src": "spritesheets/kenney-library.json"}],
        }],
    }
    with open(os.path.join(ROOT, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=1)

    compose_preview(tiles, chars, emotes)
    print("tileset frames:", len(tiles))
    print("character frames:", len(chars), "| emotes:", len(emotes))
    print("animations:", len(anims))


if __name__ == "__main__":
    main()
