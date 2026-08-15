"""Numbers read and written the way the reference implementation reads and writes them.

Every message that quotes a number — "percentages sum to 99.5", "value 20 is out of range" — has
to read the same in all three languages, because the tests compare the text. JavaScript's rule is
that a whole number carries no decimal point: ``100`` and not ``100.0``. Python's ``str`` disagrees
about exactly that, so the conversion goes through here rather than through ``str``.

Reading has the same problem from the other side. ``float`` accepts things JavaScript rejects —
``1_000`` as a thousand, ``inf`` as infinity — and a filter argument written by a config author
has to be accepted or refused identically everywhere.
"""

from __future__ import annotations

import math
import re
from decimal import ROUND_HALF_UP, Decimal

from . import text

_DECIMAL = re.compile(r"^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$")
_RADIX = re.compile(r"^0([xX])([0-9a-fA-F]+)$|^0([oO])([0-7]+)$|^0([bB])([01]+)$")


def to_text(value: float) -> str:
    """``value`` as JavaScript's ``String(value)`` would write it."""
    if math.isnan(value):
        return "NaN"
    if math.isinf(value):
        return "Infinity" if value > 0 else "-Infinity"
    if value == int(value) and abs(value) < 1e21:
        return str(int(value))
    return repr(value)


def to_fixed(value: float, decimals: int) -> str:
    """``value`` rounded to ``decimals`` places, as JavaScript's ``toFixed`` rounds it.

    Ties go away from zero, and the tie is decided on the number the double ACTUALLY holds, not on
    the short decimal that prints back as it. Those two rules disagree more often than they look
    like they should: 1.005 is stored as 1.00499999999999989, so it rounds DOWN to 1.00 — and a
    port that rounded the printed "1.005" instead would answer 1.01 and diverge on money columns.
    """
    if math.isnan(value) or math.isinf(value) or abs(value) >= 1e21:
        return to_text(value)
    quantum = Decimal(1).scaleb(-decimals)
    rounded = Decimal(value).quantize(quantum, rounding=ROUND_HALF_UP)
    if rounded == 0:
        # JavaScript takes the sign from the input, and -0 is not negative there.
        return format(abs(rounded), "f") if value >= 0 else format(rounded, "f")
    return format(rounded, "f")


def parse(raw: str) -> float:
    """``raw`` as JavaScript's ``Number(raw)`` would read it; NaN when it is not a number.

    Blank is zero, which is JavaScript's rule and the one the filter arguments rely on:
    ``slice:,4`` means "from the start".
    """
    body = text.trim(raw)
    if body == "":
        return 0.0
    if body in ("Infinity", "+Infinity"):
        return float("inf")
    if body == "-Infinity":
        return float("-inf")
    radix = _RADIX.match(body)
    if radix:
        groups = [g for g in radix.groups() if g is not None]
        base = {"x": 16, "o": 8, "b": 2}[groups[0].lower()]
        return float(int(groups[1], base))
    if not _DECIMAL.match(body):
        return float("nan")
    return float(body)
