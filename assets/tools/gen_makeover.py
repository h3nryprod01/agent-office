"""Office makeover sprites (round 3, wi-office-makeover).

New props for the room-shell + seat-system integration: window walls,
swivel office chair, desk clutter, water cooler, server rack, wall clock,
poster, empty wall data-board (renderer draws Scrum/Velocity content onto
it), and a big 2x2 rug. Same conventions as gen_tileset: builders return
(name, image, anchor_px), anchor at the bottom vertex of the footprint.

Wall-mounted pieces follow the NE-wall face slope +1/2 in image coords
(floor line descends left->right; see wall() in gen_tileset). NW variants
are mirrors, matching the wall_NE/wall_NW pair.
"""

from PIL import ImageDraw
from iso import PAL, shade, leg, iso_box, diamond
from gen_tileset import _sprite, off, wall


def _wall_fy(bx, by):
    """Floor line of a NE wall face through anchor (bx, by), slope +1/2."""
    return lambda x: by + (x - bx) // 2


def wall_window():
    """NE wall slab with a night window: warm office inside, dark sky out."""
    _, img, a = wall("wall_NE_win", along_u=True)
    d = ImageDraw.Draw(img)
    bx, by = a
    fy = _wall_fy(bx, by)
    x0, x1 = bx - 27, bx - 5
    lo, hi = 34, 76  # window bottom/top height above the floor line

    def band(xa, xb, ya, yb, c):
        d.polygon([(xa, fy(xa) - yb), (xb, fy(xb) - yb),
                   (xb, fy(xb) - ya), (xa, fy(xa) - ya)], fill=c)

    band(x0, x1, lo, hi, PAL["oak_deep"])                    # frame
    band(x0 + 2, x1 - 2, lo + 2, hi - 2, PAL["bg_deep"])     # night glass
    band(x0 + 2, x1 - 2, lo + 2, lo + 8, (52, 56, 88, 255))  # city haze
    mid = (x0 + x1) // 2                                     # mullions
    band(mid, mid + 1, lo + 2, hi - 2, PAL["oak_deep"])
    band(x0 + 2, x1 - 2, (lo + hi) // 2, (lo + hi) // 2 + 1, PAL["oak_deep"])
    for px, py in [(x0 + 5, hi - 8), (x1 - 6, hi - 12), (mid - 3, hi - 6),
                   (mid + 4, hi - 16)]:                      # stars
        d.point((px, fy(px) - py), fill=PAL["white"])
    for i, px in enumerate(range(x0 + 4, x1 - 3, 4)):        # city lights
        d.point((px, fy(px) - lo - 4 - i % 3), fill=PAL["mustard"])
    return "wall_NE_win", img, a


def chair_office(kind):
    """Swivel task chair, teal pad; kind E pairs with desk_E (mirror for W)."""
    img, d, a = _sprite(52, 62, 26, 60)
    bx, by = a
    for du, dv in [(0.08, 0.35), (0.62, 0.35), (0.35, 0.08), (0.35, 0.62)]:
        x, y = off(bx, by, du, dv)                           # star feet
        leg(d, x - 1, y, 3, PAL["tech_dark"])
    x, y = off(bx, by, 0.35, 0.35)
    leg(d, x - 1, y - 2, 10, PAL["tech_dark"])               # gas column
    iso_box(d, bx, by, 0.7, 0.7, 5, PAL["tech_dark"], lift=12)   # seat
    iso_box(d, bx, by, 0.7, 0.7, 2, PAL["carpet"], lift=17)      # cushion
    x, y = off(bx, by, 0, 0.55)                              # backrest
    iso_box(d, x, y, 0.7, 0.15, 26, PAL["tech_dark"], lift=12)
    x, y = off(bx, by, 0, 0.55)
    iso_box(d, x, y, 0.7, 0.15, 4, PAL["carpet"], lift=34)   # lumbar pad
    return "chair_office_E", img, a


def clutter_lamp():
    """Small desk lamp; renderer offsets it onto a desk top."""
    img, d, a = _sprite(18, 26, 9, 25)
    bx, by = a
    d.rectangle([bx - 4, by - 2, bx + 4, by], fill=PAL["tech_dark"])   # base
    d.rectangle([bx - 1, by - 14, bx, by - 2], fill=PAL["tech_dark"])  # arm
    d.rectangle([bx - 7, by - 18, bx + 2, by - 13], fill=PAL["mustard"])  # head
    d.rectangle([bx - 6, by - 13, bx + 1, by - 12], fill=PAL["warn"])  # glow
    return "clutter_lamp", img, a


def clutter_mug():
    img, d, a = _sprite(12, 12, 6, 11)
    bx, by = a
    d.rectangle([bx - 3, by - 7, bx + 2, by], fill=PAL["coral"])
    d.rectangle([bx - 3, by - 7, bx + 2, by - 6], fill=PAL["coral_dark"])
    d.rectangle([bx + 3, by - 5, bx + 4, by - 2], fill=PAL["coral_dark"])  # handle
    return "clutter_mug", img, a


def clutter_papers():
    img, d, a = _sprite(22, 14, 11, 13)
    bx, by = a
    for i, c in enumerate((PAL["white"], (210, 210, 205, 255))):
        d.polygon([(bx - 8 + i, by - 3 - i * 2), (bx + 2 + i, by - 8 - i * 2),
                   (bx + 8 + i, by - 5 - i * 2), (bx - 2 + i, by - i * 2)],
                  fill=c)
    d.line([(bx - 3, by - 4), (bx + 3, by - 7)], fill=PAL["screen_dim"])
    return "clutter_papers", img, a


def water_cooler():
    img, d, a = _sprite(40, 74, 20, 72)
    bx, by = a
    iso_box(d, bx, by, 0.42, 0.42, 32, PAL["white"])              # cabinet
    d.rectangle([bx - 6, by - 26, bx - 4, by - 22], fill=PAL["screen_dim"])  # tap
    d.rectangle([bx - 2, by - 26, bx, by - 22], fill=PAL["coral"])
    # bottle: rounded jug of dim-cyan water with a highlight
    t = by - 36
    d.rectangle([bx - 7, t - 16, bx + 6, t + 2], fill=PAL["screen_dim"])
    d.ellipse([bx - 7, t - 21, bx + 6, t - 11], fill=PAL["screen_dim"])
    d.rectangle([bx - 5, t - 17, bx - 3, t - 8], fill=PAL["screen"])   # shine
    d.rectangle([bx - 3, t + 2, bx + 2, t + 5], fill=shade(PAL["white"], 0.85))
    d.rectangle([bx - 7, t + 1, bx + 6, t + 2], fill=shade(PAL["screen_dim"], 0.7))
    return "water_cooler", img, a


def server_rack():
    img, d, a = _sprite(52, 106, 22, 104)
    bx, by = a
    iso_box(d, bx, by, 0.55, 0.9, 78, PAL["tech_dark"])
    # unit rows with LEDs on the wide left face (slope -1/2 toward b)
    for row in range(6):
        y0 = by - 14 - row * 11
        d.line([(bx - 26, y0 - 13), (bx - 2, y0)], fill=(20, 20, 32, 255),
               width=2)
        for i, c in enumerate(("ok", "ok", "warn", "ok")):
            x = bx - 22 + i * 5
            d.point((x, y0 - 10 + (x - (bx - 26)) // 2 - 2),
                    fill=PAL[c] if (row + i) % 4 else PAL["error"])
    d.rectangle([bx - 24, by - 88, bx - 4, by - 86], fill=PAL["screen_dim"])
    return "server_rack", img, a


def wall_clock():
    """Round office clock mounted high on a NE wall tile."""
    img, d, a = _sprite(26, 88, 13, 86)
    bx, by = a
    cy = by - 68
    d.ellipse([bx - 8, cy - 8, bx + 8, cy + 8], fill=PAL["oak_dark"])
    d.ellipse([bx - 6, cy - 6, bx + 6, cy + 6], fill=PAL["white"])
    d.line([(bx, cy), (bx, cy - 4)], fill=PAL["tech_dark"])   # hour
    d.line([(bx, cy), (bx + 3, cy + 1)], fill=PAL["coral"])   # minute
    return "wall_clock_NE", img, a


def poster():
    """Framed motivational poster on a NE wall tile: pixel rocket at night."""
    img, d, a = _sprite(34, 96, 30, 94)
    bx, by = a
    fy = _wall_fy(bx, by)
    x0, x1 = bx - 26, bx - 6
    lo, hi = 38, 70

    def band(xa, xb, ya, yb, c):
        d.polygon([(xa, fy(xa) - yb), (xb, fy(xb) - yb),
                   (xb, fy(xb) - ya), (xa, fy(xa) - ya)], fill=c)

    band(x0, x1, lo, hi, PAL["oak_deep"])                    # frame
    band(x0 + 2, x1 - 2, lo + 2, hi - 2, (38, 40, 61, 255))  # night sky
    mid = (x0 + x1) // 2
    mx, my = mid, fy(mid) - (lo + hi) // 2
    d.polygon([(mx, my - 8), (mx + 3, my - 2), (mx + 3, my + 4),
               (mx - 3, my + 4), (mx - 3, my - 2)], fill=PAL["white"])  # rocket
    d.rectangle([mx - 1, my - 2, mx, my - 1], fill=PAL["screen_dim"])   # porthole
    d.polygon([(mx - 2, my + 4), (mx + 2, my + 4), (mx, my + 8)],
              fill=PAL["coral"])                              # flame
    band(x0 + 3, x1 - 3, lo + 3, lo + 5, PAL["mustard"])      # caption bar
    return "poster_NE", img, a


BOARD_W, BOARD_H = 120, 98  # flat dashboard-screen panel (renderer draws text)


def wall_board():
    """Flat wall-mounted dashboard screen: bezel + mustard header strip + dark
    screen. Drawn straight (not iso-skewed) — it reads as a mounted TV/board so
    the renderer can overlay straight, fully readable text; a dead daemon still
    shows a tidy empty screen. Anchor = bottom-center so it hangs on the wall.
    Text layout in WallBoardView must match BOARD_W/BOARD_H and the strips here.
    """
    m = 6  # canvas margin so the bezel corners aren't clipped
    w, h = BOARD_W + m * 2, BOARD_H + m * 2
    img, d, a = _sprite(w, h, w // 2, h)
    x0, y0 = m, m                                            # panel top-left
    x1, y1 = m + BOARD_W, m + BOARD_H
    d.rectangle([x0, y0, x1, y1], fill=PAL["oak_deep"])       # bezel
    d.rectangle([x0 + 3, y0 + 3, x1 - 3, y1 - 3], fill=PAL["oak_dark"])
    d.rectangle([x0 + 5, y0 + 5, x1 - 5, y0 + 20], fill=PAL["mustard"])  # header
    d.rectangle([x0 + 5, y0 + 20, x1 - 5, y1 - 5], fill=(24, 26, 40, 255))  # screen
    for sx in (x0 + 4, x1 - 5):                               # mount screws
        for sy in (y0 + 4, y1 - 5):
            d.point((sx, sy), fill=PAL["wall_top"])
    return "wall_board_NE", img, a


def rug_big():
    """2x2 area rug, flat teal with border + diamond motif."""
    img, d, a = _sprite(128, 64, 64, 63)
    bx, by = a
    diamond(d, bx, by, 2, 2, fill=PAL["carpet"],
            outline=shade(PAL["carpet"], 0.7))
    diamond(d, bx, by - 4, 1.85, 1.85, outline=PAL["carpet_hi"])
    diamond(d, bx, by - 16, 1.0, 1.0, outline=PAL["carpet_hi"])
    diamond(d, bx, by - 26, 0.4, 0.4, fill=shade(PAL["carpet"], 1.2))
    return "rug_big", img, a


def _radial(w, h, color, peak):
    """Soft radial alpha falloff — for ADD-blend light sprites."""
    from PIL import Image
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    px = img.load()
    cx, cy = (w - 1) / 2, (h - 1) / 2
    for y in range(h):
        for x in range(w):
            dx, dy = (x - cx) / cx, (y - cy) / cy
            d = dx * dx + dy * dy
            if d < 1:
                a = int(peak * (1 - d) ** 2)
                if a:
                    px[x, y] = color + (a,)
    return img


def glow_warm():
    """Round warm halo for lamps/neon (renderer: blendMode ADD)."""
    return "glow_warm", _radial(64, 64, (255, 209, 140), 110), (32, 32)


def light_pool():
    """Iso-squashed warm pool of light on the floor under a lamp."""
    return "light_pool", _radial(96, 48, (255, 200, 120), 70), (48, 44)


def build_makeover():
    frames = [
        wall_window(),
        chair_office("E"),
        clutter_lamp(),
        clutter_mug(),
        clutter_papers(),
        water_cooler(),
        server_rack(),
        wall_clock(),
        poster(),
        wall_board(),
        rug_big(),
        glow_warm(),
        light_pool(),
    ]
    mirrored = []
    for name, target in [("wall_NE_win", "wall_NW_win"),
                         ("chair_office_E", "chair_office_W"),
                         ("wall_clock_NE", "wall_clock_NW"),
                         ("poster_NE", "poster_NW"),
                         ("wall_board_NE", "wall_board_NW")]:
        src = next(f for f in frames if f[0] == name)
        img = src[1].transpose(0)  # FLIP_LEFT_RIGHT
        ax = src[1].width - src[2][0]
        mirrored.append((target, img, (ax, src[2][1])))
    return frames + mirrored
