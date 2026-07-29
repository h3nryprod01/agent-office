"""Render art-round2 cluster previews (characters / CEO corner / decor).

Usage:  python3 assets/tools/preview_round2.py <prefix>
        prefix = "before" | "after" — filename prefix in docs/media/art-round2/

Tolerant by design: frames that don't exist yet are skipped, so the same
script renders the "before" images from round-1 assets and the "after"
images once round-2 sprites land. Deterministic like the main generator.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image
from iso import PAL, HTW, HTH
from gen_tileset import build_tileset
from gen_characters import build_characters

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUT = os.path.join(REPO, "docs", "media", "art-round2")

CHAR_STATES = ["idle_S_0", "walk_E_0", "typing_E_0", "reading_S_0",
               "blocked_S_0", "error_E_0", "talking_S_0"]


def _save(img, prefix, name, scale=2):
    os.makedirs(OUT, exist_ok=True)
    img = img.resize((img.width * scale, img.height * scale), Image.NEAREST)
    path = os.path.join(OUT, f"{prefix}-{name}.png")
    img.save(path, optimize=True)
    print("wrote", path)


def characters_lineup(frames, prefix):
    """One row per colorway, one column per key state."""
    by_name = {n: (img, a) for n, img, a in frames}
    chars = sorted({n.split("/")[0] for n in by_name if "/" in n and not n.startswith("emotes")})
    cell_w, cell_h = 44, 56
    img = Image.new("RGBA", (cell_w * len(CHAR_STATES) + 16, cell_h * len(chars) + 16), PAL["bg_deep"])
    for row, char in enumerate(chars):
        for col, state in enumerate(CHAR_STATES):
            entry = by_name.get(f"{char}/{state}")
            if not entry:
                continue
            spr, (ax, ay) = entry
            x = 8 + col * cell_w + (cell_w - 32) // 2 + 16 - ax
            y = 8 + row * cell_h + cell_h - 8 - ay
            img.alpha_composite(spr, (x, y))
    _save(img, prefix, "characters", scale=3)


def _scene(tiles, chars, ents, w, h, oy):
    """Compose a mini iso scene. ents = (key, u, v[, z]) drawn depth-sorted
    by u+v; optional 4th element overrides the sort key (wall decor, sitters)."""
    t = {n: (img, a) for n, img, a in tiles}
    c = {n: (img, a) for n, img, a in chars}
    scene = Image.new("RGBA", (w, h), PAL["bg_deep"])
    ox = w // 2
    for u in range(4):
        for v in range(4):
            key = "floor_wood_a" if (u + v) % 2 == 0 else "floor_wood_b"
            img, (ax, ay) = t[key]
            x = ox + (u + 1 - (v + 1)) * HTW
            y = oy + (u + 1 + v + 1) * HTH
            scene.alpha_composite(img, (x - ax, y - ay))
    for ent in sorted(ents, key=lambda e: e[3] if len(e) > 3 else e[1] + e[2]):
        key, u, v = ent[:3]
        src = t.get(key) or c.get(key)
        if not src:
            print("  (skip missing frame:", key + ")")
            continue
        img, (ax, ay) = src
        x = ox + int((u - v) * HTW)
        y = oy + int((u + v) * HTH)
        scene.alpha_composite(img, (x - ax, y - ay))
    return scene


def ceo_corner(tiles, chars, prefix):
    ents = [
        ("wall_corner", 0.18, 0.18),
        ("wall_NE", 1, 0.18), ("wall_NE", 2, 0.18), ("wall_NE", 3, 0.18),
        ("wall_NW", 0.18, 1), ("wall_NW", 0.18, 2), ("wall_NW", 0.18, 3),
        ("neon_sign", 2.6, 0.24, 3.5),
        ("plant_big", 0.7, 0.9),
        ("ceo_desk_E", 2.6, 1.7),
        ("chair_exec_E", 1.6, 2.2),
        ("exec-navy/typing_E_0", 1.6, 2.15, 3.9),
        ("plant", 0.7, 3.4),
    ]
    _save(_scene(tiles, chars, ents, 400, 235, 50), prefix, "ceo-corner")


def decor(tiles, chars, prefix):
    ents = [
        ("wall_corner", 0.18, 0.18),
        ("wall_NE", 1, 0.18), ("wall_NE", 2, 0.18), ("wall_NE", 3, 0.18),
        ("wall_NW", 0.18, 1), ("wall_NW", 0.18, 2), ("wall_NW", 0.18, 3),
        ("neon_sign", 1.8, 0.24, 3.5),
        ("bookshelf", 0.5, 1.2),
        ("bookshelf", 0.5, 2.3),
        ("sofa", 3.2, 1.6),
        ("coffee_table", 2.4, 2.6),
        ("plant_big", 3.6, 0.8),
        ("whiteboard", 0.5, 3.4),
    ]
    _save(_scene(tiles, chars, ents, 420, 245, 50), prefix, "decor")


def main():
    prefix = sys.argv[1] if len(sys.argv) > 1 else "after"
    tiles = build_tileset()
    chars, _ = build_characters()
    characters_lineup(chars, prefix)
    ceo_corner(tiles, chars, prefix)
    decor(tiles, chars, prefix)


if __name__ == "__main__":
    main()
