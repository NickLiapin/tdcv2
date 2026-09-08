"""A fixed ``repeat="N"`` beside ``order="sequential"`` — a row of values walked in order.

The shared fixtures pin what the walk PRODUCES. What only lives here is the pair of things a
rendering fixture cannot express: the refusal when the source runs out under ``cycle="false"``,
and the equality between ``repeat="1"`` and the plain walk — a claim about two configs, which
is only checked when both are run and compared.
"""

from __future__ import annotations

import pytest

from tdcv2.engine.memory import EngineError
from tdcv2.tdc import TDC

NOW = 1777032000000  # 2026-04-23T12:00:00Z, the fixed instant every implementation shares


def rows(gen: str, count: int, mode: str = "memory") -> list[str]:
    config = (
        f'<tdc><env count="{count}" seed="s" local="en" mode="{mode}">'
        f'<sequence name="V">{gen}</sequence></env>'
        "<block><line><data>${{V}}</data></line></block></tdc>"
    )
    return str(TDC(config_string=config, now=NOW)).rstrip("\n").split("\n")


def walked(value: str, extra: str = "") -> str:
    return f'<gen type="text" value="{value}" order="sequential"{extra}/>'


def test_a_repeat_that_matches_the_list_gives_every_row_the_whole_list() -> None:
    assert rows(walked("created,paid,shipped,delivered", ' repeat="4"'), 3) == [
        "created,paid,shipped,delivered"
    ] * 3


def test_the_walk_carries_on_across_rows_rather_than_restarting() -> None:
    # The part a single row cannot show: restarting would print `a,b` three times and pass any
    # test that only looked at row 0.
    assert rows(walked("a,b,c", ' repeat="2"'), 3) == ["a,b", "c,a", "b,c"]


def test_repeat_one_is_exactly_the_plain_walk() -> None:
    # The property that makes carrying on a generalisation rather than a second meaning.
    assert rows(walked("a,b,c", ' repeat="1"'), 6) == rows(walked("a,b,c"), 6)
    assert rows(walked("a,b,c", ' repeat="1"'), 6) == ["a", "b", "c", "a", "b", "c"]


def test_the_two_engines_walk_the_same_way() -> None:
    assert rows(walked("a,b,c", ' repeat="2"'), 8, "disk") == rows(
        walked("a,b,c", ' repeat="2"'), 8, "memory"
    )


def test_a_custom_separator_joins_the_row() -> None:
    assert rows(walked("a,b,c", ' repeat="2" separator=" | "'), 2) == ["a | b", "c | a"]


def test_running_out_under_cycle_false_names_the_element_as_well_as_the_row() -> None:
    # The message has to name a position in the WALK, not a row number that is really an
    # element index — that would send a reader to the wrong attribute.
    with pytest.raises(EngineError, match=r"row 3 runs out at element 2"):
        rows(walked("a,b,c,d,e", ' repeat="2" cycle="false"'), 5)
