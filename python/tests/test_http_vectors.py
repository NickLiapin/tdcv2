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

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "cross-language"
VECTORS = json.loads((FIXTURES / "http-vectors.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("vector", VECTORS["signature"]["vectors"], ids=lambda v: v["name"])
def test_signature_matches_every_implementation(vector):
    assert (
        sign_request(
            vector["secret"],
            vector["timestamp"],
            vector["seed"],
            vector["count"],
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
