"""A file read as a QUANTILE FUNCTION rather than as a bag of values.

``<gen type="file" src="amounts.txt" read="quantile"/>`` — the file is one measurement per
line, the engine sorts it once, and a row lands anywhere on that sorted ruler, interpolating
between two neighbours when it falls between them.

Why this exists beside ``weight=``: a weighted read honours declared shares exactly and is the
right answer for a countable value, but it can only ever emit values that were written in the
file. Stretch a thousand-line sample to a million rows and a thousand distinct values come back
with nothing between them — a comb, and for a MEASURED quantity that comb is structure the real
data never had.

Why it fits the engine: one uniform per row, and the answer depends on that row alone. So it
streams, it parallelises, and it needs no totals up front — unlike ``weight=``, which is
in-memory precisely because an exact quota has to see the whole file first.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..lib import numbers
from ..prng import permute as permute_mod

_EXPONENT = re.compile(r"[eE]")


class QuantileError(ValueError):
    """A source that cannot be read as a distribution."""


@dataclass(frozen=True)
class QuantileSource:
    """The sample, ascending, and how it was written."""

    sorted_values: list[float]
    decimals: int


def source(values: list[str], src: str) -> QuantileSource:
    """Parse and sort the file's values.

    A line that is not a number is refused rather than skipped: dropping it would change the
    very shape the file was chosen for, and silently. The message names the line, because in a
    file of ten thousand numbers "one of them is not a number" is not an answer anyone can act
    on.
    """
    if not values:
        raise QuantileError(f'file generator: read="quantile" needs values, and "{src}" has none')
    parsed: list[float] = []
    decimals = 0
    for index, raw in enumerate(values):
        text = raw.strip()
        try:
            value = float(text)
        except ValueError as err:
            raise QuantileError(_not_a_number(index, src, raw)) from err
        if text == "" or value != value or value in (float("inf"), float("-inf")):
            raise QuantileError(_not_a_number(index, src, raw))
        parsed.append(value)
        decimals = max(decimals, _decimals_of(text))
    parsed.sort()
    return QuantileSource(parsed, decimals)


def _not_a_number(index: int, src: str, raw: str) -> str:
    return (
        f'file generator: read="quantile" reads the file as measurements, and line '
        f'{index + 1} of "{src}" is "{raw}", which is not a number. Every value has to be one, '
        "because the sorted sample IS the distribution."
    )


def _decimals_of(text: str) -> int:
    """How many digits this text wrote after the point — ``12.50`` is two, ``12`` is none."""
    dot = text.find(".")
    if dot < 0:
        return 0
    # An exponent would make the count meaningless, so such a value asks for nothing.
    if _EXPONENT.search(text):
        return 0
    return len(text) - dot - 1


def at(sorted_values: list[float], u: float) -> float:
    """The value at probability ``u``, interpolating between neighbours.

    Each observation sits at ``(i + 0.5) / n`` — the MIDDLE of the slice of probability it owns
    — rather than at ``i / (n - 1)``, which is where the ENDS of the sample would be. That is not
    a detail of taste: the end convention gives the smallest and largest observations exactly
    half the weight they should have, because there is nothing on the far side of them to ramp
    from. Measured on the reference before it was fixed, over a hundred distinct values that each
    owe 1.000%: first 0.505%, middle 1.010%, last 0.505%.

    It is also the convention the ROW axis already uses, where row ``i`` reads
    ``(slot + 0.5) / count``. One rule on both axes.
    """
    n = len(sorted_values)
    if n == 1:
        return sorted_values[0]
    p = min(float(n - 1), max(0.0, u * n - 0.5))
    lo = int(p)
    low = sorted_values[lo]
    if lo + 1 >= n:
        return sorted_values[n - 1]
    high = sorted_values[lo + 1]
    # A repeated value makes low == high, and the interpolation returns it unchanged — that is
    # how an atom keeps its plateau while everything around it stays continuous.
    return low + (p - lo) * (high - low)


def render(value: float, decimals: int) -> str:
    """The finished cell: written like the source unless the config said otherwise.

    Through the shared rounding rather than Python's own formatting: a value that lands exactly on
    a half — and a swept run lands on halves often — rounds away from zero here and to the EVEN
    digit in Python's default. Measured on a twenty-row fixture, one row in twenty came out 20
    where the reference said 21.
    """
    return numbers.to_fixed(value, decimals)


def exact_at(
    quantile_source: QuantileSource, decimals: int, count: int, key: int, position: int
) -> str:
    """The EXACT sweep: every row takes its own point on the ruler, no dice at all.

    Row ``i`` is sent to slot ``permute(i, count, key)`` and reads probability
    ``(slot + 0.5) / count``. Over the whole run the slots are the numbers ``0 … count-1`` exactly
    once each, so the generated column reproduces the sample's distribution with no sampling
    noise whatever.

    The permutation is what keeps it usable: without it the column would come out sorted. It is
    the same seekable, seeded permutation ``uniq`` and the exact ``percent=`` quota already use,
    so a row still costs nothing to compute on its own and ``--jobs`` keeps working.
    """
    slot = permute_mod.permute(position, count, key)
    return render(at(quantile_source.sorted_values, (slot + 0.5) / count), decimals)


def is_quantile(attrs: dict[str, str]) -> bool:
    """``read="quantile"``: the file is a distribution, not a bag of values."""
    return (attrs.get("read") or "").strip() == "quantile"


def is_exact_sample(attrs: dict[str, str]) -> bool:
    """``sample="exact"``: cover the distribution evenly rather than draw from it."""
    return (attrs.get("sample") or "").strip() == "exact"


def decimals_for(attrs: dict[str, str], quantile_source: QuantileSource) -> int:
    """``decimals=`` when the config declared one, otherwise the source's own precision.

    Interpolating between 31 and 40 gives 35.4, which is right for money and wrong for a count of
    orders. Rather than guess, the answer is printed with the same number of decimal places as
    the SOURCE.
    """
    raw = (attrs.get("decimals") or "").strip()
    return quantile_source.decimals if raw == "" else int(float(raw))
