"""The Parquet writer, held to the reference's bytes.

Not "a reader can open it" — the same length and the same digest. Two Parquet writers can both be
correct and disagree byte for byte, because the format leaves compression and encoding choices to
whoever writes. This project promises the files match, and a digest is the only thing that checks
it.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import pytest

from tdcv2 import TDC
from tdcv2.output import parquet_output

REPO = Path(__file__).resolve().parents[2]
FIXTURE = REPO / "fixtures" / "cross-language" / "parquet.json"

_DOCUMENT = json.loads(FIXTURE.read_text(encoding="utf-8"))
_CASES = _DOCUMENT["cases"]

# The clock the fixture was rendered with: 2026-04-23T12:00:00Z.
NOW = 1776945600000


def _base_dir(case: dict) -> Path | None:
    """A case with `dataPath` names a folder under `cases/` holding the files it reads."""
    data_path = case.get("dataPath")
    return FIXTURE.parent / "cases" / data_path if data_path else None


@pytest.mark.parametrize("case", _CASES, ids=[c["name"] for c in _CASES])
def test_the_writer_produces_the_reference_bytes(case: dict) -> None:
    tdc = TDC(
        config_string=case["config"],
        now=NOW,
        packs_dir=REPO / "data" / "packs",
        base_dir=_base_dir(case),
    )
    produced = parquet_output.to_bytes(tdc.config, tdc.rows())

    assert len(produced) == case["size"], case["description"]
    assert hashlib.sha256(produced).hexdigest() == case["sha256"], case["description"]


def test_the_file_starts_and_ends_with_the_magic() -> None:
    tdc = TDC(config_string=_CASES[0]["config"], now=NOW, packs_dir=REPO / "data" / "packs")
    produced = parquet_output.to_bytes(tdc.config, tdc.rows())
    assert produced[:4] == b"PAR1"
    assert produced[-4:] == b"PAR1"


def test_a_block_with_no_named_data_has_no_columns_to_write() -> None:
    config = (
        '<tdc><env count="2" seed="s"><sequence name="A"><gen type="text" value="x"/></sequence>'
        "</env><block><line><data>${{A}}</data></line></block></tdc>"
    )
    tdc = TDC(config_string=config, now=NOW)
    with pytest.raises(ValueError, match="at least one named column"):
        parquet_output.to_bytes(tdc.config, tdc.rows())
