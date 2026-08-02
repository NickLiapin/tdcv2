"""Every shared diagnostic case: the same config earns the same codes at the same positions.

The code and the position are the contract; the wording is not. Two implementations that disagree
about which configs are acceptable are a portability bug even when neither ever produced a wrong
value, which is exactly what these fixtures are for.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tdcv2.packs import DataPacks
from tdcv2.parser import facade
from tdcv2.validator import validate

REPO = Path(__file__).resolve().parents[2]
DIAGNOSTICS = REPO / "fixtures" / "cross-language" / "diagnostics"

_PACKS = DataPacks.for_project(REPO)


def _load() -> list[tuple[str, dict]]:
    out = []
    for path in sorted(DIAGNOSTICS.glob("*.json")):
        document = json.loads(path.read_text(encoding="utf-8"))
        for case in document["cases"]:
            out.append((f"{path.stem}/{case['name']}", case))
    return out


ALL = _load()


@pytest.mark.parametrize("case", [c for _, c in ALL], ids=[name for name, _ in ALL])
def test_a_config_earns_the_diagnostics_the_reference_gives_it(case: dict) -> None:
    parsed = facade.parse(case["config"])
    if not parsed.ok:
        # A parse error stops the run: there is no tree to validate, and the parser's own
        # complaint is the only honest thing to report.
        produced = [f"error PARSE {p.line}:{p.column}" for p in parsed.problems]
    else:
        produced = [d.signature() for d in validate(parsed.tree, None, _PACKS)]
    assert produced == case["expected"], case["description"]
