"""A run's output reaches its destination whole, or not at all.

The shared CLI fixture pins what matters most — a failed run leaves the previous file byte for
byte, for text, Parquet and a parallel run. These pin the edges a config cannot reach: a link
stays a link, a device is written in place, and a failure halfway takes its partial file with it.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from tdcv2.output.atomic import open_atomically, partial_path


def test_replaces_the_destination_only_when_the_write_finishes(tmp_path: Path) -> None:
    out = tmp_path / "out.csv"
    out.write_text("old\n")
    with open_atomically(out, "w") as f:
        f.write("new\n")
        f.flush()
        assert out.read_text() == "old\n"  # mid-write, the destination is still the old file
        assert partial_path(out).exists()
    assert out.read_text() == "new\n"
    assert not partial_path(out).exists()


def test_a_failure_halfway_leaves_the_destination_and_no_partial_file(tmp_path: Path) -> None:
    out = tmp_path / "out.csv"
    out.write_text("old\n")
    with pytest.raises(ValueError, match="row 3 refused"), open_atomically(out, "w") as f:
        f.write("half of a ")
        raise ValueError("row 3 refused")
    assert out.read_text() == "old\n"
    assert not partial_path(out).exists()


def test_writes_through_a_symbolic_link_which_stays_a_link(tmp_path: Path) -> None:
    real = tmp_path / "real.csv"
    link = tmp_path / "link.csv"
    real.write_text("old\n")
    os.symlink(real, link)
    with open_atomically(link, "w") as f:
        f.write("new\n")
    assert link.is_symlink()
    assert real.read_text() == "new\n"
    assert not partial_path(link).exists()


def test_writes_a_device_in_place() -> None:
    # /dev/null is not a regular file; a rename onto it would be wrong.
    with open_atomically("/dev/null", "w") as f:
        f.write("x")
