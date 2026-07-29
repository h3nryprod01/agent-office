"""Repack a curated office-relevant subset of Kenney's Library Pack (CC0)
into a PixiJS atlas: assets/spritesheets/kenney-library.{png,json}.

Originals stay untouched in assets/third_party/kenney/. These sprites are
prerendered 3D miniatures (256x512) — a style FALLBACK, do not mix with the
pixel-art tileset in one scene (docs/art-direction.md §6).

Usage: python3 assets/tools/pack_kenney.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from PIL import Image
from atlaslib import write_atlas

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "third_party", "kenney",
                   "isometric-miniature-library", "Isometric")
SHEETS = os.path.join(ROOT, "spritesheets")

# Office-usable subset: desk combo, tables, chair, shelves, carpet, walls
ITEMS = [
    "bookcaseWideBooksDesk",  # closest thing to a workstation desk
    "bookcaseBooks",
    "bookcaseHalfBooks",
    "libraryChair",
    "longTable",
    "longTableChairs",
    "bookStand",
    "displayCaseBooks",
    "floorCarpet",
    "floorCarpetSmall",
    "wallDoorway",
]
DIRS = ["N", "E", "S", "W"]

# Kenney miniature convention: footprint bottom vertex sits at the horizontal
# center; empirically ~72px above the canvas bottom (tile 256x128 + skirt).
ANCHOR_Y_FROM_BOTTOM = 72


def main():
    frames = []
    for item in ITEMS:
        for d in DIRS:
            path = os.path.join(SRC, f"{item}_{d}.png")
            img = Image.open(path).convert("RGBA")
            anchor = (img.width // 2, img.height - ANCHOR_Y_FROM_BOTTOM)
            frames.append((f"kenney/{item}_{d}", img, anchor))
    write_atlas(frames, os.path.join(SHEETS, "kenney-library.png"),
                os.path.join(SHEETS, "kenney-library.json"), max_width=2048)
    print(f"packed {len(frames)} frames from {len(ITEMS)} items")


if __name__ == "__main__":
    main()
