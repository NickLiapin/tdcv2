"""Dictionary encoding — each distinct value stored once, then pointed at.

A column of city names repeats "Moscow" ten thousand times. PLAIN writes those bytes ten thousand
times; a dictionary writes them once and spends two BITS per row pointing at them. That is the
largest size win available short of compression, and it costs no dependency.

Whether to use it has to be decided from the data, and the decision has to be reproducible. A
heuristic that consulted anything else — a clock, a memory figure, a sampling rate — would put
different bytes in the file on different runs and break the guarantee the whole writer exists to
keep. So the rule below reads only the values.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..column_type import ColumnType, Kind
from .convert import Value

# A dictionary pays for itself when values repeat. Requiring at least a halving keeps it away from
# near-unique columns — ids, timestamps, uuids — where the indices would be pure overhead on top of
# values that are already all different.
MAX_DISTINCT_RATIO = 0.5

# Beyond this, the dictionary page itself grows large enough that a reader pays to load it even
# when it wants only a few rows.
MAX_DISTINCT = 1 << 16


@dataclass(frozen=True, slots=True)
class Built:
    """The distinct values in first-seen order, and one index per present value."""

    values: list[Value]
    indices: list[int]


def build(type_: ColumnType, present: list[Value]) -> Built | None:
    """A dictionary for these values, or nothing when it would not pay.

    Absence is the signal to keep PLAIN encoding, not an error.
    """
    # A boolean already costs one bit; a dictionary would only add a page to carry two values.
    if type_.kind is Kind.BOOL or not present:
        return None

    seen: dict[str, int] = {}
    values: list[Value] = []
    indices: list[int] = []

    for value in present:
        key = value.key()
        index = seen.get(key)
        if index is None:
            index = len(values)
            seen[key] = index
            values.append(value)
            # Given up as soon as it is clearly not worth it, rather than building a dictionary
            # the size of the column and then throwing it away.
            if len(values) > MAX_DISTINCT:
                return None
        indices.append(index)

    if len(values) > len(present) * MAX_DISTINCT_RATIO:
        return None
    return Built(values, indices)
