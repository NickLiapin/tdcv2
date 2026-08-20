"""The public surface: what a caller actually touches."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tdcv2 import TDC
from tdcv2.errors import Severity, TdcError

REPO = Path(__file__).resolve().parents[2]
PACKS = REPO / "data" / "packs"

CONFIG = (
    '<tdc><env count="4" seed="api" local="en" mode="memory">'
    '<sequence name="Gender"><gen type="text" value="Male,Female" percent="50,50"/></sequence>'
    '<sequence name="Age"><gen type="number" value="20..60"/></sequence>'
    '<sequence name="Address"><gen type="text" name="City" value="Praha,Brno"/>'
    '<gen type="text" name="Zip" value="11000,60200"/></sequence>'
    "</env><block><line><data>${{Gender}},${{Age}}</data></line></block></tdc>"
)


def _tdc(**kwargs) -> TDC:
    return TDC(config_string=CONFIG, packs_dir=PACKS, **kwargs)


def test_the_text_and_the_rows_are_the_same_run() -> None:
    tdc = _tdc()
    lines = str(tdc).split("\n")[:-1]
    assert [f"{row['Gender']},{row['Age']}" for row in tdc] == lines


def test_a_row_addresses_its_sequences_by_name() -> None:
    row = _tdc()[0]
    assert row["Gender"] in ("Male", "Female")
    assert row.index == 0
    assert row.get("NoSuchSequence") is None


def test_a_compound_reads_as_one_thing_with_parts() -> None:
    row = _tdc()[0]
    assert row["Address.City"] in ("Praha", "Brno")
    nested = row.nested()
    assert set(nested["Address"]) == {"City", "Zip"}
    assert nested["Gender"] == row["Gender"]


def test_the_run_is_generated_once_however_it_is_asked_for() -> None:
    tdc = _tdc()
    first = str(tdc)
    rows = tdc.to_list()
    assert str(tdc) == first
    assert rows[0]["Gender"] == tdc[0]["Gender"]


def test_the_same_seed_gives_the_same_data() -> None:
    assert str(_tdc()) == str(_tdc())


UNSEEDED = (
    '<tdc><env count="8" mode="memory"><sequence name="N">'
    '<gen type="number" value="1..999999"/></sequence></env>'
    "<block><line><data>${{N}}</data></line></block></tdc>"
)


def test_a_run_that_names_no_seed_gets_a_fresh_one_and_says_what_it_was() -> None:
    """A generated seed has to BE a seed, and has to be the way back to the run it made."""
    first = TDC(config_string=UNSEEDED)
    assert first.seed_info().generated
    # An empty one would make the advice to re-run with it reproduce nothing.
    assert first.seed_info().seed != ""

    # A seedless run is a fresh sample every time, as it is in the reference.
    second = TDC(config_string=UNSEEDED)
    assert first.seed_info().seed != second.seed_info().seed
    assert str(first) != str(second)

    # And the reported seed is the way back to it — the only reason to report it.
    replayed = TDC(config_string=UNSEEDED, seed=first.seed_info().seed)
    assert str(replayed) == str(first)
    assert not replayed.seed_info().generated


def test_an_override_wins_over_what_the_config_declared() -> None:
    assert _tdc(count=2).count == 2
    assert _tdc(seed="other").seed_info().seed == "other"
    # Code over file: a test that pins a seed needs that value to hold even when the config it
    # borrowed carries one of its own.
    assert str(_tdc(seed="other")) != str(_tdc())


def test_a_config_that_does_not_parse_says_so() -> None:
    # The failure arrives as diagnostics, not as prose: that is what lets the command line draw
    # the offending line rather than only quote the message.
    with pytest.raises(TdcError) as caught:
        TDC(config_string="<tdc><env", packs_dir=PACKS)
    assert caught.value.diagnostics
    assert caught.value.source == "<tdc><env"


def test_a_config_the_reference_refuses_is_refused_here_too() -> None:
    # A validation error stops the constructor: the two implementations have to disagree about
    # nothing, including which configs are legal.
    with pytest.raises(TdcError) as caught:
        TDC(
            config_string='<tdc><env count="1"><sequence name="A"><gen type="text"/></sequence>'
            "</env><block><line><data>x</data></line></block></tdc>",
            packs_dir=PACKS,
        )
    # The code is on the diagnostic, not in the prose — the wording is deliberately free to vary
    # between the implementations, and the code is not.
    assert any(d.code == "TDC050" for d in caught.value.diagnostics)


def test_a_warning_is_reported_rather_than_raised() -> None:
    tdc = TDC(
        config_string='<tdc><env count="1"><sequence name="A"><gen type="text" value="x"/>'
        "</sequence>"
        '<switch name="S" on="A"><map>nocolon</map></switch>'
        "</env><block><line><data>${{S}}</data></line></block></tdc>",
        packs_dir=PACKS,
    )
    assert [d.code for d in tdc.diagnostics] == ["TDC136"]
    assert tdc.diagnostics[0].severity is Severity.WARNING


def test_exactly_one_source_is_required() -> None:
    with pytest.raises(ValueError, match="exactly one"):
        TDC()
    with pytest.raises(ValueError, match="exactly one"):
        TDC("somewhere.tdc", config_string=CONFIG)


def test_a_config_read_from_a_file_resolves_its_sources_next_to_itself(tmp_path: Path) -> None:
    (tmp_path / "codes.txt").write_text("alpha\nbeta\n", encoding="utf-8")
    config = tmp_path / "run.tdc"
    config.write_text(
        '<tdc><env count="2" seed="s" mode="memory">'
        '<sequence name="C"><gen type="file" src="./codes.txt"/></sequence>'
        "</env><block><line><data>${{C}}</data></line></block></tdc>",
        encoding="utf-8",
    )
    produced = str(TDC(config, packs_dir=PACKS)).split("\n")[:-1]
    assert all(value in ("alpha", "beta") for value in produced)


def test_the_engine_a_config_lands_on_is_visible() -> None:
    assert _tdc().engine() == 1  # mode="memory"
    streaming = TDC(config_string=CONFIG.replace('mode="memory"', ""), packs_dir=PACKS)
    assert streaming.engine() == 2  # no mode at all means disk, and nothing needs exactness


def test_naming_an_engine_overrides_the_config() -> None:
    assert _tdc(engine=2).engine() == 2


def test_the_clock_can_be_pinned_so_a_date_test_survives_tomorrow() -> None:
    config = (
        '<tdc><env count="1" seed="s" mode="memory">'
        '<sequence name="D"><gen type="date" value="today" format="ISO"/></sequence>'
        "</env><block><line><data>${{D}}</data></line></block></tdc>"
    )
    tdc = TDC(config_string=config, now=1776945600000, packs_dir=PACKS)
    assert str(tdc) == "2026-04-23\n"


def test_a_config_with_no_service_is_not_a_network_run() -> None:
    assert _tdc().uses_http() is False


def test_a_run_this_size_needs_no_warning() -> None:
    assert _tdc().preflight() is None


def test_writing_a_file_produces_what_the_string_would_have(tmp_path: Path) -> None:
    tdc = _tdc()
    target = tmp_path / "out.csv"
    tdc.write_file(target)
    assert target.read_text(encoding="utf-8") == str(tdc)


def test_a_parquet_extension_switches_the_format(tmp_path: Path) -> None:
    config = (
        '<tdc><env count="3" seed="s" mode="memory">'
        '<sequence name="Id"><gen type="increment" value="1"/></sequence>'
        '</env><block><line><data name="id">${{Id}}</data></line></block></tdc>'
    )
    target = tmp_path / "out.parquet"
    TDC(config_string=config, packs_dir=PACKS).write_file(target)
    data = target.read_bytes()
    assert data[:4] == b"PAR1"
    assert data[-4:] == b"PAR1"


def test_the_seed_says_whether_the_config_supplied_one() -> None:
    assert _tdc().seed_info().generated is False
    bare = TDC(
        config_string='<tdc><env count="1"><sequence name="A"><gen type="text" value="x"/>'
        "</sequence></env><block><line><data>${{A}}</data></line></block></tdc>",
        packs_dir=PACKS,
    )
    assert bare.seed_info().generated is True


def test_the_repository_readme_example_still_runs() -> None:
    """A run through the whole stack: packs, a compound, a template and a computed value."""
    config = (
        '<tdc><env count="3" seed="readme" local="en" mode="memory">'
        '<sequence name="Name"><gen type="template" value="person.male.firstName"/></sequence>'
        '<sequence name="Id"><gen type="increment" value="1000"/></sequence>'
        '<sequence name="Tag"><compute><result><concat>'
        '<upper><field name="Name"/></upper><str v="-"/><field name="Id"/>'
        "</concat></result></compute></sequence>"
        "</env><block><line><data>${{Tag}}</data></line></block></tdc>"
    )
    produced = str(TDC(config_string=config, packs_dir=PACKS)).split("\n")[:-1]
    assert len(produced) == 3
    assert all("-" in line and line.split("-")[0].isupper() for line in produced)


SHARED = REPO / "fixtures" / "cross-language"


def _shared_documents(kind: str) -> list[tuple[Path, dict]]:
    """Every shared fixture file of one kind, parsed.

    A missing directory or an unparseable file fails here rather than one test further on, where
    it would arrive as a confusing assertion about a case nobody wrote.
    """
    directory = SHARED / kind
    files = sorted(directory.glob("*.json"))
    assert files, f"no shared fixtures under {directory}"
    return [(path, json.loads(path.read_text(encoding="utf-8"))) for path in files]


# What both harnesses in this suite read off a case. `test_cases.py` renders `config` and compares
# it to `expected`; `test_diagnostics.py` validates `config` and compares the signatures. Neither
# can tell a case it silently skipped from a case that passed, which is what these guard.
_REQUIRED = {
    "cases": ("name", "description", "config"),
    "diagnostics": ("name", "description", "config", "demonstrates"),
}


@pytest.mark.parametrize("kind", ["cases", "diagnostics"])
def test_every_shared_fixture_file_parses_and_carries_cases(kind: str) -> None:
    """A file emptied or truncated leaves a parametrized suite green over nothing.

    Deliberately a statement about SHAPE and not about how many cases there are. A total was what
    stood here, and it collided: every worker who added a fixture had to bump one shared number,
    and two doing so at once bumped it to two different values. It also never caught anything the
    per-case assertions missed — the thing worth guarding is that every file is still readable and
    still holds cases, and that is true at any size.
    """
    for path, document in _shared_documents(kind):
        assert document["schemaVersion"] == 1, path.name
        assert isinstance(document["cases"], list), path.name
        assert document["cases"], f"{path.name} holds no cases"


@pytest.mark.parametrize("kind", ["cases", "diagnostics"])
def test_every_shared_case_carries_what_the_harness_reads(kind: str) -> None:
    for path, document in _shared_documents(kind):
        for case in document["cases"]:
            where = f"{path.name} / {case.get('name', '?')}"
            for field in _REQUIRED[kind]:
                assert isinstance(case.get(field), str), f"{where}: {field} is missing"
            for field in ("name", "config"):
                assert case[field].strip(), f"{where}: {field} is empty"
            assert isinstance(case["expected"], list), where
            assert all(isinstance(line, str) for line in case["expected"]), where
            # A rendered case with no expectation asserts nothing. Among the diagnostics an empty
            # list IS the assertion — that config earns no complaint — so only `cases` is held to
            # having something to compare against.
            if kind == "cases":
                assert case["expected"], f"{where}: expects nothing"


@pytest.mark.parametrize("kind", ["cases", "diagnostics"])
def test_no_two_shared_cases_in_one_file_share_a_name(kind: str) -> None:
    # Both harnesses identify a case as "<file>/<name>", so a duplicate is two tests reported
    # under one id — and a fixture pasted over its neighbour would read as a passing suite.
    for path, document in _shared_documents(kind):
        names = [case["name"] for case in document["cases"]]
        assert len(set(names)) == len(names), f"{path.name}: duplicate case names"


def test_to_columns_agrees_with_the_text_output() -> None:
    """The numeric way out says the same thing as the text one — a second way to read one run."""
    config = (
        '<tdc><env count="4" seed="c">'
        '<sequence name="N"><gen type="increment" value="1"/></sequence>'
        '<sequence name="MV"><gen type="formula" expr="gauss(N, 2, 1)"/></sequence>'
        '<sequence name="Label"><gen type="text" value="a,b" percent="50,50"/></sequence>'
        "</env><block><line><data>${{N}}</data></line></block></tdc>"
    )
    tdc = TDC(config_string=config)
    columns = tdc.to_columns()
    rows = [r for r in str(tdc).split("\n") if r]

    assert len(rows) == 4
    # A column of numbers is an array of doubles; anything else stays as it was.
    assert columns["N"].typecode == "d"
    assert columns["MV"].typecode == "d"
    assert not hasattr(columns["Label"], "typecode")
    # The numbers are the same doubles the text prints, not a rounding of them.
    for i, line in enumerate(rows):
        assert columns["N"][i] == float(line)
