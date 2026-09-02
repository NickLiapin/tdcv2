"""Sizes people can read.

The bug this replaces: ``pack list`` divided by 1,048,576 and printed one
decimal, so a 3 KB pack and a 9 KB pack both read ``0.0 MB`` and the whole
catalogue looked like it weighed nothing. These cases pin the boundaries, and
the shared CLI fixture pins that all five implementations agree.
"""

from __future__ import annotations

import pytest

from tdcv2.human_bytes import human_bytes


def test_says_bytes_in_bytes_rather_than_a_fraction_of_a_kilobyte() -> None:
    # The case that started this: below a kilobyte there IS no sensible
    # fraction, so the unit has to change instead of the precision.
    assert human_bytes(1) == "1 B"
    assert human_bytes(800) == "800 B"
    assert human_bytes(1023) == "1023 B"


@pytest.mark.parametrize("size", [1, 9, 99, 512, 1024, 2710, 9999])
def test_never_prints_zero_point_zero_for_a_file_that_exists(size: int) -> None:
    assert not human_bytes(size).startswith("0.0")


def test_keeps_a_decimal_below_a_hundred() -> None:
    assert human_bytes(1024) == "1.0 KB"
    assert human_bytes(2710) == "2.6 KB"  # the smallest shipped pack
    assert human_bytes(10_240) == "10.0 KB"
    assert human_bytes(99_000) == "96.7 KB"


def test_drops_the_decimal_at_a_hundred_where_it_is_noise() -> None:
    assert human_bytes(102_400) == "100 KB"
    assert human_bytes(253_515) == "248 KB"  # the largest shipped pack


def test_climbs_a_unit_when_it_should() -> None:
    assert human_bytes(1_048_576) == "1.0 MB"
    assert human_bytes(1_572_864) == "1.5 MB"
    assert human_bytes(1_073_741_824) == "1.0 GB"
    assert human_bytes(34_359_738_368) == "32.0 GB"
    assert human_bytes(1_099_511_627_776) == "1.0 TB"


def test_promotes_rather_than_printing_1024_of_a_unit() -> None:
    # 1023.999 KB rounds to a whole 1024 KB, which nobody writes.
    assert human_bytes(1_073_741_823) == "1.0 GB"
    assert human_bytes(1_048_575) == "1.0 MB"


def test_answers_a_nonsense_number_instead_of_throwing_at_it() -> None:
    assert human_bytes(0) == "0 B"
    assert human_bytes(-1) == "0 B"
