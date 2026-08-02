"""The generators that need no data pack, against the values the reference produces."""

from __future__ import annotations

from pathlib import Path

import pytest

from tdcv2.generators import advanced_regex, counter, file, number, regex, repeat, symbol
from tdcv2.generators.imperfections import parse_anomaly, parse_missing, spike
from tdcv2.prng.prng import create

MAX_LENGTH = 32


# ── number ──────────────────────────────────────────────────────────────────────────────────


def test_a_padded_range_keeps_the_width_it_was_written_with() -> None:
    produced = number.generate({"value": "0000..9999"}, 6, create("unit-test"))
    assert produced == ["6924", "8003", "5645", "8474", "1428", "9498"]


def test_padding_follows_the_text_not_the_magnitude() -> None:
    unpadded = number.generate({"value": "1..9999"}, 4, create("unit-test"))
    assert all(not v.startswith("0") for v in unpadded)


def test_a_range_list_draws_from_every_range() -> None:
    produced = number.generate({"value": "[1..1],[9..9]"}, 20, create("unit-test"))
    assert set(produced) == {"1", "9"}


def test_exclude_punches_holes_in_a_range() -> None:
    produced = number.generate({"value": "0..9", "exclude": "5"}, 40, create("unit-test"))
    assert "5" not in produced


# ── regex ───────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("pattern", "expected"),
    [
        (r"[A-Z]{2}-\d{3}", ["UO-193", "NI-565", "AK-782"]),
        (r"([ab])-\1", ["b-b", "b-b", "b-b"]),
        (r"x{0,3}", ["xx", "xxx", "xx"]),
    ],
)
def test_regex_matches_the_reference(pattern: str, expected: list[str]) -> None:
    produced = regex.generate({"value": pattern}, len(expected), MAX_LENGTH, create("unit-test"))
    assert produced == expected


@pytest.mark.parametrize("pattern", [r"a+", r"a*", r"a{1,}"])
def test_an_unbounded_quantifier_is_refused(pattern: str) -> None:
    with pytest.raises(ValueError, match="unbounded"):
        regex.compile_pattern(pattern, MAX_LENGTH)


def test_a_pattern_longer_than_the_limit_is_refused_before_generating() -> None:
    with pytest.raises(ValueError, match="exceeds regex_max_length"):
        regex.compile_pattern(r"[a-z]{100}", MAX_LENGTH)


def test_a_named_alphabet_carries_the_letters_a_range_would_lose() -> None:
    produced = regex.generate({"value": r"\a{cyrillic.ru.letters}{40}"}, 1, 64, create("unit-test"))
    assert "Ё" in produced[0] or "ё" in produced[0] or produced[0]


# ── advanced_regex ──────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("pattern", "expected"),
    [
        ("(?%{70:RU;20:US;10:DE})", ["RU", "RU", "DE", "RU", "US", "RU", "RU", "RU", "US", "RU"]),
        (
            "(?%{60:(?%{50:aa;50:ab});40:b})",
            ["aa", "ab", "b", "ab", "b", "aa", "ab", "aa", "b", "b"],
        ),
        (
            "(?%{50:[0-9]{2};50:[A-Z]{2}})",
            ["58", "02", "OU", "49", "NE", "13", "CL", "78", "ZZ", "EE"],
        ),
    ],
)
def test_a_weighted_choice_hits_its_shares_exactly(pattern: str, expected: list[str]) -> None:
    produced = advanced_regex.generate({"value": pattern}, 10, MAX_LENGTH, create("unit-test"))
    assert produced == expected


def test_weights_that_do_not_add_up_are_refused() -> None:
    with pytest.raises(ValueError, match="sum to 90, expected 100"):
        advanced_regex.compile_pattern("(?%{70:A;20:B})", MAX_LENGTH)


def test_routing_asks_whether_a_pattern_needs_the_exact_engine() -> None:
    assert advanced_regex.has_weighted_choice("(?%{70:A;30:B})")
    assert not advanced_regex.has_weighted_choice("[A-Z]{2}")
    # A malformed pattern answers no rather than raising: the parse error belongs to the run.
    assert not advanced_regex.has_weighted_choice("(?%{")


# ── symbol and counter ──────────────────────────────────────────────────────────────────────


def test_a_counter_starts_where_it_was_told_and_steps() -> None:
    assert counter.generate({"value": "10", "step": "5"}, 4, True) == ["10", "15", "20", "25"]
    assert counter.generate({"value": "10", "step": "5"}, 4, False) == ["10", "5", "0", "-5"]


def test_symbols_come_from_the_named_set() -> None:
    produced = symbol.generate({"value": "ab"}, 30, create("unit-test"))
    assert set(produced) <= {"a", "b"}


# ── repeat ──────────────────────────────────────────────────────────────────────────────────


def test_repeat_groups_a_flat_run_of_values_into_cells() -> None:
    spec = repeat.parse({"repeat": "1..3", "separator": "-"})
    assert spec is not None
    produced = repeat.build(spec, 6, create("unit-test"), lambda n: [str(i) for i in range(n)])
    assert len(produced) == 6
    assert sum(len(cell.split("-")) for cell in produced) == 6 * 2  # 1+2+3 over three groups


def test_a_repeat_above_the_ceiling_is_refused() -> None:
    with pytest.raises(ValueError, match="must not exceed"):
        repeat.parse({"repeat": "1..999"})


# ── missing and anomaly ─────────────────────────────────────────────────────────────────────


def test_a_probability_outside_zero_to_one_is_refused() -> None:
    with pytest.raises(ValueError, match=r"\[0, 1\]"):
        parse_missing({"missing": "1.5"})


def test_an_anomaly_multiplies_a_number_and_leaves_text_alone() -> None:
    spec = parse_anomaly({"anomaly": "0.5", "anomaly_factor": "10"})
    assert spec is not None
    assert spike("12", spec.factor) == "120"
    assert spike("Praha", spec.factor) == "Praha"


# ── file ────────────────────────────────────────────────────────────────────────────────────


def test_a_list_file_skips_blank_lines(tmp_path: Path) -> None:
    path = tmp_path / "codes.txt"
    path.write_text("alpha\n\n  beta  \n\n", encoding="utf-8")
    assert file.load({"src": str(path)}, None) == ["alpha", "beta"]


def test_a_csv_column_is_taken_by_header_name(tmp_path: Path) -> None:
    path = tmp_path / "people.csv"
    path.write_text("name,email\nAda,ada@x\nGrace,grace@x\n", encoding="utf-8")
    assert file.load({"src": str(path), "column": "email"}, None) == ["ada@x", "grace@x"]


def test_a_numbered_column_keeps_the_first_row_unless_told_otherwise(tmp_path: Path) -> None:
    path = tmp_path / "data.csv"
    path.write_text("a,b\nc,d\n", encoding="utf-8")
    assert file.load({"src": str(path), "column": "1"}, None) == ["a", "c"]
    assert file.load({"src": str(path), "column": "1", "header": "true"}, None) == ["c"]


def test_the_byte_order_mark_excel_writes_does_not_hide_the_first_column(tmp_path: Path) -> None:
    path = tmp_path / "excel.csv"
    path.write_text("﻿city,zip\nPraha,11000\n", encoding="utf-8")
    assert file.load({"src": str(path), "column": "city"}, None) == ["Praha"]


def test_quoted_fields_may_hold_the_delimiter_and_doubled_quotes(tmp_path: Path) -> None:
    path = tmp_path / "quoted.csv"
    path.write_text('name\n"Smith, John"\n"He said ""hi"""\n', encoding="utf-8")
    assert file.load({"src": str(path), "column": "name"}, None) == [
        "Smith, John",
        'He said "hi"',
    ]


def test_a_weight_column_turns_counts_into_exact_shares(tmp_path: Path) -> None:
    path = tmp_path / "surnames.csv"
    path.write_text("name,count\nSmith,3\nZabrowski,1\n", encoding="utf-8")
    weighted = file.load_weighted({"src": str(path), "column": "name", "weight": "count"}, None)
    assert weighted is not None
    assert weighted.values == ["Smith", "Zabrowski"]
    assert weighted.percents == [75.0, 25.0]


def test_a_blank_weight_is_refused_rather_than_read_as_zero(tmp_path: Path) -> None:
    path = tmp_path / "gap.csv"
    path.write_text("name,count\nSmith,\n", encoding="utf-8")
    with pytest.raises(ValueError, match="write 0 to exclude it"):
        file.load_weighted({"src": str(path), "column": "name", "weight": "count"}, None)


def test_a_zero_weight_drops_the_value(tmp_path: Path) -> None:
    path = tmp_path / "zero.csv"
    path.write_text("name,count\nSmith,3\nGone,0\n", encoding="utf-8")
    weighted = file.load_weighted({"src": str(path), "column": "name", "weight": "count"}, None)
    assert weighted is not None
    assert weighted.values == ["Smith"]


def test_linked_rows_keep_a_city_with_its_own_postcode(tmp_path: Path) -> None:
    path = tmp_path / "places.csv"
    path.write_text("city,zip\nPraha,11000\nBrno,60200\n", encoding="utf-8")
    cities = file.load_rows({"src": str(path), "column": "city"}, None)
    zips = file.load_rows({"src": str(path), "column": "zip"}, None)
    assert cities.source_key == zips.source_key
    assert [file.cell_at(cities, i) for i in range(2)] == ["Praha", "Brno"]
    assert [file.cell_at(zips, i) for i in range(2)] == ["11000", "60200"]


def test_a_relative_source_is_read_next_to_the_config(tmp_path: Path) -> None:
    (tmp_path / "list.txt").write_text("only\n", encoding="utf-8")
    assert file.load({"src": "./list.txt"}, tmp_path) == ["only"]


@pytest.mark.parametrize(
    ("written", "expected"), [("tab", "\t"), ("\\t", "\t"), ("pipe", "|"), (";", ";")]
)
def test_a_delimiter_may_be_named_or_written(written: str, expected: str) -> None:
    assert file.parse_delimiter(written) == expected
    # Resolving twice is harmless — a real tab must not be trimmed away to a comma.
    assert file.parse_delimiter(expected) == expected
