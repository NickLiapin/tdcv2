"""The min, the max and the NULL count of a column chunk.

This is what lets a reader skip a whole row group: asked for ``price > 500``, it reads the chunk's
maximum and moves on without decoding a byte. Cheap to produce — every value is already in hand —
and a large win for whoever queries the file.

The danger runs the other way from most features: WRONG statistics are worse than none. A maximum
that is too low makes a reader skip a group that did contain matching rows, and the query returns
fewer results with no error and no warning. So the comparisons here follow Parquet's declared sort
orders rather than the language's defaults — byte arrays compare as unsigned UTF-8 bytes, NaN never
takes part in a bound, and the unsigned kinds are compared unsigned even though they are stored in
signed slots.

Only ``min_value``/``max_value`` are written, never the deprecated ``min``/``max``: the old pair had
ambiguous signedness that readers disagreed about, and writing a field readers may misread is the
same trap as writing a wrong bound.
"""

from __future__ import annotations

import math
import struct
from dataclasses import dataclass

from ..column_type import ColumnType, Kind
from . import plain
from .convert import Value

_INT32_KINDS = (Kind.INT32, Kind.DATE, Kind.UINT8, Kind.UINT16, Kind.UINT32)
_INT64_KINDS = (Kind.INT64, Kind.TIMESTAMP, Kind.DECIMAL, Kind.UINT64)
_TEXT_KINDS = (Kind.STRING, Kind.ENUM, Kind.JSON)
_FLOAT_KINDS = (Kind.FLOAT, Kind.FLOAT16, Kind.DOUBLE)


@dataclass(frozen=True, slots=True)
class Result:
    """PLAIN-encoded bounds; absent when the chunk holds no non-NULL value at all."""

    min_value: bytes | None
    max_value: bytes | None
    null_count: int


def compute(type_: ColumnType, present: list[Value], null_count: int) -> Result:
    """Min, max and NULL count for one column chunk.

    ``null_count`` is supplied by the caller because for a list column the NULLs live in the
    definition levels rather than among the values.
    """
    smallest: Value | None = None
    largest: Value | None = None

    for value in present:
        if value is None or _unusable(type_, value):
            continue
        if smallest is None or _compare(type_, value, smallest) < 0:
            smallest = value
        if largest is None or _compare(type_, value, largest) > 0:
            largest = value

    if smallest is None:
        return Result(None, None, null_count)
    return Result(_encode_one(type_, smallest), _encode_one(type_, largest), null_count)


def compare_bytes(a: bytes, b: bytes) -> int:
    """Unsigned byte-wise comparison — Parquet's sort order for a byte array."""
    if a == b:
        return 0
    return -1 if a < b else 1


def _encode_one(type_: ColumnType, value: Value) -> bytes:
    """PLAIN encoding of ONE value, as statistics store it — no length prefix."""
    kind = type_.kind
    if kind is Kind.BOOL:
        return bytes([1 if value.number else 0])
    if kind in _INT32_KINDS:
        return struct.pack("<i", int(value.number))
    if kind is Kind.FLOAT:
        return struct.pack("<f", value.number)
    if kind is Kind.FLOAT16:
        return struct.pack("<H", plain.half_bits(value.number))
    if kind in _INT64_KINDS:
        return struct.pack("<q", int(value.number))
    if kind is Kind.DOUBLE:
        return struct.pack("<d", value.number)
    if kind in _TEXT_KINDS:
        return value.text.encode("utf-8")
    if kind is Kind.UUID:
        return value.raw
    return b""


def _compare(type_: ColumnType, a: Value, b: Value) -> int:
    """Two present values ordered, following Parquet's rules for this column type."""
    kind = type_.kind
    if kind in _FLOAT_KINDS:
        x, y = a.number, b.number
        if math.isnan(x) or math.isnan(y):
            return 0
        return -1 if x < y else (1 if x > y else 0)
    if kind is Kind.UINT32:
        # Stored as wrapped signed bits, so compared unsigned — otherwise a value above 2^31 would
        # look smaller than one, and the bound would exclude real rows.
        return _cmp(int(a.number) & 0xFFFFFFFF, int(b.number) & 0xFFFFFFFF)
    if kind is Kind.UINT64:
        return _cmp(int(a.number) & 0xFFFFFFFFFFFFFFFF, int(b.number) & 0xFFFFFFFFFFFFFFFF)
    if kind in _TEXT_KINDS:
        return compare_bytes(a.text.encode("utf-8"), b.text.encode("utf-8"))
    if kind is Kind.UUID:
        return compare_bytes(a.raw, b.raw)
    # bool, the signed integers, and the small unsigned kinds, which keep their true value in the
    # signed slot.
    return _cmp(a.number, b.number)


def _cmp(x, y) -> int:
    return -1 if x < y else (1 if x > y else 0)


def _unusable(type_: ColumnType, value: Value) -> bool:
    """A value that cannot take part in a bound. NaN only, for now."""
    return type_.kind in _FLOAT_KINDS and math.isnan(value.number)
