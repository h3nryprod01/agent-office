"""Palette + isometric pixel-art drawing primitives (2:1, tile 64x32).

Shading rule (see docs/art-direction.md): top face lightest, left face base,
right face darkest; 1px outline two shades darker than base.
"""

from PIL import Image, ImageDraw

# Half-tile extents in px
HTW, HTH = 32, 16  # half tile width / height

PAL = {
    "bg_deep": (26, 28, 44, 255),
    "bg_soft": (38, 40, 61, 255),
    "wood_light": (200, 159, 118, 255),
    "wood_mid": (185, 138, 94, 255),
    "wood_dark": (138, 95, 61, 255),
    "carpet": (47, 111, 104, 255),
    "carpet_hi": (62, 197, 167, 255),
    "wall_top": (93, 97, 128, 255),
    "wall_base": (74, 78, 105, 255),
    "wall_dark": (58, 61, 85, 255),
    "oak": (156, 107, 68, 255),
    "oak_dark": (122, 82, 48, 255),
    "oak_deep": (92, 61, 36, 255),
    "coral": (226, 114, 91, 255),
    "coral_dark": (178, 84, 66, 255),
    "mustard": (255, 209, 102, 255),
    "screen": (155, 246, 255, 255),
    "screen_dim": (76, 201, 240, 255),
    "tech_dark": (34, 34, 59, 255),
    "plant": (88, 129, 87, 255),
    "plant_dark": (58, 90, 64, 255),
    "skin": (242, 198, 160, 255),
    "skin_dark": (217, 158, 120, 255),
    "white": (238, 238, 235, 255),
    "ok": (62, 197, 167, 255),
    "warn": (255, 209, 102, 255),
    "error": (255, 107, 107, 255),
}


def shade(color, factor):
    r, g, b, a = color
    return (int(r * factor), int(g * factor), int(b * factor), a)


def canvas(w, h):
    return Image.new("RGBA", (w, h), (0, 0, 0, 0))


def diamond(draw, bx, by, sx=1.0, sy=1.0, fill=None, outline=None):
    """Iso floor diamond. (bx, by) = bottom vertex; sx/sy = footprint in tiles."""
    pts = [
        (bx, by),
        (bx + sx * HTW, by - sx * HTH),
        (bx + sx * HTW - sy * HTW, by - sx * HTH - sy * HTH),
        (bx - sy * HTW, by - sy * HTH),
    ]
    draw.polygon(pts, fill=fill, outline=outline)
    return pts


def iso_box(draw, bx, by, sx, sy, h, base, lift=0):
    """Iso cuboid. (bx, by) = bottom vertex of footprint on the floor;
    sx/sy footprint in tiles; h = height px; lift = raise off floor (legs)."""
    top, left, right = shade(base, 1.18), base, shade(base, 0.72)
    out = shade(base, 0.45)
    b = (bx, by - lift)
    r = (bx + sx * HTW, b[1] - sx * HTH)
    l = (bx - sy * HTW, b[1] - sy * HTH)
    t = (bx + sx * HTW - sy * HTW, b[1] - sx * HTH - sy * HTH)
    up = lambda p: (p[0], p[1] - h)
    draw.polygon([l, b, up(b), up(l)], fill=left, outline=out)
    draw.polygon([b, r, up(r), up(b)], fill=right, outline=out)
    draw.polygon([up(b), up(r), up(t), up(l)], fill=top, outline=out)
    return {"b": up(b), "r": up(r), "l": up(l), "t": up(t)}


def leg(draw, x, y, h, color):
    """Thin furniture leg drawn as a 3px column from (x, y) upward."""
    draw.rectangle([x, y - h, x + 2, y], fill=shade(color, 0.6))
