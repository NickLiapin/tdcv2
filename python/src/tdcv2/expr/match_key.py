"""The key two TEXTS share when ``==`` calls them equal.

``==`` between two texts has one rule that is not plain string equality: if both read as whole
numbers, they are compared as whole numbers. So ``"01" == "1"`` is true, and ``"0" == "00"`` is
true.

Most of the engine never needs this, because it evaluates the expression. Two places do not
evaluate it and must still agree with it:

- a ``<gen type="pool" filter="field == Column">`` is BUCKETED, so a row costs a map lookup
  instead of a walk over every member;
- TDC225 asks, before the run, whether the two sides can ever overlap.

Both compared raw text, and both were therefore wrong about the same configs. Measured on a
pool whose ``code`` holds ``01,02,03`` against a column producing ``1,2,3``::

    filter="code == Want"            check REFUSED it: "can never match"
    filter="code == Want && 1 == 1"  matched every row

The second is the same question with one term that changes nothing — it only stops the shape
from being recognised, so the general path answers it. One config was refused and its twin
worked.
"""

from __future__ import annotations

_INT64_MIN = -(2**63)
_INT64_MAX = 2**63 - 1


def match_key(value: str) -> str:
    """``"01"`` and ``"1"`` share the key ``"1"``.

    ``"1.0"`` and ``"1"`` do not share one, because ``==`` between two texts does not read a
    decimal point either.
    """
    body = value[1:] if value[:1] in "+-" else value
    if not body or not body.isdigit():
        return value
    parsed = int(value)
    # Outside the exact domain the evaluator stops treating it as a whole number, and so does
    # this.
    if parsed < _INT64_MIN or parsed > _INT64_MAX:
        return value
    return str(parsed)
