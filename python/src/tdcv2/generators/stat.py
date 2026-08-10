"""``<gen type="stat">`` — one number for the WHOLE run, on every row.

``accumulate=`` totals a list inside one record. ``<gen type="running">`` totals a column as it
goes, so row i knows about rows 1..i. This is the third and last axis: a row that knows something
about EVERY row, including the ones after it.

``sum``, ``min`` and ``max`` are the last value of the corresponding RUNNING column, computed by
:func:`tdcv2.generators.accumulate.apply_column`. That is not a shortcut — it is how the two
features are kept from drifting: the fixed-point scale rule, the treatment of an empty cell and
the "min returns the winning element's own spelling" rule are written once and used twice.

``mean``, ``median`` and ``stddev`` are ratios and cannot be exact, so they are computed in
floating point over the numeric values — the same three formulas the expression language's list
functions use, including the POPULATION standard deviation. ``decimals=`` rounds the answer;
without it the full value is printed, because a mean that quietly lost digits is worse than an
ugly one.
"""

from __future__ import annotations

import math

from ..lib import numbers
from ..math import tdc_math
from . import accumulate as accumulate_gen

OPS = ("sum", "mean", "median", "min", "max", "count", "stddev")


class StatError(ValueError):
    """A statistic that cannot be read as one."""


def read_op(attrs: dict[str, str]) -> str | None:
    """Read ``op=`` where an unknown op simply means "none".

    The engine path uses this one: by the time a value is drawn the validator has already refused
    a misspelled op, so throwing here would turn a reported problem into a crash.
    """
    raw = (attrs.get("op") or "").strip()
    return raw if raw in OPS else None


def parse_op(attrs: dict[str, str]) -> str | None:
    """The same, but strict — the validator's copy, which turns a bad op into a diagnostic."""
    raw = (attrs.get("op") or "").strip()
    if raw == "":
        return None
    if raw not in OPS:
        raise StatError(f'op="{raw}" is not one of {", ".join(OPS)}')
    return raw


def parse_decimals(attrs: dict[str, str]) -> int | None:
    """``decimals=``, or None when the answer is printed at full precision."""
    raw = (attrs.get("decimals") or "").strip()
    if raw == "":
        return None
    try:
        n = int(raw)
    except ValueError:
        raise StatError(f'decimals="{raw}" is not a whole number from 0 to 10') from None
    if str(n) != raw.lstrip("+") or n < 0 or n > 10:
        raise StatError(f'decimals="{raw}" is not a whole number from 0 to 10')
    return n


def statistic(values: list[str | None], op: str, decimals: int | None) -> str:
    """The statistic itself, as the text that goes in every cell.

    A cell the parent filter emptied does not take part — the same rule ``apply_column`` follows,
    so a filtered column has one meaning across the three features rather than three.
    """
    present = [v for v in values if v is not None and v.strip() != ""]
    if op == "count":
        return str(len(present))
    if not present:
        return ""

    if op in ("sum", "min", "max"):
        # The last value of the running column IS the total over every row, and reusing it is
        # what keeps the exact-decimal arithmetic from drifting.
        running = accumulate_gen.apply_column(values, op, None, None)
        last = next((v for v in reversed(running) if v is not None), "")
        return last if decimals is None else _fixed(float(last), decimals)

    figures = [float(v) for v in present]
    if op == "mean":
        answer = _mean(figures)
    elif op == "median":
        answer = _median(figures)
    else:
        answer = _stddev(figures)
    return numbers.to_text(answer) if decimals is None else _fixed(answer, decimals)


def _mean(values: list[float]) -> float:
    return sum(values) / len(values)


def _median(values: list[float]) -> float:
    ordered = sorted(values)
    half = len(ordered) // 2
    if len(ordered) % 2 == 1:
        return ordered[half]
    return (ordered[half - 1] + ordered[half]) / 2


def _stddev(values: list[float]) -> float:
    """The POPULATION standard deviation — divided by n, matching ``stddev()`` in an expression."""
    average = _mean(values)
    variance = sum((v - average) * (v - average) for v in values) / len(values)
    return tdc_math.sqrt(variance)


def _fixed(value: float, decimals: int) -> str:
    """``decimals=`` applied.

    ``numbers.to_fixed`` and nothing hand-rolled, deliberately. Multiplying by 10^decimals and
    flooring introduces a rounding error of its own before the rounding rule ever runs, so two
    implementations could land on either side of a tie for the same input. ``to_fixed`` works on
    the decimal expansion of the double itself and is what ``decimals=`` on ``<gen type="number">``
    already uses, so the attribute means one thing across the whole engine rather than two.
    """
    if math.isnan(value) or math.isinf(value):
        return numbers.to_text(value)
    return numbers.to_fixed(value, decimals)
