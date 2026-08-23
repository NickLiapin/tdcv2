"""The fingerprint layer against the shared cross-language vectors.

Every number in that fixture decides WHICH tuples a large uniq run avoids, so an implementation
that differs in any of them produces a different file from the same seed. Hash, pile, record bytes
and pile count are each pinned here rather than trusted.
"""

from __future__ import annotations

import json
import tempfile
from pathlib import Path

import pytest

from tdcv2.engine import fingerprint as fp

VECTORS = json.loads(
    (
        Path(__file__).resolve().parents[2] / "fixtures/cross-language/fingerprint-vectors.json"
    ).read_text(encoding="utf-8")
)


def test_record_width_and_index_limit_match_the_contract() -> None:
    assert fp.RECORD_BYTES == VECTORS["recordBytes"]
    assert fp.MAX_INDEX == VECTORS["maxIndex"]


@pytest.mark.parametrize("vector", VECTORS["hashes"], ids=lambda v: repr(v["key"])[:30])
def test_hash_and_pile_match_the_reference(vector: dict) -> None:
    hi, lo = fp.hash64(vector["key"])
    assert hi == vector["hi"]
    assert lo == vector["lo"]
    for buckets, expected in vector["buckets"].items():
        assert fp.bucket_of(hi, int(buckets)) == expected


@pytest.mark.parametrize("vector", VECTORS["records"], ids=lambda v: str(v["index"]))
def test_record_bytes_match_the_reference(vector: dict) -> None:
    encoded = fp.encode(vector["hi"], vector["lo"], vector["index"])
    assert encoded.hex() == vector["bytes"]
    # And back again: a reader that disagrees with its own writer is worse than one that
    # disagrees with the reference, because nothing would catch it.
    assert fp.decode(encoded) == (vector["hi"], vector["lo"], vector["index"])


def test_an_index_past_the_limit_is_refused_not_wrapped() -> None:
    with pytest.raises(ValueError, match="5-byte"):
        fp.encode(1, 1, fp.MAX_INDEX)


@pytest.mark.parametrize("vector", VECTORS["pileCounts"], ids=lambda v: f"{v['count']}/{v['cores']}")
def test_pile_count_matches_the_reference(vector: dict) -> None:
    assert fp.bucket_count_for(vector["count"], vector["cores"]) == vector["buckets"]


def test_sorting_is_byte_order_and_finds_every_repeated_fingerprint() -> None:
    """Many files in, one ordered file out, with planted duplicates spanning the files."""
    with tempfile.TemporaryDirectory() as raw:
        directory = Path(raw)
        inputs = [directory / f"in-{k}" for k in range(3)]
        writers = [fp.Writer(path) for path in inputs]

        for i in range(300):
            hi, lo = fp.hash64(f"unique-{i}")
            writers[i % 3].write(hi, lo, i)
        planted = {"dupA": [7, 105, 203], "dupB": [50, 151]}
        for k, (key, rows) in enumerate(planted.items()):
            hi, lo = fp.hash64(key)
            for row in rows:
                writers[k % 3].write(hi, lo, row)
        # Same high word, differing low words, written descending: an order that only comes out
        # right if the low word decides. 305 random hashes never collide in 32 bits, so without
        # these the sort could ignore the low word and still pass.
        for lo in range(9, -1, -1):
            writers[0].write(777, lo, 400 + lo)
        for writer in writers:
            writer.close()

        out = directory / "sorted"
        assert fp.sort_files(inputs, out, directory, batch_size=64) == 315

        records = list(fp.read_records(out))
        assert len(records) == 315
        assert records == sorted(records), "the file is not in byte order"

        groups = [sorted(g) for g in fp.candidate_groups(out)]
        assert len(groups) == 2
        assert [7, 105, 203] in groups
        assert [50, 151] in groups


def test_the_ledger_never_calls_a_taken_tuple_free() -> None:
    buckets = 4
    keys = [f"taken-{i}" for i in range(500)]
    with tempfile.TemporaryDirectory() as raw:
        directory = Path(raw)
        writers = [fp.Writer(directory / f"raw-{b}") for b in range(buckets)]
        for row, key in enumerate(keys):
            hi, lo = fp.hash64(key)
            writers[fp.bucket_of(hi, buckets)].write(hi, lo, row)
        for writer in writers:
            writer.close()

        sorted_paths = []
        for b in range(buckets):
            out = directory / f"sorted-{b}"
            fp.sort_files([directory / f"raw-{b}"], out, directory)
            sorted_paths.append(out)

        moving = {3, 4}
        ledger = fp.Ledger(sorted_paths, moving)
        try:
            # The property uniqueness rests on: every taken tuple answers taken.
            for row, key in enumerate(keys):
                if row not in moving:
                    assert ledger.has(key), key
            # A tuple held ONLY by rows being moved is free — those values are being given away.
            assert not ledger.has("taken-3")
            assert not ledger.has("taken-4")
            # And tuples nobody holds are free.
            for i in range(200):
                assert not ledger.has(f"nobody-{i}")
        finally:
            ledger.close()
