"""Shelf-pack sprites into a texture atlas + PixiJS Spritesheet JSON.

Frames are (name, PIL.Image, anchor) tuples; anchor is (ax, ay) in pixels
within the sprite canvas (e.g. feet / bottom vertex of the iso footprint).
PixiJS reads the per-frame "anchor" field natively.
"""

import json
from PIL import Image

PADDING = 2


def pack_atlas(frames, max_width=1024):
    """frames: list of (name, image, (anchor_x_px, anchor_y_px)).
    Returns (sheet_image, frames_json_dict)."""
    ordered = sorted(frames, key=lambda f: -f[1].height)
    shelves = []  # (shelf_y, shelf_h, cursor_x)
    placements = {}
    sheet_w, sheet_h = 0, 0

    for name, img, anchor in ordered:
        w, h = img.width + PADDING, img.height + PADDING
        spot = None
        for i, (sy, sh, cx) in enumerate(shelves):
            if h <= sh and cx + w <= max_width:
                spot = (i, cx, sy)
                break
        if spot is None:
            sy = sheet_h
            shelves.append([sy, h, 0])
            spot = (len(shelves) - 1, 0, sy)
            sheet_h += h
        i, x, y = spot
        shelves[i][2] = x + w
        placements[name] = (x, y, img, anchor)
        sheet_w = max(sheet_w, x + w)

    sheet = Image.new("RGBA", (sheet_w, sheet_h), (0, 0, 0, 0))
    frames_json = {}
    for name, (x, y, img, anchor) in placements.items():
        sheet.paste(img, (x, y))
        frames_json[name] = {
            "frame": {"x": x, "y": y, "w": img.width, "h": img.height},
            "rotated": False,
            "trimmed": False,
            "spriteSourceSize": {"x": 0, "y": 0, "w": img.width, "h": img.height},
            "sourceSize": {"w": img.width, "h": img.height},
            "anchor": {
                "x": round(anchor[0] / img.width, 4),
                "y": round(anchor[1] / img.height, 4),
            },
        }
    return sheet, frames_json


def write_atlas(frames, out_png, out_json, animations=None, scale=1, max_width=1024):
    sheet, frames_json = pack_atlas(frames, max_width=max_width)
    sheet.save(out_png, optimize=True)
    data = {
        "frames": frames_json,
        "meta": {
            "app": "agent-office/assets/tools",
            "image": out_png.split("/")[-1],
            "format": "RGBA8888",
            "size": {"w": sheet.width, "h": sheet.height},
            "scale": str(scale),
        },
    }
    if animations:
        data["animations"] = animations
    with open(out_json, "w") as f:
        json.dump(data, f, indent=1, sort_keys=True)
    return sheet
