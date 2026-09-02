"""The interactive picker behind ``tdcv2 pack``.

The catalogue is 108 bundles and growing. As one flat list it is unusable: a screenful at a time,
languages interleaved with countries, and finding Brazil means paging through the alphabet. So it
is browsed the way the catalogue is actually shaped — the locale-agnostic set, then languages, then
countries reached through a continent — with search from anywhere and a basket reviewed before
anything downloads.

The map is not decoration. The continent under the cursor lights up, and every pick burns a spark
where that country actually is, so "what have I taken so far" is answerable at a glance. Where a
country sits comes from the registry index, not from a table kept here: the same picker exists in
three languages, and three copies of world geography would be three copies that disagree.

This module draws and returns a decision. It never touches the network or the disk — the caller
installs and removes, which keeps digests, progress and config writing in one place.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from typing import TYPE_CHECKING

from ..human_bytes import human_bytes

if TYPE_CHECKING:
    from ..packs.registry import Bundle

# ── what this terminal can do ─────────────────────────────────────────────────


def _supports_unicode() -> bool:
    """Half-blocks are common but not universal, so they are detected rather than assumed.

    Windows Terminal, iTerm2, the macOS Terminal, VS Code and the rest of the modern crop handle
    everything here. The old Windows console does not — a raster font has no ``▀`` — so the drawing
    falls back to ASCII and the map to one row per line instead of two rows sharing one.
    """
    if os.environ.get("TDCV2_ASCII"):
        return False
    if sys.platform != "win32":
        locale = os.environ.get("LC_ALL") or os.environ.get("LC_CTYPE") or os.environ.get("LANG")
        return not locale or "utf-8" in locale.lower() or "utf8" in locale.lower()
    return bool(
        os.environ.get("WT_SESSION")
        or os.environ.get("TERM_PROGRAM")
        or os.environ.get("ConEmuANSI")  # noqa: SIM112 — ConEmu spells it this way
    )


def _supports_colour() -> bool:
    return (
        not os.environ.get("NO_COLOR") and os.environ.get("TERM") != "dumb" and sys.stdout.isatty()
    )


UNICODE = _supports_unicode()
COLOUR = _supports_colour()

GLYPHS = (
    {
        "cursor": "❯",
        "group": "»",
        "on": "▣",
        "off": "▢",
        "done": "✓",
        "drop": "✗",
        "chip": "■",
        "land": "█",
    }
    if UNICODE
    else {
        "cursor": ">",
        "group": ">",
        "on": "[x]",
        "off": "[ ]",
        "done": "[+]",
        "drop": "[-]",
        "chip": "*",
        "land": "#",
    }
)

ESC = "\x1b["


def sgr(text: str, code: str) -> str:
    return f"{ESC}{code}m{text}{ESC}0m" if COLOUR else text


def dim(text: str) -> str:
    return sgr(text, "2")


def bold(text: str) -> str:
    return sgr(text, "1")


# ── the world ─────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class Continent:
    key: str
    name: str
    colour: int
    bright: int


CONTINENTS: list[Continent] = [
    Continent("europe", "Europe", 34, 94),
    Continent("asia", "Asia", 35, 95),
    Continent("africa", "Africa", 33, 93),
    Continent("north", "North America", 36, 96),
    Continent("south", "South America", 32, 92),
    Continent("oceania", "Oceania", 31, 91),
]

#: The continents as rough outlines in real coordinates rather than a fixed grid of characters.
#:
#: A hand-drawn grid only looks right at the size it was drawn for. Polygons are rasterised to
#: whatever the window allows, so the shapes survive being made bigger — and each landmass's
#: coastline falls out of the same data, which is what lets the map be drawn as outlines.
OUTLINES: dict[str, list[list[tuple[float, float]]]] = {
    "africa": [
        [
            (-17, 15),
            (-16, 12),
            (-13, 8),
            (-7, 4),
            (3, 6),
            (9, 4),
            (9, -1),
            (12, -6),
            (13, -13),
            (15, -22),
            (18, -34),
            (25, -34),
            (32, -26),
            (40, -16),
            (41, -2),
            (51, 12),
            (43, 12),
            (37, 22),
            (34, 28),
            (32, 31),
            (20, 32),
            (10, 34),
            (0, 36),
            (-6, 36),
            (-10, 30),
            (-16, 22),
        ],
        [(44, -12), (50, -15), (50, -25), (45, -25), (43, -16)],
    ],
    "europe": [
        [
            (-10, 36),
            (-9, 43),
            (-2, 48),
            (-5, 50),
            (-6, 58),
            (5, 62),
            (12, 68),
            (28, 71),
            (40, 66),
            (60, 66),
            (60, 50),
            (50, 46),
            (40, 44),
            (28, 41),
            (24, 36),
            (15, 38),
            (12, 45),
            (3, 43),
        ],
    ],
    "asia": [
        [
            (60, 66),
            (70, 73),
            (100, 77),
            (140, 73),
            (170, 68),
            (180, 65),
            (180, 60),
            (160, 60),
            (155, 50),
            (142, 45),
            (130, 35),
            (122, 30),
            (110, 20),
            (105, 10),
            (100, 2),
            (95, 15),
            (88, 21),
            (80, 8),
            (72, 20),
            (62, 25),
            (56, 26),
            (52, 17),
            (43, 12),
            (35, 30),
            (36, 36),
            (28, 41),
            (40, 44),
            (50, 46),
            (60, 50),
        ],
    ],
    "north": [
        [
            (-168, 66),
            (-165, 60),
            (-152, 58),
            (-140, 60),
            (-130, 54),
            (-125, 48),
            (-124, 40),
            (-117, 32),
            (-110, 23),
            (-105, 20),
            (-97, 16),
            (-92, 15),
            (-84, 10),
            (-78, 8),
            (-83, 15),
            (-88, 21),
            (-97, 26),
            (-94, 29),
            (-89, 29),
            (-82, 25),
            (-81, 32),
            (-76, 37),
            (-70, 43),
            (-66, 45),
            (-60, 47),
            (-55, 52),
            (-64, 60),
            (-78, 62),
            (-95, 60),
            (-85, 68),
            (-100, 70),
            (-125, 70),
            (-140, 70),
            (-160, 71),
        ],
        [(-45, 60), (-20, 70), (-20, 82), (-60, 83), (-70, 76), (-55, 64)],
    ],
    "south": [
        [
            (-81, 8),
            (-77, 1),
            (-80, -5),
            (-71, -18),
            (-70, -25),
            (-72, -40),
            (-75, -52),
            (-68, -55),
            (-65, -42),
            (-62, -38),
            (-57, -35),
            (-48, -25),
            (-40, -20),
            (-35, -8),
            (-44, -2),
            (-50, 0),
            (-60, 6),
            (-70, 11),
            (-77, 8),
        ],
    ],
    "oceania": [
        [
            (114, -22),
            (113, -26),
            (115, -34),
            (129, -32),
            (138, -35),
            (147, -38),
            (150, -37),
            (153, -28),
            (146, -19),
            (142, -11),
            (136, -12),
            (130, -11),
            (125, -14),
            (122, -18),
        ],
        [
            (172, -34),
            (174, -37),
            (178, -38),
            (174, -41),
            (171, -44),
            (167, -46),
            (166, -45),
            (170, -41),
        ],
    ],
}

LON_MIN, LON_MAX = -170.0, 190.0
LAT_MAX, LAT_MIN = 84.0, -56.0


def _inside(lon: float, lat: float, ring: list[tuple[float, float]]) -> bool:
    hit = False
    j = len(ring) - 1
    for i, (xi, yi) in enumerate(ring):
        xj, yj = ring[j]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


_rasters: dict[tuple[int, int], tuple[list[str | None], list[bool]]] = {}


def _raster(w: int, h: int) -> tuple[list[str | None], list[bool]]:
    """Which continent owns each pixel, and whether that pixel sits on a coastline."""
    cached = _rasters.get((w, h))
    if cached is not None:
        return cached

    land: list[str | None] = [None] * (w * h)
    for row in range(h):
        lat = LAT_MAX - ((row + 0.5) / h) * (LAT_MAX - LAT_MIN)
        for col in range(w):
            lon = LON_MIN + ((col + 0.5) / w) * (LON_MAX - LON_MIN)
            for name, rings in OUTLINES.items():
                if any(_inside(lon, lat, r) or _inside(lon - 360, lat, r) for r in rings):
                    land[row * w + col] = name
                    break

    edge = [False] * (w * h)
    for row in range(h):
        for col in range(w):
            here = land[row * w + col]
            if here is None:
                continue
            edge[row * w + col] = (
                row == 0
                or row == h - 1
                or col == 0
                or col == w - 1
                or land[(row - 1) * w + col] != here
                or land[(row + 1) * w + col] != here
                or land[row * w + col - 1] != here
                or land[row * w + col + 1] != here
            )

    _rasters[(w, h)] = (land, edge)
    return land, edge


def _map_size(columns: int, rows: int, reserved: int) -> tuple[int, int] | None:
    """The largest map that still leaves room for the list, or None when nothing sensible fits."""
    w = min(columns - 4, 132)
    while w >= 56:
        # 360 degrees of longitude against 140 of latitude: keep the ratio so nothing is squashed.
        h = max(2, round(w * 0.39 / 2) * 2)
        if (h // 2 if UNICODE and COLOUR else h) + reserved <= rows:
            return w, h
        w -= 4
    return None


# ── raw keys ──────────────────────────────────────────────────────────────────


def _read_key() -> str:
    """One keypress, named. Escape sequences are decoded here so the loop reads plainly."""
    first = sys.stdin.read(1)
    if first == "":
        return "quit"
    if first == "\x03":
        return "quit"
    if first in ("\r", "\n"):
        return "enter"
    if first in ("\x7f", "\x08"):
        return "backspace"
    if first == " ":
        return "space"
    if first != "\x1b":
        return first

    # An escape alone is "go back"; an escape with more behind it is an arrow or a page key.
    second = sys.stdin.read(1)
    if second not in ("[", "O"):
        return "escape"
    third = sys.stdin.read(1)
    simple = {"A": "up", "B": "down", "C": "right", "D": "left", "H": "home", "F": "end"}
    if third in simple:
        return simple[third]
    if third.isdigit():
        rest = ""
        while True:
            ch = sys.stdin.read(1)
            if ch == "" or ch == "~":
                break
            rest += ch
        return {"5": "pageup", "6": "pagedown", "1": "home", "4": "end"}.get(third, "unknown")
    return "unknown"


# ── the picker ────────────────────────────────────────────────────────────────


@dataclass
class _Screen:
    screen: str
    cursor: int = 0
    offset: int = 0


@dataclass(frozen=True, slots=True)
class Item:
    kind: str  # 'pack' | 'group' | 'action'
    label: str
    hint: str
    id: str | None = None
    to: str | None = None
    act: str | None = None
    region: str | None = None


@dataclass(frozen=True, slots=True)
class Decision:
    """What the user chose. ``None`` from :func:`run_picker` means they left without confirming."""

    install: list[str]
    remove: list[str]


def plain_name(name: str) -> str:
    """ "Argentina (country)" is right in a printed list, and noise on a screen that says so."""
    for suffix in (" (country)", " (language)", " (locale-agnostic)"):
        if name.endswith(suffix):
            return name[: -len(suffix)]
    return name


def run_picker(bundles: list[Bundle], installed: set[str]) -> Decision | None:
    """Browse the catalogue and come back with what to install and what to remove."""
    picker = _Picker(bundles, installed)
    return picker.run()


class _Picker:
    def __init__(self, bundles: list[Bundle], installed: set[str]) -> None:
        self.bundles = bundles
        self.by_id = {b.id: b for b in bundles}
        self.installed = installed
        self.languages = [b for b in bundles if b.locale]
        self.countries = [b for b in bundles if b.country]
        self.neither = [b for b in bundles if not b.locale and not b.country]
        self.selected: set[str] = set()
        self.dropping: set[str] = set()
        self.stack = [_Screen("start")]
        self.query = ""
        self.flash = ""
        self.body_visible = False

    # ── data ──

    def in_region(self, key: str) -> list[Bundle]:
        return [b for b in self.countries if key in b.regions]

    def size_of(self, bundle_id: str) -> str:
        bundle = self.by_id.get(bundle_id)
        return human_bytes(bundle.bytes) if bundle else ""

    def not_installed(self) -> list[str]:
        return [b.id for b in self.bundles if b.id not in self.installed]

    def counts(self) -> dict[str, int]:
        return {
            c.key: sum(1 for b in self.in_region(c.key) if b.id in self.selected)
            for c in CONTINENTS
        }

    @property
    def top(self) -> _Screen:
        return self.stack[-1]

    def items(self) -> list[Item]:
        screen = self.top.screen
        if screen == "start":
            rest = self.not_installed()
            total = sum(self.by_id[i].bytes for i in rest)
            out = [
                Item(
                    "action",
                    "Everything",
                    "already installed"
                    if not rest
                    else f"{len(rest)} not installed · {human_bytes(total)}",
                    act="all",
                ),
                Item(
                    "group", "Choose what I need", "by language, by country, or search", to="browse"
                ),
            ]
            if self.installed:
                out.append(
                    Item(
                        "group",
                        "Installed packs",
                        f"{len(self.installed)} here · remove any you no longer want",
                        to="installed",
                    )
                )
            return out

        if screen == "browse":
            picked_l = sum(1 for b in self.languages if b.id in self.selected)
            picked_c = sum(1 for b in self.countries if b.id in self.selected)
            out = [
                Item("pack", plain_name(b.name), b.description[:64], id=b.id) for b in self.neither
            ]
            out += [
                Item(
                    "group",
                    "Languages",
                    f"{len(self.languages)} available"
                    + (f" · {picked_l} picked" if picked_l else ""),
                    to="languages",
                ),
                Item(
                    "group",
                    "Countries",
                    f"{len(self.countries)} available"
                    + (f" · {picked_c} picked" if picked_c else ""),
                    to="regions",
                ),
                Item(
                    "group",
                    "Review and install",
                    f"{len(self.selected)} in the basket" if self.selected else "basket is empty",
                    to="review",
                ),
            ]
            return out

        if screen == "languages":
            return [
                Item("pack", plain_name(b.name), f"{b.id} · {self.size_of(b.id)}", id=b.id)
                for b in self.languages
            ]

        if screen == "regions":
            out = []
            for c in CONTINENTS:
                here = self.in_region(c.key)
                picked = sum(1 for b in here if b.id in self.selected)
                out.append(
                    Item(
                        "group",
                        c.name,
                        f"{len(here)} countries" + (f" · {picked} picked" if picked else ""),
                        to=f"region:{c.key}",
                        region=c.key,
                    )
                )
            return out

        if screen == "installed":
            return [
                Item(
                    "pack",
                    plain_name(self.by_id[i].name if i in self.by_id else i),
                    "marked for removal" if i in self.dropping else f"{i} · installed",
                    id=i,
                )
                for i in sorted(self.installed)
            ]

        if screen == "review":
            chosen = sorted(self.selected)
            if not chosen and not self.dropping:
                return []
            total = sum(self.by_id[i].bytes for i in chosen if i in self.by_id)
            out = [
                Item("pack", plain_name(self.by_id[i].name), f"{i} · {self.size_of(i)}", id=i)
                for i in chosen
            ]
            out += [
                Item(
                    "pack",
                    plain_name(self.by_id[i].name if i in self.by_id else i),
                    "will be removed",
                    id=i,
                )
                for i in sorted(self.dropping)
            ]
            what = ", ".join(
                part
                for part in (
                    f"install {len(chosen)}" if chosen else "",
                    f"remove {len(self.dropping)}" if self.dropping else "",
                )
                if part
            )
            out.append(
                Item(
                    "action", f"Apply — {what}", human_bytes(total) if chosen else "", act="confirm"
                )
            )
            return out

        if screen == "search":
            q = self.query.strip().lower()
            if not q:
                return []
            out = []
            for b in self.bundles:
                if q not in b.id and q not in plain_name(b.name).lower():
                    continue
                if b.locale:
                    where = "language"
                elif b.country:
                    where = " / ".join(c.name for c in CONTINENTS if c.key in b.regions)
                else:
                    where = "no language, no country"
                out.append(
                    Item("pack", plain_name(b.name), f"{where} · {self.size_of(b.id)}", id=b.id)
                )
            return out

        key = screen[len("region:") :]
        return [
            Item(
                "pack",
                plain_name(b.name),
                f"{b.id} · {self.size_of(b.id)}"
                + (" · spans two continents" if len(b.regions) > 1 else ""),
                id=b.id,
            )
            for b in self.in_region(key)
        ]

    def title(self) -> str:
        screen = self.top.screen
        titles = {
            "start": "Data packs",
            "browse": "Data packs › Choose",
            "languages": "Data packs › Languages",
            "regions": "Data packs › Countries",
            "installed": "Data packs › Installed",
            "review": "Data packs › Review",
            "search": "Data packs › Search",
        }
        if screen in titles:
            return titles[screen]
        key = screen[len("region:") :]
        name = next((c.name for c in CONTINENTS if c.key == key), key)
        return f"Data packs › Countries › {name}"

    # ── drawing ──

    def render_map(self, w: int, h: int, focused: str | None) -> list[str]:
        land, edge = _raster(w, h)
        counts = self.counts()
        lit: set[int] = set()
        for bundle_id in self.selected:
            point = self.by_id.get(bundle_id)
            point = point.point if point else None
            if point is None:
                continue
            col = round((point[0] - LON_MIN) / (LON_MAX - LON_MIN) * w - 0.5)
            row = round((LAT_MAX - point[1]) / (LAT_MAX - LAT_MIN) * h - 0.5)
            if 0 <= col < w and 0 <= row < h:
                lit.add(row * w + col)

        def shade(index: int) -> str | None:
            # Land you have not chosen is a grey body under a coloured coastline: the shape stays
            # readable, but nothing is filled in until you pick it.
            if index in lit:
                return "1;97"
            key = land[index]
            if key is None:
                return None
            continent = next(c for c in CONTINENTS if c.key == key)
            is_edge = edge[index]
            if key == focused:
                return f"1;{continent.bright}" if is_edge else str(continent.colour)
            if counts.get(key, 0) > 0:
                return str(continent.bright) if is_edge else f"2;{continent.colour}"
            if is_edge:
                return str(continent.colour)
            return "90" if self.body_visible else None

        lines: list[str] = []
        if UNICODE and COLOUR:
            for row in range(0, h, 2):
                line = "  "
                for col in range(w):
                    upper = shade(row * w + col)
                    lower = shade((row + 1) * w + col) if row + 1 < h else None
                    if upper is None and lower is None:
                        line += " "
                    elif upper is not None and lower is not None:
                        # One cell, two pixels: the top is drawn, the bottom becomes its background.
                        background = int(lower.split(";")[-1]) + 10
                        line += f"{ESC}{upper};{background}m▀{ESC}0m"
                    elif upper is not None:
                        line += f"{ESC}{upper}m▀{ESC}0m"
                    else:
                        line += f"{ESC}{lower}m▄{ESC}0m"
                lines.append(line)
        else:
            # No half-blocks, or no colour to tell the two pixels apart: one row per line,
            # coastlines only. Still a world, and it still shows where a pick landed.
            for row in range(h):
                line = "  "
                for col in range(w):
                    index = row * w + col
                    code = shade(index)
                    if code is None or (not COLOUR and not edge[index] and index not in lit):
                        line += " "
                    else:
                        line += f"{ESC}{code}m{GLYPHS['land']}{ESC}0m" if COLOUR else GLYPHS["land"]
                lines.append(line)

        chips = []
        for c in CONTINENTS:
            picked = counts.get(c.key, 0)
            label = f"{c.name} ({picked})" if picked else c.name
            code = f"1;{c.bright}" if c.key == focused else f"2;{c.colour}"
            chips.append(sgr(f"{GLYPHS['chip']} {label}", code))
        lines.append("")
        columns = _terminal_size()[0]
        if columns >= 92:
            lines.append("  " + "   ".join(chips))
        else:
            lines.append("  " + "   ".join(chips[:3]))
            lines.append("  " + "   ".join(chips[3:]))
        return lines

    def draw(self) -> None:
        state = self.top
        items = self.items()
        columns, rows = _terminal_size()

        on_map = state.screen == "regions" or state.screen.startswith("region:")
        size = _map_size(columns, rows, 13) if on_map else None
        chrome = ((size[1] // 2 if UNICODE and COLOUR else size[1]) + 13) if size else 8
        viewport = max(4, min(len(items), rows - chrome))

        # An empty list still has to draw. Clamping only the upper end let the cursor reach -1 on a
        # screen with nothing in it, and the row loop then started below zero.
        state.cursor = min(max(0, state.cursor), max(0, len(items) - 1))
        if state.cursor < state.offset:
            state.offset = state.cursor
        if state.cursor >= state.offset + viewport:
            state.offset = state.cursor - viewport + 1
        state.offset = max(0, state.offset)

        out = [f"{ESC}2J{ESC}H", "", "  " + bold(self.title()), ""]

        if size:
            focused = (
                state.screen[len("region:") :]
                if state.screen.startswith("region:")
                else (items[state.cursor].region if items else None)
            )
            out += self.render_map(size[0], size[1], focused)
            out.append("")

        if state.screen == "search":
            out += ["  Search: " + (bold(self.query) if self.query else dim("type a name…")), ""]

        if not items:
            out.append(
                dim(
                    "  nothing matches"
                    if state.screen == "search"
                    else "  Nothing picked yet — go back and choose something."
                    if state.screen == "review"
                    else "  empty"
                )
            )

        for i in range(state.offset, min(len(items), state.offset + viewport)):
            item = items[i]
            here = i == state.cursor
            mark = "   "
            if item.kind == "pack" and item.id is not None:
                if item.id in self.dropping:
                    mark = bold(f" {GLYPHS['drop']} ")
                elif item.id in self.selected:
                    mark = bold(f" {GLYPHS['on']} ")
                elif item.id in self.installed:
                    mark = dim(f" {GLYPHS['done']} ")
                else:
                    mark = f" {GLYPHS['off']} "
            elif item.kind == "group":
                mark = f" {GLYPHS['group']} "
            label = item.label.ljust(26)
            cursor = bold(GLYPHS["cursor"]) if here else " "
            out.append(f"  {cursor}{mark}{bold(label) if here else label} {dim(item.hint)}")

        if len(items) > viewport:
            shown = f"{state.offset + 1}–{min(len(items), state.offset + viewport)} of {len(items)}"
            out += ["", dim(f"  {shown}")]

        out.append("")
        if state.screen == "search":
            keys = "↑↓ move · enter pick · esc leave search"
        elif state.screen == "review":
            keys = "↑↓ move · space drop · enter apply · backspace back · q cancel"
        elif state.screen == "installed":
            keys = "↑↓ move · space mark for removal · backspace back · q cancel"
        else:
            keys = (
                "↑↓ move · enter open · space pick · / search · m map · backspace back · q cancel"
            )
        out.append(dim("  " + keys))

        if self.selected or self.dropping:
            parts = [
                p
                for p in (
                    f"{len(self.selected)} to install" if self.selected else "",
                    f"{len(self.dropping)} to remove" if self.dropping else "",
                )
                if p
            ]
            out.append("  " + dim("basket: ") + bold(", ".join(parts)))
        if self.flash:
            out += ["", "  " + self.flash]

        sys.stdout.write("\n".join(out) + "\n")
        sys.stdout.flush()

    # ── keys ──

    def toggle(self, bundle_id: str) -> None:
        if self.top.screen == "installed" or bundle_id in self.dropping:
            self.dropping.symmetric_difference_update({bundle_id})
            return
        if bundle_id in self.installed:
            self.flash = dim(f"{bundle_id} is already installed")
            return
        self.selected.symmetric_difference_update({bundle_id})

    def run(self) -> Decision | None:
        with _raw_terminal():
            sys.stdout.write(f"{ESC}?25l")
            try:
                return self._loop()
            finally:
                sys.stdout.write(f"{ESC}?25h{ESC}2J{ESC}H")
                sys.stdout.flush()

    def _loop(self) -> Decision | None:
        while True:
            self.draw()
            key = _read_key()
            state = self.top
            items = self.items()
            self.flash = ""

            if key == "quit":
                return None

            if state.screen == "search":
                if key == "escape":
                    self.stack.pop()
                    self.query = ""
                    continue
                if key == "backspace":
                    self.query = self.query[:-1]
                    state.cursor = 0
                    continue
                if key == "space":
                    self.query += " "
                    state.cursor = 0
                    continue
                if key == "enter":
                    if items and items[state.cursor].id:
                        self.toggle(items[state.cursor].id or "")
                    continue
                if len(key) == 1 and key.isprintable():
                    self.query += key
                    state.cursor = 0
                    continue

            if key == "q":
                return None
            if key == "up":
                state.cursor = max(0, state.cursor - 1)
            elif key == "down":
                state.cursor = max(0, min(len(items) - 1, state.cursor + 1))
            elif key == "pageup":
                state.cursor = max(0, state.cursor - 10)
            elif key == "pagedown":
                state.cursor = max(0, min(len(items) - 1, state.cursor + 10))
            elif key == "home":
                state.cursor = 0
            elif key == "end":
                state.cursor = max(0, len(items) - 1)
            elif key == "m":
                self.body_visible = not self.body_visible
                self.flash = dim("land filled" if self.body_visible else "coastlines only")
            elif key == "/":
                self.stack.append(_Screen("search"))
                self.query = ""
            elif key == "space":
                item = items[state.cursor] if items else None
                if item and item.kind == "pack" and item.id:
                    self.toggle(item.id)
                elif item and item.kind == "group" and (item.to or "").startswith("region:"):
                    # Space on a continent takes the whole continent — "all of Africa" in one key.
                    here = [
                        b
                        for b in self.in_region((item.to or "")[len("region:") :])
                        if b.id not in self.installed
                    ]
                    everything = all(b.id in self.selected for b in here)
                    for b in here:
                        self.selected.discard(b.id) if everything else self.selected.add(b.id)
                    self.flash = dim("continent cleared" if everything else "whole continent added")
            elif key == "enter":
                item = items[state.cursor] if items else None
                if item is None:
                    continue
                if item.kind == "group" and item.to:
                    self.stack.append(_Screen(item.to))
                elif item.kind == "action" and item.act == "all":
                    self.selected.update(self.not_installed())
                    self.stack.append(_Screen("review"))
                elif item.kind == "action" and item.act == "confirm":
                    return Decision(sorted(self.selected), sorted(self.dropping))
            elif key in ("backspace", "escape", "left") and len(self.stack) > 1:
                self.stack.pop()


def _terminal_size() -> tuple[int, int]:
    try:
        size = os.get_terminal_size()
        return size.columns, size.lines
    except OSError:
        return 80, 24


class _raw_terminal:  # noqa: N801 — a context manager, used lowercase like `open`
    """stdin in raw mode for the life of the picker, and exactly as it was afterwards.

    Windows has no termios; there the console is already delivering keys one at a time through
    msvcrt, so there is nothing to switch off.
    """

    def __enter__(self) -> None:
        self.saved = None
        if sys.platform == "win32" or not sys.stdin.isatty():
            return
        import termios
        import tty

        self.saved = termios.tcgetattr(sys.stdin.fileno())
        tty.setraw(sys.stdin.fileno())

    def __exit__(self, *exc: object) -> None:
        if self.saved is None:
            return
        import termios

        termios.tcsetattr(sys.stdin.fileno(), termios.TCSADRAIN, self.saved)
