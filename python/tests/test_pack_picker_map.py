"""The pack picker's map, against the shared fixture.

The picker is about 5,600 lines across the five implementations and had no test at all — the
largest untested surface in the project. Most of it is a terminal loop, and a loop that reads
keys is not something a fixture can hold. Its geometry is, and geometry is the part five copies
of a coordinate table can quietly disagree about: each implementation keeps its own continent
outlines, so one hand-edited number would move a coastline in one language and nowhere else.

The tables were identical when this was written — measured, all six continents, every number.
The point PROJECTION was not: Python's ``round`` breaks a tie to the even number, and 58
(country, map size) pairs among the 198 that ship land on exactly a tie.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tdcv2.cli.pack_picker import map_cell, map_rows, map_size

FIXTURE = Path(__file__).resolve().parents[2] / "fixtures" / "cross-language" / "pack-picker.json"
DATA = json.loads(FIXTURE.read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", DATA["mapSizes"])
def test_fits_the_map_to_the_terminal(case):
    got = map_size(case["columns"], case["rows"], case["reserved"], case["halfBlocks"])
    want = case["size"]
    assert got == (None if want is None else (want["w"], want["h"]))


@pytest.mark.parametrize("case", DATA["rasters"], ids=lambda c: f"{c['w']}x{c['h']}")
def test_rasterises_the_continents_to_the_same_pixels(case):
    assert map_rows(case["w"], case["h"]) == case["rows"]


@pytest.mark.parametrize("case", DATA["points"], ids=lambda c: f"{c['name']}@{c['w']}x{c['h']}")
def test_puts_a_country_where_the_country_is(case):
    got = map_cell(case["lon"], case["lat"], case["w"], case["h"])
    want = case["cell"]
    assert got == (None if want is None else (want["col"], want["row"]))


def test_the_frame_is_half_open():
    # Its top-left corner is on the map and its bottom-right is just past it, the way a pixel
    # grid works. All five agree on both.
    assert map_cell(-170, 84, 56, 22) == (0, 0)
    assert map_cell(190, -56, 56, 22) is None
    assert map_cell(189, -55, 56, 22) == (55, 21)
    assert map_cell(0, 90, 56, 22) is None
    assert map_cell(0, -90, 56, 22) is None


def test_half_blocks_buy_height():
    half = map_size(120, 40, 13, True)
    full = map_size(120, 40, 13, False)
    assert half is not None and full is not None
    assert half[0] > full[0]


def test_refuses_to_draw_rather_than_squash():
    assert map_size(59, 200, 0, True) is None  # narrower than the smallest map
    assert map_size(200, 14, 13, True) is None  # no room for the list beside it
