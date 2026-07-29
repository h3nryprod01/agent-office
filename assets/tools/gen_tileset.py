"""Office tileset sprites (pixel-art isometric, tile 64x32).

Every builder returns (name, image, anchor_px) where anchor is the bottom
vertex of the sprite's footprint diamond (see docs/art-direction.md §2).
Sub-parts are positioned in tile-space offsets via `off()`.
"""

from PIL import ImageDraw
from iso import PAL, HTW, HTH, canvas, diamond, iso_box, shade, leg

BOOK_COLORS = [PAL["coral"], PAL["ok"], PAL["mustard"], PAL["screen_dim"],
               PAL["wood_light"], PAL["error"]]


def off(bx, by, du, dv):
    """Tile-space offset (du along +x, dv along +y) from bottom vertex."""
    return bx + (du - dv) * HTW, by - (du + dv) * HTH


def _sprite(w, h, bx, by):
    img = canvas(w, h)
    return img, ImageDraw.Draw(img), (bx, by)


def floor_tile(name, base, stripes=False):
    img, d, a = _sprite(64, 32, 32, 31)
    top = [(32, 0), (63, 16), (32, 31), (0, 16)]
    d.polygon(top, fill=base, outline=shade(base, 0.75))
    if stripes:  # wood planks
        for i in (1, 2, 3):
            d.line([(i * 8, 16 - i * 4), (32 + i * 8, 32 - i * 4)],
                   fill=shade(base, 0.88))
    return name, img, a


def carpet_tile():
    img, d, a = _sprite(64, 32, 32, 31)
    d.polygon([(32, 0), (63, 16), (32, 31), (0, 16)],
              fill=PAL["carpet"], outline=shade(PAL["carpet"], 0.7))
    d.polygon([(32, 6), (51, 16), (32, 25), (13, 16)],
              outline=PAL["carpet_hi"])
    return "floor_carpet", img, a


def wall(name, along_u):
    """Thin tall wall slab. along_u=True: runs along world +x → NE (upper
    right) edge; else along +y → NW (upper left) edge. In iso_box terms sx
    extends -y and sy extends -x from the bottom vertex."""
    sx, sy = (0.18, 1) if along_u else (1, 0.18)
    img, d, a = _sprite(42, 118, (33 if along_u else 8), 116)
    iso_box(d, a[0], a[1], sx, sy, 96, PAL["wall_base"])
    iso_box(d, a[0], a[1], sx, sy, 6, PAL["wall_dark"])          # baseboard
    iso_box(d, a[0], a[1], sx, sy, 3, PAL["wall_top"], lift=93)  # crown trim
    return name, img, a


def wall_corner():
    img, d, a = _sprite(46, 118, 37, 116)
    for s in [(0.18, 1), (1, 0.18)]:
        iso_box(d, a[0], a[1], *s, 96, PAL["wall_base"])
        iso_box(d, a[0], a[1], *s, 6, PAL["wall_dark"])
        iso_box(d, a[0], a[1], *s, 3, PAL["wall_top"], lift=93)
    return "wall_corner", img, a


def desk():
    """Desk, 2x1 tiles, monitor at the back. Mirror the sprite for desk_W."""
    img, d, a = _sprite(102, 96, 36, 94)
    bx, by = a
    for du, dv in [(0.08, 0.08), (1.8, 0.08), (0.08, 0.82), (1.8, 0.82)]:
        x, y = off(bx, by, du, dv)
        leg(d, x - 1, y, 18, PAL["oak_deep"])
    iso_box(d, bx, by, 2, 1, 7, PAL["oak"], lift=18)
    # monitor along the back edge, screen facing front
    mx, my = off(bx, by, 0.7, 0.72)
    leg(d, mx - 1, my - 25, 4, PAL["tech_dark"])
    f = iso_box(d, mx, my, 0.8, 0.1, 16, PAL["tech_dark"], lift=29)
    d.polygon([(f["b"][0] + 2, f["b"][1] + 14), (f["r"][0] - 2, f["r"][1] + 14),
               (f["r"][0] - 2, f["r"][1] + 3), (f["b"][0] + 2, f["b"][1] + 3)],
              fill=PAL["screen_dim"])
    kx, ky = off(bx, by, 0.7, 0.25)
    iso_box(d, kx, ky, 0.7, 0.25, 2, PAL["wall_top"], lift=26)
    return "desk_E", img, a


def chair(kind):
    """kind: E (back at far-v edge), N (back at near-u edge); mirror for W/S."""
    img, d, a = _sprite(52, 60, 26, 58)
    bx, by = a
    seat = (0.7, 0.7)
    for du, dv in [(0.1, 0.1), (0.55, 0.1), (0.1, 0.55), (0.55, 0.55)]:
        x, y = off(bx, by, du, dv)
        leg(d, x - 1, y, 10, PAL["tech_dark"])
    if kind == "N":  # backrest behind the seat (far corner), drawn first
        x, y = off(bx, by, 0.55, 0)
        iso_box(d, x, y, 0.15, 0.7, 26, PAL["oak_dark"], lift=10)
    iso_box(d, bx, by, *seat, 5, PAL["oak"], lift=10)
    if kind == "E":  # backrest nearer the viewer, occludes seat edge
        x, y = off(bx, by, 0, 0.55)
        iso_box(d, x, y, 0.7, 0.15, 26, PAL["oak_dark"], lift=10)
    return f"chair_{kind}", img, a


def bookshelf():
    img, d, a = _sprite(52, 112, 14, 110)
    bx, by = a
    iso_box(d, bx, by, 1, 0.35, 78, PAL["oak_dark"])
    # book spines on the wide front face (b -> r edge), three shelf bands;
    # varied heights + leaning gaps so it reads "lived-in", not a barcode
    for band in (8, 32, 56):
        for i in range(7):
            if (band + i) % 5 == 4:
                continue                                     # gap on the shelf
            c = BOOK_COLORS[i % len(BOOK_COLORS)]
            x = bx + 3 + i * 4
            y = by - (x - bx) // 2
            h = 16 - (i * 7 + band) % 4                      # varied book height
            d.rectangle([x, y - band - h, x + 2, y - band], fill=c)
    # wood top trim + a small plant on top
    iso_box(d, bx, by, 1, 0.35, 3, PAL["oak"], lift=78)
    px, py = off(bx, by, 0.45, 0.18)
    d.ellipse([px - 4, py - 92, px + 4, py - 85], fill=PAL["plant"])
    d.rectangle([px - 2, py - 86, px + 2, py - 82], fill=PAL["coral_dark"])
    return "bookshelf", img, a


def filing_cabinet():
    """Steel filing cabinet (wi-office-life) — stands beside the bookshelf;
    clickable in the renderer to open the outputs panel."""
    img, d, a = _sprite(42, 96, 21, 94)
    bx, by = a
    steel = (107, 114, 142, 255)
    iso_box(d, bx, by, 0.42, 0.42, 70, steel)
    # three drawer gaps + handles on the right face (slope -1/2, same
    # convention bookshelf's shelves use)
    for band in (14, 36, 58):
        d.line([(bx + 1, by - band), (bx + 17, by - band - 8)], fill=shade(steel, 0.45))
        hx, hy = bx + 7, by - band - 4
        d.rectangle([hx, hy, hx + 3, hy + 1], fill=PAL["mustard"])
    return "filing_cabinet", img, a


def ceo_desk():
    """Executive desk, 2x1 tiles: walnut slab on side panels + desk lamp.
    Faces E like desk_E (chair goes on the -x side)."""
    img, d, a = _sprite(102, 96, 36, 94)
    bx, by = a
    for du in (0.08, 1.72):                                   # side panels
        x, y = off(bx, by, du, 0.12)
        iso_box(d, x, y, 0.2, 0.72, 16, PAL["oak_deep"])
    iso_box(d, bx, by, 2, 1, 9, PAL["oak_dark"], lift=16)     # thick top
    # monitor, centered on the back edge
    mx, my = off(bx, by, 0.75, 0.72)
    leg(d, mx - 1, my - 25, 4, PAL["tech_dark"])
    f = iso_box(d, mx, my, 0.8, 0.1, 16, PAL["tech_dark"], lift=29)
    d.polygon([(f["b"][0] + 2, f["b"][1] + 14), (f["r"][0] - 2, f["r"][1] + 14),
               (f["r"][0] - 2, f["r"][1] + 3), (f["b"][0] + 2, f["b"][1] + 3)],
              fill=PAL["screen_dim"])
    # brass desk lamp at the far-right corner
    lx, ly = off(bx, by, 1.72, 0.78)
    leg(d, lx - 1, ly - 25, 10, PAL["oak_deep"])
    d.rectangle([lx - 5, ly - 39, lx + 3, ly - 35], fill=PAL["mustard"])
    d.rectangle([lx - 4, ly - 35, lx + 2, ly - 34], fill=PAL["warn"])
    return "ceo_desk_E", img, a


def chair_exec():
    """Executive leather chair facing E (mirror for W): tall dark backrest."""
    img, d, a = _sprite(52, 74, 26, 72)
    bx, by = a
    leather = (52, 46, 64, 255)
    x, y = off(bx, by, 0.3, 0.3)
    leg(d, x - 1, y, 8, PAL["tech_dark"])                     # center column
    iso_box(d, bx, by, 0.75, 0.75, 8, leather, lift=8)        # padded seat
    x, y = off(bx, by, 0, 0.55)                               # tall backrest
    iso_box(d, x, y, 0.75, 0.2, 38, leather, lift=8)
    x, y = off(bx, by, 0, 0.55)                               # headrest pad
    iso_box(d, x, y, 0.75, 0.2, 6, shade(leather, 1.35), lift=48)
    return "chair_exec_E", img, a


def coffee_table():
    """Low oak coffee table, 1x1, pairs with the sofa."""
    img, d, a = _sprite(64, 42, 32, 40)
    bx, by = a
    for du, dv in [(0.12, 0.12), (0.72, 0.12), (0.12, 0.72), (0.72, 0.72)]:
        x, y = off(bx, by, du, dv)
        leg(d, x - 1, y, 8, PAL["oak_deep"])
    iso_box(d, bx, by, 0.9, 0.9, 4, PAL["oak"], lift=8)
    mx, my = off(bx, by, 0.42, 0.42)                          # mug on top
    d.rectangle([mx - 2, my - 17, mx + 2, my - 13], fill=PAL["coral"])
    return "coffee_table", img, a


def plant_big():
    """Tall floor plant: big pot + layered monstera-ish foliage."""
    img, d, a = _sprite(56, 88, 28, 86)
    bx, by = a
    iso_box(d, bx, by, 0.45, 0.45, 14, PAL["oak_deep"])
    d.rectangle([bx - 1, by - 44, bx + 1, by - 22], fill=PAL["plant_dark"])
    for dx, dy, r, c in [(-9, -46, 10, "plant_dark"), (7, -52, 10, "plant"),
                         (-2, -62, 9, "plant"), (-12, -56, 6, "plant_dark"),
                         (10, -42, 6, "plant_dark"), (2, -70, 6, "plant")]:
        d.ellipse([bx + dx - r, by + dy - r, bx + dx + r, by + dy + r],
                  fill=PAL[c])
    return "plant_big", img, a


def neon_sign():
    """Wall decor, self-contained: brick panel + glowing neon zigzag + ring.
    Anchor at the bottom vertex of the wall tile it mounts on (NE wall, along
    +x) — drawn floating at wall height, overlaps wall_NE placed on the same
    tile. Mirror for the NW wall."""
    img, d, a = _sprite(50, 96, 4, 94)
    bx, by = a
    brick, brick_hi = (128, 76, 68, 255), (146, 90, 78, 255)
    mortar = (72, 50, 52, 255)
    x0, y0 = bx, by - 34                                      # panel bottom-left
    w, h = 42, 26

    def sy(x):                                                # iso slope: -1/2
        return y0 - (x - x0) // 2

    def pt(px, py):                                           # panel-space point
        return x0 + px, sy(x0 + px) - py

    d.polygon([pt(0, 0), pt(w, 0), pt(w, h), pt(0, h)], fill=mortar)
    for row in range(4):                                      # staggered bricks
        py = 1 + row * 7
        for col in range(5):
            px = 1 + col * 9 - (row % 2) * 4
            px0, px1 = max(px, 1), min(px + 8, w - 1)
            if px1 <= px0:
                continue
            c = brick_hi if (row + col) % 3 == 0 else brick
            d.polygon([pt(px0, py), pt(px1, py), pt(px1, py + 5), pt(px0, py + 5)],
                      fill=c)
    # neon: cyan lightning zigzag + coral ring (glow pass under bright pass)
    bolt = [pt(5, 14), pt(11, 6), pt(9, 17), pt(15, 9)]
    d.line(bolt, fill=PAL["screen_dim"], width=3)
    d.line(bolt, fill=PAL["screen"], width=1)
    cx, cy = pt(30, 13)
    d.ellipse([cx - 6, cy - 6, cx + 6, cy + 6], outline=PAL["coral"], width=2)
    d.ellipse([cx - 4, cy - 4, cx + 4, cy + 4], outline=PAL["mustard"])
    return "neon_sign", img, a


def arcade():
    img, d, a = _sprite(60, 92, 30, 90)
    bx, by = a
    iso_box(d, bx, by, 0.8, 0.8, 54, PAL["tech_dark"])
    fx, fy = off(bx, by, 0, 0.8)  # front-left face detail origin
    d.polygon([(bx - 24, by - 26), (bx - 4, by - 16), (bx - 4, by - 32),
               (bx - 24, by - 42)], fill=PAL["screen"])  # screen
    d.rectangle([bx - 20, by - 12, bx - 8, by - 10], fill=PAL["error"])  # buttons
    tx, ty = off(bx, by, 0, 0)
    iso_box(d, tx, ty, 0.8, 0.8, 6, PAL["coral"], lift=56)  # marquee
    return "arcade", img, a


def sofa():
    img, d, a = _sprite(102, 74, 36, 72)
    bx, by = a
    iso_box(d, bx, by, 2, 0.9, 14, PAL["coral"])
    x, y = off(bx, by, 0, 0.65)
    iso_box(d, x, y, 2, 0.25, 30, PAL["coral_dark"])       # backrest
    for du in (0, 1.8):
        x, y = off(bx, by, du, 0)
        iso_box(d, x, y, 0.2, 0.65, 22, PAL["coral_dark"])  # armrests
    x, y = off(bx, by, 1.0, 0.05)
    d.line([off(bx, by, 1.0, 0.05), off(bx, by, 1.0, 0.6)],
           fill=shade(PAL["coral"], 0.6))                   # cushion split
    return "sofa", img, a


def whiteboard():
    img, d, a = _sprite(52, 88, 27, 86)
    bx, by = a
    for du, dv in [(0.08, 0.15), (0.85, 0.15)]:
        x, y = off(bx, by, du, dv)
        leg(d, x - 1, y, 30, PAL["tech_dark"])
    f = iso_box(d, bx, by, 1, 0.1, 44, PAL["white"], lift=30)
    # marker scribbles on the wide front face (follows the b -> r slope)
    bx0, by0 = f["b"]
    for i, c in enumerate((PAL["ok"], PAL["error"], PAL["screen_dim"])):
        y0 = by0 + 34 - i * 10
        d.line([(bx0 + 4, y0), (bx0 + 26, y0 - 11)], fill=c, width=2)
    return "whiteboard", img, a


def reception():
    img, d, a = _sprite(102, 90, 36, 88)
    bx, by = a
    iso_box(d, bx, by, 2, 0.8, 34, PAL["oak"])
    # accent stripe on the front-left face
    for x in range(bx - int(0.8 * HTW) + 2, bx - 2, 3):
        y = by - int((x - (bx - int(0.8 * HTW))) * 0.5)
        d.rectangle([x, y - 22, x + 1, y - 12], fill=PAL["ok"])
    iso_box(d, bx + 2, by + 1, 2.05, 0.85, 4, PAL["wood_light"], lift=34)  # top
    return "reception", img, a


def plant():
    img, d, a = _sprite(44, 60, 22, 58)
    bx, by = a
    iso_box(d, bx, by, 0.35, 0.35, 10, PAL["coral_dark"])
    for dx, dy, r, c in [(-6, -28, 8, "plant_dark"), (4, -32, 8, "plant"),
                         (-1, -40, 7, "plant"), (-8, -36, 5, "plant_dark"),
                         (6, -24, 5, "plant_dark")]:
        d.ellipse([bx + dx - r, by + dy - r, bx + dx + r, by + dy + r],
                  fill=PAL[c])
    return "plant", img, a


def build_tileset():
    frames = [
        floor_tile("floor_wood_a", PAL["wood_light"], stripes=True),
        floor_tile("floor_wood_b", PAL["wood_mid"], stripes=True),
        carpet_tile(),
        wall("wall_NE", along_u=True),
        wall("wall_NW", along_u=False),
        wall_corner(),
        desk(),
        chair("E"),
        chair("N"),
        bookshelf(),
        filing_cabinet(),
        arcade(),
        sofa(),
        whiteboard(),
        reception(),
        plant(),
        ceo_desk(),
        chair_exec(),
        coffee_table(),
        plant_big(),
        neon_sign(),
    ]
    # mirrored facings (valid in 2:1 iso)
    mirrored = []
    for name, target in [("desk_E", "desk_W"), ("chair_E", "chair_W"),
                         ("chair_N", "chair_S"), ("ceo_desk_E", "ceo_desk_W"),
                         ("chair_exec_E", "chair_exec_W"),
                         ("neon_sign", "neon_sign_NW")]:
        src = next(f for f in frames if f[0] == name)
        img = src[1].transpose(0)  # FLIP_LEFT_RIGHT
        ax = src[1].width - src[2][0]
        mirrored.append((target, img, (ax, src[2][1])))
    return frames + mirrored
