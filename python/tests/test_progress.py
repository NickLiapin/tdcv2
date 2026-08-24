"""The `--progress` channel: what a watcher is promised about the numbers it is given."""

import pytest

from tdcv2 import TDC
from tdcv2.engine import fingerprint

NOW = 1704067200000  # 2024-01-01T00:00:00Z

NAMES = ",".join(f"a{i}" for i in range(40))
UNIQ = (
    '<tdc><env count="400" seed="p" local="en" mode="disk"><uniq>'
    '<sequence name="A"><gen type="text" value="' + NAMES + '"/></sequence>'
    '<sequence name="B"><gen type="text" value="m,n,o,p,q,r,s,t,u,v,w,x"/></sequence>'
    "</uniq></env><block><line><data>${{A}}-${{B}}</data></line></block></tdc>"
)


@pytest.fixture
def on_disk(monkeypatch: pytest.MonkeyPatch) -> None:
    """Take the fingerprint path on a small run.

    The piles are worth their cost above a million rows and the engine picks by count, so an
    honest small config never reaches `uniq-scan` or `uniq-sort`. Four piles is what the
    reference's own progress test forces, and it keeps this one a fifth of a second.
    """
    monkeypatch.setattr(fingerprint, "bucket_count_for", lambda count, cores: 4)


def _phases_of(config: str) -> list[tuple[str, int, int]]:
    seen: list[tuple[str, int, int]] = []
    TDC(
        config_string=config, now=NOW, on_progress=lambda p, d, t: seen.append((p, d, t))
    ).to_string()
    return seen


def test_the_uniq_phases_and_the_render_arrive_in_order(on_disk: None) -> None:
    seen = _phases_of(UNIQ)
    order = list(dict.fromkeys(phase for phase, _, _ in seen))
    # 400 rows drawn from 480 pairs: the repair is certain here, and it reports.
    assert order == ["uniq-scan", "uniq-sort", "uniq-repair", "render"]


def test_a_phases_numbers_only_ever_rise(on_disk: None) -> None:
    """What a progress bar needs: within a phase, neither the count nor the scale goes backwards.

    The repair is several steps with different units — candidate groups, then pool rows, then a
    deal per sweep — reported on ONE rising scale for exactly this reason. Reported straight, the
    counter would restart at every step and the bar would jump backwards.
    """
    seen = _phases_of(UNIQ)
    for phase in dict.fromkeys(p for p, _, _ in seen):
        of = [(d, t) for p, d, t in seen if p == phase]
        for (done, total), (before, scale) in zip(of[1:], of[:-1], strict=True):
            assert done >= before, phase
            assert total >= scale, phase
            assert done <= total, phase


def test_the_repair_and_the_render_close_full(on_disk: None) -> None:
    """A phase that ends at its total is a phase a watcher can see END, not stall at 97%."""
    seen = _phases_of(UNIQ)
    for phase in ("uniq-repair", "render"):
        of = [(d, t) for p, d, t in seen if p == phase]
        assert of, phase
        assert of[-1][0] == of[-1][1], phase
