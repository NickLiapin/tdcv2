"""``repeat=`` built in memory the way the streaming engine builds it.

A repeating column has two plans, not one. How MANY values a row keeps is an exact quota over
the run — permuted by ``#replen``, so a row's length follows from its own position and never
from a running total over its predecessors. What those values ARE then depends on the
generator: a list is laid out over the whole slot space and read at the row's slots, while
anything drawn takes one seekable sub-stream per element, ``#e0``, ``#e1``, and so on.

Both halves are keyed by ``(seed, stream_id)`` and mirror the reference's ``repeat-keyed.ts``.
The older sequential builder in ``generators/repeat.py`` stays for the cases with nothing to
key by — an inline generator inside a pack body.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import TYPE_CHECKING

from ..distribution import hamilton
from ..generators import repeat as repeat_gen
from ..prng import permute, seekable
from ..prng.prng import create

from . import per_row

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..model import Gen
    from .memory import _Run


def _length_plan(
    spec: repeat_gen.Spec, count: int, seed: str, stream_id: str
) -> tuple[repeat_gen.Plan, Callable[[int], int]]:
    """How many values each position keeps, and where in the slot space they start."""
    counts = hamilton.counts_per_value(
        count, repeat_gen.length_percents(spec), create(f"{seed}|{stream_id}|replen")
    )
    key = permute.key(seed, f"{stream_id}#replen")
    plan = repeat_gen.plan(spec, count, counts)
    return plan, lambda i: permute.permute(i, count, key)


def build_draws(
    spec: repeat_gen.Spec,
    count: int,
    run: _Run,
    seed: str,
    stream_id: str,
    generate: Callable[[Gen, int, _Run], list[str]],
    finish: Callable[..., list[str]],
    flag_text_out: list[str] | None = None,
    *,
    gen: Gen,
) -> list[str]:
    """A repeating column of DRAWN values.

    Element k of a row comes off the row's own ``#e{k}`` stream, so the row still resolves
    alone — which is also what lets a worker render a range of rows without seeing the rest.
    """
    from dataclasses import replace

    plan, position_at = _length_plan(spec, count, seed, stream_id)
    single = _without_repeat(gen)
    out: list[str] = []
    for i in range(count):
        row = per_row.absolute_row(run, i)
        keep = plan.length_at(position_at(i))
        parts: list[str] = []
        marks: list[str] = []
        for k in range(keep):
            flags = [False]
            one = replace(run, prng=seekable.generator(seed, f"{stream_id}#e{k}", row))
            value = finish(generate(single, 1, one), single.attrs, one.prng, flags)
            parts.append(value[0] if value else "")
            marks.append(str(flags[0]).lower())
        out.append(repeat_gen.join(parts, spec))
        # A parallel list of true/false, never a running total — accumulating it would mean
        # nothing — so it joins with the separator alone.
        if flag_text_out is not None:
            flag_text_out.append(spec.separator.join(marks))
    return out


def build_layout(
    spec: repeat_gen.Spec,
    values: list[str],
    percents: list[float],
    count: int,
    run: _Run,
    seed: str,
    stream_id: str,
    modify: Callable[[int, str, int], str] | None = None,
) -> list[str]:
    """A repeating column of LISTED values.

    The slot space covers every element of every row at once, laid out exactly and permuted;
    a row reads the slots its length plan gave it.
    """
    plan, position_at = _length_plan(spec, count, seed, stream_id)
    slot_count = plan.total_slots
    counts = hamilton.counts_per_value(slot_count, percents, create(f"{seed}|{stream_id}|pct"))
    key = permute.key(seed, stream_id)
    cum_hi: list[int] = []
    acc = 0
    for c in counts:
        acc += c
        cum_hi.append(acc)

    def value_for_slot(slot: int) -> str:
        lo, hi = 0, len(cum_hi) - 1
        while lo < hi:
            mid = (lo + hi) // 2
            if slot < cum_hi[mid]:
                hi = mid
            else:
                lo = mid + 1
        return values[lo]

    out: list[str] = []
    for i in range(count):
        p = position_at(i)
        row = per_row.absolute_row(run, i)
        start = plan.slot_start_at(p)
        keep = plan.length_at(p)
        parts = []
        for k in range(keep):
            raw = value_for_slot(permute.permute(start + k, slot_count, key))
            parts.append(modify(row, raw, k) if modify is not None else raw)
        out.append(repeat_gen.join(parts, spec))
    return out


def element_uniforms(
    seed: str, stream_id: str, purpose: str, budget: int
) -> Callable[[int, int], float]:
    """The ``anomaly=``/``missing=`` draw for one element of a repeating LISTED column.

    One draw per element, pulled a whole row at a time — the budget is the row's maximum
    length, so which uniform element k gets does not depend on how long its row turned out.
    """
    cache: dict[int, list[float]] = {}

    def draw(row: int, k: int) -> float:
        drawn = cache.get(row)
        if drawn is None:
            drawn = seekable.uniforms(seed, f"{stream_id}{purpose}", row, budget)
            cache.clear()
            cache[row] = drawn
        return drawn[k] if k < len(drawn) else 1.0

    return draw


def _without_repeat(gen: Gen) -> Gen:
    """The same gen with ``repeat`` removed, so the per-element build cannot re-apply it."""
    from ..model import Gen as GenType

    return GenType(gen.type, {k: v for k, v in gen.attrs.items() if k != "repeat"})
