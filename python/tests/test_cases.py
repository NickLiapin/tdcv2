"""Every shared case, rendered by the in-memory engine.

The fixtures were captured from the reference implementation. A case that passes here means this
port produces the same bytes for the same config and seed, which is the whole contract.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tdcv2 import engine
from tdcv2.date import plain
from tdcv2.errors import Severity
from tdcv2.packs import DataPacks
from tdcv2.parser import config_builder, facade
from tdcv2.validator.validate import validate

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
    captured from. The ones that say nothing at all are about routing itself — including the case
    where the streaming engine, having been routed a config, turns out not to be able to answer it
    and the run moves to memory. Dispatching here by hand is what hid that: the facade recovered
    and this did not, so the two disagreed about what a config produces.
    """
    parsed = facade.parse(case["config"])
    assert parsed.ok, f"syntax errors: {[str(p) for p in parsed.problems]}"

    # A case says "this config renders these bytes", which presumes the validator accepts it.
    # Rendering straight off the parse tree skips that presumption, and a port whose validator
    # refuses an attribute the reference reads then passes here while `tdcv2 check` on the same
    # file fails. That is how `base=` on <gen type="running"> stayed refused in three ports.
    refusals = [d for d in validate(parsed.tree, packs=_PACKS) if d.severity is Severity.ERROR]
    assert not refusals, f"the validator refuses a shared case: {[d.signature() for d in refusals]}"

    config = config_builder.build(parsed.tree)
    now = now_millis(case)

    produced = engine.render(config, _PACKS, now)
    assert produced.split("\n")[:-1] == case["expected"]
