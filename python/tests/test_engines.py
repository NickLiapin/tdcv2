"""Every shared case again, on the streaming and exact engines.

The ``expected`` in a case file is what the IN-MEMORY engine produces. The streaming engines draw
by row index rather than in order, so the same seed gives a different column; both are correct and
neither is the other's reference. What has to hold is that this port's Engine 2 agrees with the
reference's Engine 2, value for value — and that it refuses the same configs, since an engine that
quietly answers a config it cannot do correctly is worse than one that stops.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest
from test_cases import CASES, now_millis

from tdcv2.engine import disk, stream
from tdcv2.engine.exact_uniq import RepairNeededError
from tdcv2.packs import DataPacks
from tdcv2.parser import config_builder, facade

REPO = Path(__file__).resolve().parents[2]
ENGINES = REPO / "fixtures" / "cross-language" / "engines.json"

_PACKS = DataPacks.for_project(REPO)
_EXPECTED = json.loads(ENGINES.read_text(encoding="utf-8"))["cases"]


def _cases() -> list[tuple[str, dict]]:
    out = []
    for path in sorted(CASES.glob("*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        for case in document["cases"]:
            out.append((f"{path.stem}/{case['name']}", case))
    return out


ALL = _cases()


def _run(case: dict, engine: int) -> str:
    parsed = facade.parse(case["config"])
    assert parsed.ok, f"syntax errors: {[str(p) for p in parsed.problems]}"
    config = config_builder.build(parsed.tree)
    now = now_millis(case)
    # A `type="file"` case names the folder its samples live in, relative to the cases directory —
    # the same field the render runner reads.
    data_path = case.get("dataPath")
    base_dir = CASES / data_path if data_path else None
    if engine == 2:
        return stream.render(config, _PACKS, now, base_dir)
    return disk.render(config, _PACKS, now, base_dir)


@pytest.mark.parametrize(("name", "case"), ALL, ids=[name for name, _ in ALL])
@pytest.mark.parametrize("engine", [2, 3])
def test_a_streaming_engine_matches_the_reference(name: str, case: dict, engine: int) -> None:
    expected = _EXPECTED[name][f"engine{engine}"]

    if "refused" in expected:
        # WHAT is refused is the contract; how each language phrases it is not — and neither is
        # the exception class. A refusal that comes from the expression layer rather than the
        # streaming builder is a plain ValueError, the same way the router's refusals are; the
        # Java runner simply catches RuntimeException here, and this list is the same idea
        # spelled out.
        with pytest.raises(
            (stream.UnsupportedError, stream.StreamError, RepairNeededError, ValueError)
        ):
            _run(case, engine)
        return

    produced = _run(case, engine)
    assert produced.split("\n")[:-1] == expected["lines"]
