"""Chibi character sprites, 32x48/frame, anchor at feet (16, 46).

States (contract with docs/art-direction.md §4): idle, walk NESW, typing,
reading, blocked, error, talking. Frame names: {char}/{state}_{dir}_{i}.
"""

from PIL import ImageDraw
from iso import PAL, canvas

COLORWAYS = {
    "coder-teal": {"shirt": PAL["ok"], "pants": PAL["tech_dark"],
                   "hair": (34, 34, 59, 255)},
    "coder-coral": {"shirt": PAL["coral"], "pants": (58, 61, 85, 255),
                    "hair": (92, 61, 36, 255)},
    # round 2 — PM/CEO: navy suit, silver hair, white shirt + coral tie
    "exec-navy": {"shirt": (43, 45, 66, 255), "pants": (30, 32, 50, 255),
                  "hair": (168, 170, 188, 255), "tie": PAL["coral"]},
    # round 2 — Codex agents: steel robot, cyan visor instead of eyes,
    # antenna; "hair" doubles as the metal shell color (back of head, slump)
    "robot-steel": {"shirt": (122, 128, 152, 255), "pants": (66, 70, 92, 255),
                    "hair": (96, 102, 128, 255), "robot": True,
                    "skin": (170, 176, 198, 255),
                    "skin_dark": (130, 136, 160, 255)},
}
SKIN, SKIN_D = PAL["skin"], PAL["skin_dark"]
DARK = (20, 20, 32, 255)
FACING_DEFAULT = {"idle": "S", "reading": "S", "blocked": "S", "talking": "S",
                  "typing": "E", "error": "E"}


def _frame():
    img = canvas(32, 48)
    return img, ImageDraw.Draw(img)


def _r(d, x0, y0, x1, y1, c):
    d.rectangle([x0, y0, x1, y1], fill=c)


def _head(d, cw, face, dy=0):
    """face: 'S' front, 'N' back, 'E' side (W is mirrored later)."""
    hair = cw["hair"]
    skin, skin_d = cw.get("skin", SKIN), cw.get("skin_dark", SKIN_D)
    robot = cw.get("robot", False)
    if robot:  # antenna with a warning-light tip
        _r(d, 15, 2 + dy, 16, 5 + dy, hair)
        _r(d, 14, 0 + dy, 17, 2 + dy, PAL["warn"])
    _r(d, 9, 6 + dy, 22, 12 + dy, hair)                      # hair top
    if face == "N":
        _r(d, 9, 12 + dy, 22, 20 + dy, hair)                 # back of head
        _r(d, 10, 20 + dy, 21, 21 + dy, skin_d)              # neck
    elif face == "S":
        _r(d, 10, 12 + dy, 21, 20 + dy, skin)
        _r(d, 9, 12 + dy, 9, 16 + dy, hair)
        _r(d, 22, 12 + dy, 22, 16 + dy, hair)
        if robot:  # full-width cyan visor instead of eyes
            _r(d, 11, 14 + dy, 20, 16 + dy, PAL["screen_dim"])
            _r(d, 13, 14 + dy, 14, 15 + dy, PAL["screen"])
            _r(d, 17, 14 + dy, 18, 15 + dy, PAL["screen"])
        else:
            _r(d, 13, 15 + dy, 14, 16 + dy, DARK)            # eyes
            _r(d, 18, 15 + dy, 19, 16 + dy, DARK)
    else:  # E — profile looking right
        _r(d, 9, 12 + dy, 15, 20 + dy, hair)
        _r(d, 16, 12 + dy, 22, 20 + dy, skin)
        if robot:
            _r(d, 17, 14 + dy, 21, 16 + dy, PAL["screen_dim"])
            _r(d, 19, 14 + dy, 20, 15 + dy, PAL["screen"])
        else:
            _r(d, 19, 15 + dy, 20, 16 + dy, DARK)


def _standing(d, cw, face, leg_phase=0, arms=None, head_dy=0):
    """leg_phase: 0 both down, 1 left up, 2 right up. arms: fn(d) override."""
    shirt, pants = cw["shirt"], cw["pants"]
    skin = cw.get("skin", SKIN)
    _head(d, cw, face, dy=head_dy)
    _r(d, 10, 21, 21, 34, shirt)
    _r(d, 20, 21, 21, 34, tuple(int(c * 0.8) for c in shirt[:3]) + (255,))
    if face == "S" and "tie" in cw:                          # suit: shirt + tie
        _r(d, 13, 21, 18, 27, PAL["white"])
        _r(d, 15, 21, 16, 28, cw["tie"])
    if arms:
        arms(d)
    else:
        _r(d, 7, 22, 9, 31, shirt), _r(d, 7, 32, 9, 33, skin)
        _r(d, 22, 22, 24, 31, shirt), _r(d, 22, 32, 24, 33, skin)
    ly = 2 if leg_phase == 1 else 0
    ry = 2 if leg_phase == 2 else 0
    _r(d, 11, 35, 14, 44 - ly, pants), _r(d, 11, 45 - ly, 14, 46 - ly, DARK)
    _r(d, 17, 35, 20, 44 - ry, pants), _r(d, 17, 45 - ry, 20, 46 - ry, DARK)


def _seated(d, cw, slump=False):
    """Side view facing E, seated. slump=True → head on the desk (error)."""
    shirt, pants = cw["shirt"], cw["pants"]
    if slump:
        _r(d, 8, 26, 17, 40, shirt)                          # hunched torso
        _r(d, 14, 20, 25, 28, cw["hair"])                    # head dropped fwd
        _r(d, 20, 26, 25, 29, cw.get("skin", SKIN))
        _r(d, 16, 29, 24, 31, shirt)                         # arms sprawled
    else:
        _head(d, cw, "E", dy=4)
        _r(d, 10, 25, 19, 38, shirt)
    _r(d, 14, 38 if not slump else 40, 23, 41 if not slump else 43, pants)
    _r(d, 21, 41, 24, 45, pants)                              # shins down
    _r(d, 21, 45, 25, 46, DARK)


def _emote(name, painter):
    img = canvas(16, 16)
    painter(ImageDraw.Draw(img))
    return name, img, (8, 15)


def _char_frames(char_id, cw):
    out, anims = [], {}
    skin = cw.get("skin", SKIN)

    def add(state, dir_, idx, img):
        key = f"{char_id}/{state}_{dir_}_{idx}"
        out.append((key, img, (16, 46)))
        anims.setdefault(f"{char_id}/{state}_{dir_}", []).append(key)

    # idle S — breathe bob
    for i, dy in enumerate((0, 1)):
        img, d = _frame()
        _standing(d, cw, "S", head_dy=dy)
        add("idle", "S", i, img)

    # walk NESW — 4-frame leg cycle (W mirrors E, done below)
    for dir_ in ("N", "E", "S"):
        for i, phase in enumerate((1, 0, 2, 0)):
            img, d = _frame()
            _standing(d, cw, dir_, leg_phase=phase)
            add("walk", dir_, i, img)
    for i in range(4):
        src = next(f for f in out if f[0] == f"{char_id}/walk_E_{i}")
        add("walk", "W", i, src[1].transpose(0))

    # typing E — seated, hands drumming
    for i in range(2):
        img, d = _frame()
        _seated(d, cw)
        _r(d, 18, 27 + i, 26, 29 + i, cw["shirt"])           # forearms
        _r(d, 25, 28 + i, 27, 30 + i, skin)
        add("typing", "E", i, img)

    # reading S — page flip
    for i in range(2):
        img, d = _frame()
        def arms(d):
            _r(d, 7, 22, 9, 28, cw["shirt"]), _r(d, 22, 22, 24, 28, cw["shirt"])
        _standing(d, cw, "S", arms=arms)
        _r(d, 13, 15, 14, 16, cw["hair"])                    # eyes look down
        _r(d, 18, 15, 19, 16, cw["hair"])
        _r(d, 13, 16, 14, 17, DARK), _r(d, 18, 16, 19, 17, DARK)
        _r(d, 9, 26 + i, 22, 33, PAL["white"])               # document
        _r(d, 15, 26 + i, 16, 33, (180, 180, 178, 255))      # spine
        add("reading", "S", i, img)

    # blocked S — hand raised / waving
    for i in range(2):
        img, d = _frame()
        def arms(d, i=i):
            _r(d, 7, 22, 9, 31, cw["shirt"]), _r(d, 7, 32, 9, 33, skin)
            _r(d, 22, 12 + i * 3, 24, 28, cw["shirt"])       # raised arm
            _r(d, 22, 9 + i * 3, 24, 11 + i * 3, skin)       # hand up
        _standing(d, cw, "S", arms=arms)
        add("blocked", "S", i, img)

    # error E — slumped on the desk
    img, d = _frame()
    _seated(d, cw, slump=True)
    add("error", "E", 0, img)

    # seated W facings — mirror of E, pair with desk_W (round 3 seat system)
    for i in range(2):
        src = next(f for f in out if f[0] == f"{char_id}/typing_E_{i}")
        add("typing", "W", i, src[1].transpose(0))
    src = next(f for f in out if f[0] == f"{char_id}/error_E_0")
    add("error", "W", 0, src[1].transpose(0))

    # talking S — mouth + gesture
    for i in range(2):
        img, d = _frame()
        def arms(d, i=i):
            _r(d, 7, 22, 9, 31, cw["shirt"]), _r(d, 7, 32, 9, 33, skin)
            _r(d, 22, 24 - i * 2, 26, 26 - i * 2, cw["shirt"])
            _r(d, 26, 24 - i * 2, 27, 26 - i * 2, skin)      # gesturing hand
        _standing(d, cw, "S", arms=arms)
        if i == 0:
            _r(d, 15, 18, 16, 19, DARK)                      # mouth open
        add("talking", "S", i, img)

    # phone S — one arm holds a handset to the ear (CEO idle flavor, wi-office-life)
    img, d = _frame()
    def phone_arms(d):
        _r(d, 7, 22, 9, 31, cw["shirt"]), _r(d, 7, 32, 9, 33, skin)   # arm down
        _r(d, 22, 10, 24, 24, cw["shirt"])                             # arm raised to the ear
        _r(d, 21, 8, 25, 13, DARK)                                     # handset
    _standing(d, cw, "S", arms=phone_arms)
    add("phone", "S", 0, img)

    return out, anims


def build_characters():
    frames, animations = [], {}
    for char_id, cw in COLORWAYS.items():
        f, a = _char_frames(char_id, cw)
        frames += f
        animations.update(a)
    return frames, animations


def build_emotes():
    def exclaim(d):
        d.polygon([(8, 0), (15, 8), (8, 15), (1, 8)], fill=PAL["warn"])
        d.rectangle([7, 3, 8, 9], fill=DARK)
        d.rectangle([7, 11, 8, 12], fill=DARK)

    def chat(d):
        d.rounded_rectangle([1, 1, 14, 11], 3, fill=PAL["white"])
        d.polygon([(4, 11), (8, 11), (4, 15)], fill=PAL["white"])
        for x in (4, 7, 10):
            d.rectangle([x, 5, x + 1, 6], fill=DARK)

    def error(d):
        d.ellipse([1, 1, 14, 14], fill=PAL["error"])
        d.line([(5, 5), (10, 10)], fill=PAL["white"], width=2)
        d.line([(10, 5), (5, 10)], fill=PAL["white"], width=2)

    def zzz(d):
        for i, (x, y, s) in enumerate([(1, 9, 5), (6, 5, 5), (11, 1, 4)]):
            d.line([(x, y), (x + s, y)], fill=PAL["screen"])
            d.line([(x + s, y), (x, y + s)], fill=PAL["screen"])
            d.line([(x, y + s), (x + s, y + s)], fill=PAL["screen"])

    return [_emote("emotes/exclaim", exclaim), _emote("emotes/chat", chat),
            _emote("emotes/error", error), _emote("emotes/zzz", zzz)]
