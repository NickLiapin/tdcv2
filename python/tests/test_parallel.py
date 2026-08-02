"""Splitting a run across processes must not change a byte of it.

The whole feature rests on one claim — a row is a function of its own index — so the tests check
the claim rather than the speed: shards that cover the run exactly, pieces that concatenate into
what one process writes, and a fallback to one process wherever splitting would be unsafe.
"""

from __future__ import annotations

from itertools import pairwise
from pathlib import Path

import pytest

from tdcv2 import TDC
from tdcv2.engine import parallel

NOW = 1776945600000

# Fixtures on every level, so a shard boundary has something to get wrong: an opening and closing
# line that belong to the run, and a delimiter that belongs between rows.
CONFIG = """<tdc>
  <env count="{count}" seed="bench" local="en" engine="2">
    <before><line><data>BEGIN</data></line></before>
    <after><line><data>END</data></line></after>
    <delimiter_block><line><data>--</data></line></delimiter_block>
    <sequence name="Id"><gen type="increment" value="1"/></sequence>
    <sequence name="Name"><gen type="template" value="person.male.firstName"/></sequence>
  </env>
  <block>
    <line><data>${{Id}},${{Name}}</data></line>
  </block>
</tdc>
"""


def write_config(directory: Path, count: int) -> Path:
    path = directory / "run.tdc"
    path.write_text(CONFIG.format(count=count), encoding="utf-8")
    return path


class TestShards:
    @pytest.mark.parametrize(
        ("count", "workers"),
        [(100, 1), (100, 3), (100, 7), (10, 10), (7, 10), (1, 4), (1_000_000, 11)],
    )
    def test_covers_every_row_exactly_once(self, count: int, workers: int) -> None:
        ranges = parallel.shards(count, workers)
        assert ranges[0][0] == 0
        assert ranges[-1][1] == count
        for (_, previous_stop), (start, _) in pairwise(ranges):
            assert start == previous_stop
        assert sum(stop - start for start, stop in ranges) == count

    def test_never_hands_out_an_empty_range(self) -> None:
        assert parallel.shards(3, 10) == [(0, 1), (1, 2), (2, 3)]

    def test_spreads_the_remainder_over_the_early_shards(self) -> None:
        # Not [(0,3),(3,6),(6,10)] — the last worker would be a row behind everyone.
        assert parallel.shards(10, 3) == [(0, 4), (4, 7), (7, 10)]

    def test_rejects_no_workers(self) -> None:
        with pytest.raises(ValueError, match="at least 1"):
            parallel.shards(10, 0)


class TestWriteRows:
    @pytest.mark.parametrize("splits", [[(0, 20)], [(0, 1), (1, 20)], [(0, 7), (7, 13), (13, 20)]])
    def test_pieces_join_into_the_whole(self, tmp_path: Path, splits) -> None:
        run = TDC(write_config(tmp_path, 20), now=NOW)._run()

        whole: list[str] = []
        run.write_to(whole.append)

        pieces: list[str] = []
        for start, stop in splits:
            run.write_rows(pieces.append, start, stop)

        assert "".join(pieces) == "".join(whole)

    def test_only_the_first_shard_opens_and_only_the_last_closes(self, tmp_path: Path) -> None:
        run = TDC(write_config(tmp_path, 20), now=NOW)._run()

        middle: list[str] = []
        run.write_rows(middle.append, 5, 10)
        text = "".join(middle)

        assert "BEGIN" not in text
        assert "END" not in text


class TestParallelWriteFile:
    def test_output_is_identical_to_one_process(self, tmp_path: Path) -> None:
        config = write_config(tmp_path, 500)
        single, split = tmp_path / "single.csv", tmp_path / "split.csv"

        TDC(config, now=NOW).write_file(single)
        # Called directly rather than through `workers=`: 500 rows is far below the size at which
        # the facade thinks processes are worth starting, and the bytes are the point here.
        parallel.write_file(config, split, {"now": NOW}, workers=4, count=500)

        assert split.read_bytes() == single.read_bytes()

    def test_a_worker_that_fails_is_reported(self, tmp_path: Path) -> None:
        config = write_config(tmp_path, 100)
        with pytest.raises(parallel.ShardError):
            # No such engine, so every shard refuses — the parent must say so rather than write a
            # short file and call it done.
            parallel.write_file(
                config, tmp_path / "out.csv", {"now": NOW, "engine": 9}, workers=2, count=100
            )


class TestWorkerCount:
    def test_none_means_one_process(self, tmp_path: Path) -> None:
        assert TDC(write_config(tmp_path, 10_000_000), now=NOW)._worker_count(None) == 1

    def test_auto_splits_a_long_streaming_run(self, tmp_path: Path) -> None:
        data = TDC(write_config(tmp_path, 10_000_000), now=NOW)
        assert data._worker_count("auto") == parallel.default_workers()

    def test_a_short_run_stays_on_one_process(self, tmp_path: Path) -> None:
        assert TDC(write_config(tmp_path, 100), now=NOW)._worker_count("auto") == 1

    def test_the_in_memory_engine_stays_on_one_process(self, tmp_path: Path) -> None:
        path = tmp_path / "mem.tdc"
        path.write_text(CONFIG.format(count=10_000_000).replace('engine="2"', 'engine="1"'))
        assert TDC(path, now=NOW)._worker_count("auto") == 1

    def test_a_config_given_as_a_string_stays_on_one_process(self) -> None:
        # There is no file for a worker to read, and re-parsing the string in each of them would
        # need the caller's base directory too.
        data = TDC(config_string=CONFIG.format(count=10_000_000), now=NOW)
        assert data._worker_count("auto") == 1

    def test_rejects_a_workers_value_that_is_neither(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError, match="int"):
            TDC(write_config(tmp_path, 100), now=NOW)._worker_count("many")
