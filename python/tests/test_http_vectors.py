"""The two numbers a service recomputes, held to the shared vector file.

A service checks ONE signature and reads ONE seed, and cannot tell which of the
five runtimes sent the request — so both are the wire contract, not an
implementation detail. Until this file existed the Python http generator had no
tests at all: `sign_request` and `seed_for` could have returned anything and
every suite in the repo would still have been green.

The other four read the same JSON, so a drift in any one of them fails there too.
"""

import json
from pathlib import Path

import pytest

from tdcv2.generators.http import seed_for, sign_request
from tdcv2.generators.http_target import dot_segment_of, http_target

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "cross-language"
VECTORS = json.loads((FIXTURES / "http-vectors.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("vector", VECTORS["signature"]["vectors"], ids=lambda v: v["name"])
def test_signature_matches_every_implementation(vector):
    assert (
        sign_request(
            vector["secret"],
            vector["method"],
            vector["target"],
            vector["timestamp"],
            vector["seed"],
            vector["count"],
            vector["offset"],
            vector["total"],
            vector["body"],
        )
        == vector["signature"]
    )


def test_every_part_of_the_message_reaches_the_hash():
    # Pinning one request pins nothing. The vectors differ from the canonical
    # one in a single field each, so an implementation that dropped a field
    # would match the first and fail one of the others.
    signatures = {v["signature"] for v in VECTORS["signature"]["vectors"]}
    assert len(signatures) == len(VECTORS["signature"]["vectors"])


@pytest.mark.parametrize("vector", VECTORS["target"]["vectors"], ids=lambda v: v["name"])
def test_the_signed_target_matches_every_implementation(vector):
    got = http_target(vector["src"])
    assert (got.target, got.url) == (vector["target"], vector["url"])


def test_a_target_already_in_its_form_is_left_untouched():
    # The property the rebuilt URL relies on: what the rule produced, it produces again — so a
    # client handed it has nothing left to change.
    for vector in VECTORS["target"]["vectors"]:
        got = http_target(vector["url"])
        assert (got.target, got.url) == (vector["target"], vector["url"]), vector["name"]


def test_a_dot_segment_is_found_however_it_is_spelled():
    assert dot_segment_of("http://h/a/../b") == ".."
    assert dot_segment_of("http://h/./b") == "."
    assert dot_segment_of("http://h/a/%2e%2E") == ".."
    assert dot_segment_of("http://h/a/.%2e/b?x=..") == ".."
    assert dot_segment_of("http://h/a..b/.x/x.?q=/../") is None


@pytest.mark.parametrize(
    "vector",
    VECTORS["derivedSeed"]["vectors"],
    ids=lambda v: f"{v['envSeed']}|{v['sequence']}",
)
def test_derived_seed_matches_every_implementation(vector):
    assert seed_for(vector["envSeed"], vector["sequence"]) == vector["derived"]


def test_two_sequences_of_one_run_get_different_seeds():
    # Why the value is derived rather than passed through: a service that
    # generates from the seed would otherwise return two identical columns.
    assert seed_for("run", "A") != seed_for("run", "B")
