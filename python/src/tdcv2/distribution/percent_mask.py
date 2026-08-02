"""``percent="50,,20"`` — stated shares, with the blanks splitting what is left.

A mask says what it cares about and leaves the rest. Writing every share explicitly is both
tedious and fragile: adding a value means recomputing all of them, and the numbers stop adding
up the moment someone forgets. A blank position takes an equal cut of the remainder, so a config
can pin the one share that matters and let the others follow.
"""

from __future__ import annotations

from enum import Enum

_TOLERANCE = 0.0001


class Kind(Enum):
    """Which way a percent mask is wrong.

    Three different mistakes, each with its own diagnostic code: the wrong number of entries, an
    entry that is not a share, and shares that do not add up. They call for three different
    fixes, and one code for all of them would say only that the mask is wrong.
    """

    LENGTH = "length"
    NUMBER = "number"
    SUM = "sum"


class MaskError(ValueError):
    """A mask that cannot be used, with the reason in a form a caller can branch on."""

    def __init__(self, message: str, kind: Kind) -> None:
        super().__init__(message)
        self.kind = kind


def expand(mask: str, value_count: int) -> list[float]:
    """The mask as one share per value, blanks resolved."""
    if value_count <= 0:
        raise ValueError("percent mask requires at least one value")

    parts = _normalize(mask, value_count)
    fixed = [0.0] * len(parts)
    blanks: list[int] = []
    fixed_sum = 0.0

    for i, part in enumerate(parts):
        if not part:
            blanks.append(i)
            continue
        try:
            n = float(part)
        except ValueError:
            raise MaskError(
                "percent contains a non-numeric or negative value", Kind.NUMBER
            ) from None
        if n < 0 or n != n or n in (float("inf"), float("-inf")):
            raise MaskError("percent contains a non-numeric or negative value", Kind.NUMBER)
        fixed[i] = n
        fixed_sum += n

    if fixed_sum > 100 + _TOLERANCE:
        raise MaskError(f"percent values sum to {_number(fixed_sum)}, expected <= 100", Kind.SUM)

    if not blanks:
        if abs(fixed_sum - 100) > _TOLERANCE:
            raise MaskError(f"percent values sum to {_number(fixed_sum)}, expected 100", Kind.SUM)
        return fixed

    remainder = (100 - fixed_sum) / len(blanks)
    for index in blanks:
        fixed[index] = remainder
    return fixed


def _normalize(mask: str, value_count: int) -> list[str]:
    """Pad a short mask out to one entry per value."""
    parts = [s.strip() for s in mask.split(",")]
    if len(parts) > value_count:
        raise MaskError(
            f"percent has {len(parts)} entries but value has {value_count}", Kind.LENGTH
        )

    missing = value_count - len(parts)
    if missing == 0:
        return parts

    if mask.lstrip().startswith(","):
        # A leading comma means the first entry is anchored and the padding follows it.
        return [parts[0], *([""] * missing), *parts[1:]]
    return [*parts, *([""] * missing)]


def _number(value: float) -> str:
    """A number as JavaScript writes it — a whole one carries no decimal point."""
    if value == int(value) and abs(value) < 1e21:
        return str(int(value))
    return repr(value)
