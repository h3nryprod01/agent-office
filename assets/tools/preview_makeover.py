"""Render the round-3 makeover verification scene (wi-office-makeover).

Usage:  python3 assets/tools/preview_makeover.py
Output: assets/preview/makeover-preview.png

Puts every NEW sprite in one room next to the props it must pair with
(desk + office chair + seated typing agent, wall boards on both walls,
window walls, clutter on a desk top) so misaligned anchors show up
immediately. Deterministic like the main generator.
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image
from iso import PAL, HTW, HTH
from gen_tileset import build_tileset
from gen_makeover import build_makeover
from gen_characters import build_characters

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOM = 8


def main():
    tiles = {n: (img, a) for n, img, a in build_tileset() + build_makeover()}
    chars = {n: (img, a) for n, img, a in build_characters()[0]}

    w, h = 680, 460
    ox, oy = w // 2, 110
    scene = Image.new("RGBA", (w, h), PAL["bg_deep"])

    def blit(key, u, v, src, dy=0):
        img, (ax, ay) = src[key]
        x = ox + (u - v) * HTW
        y = oy + (u + v) * HTH
        scene.alpha_composite(img, (int(x - ax), int(y - ay + dy)))

    for u in range(ROOM):
        for v in range(ROOM):
            blit("floor_wood_a" if (u + v) % 2 == 0 else "floor_wood_b",
                 u + 1, v + 1, tiles)

    # (key, u, v, src[, dy[, z]]) — z overrides the u+v sort key
    ents = [
        ("rug_big", 5.6, 5.6, tiles, 0, 0.1),
        ("wall_corner", 0.18, 0.18, tiles),
        *[("wall_NE" if k not in (1, 2) else "wall_NE_win", k + 1, 0.18, tiles)
          for k in range(ROOM)],
        *[("wall_NW" if k != 1 else "wall_NW_win", 0.18, k + 1, tiles)
          for k in range(ROOM)],
        ("wall_board_NE", 5.5, 0.2, tiles, 0, 8.9),
        ("wall_clock_NE", 6.6, 0.22, tiles, 0, 9.0),
        ("poster_NE", 7.8, 0.25, tiles, 0, 9.05),
        ("wall_board_NW", 0.2, 5.5, tiles, 0, 9.1),
        ("poster_NW", 0.25, 6.6, tiles, 0, 9.15),
        ("server_rack", 7.6, 1.1, tiles),
        ("water_cooler", 0.7, 7.4, tiles),
        # E-facing desk cluster: desk + swivel chair + seated agent + clutter
        ("desk_E", 3.4, 1.6, tiles),
        ("chair_office_E", 2.85, 2.25, tiles, 0, 5.1),
        ("coder-teal/typing_E_0", 2.85, 2.25, chars, -7, 5.15),
        ("clutter_mug", 3.2, 1.45, tiles, -25, 5.2),
        ("clutter_papers", 2.95, 1.6, tiles, -25, 5.21),
        ("clutter_lamp", 3.6, 1.2, tiles, -26, 5.22),
        # W-facing mirror cluster
        ("desk_W", 4.6, 4.4, tiles),
        ("chair_office_W", 5.15, 3.75, tiles, 0, 9.2),
        ("robot-steel/typing_W_0", 5.15, 3.75, chars, -7, 9.25),
        # error W on the second E desk row for contrast
        ("desk_E", 6.4, 1.6, tiles),
        ("coder-coral/error_E_0", 5.7, 2.1, chars),
        ("plant_big", 7.6, 7.4, tiles),
    ]
    for ent in sorted(ents, key=lambda x: x[5] if len(x) > 5 else x[1] + x[2]):
        key, u, v, src = ent[:4]
        blit(key, u, v, src, dy=ent[4] if len(ent) > 4 else 0)

    scene = scene.resize((w * 2, h * 2), Image.NEAREST)
    out = os.path.join(ROOT, "preview")
    os.makedirs(out, exist_ok=True)
    path = os.path.join(out, "makeover-preview.png")
    scene.save(path, optimize=True)
    print("wrote", path)


if __name__ == "__main__":
    main()
