"""Every shared case, rendered by the in-memory engine.

The fixtures were captured from the reference implementation. A case that passes here means this
port produces the same bytes for the same config and seed, which is the whole contract.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tdcv2.date import plain
from tdcv2.engine import disk, memory, router, stream
from tdcv2.packs import DataPacks
from tdcv2.parser import config_builder, facade

REPO = Path(__file__).resolve().parents[2]
CASES = REPO / "fixtures" / "cross-language" / "cases"

# The monorepo is a project, so every locale resolves — the same packs the other implementations
# read for these fixtures.
_PACKS = DataPacks.for_project(REPO)


def _load() -> list[tuple[str, dict]]:
    out = []
    for path in sorted(CASES.glob("*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        for case in document["cases"]:
            out.append((f"{path.stem}/{case['name']}", case))
    return out


def now_millis(case: dict) -> int:
    """The frozen clock a date case names, as milliseconds since the epoch."""
    raw = case.get("now")
    if raw is None:
        return 0
    text = raw.rstrip("Z")
    date_part, _, time_part = text.partition("T")
    year, month, day = (int(p) for p in date_part.split("-"))
    hour, minute, second = (int(p) for p in (time_part or "00:00:00").split(":"))
    return plain.to_epoch_millis(plain.PlainDateTime(year, month, day, hour, minute, second))


ALL = _load()


@pytest.mark.parametrize("case", [c for _, c in ALL], ids=[name for name, _ in ALL])
def test_a_shared_case_renders_what_the_reference_rendered(case: dict) -> None:
    """Through the ROUTER, the way a run reaches an engine in the first place.

    Most cases say mode="memory" and land on the in-memory engine, whose values the fixtures were
    captured from. The one that says nothing at all is about routing itself: with no mode= a
    config streams, and its expected output is the streaming engine's.
    """
    parsed = facade.parse(case["config"])
    assert parsed.ok, f"syntax errors: {[str(p) for p in parsed.problems]}"
    config = config_builder.build(parsed.tree)
    now = now_millis(case)

    engine = router.resolve(config, _PACKS)
    if engine == 1:
        produced = memory.render(config, _PACKS, now)
    elif engine == 2:
        produced = stream.render(config, _PACKS, now)
    else:
        produced = disk.render(config, _PACKS, now)
    assert produced.split("\n")[:-1] == case["expected"]
