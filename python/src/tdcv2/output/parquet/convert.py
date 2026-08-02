"""Rendered text into a typed value.

The engine produces strings; a typed container needs real values. Anything that cannot be
represented exactly is an error here — never a silent rounding, never a truncation. A synthetic
dataset that quietly loses digits is worse than one that refuses to be written, because the first
kind is discovered much later and by someone who trusted it.
"""

from __future__ import annotations

import math
import re
import struct
from dataclasses import dataclass

from ...date.plain import PlainDateTime, days_in_month, to_epoch_millis
from ..column_type import ColumnType, Kind
from . import plain

_INTEGER = re.compile(r"^[+-]?\d+$")
_DATE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")
_DECIMAL = re.compile(r"^([+-]?)(\d+)(?:\.(\d*))?$")
_HEX32 = re.compile(r"^[0-9a-f]{32}$")
_NUMBER = re.compile(r"^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$")
_TIMESTAMP = re.compile(
    r"^(\d{4})-(\d{2})-(\d{2})"
    r"(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?)?"
    r"(Z|[+-]\d{2}:?\d{2})?$"
)


@dataclass(frozen=True, slots=True)
class Value:
    """A value ready for PLAIN encoding. ``kind`` says which slot holds it."""

    kind: str
    """``bool``, ``int``, ``long``, ``double``, ``text`` or ``bytes``."""

    number: int | float = 0
    text: str = ""
    raw: bytes = b""

    def key(self) -> str:
        """A stable identity. It must never merge two values a reader would tell apart."""
        if self.kind == "bytes":
            return "b:" + self.raw.hex()
        if self.kind == "text":
            return "s:" + self.text
        if self.kind == "long":
            return f"i:{self.number}"
        if self.kind == "int":
            # Distinguished from a long by its prefix, so the same digits in two slots cannot
            # merge.
            return f"j:{self.number}"
        if self.kind == "double":
            return f"d:{self.number}"
        return f"z:{self.number}"


def bool_value(v: bool) -> Value:
    return Value("bool", 1 if v else 0)


def int_value(v: int) -> Value:
    return Value("int", v)


def long_value(v: int) -> Value:
    return Value("long", v)


def double_value(v: float) -> Value:
    return Value("double", v)


def text_value(v: str) -> Value:
    return Value("text", text=v)


def bytes_value(v: bytes) -> Value:
    return Value("bytes", raw=v)


def value(raw: str, type_: ColumnType) -> Value | None:
    """One rendered cell.

    Raises with a message about the value and the expectation; the writer wraps it in the column
    name and the row number, so the complaint names the cell rather than the file. ``None`` means
    the column is NULL on this row.
    """
    if raw == "":
        if type_.nullable:
            return None
        raise ValueError("empty value in a required column (add |null to allow NULL)")
    text = raw.strip()
    kind = type_.kind

    if kind is Kind.BOOL:
        lowered = text.lower()
        if lowered in ("true", "1"):
            return bool_value(True)
        if lowered in ("false", "0"):
            return bool_value(False)
        raise ValueError(f'"{raw}" is not a boolean (expected true/false or 1/0)')
    if kind is Kind.INT32:
        v = _integer(text, "int32")
        if v < -(2**31) or v > 2**31 - 1:
            raise ValueError(f'"{raw}" is out of range for int32')
        return int_value(v)
    if kind is Kind.INT64:
        v = _integer(text, "int64")
        if v < -(2**63) or v > 2**63 - 1:
            raise ValueError(f'"{raw}" is out of range for int64')
        return long_value(v)
    if kind in (Kind.UINT8, Kind.UINT16, Kind.UINT32):
        bits = {Kind.UINT8: 8, Kind.UINT16: 16, Kind.UINT32: 32}[kind]
        # Stored in a signed 32-bit slot: a value above 2^31-1 wraps to negative bits, which is
        # exactly what the unsigned annotation tells a reader to undo.
        return int_value(_to_signed(_unsigned(text, raw, bits), 32))
    if kind is Kind.UINT64:
        return long_value(_to_signed(_unsigned(text, raw, 64), 64))
    if kind is Kind.FLOAT:
        v = _number(text, raw)
        # Rounded to what four bytes can actually hold, so the value in memory is the value on
        # disk — otherwise the column statistics would describe numbers the file does not have.
        (rounded,) = struct.unpack("<f", struct.pack("<f", v))
        if not math.isfinite(rounded):
            raise ValueError(f'"{raw}" is out of range for float')
        return double_value(rounded)
    if kind is Kind.FLOAT16:
        v = _number(text, raw)
        rounded = plain.half_to_float(plain.half_bits(v))
        if not math.isfinite(rounded):
            raise ValueError(f'"{raw}" is out of range for float16')
        return double_value(rounded)
    if kind is Kind.DOUBLE:
        return double_value(_number(text, raw))
    if kind is Kind.DATE:
        return int_value(_days(text))
    if kind is Kind.TIMESTAMP:
        return long_value(_millis(text, raw))
    if kind is Kind.DECIMAL:
        return long_value(_decimal(text, type_.precision, type_.scale))
    if kind is Kind.UUID:
        return bytes_value(_uuid(text))
    if kind in (Kind.STRING, Kind.ENUM, Kind.JSON):
        return text_value(raw)  # passed through untouched, surrounding spaces included
    raise ValueError(f"cannot convert to {type_}")


def _integer(text: str, what: str) -> int:
    if not _INTEGER.match(text):
        raise ValueError(f'"{text}" is not an integer ({what})')
    return int(text)


def _number(text: str, raw: str) -> float:
    # Python accepts "1_0", "inf" and "nan"; JavaScript's Number() does not, and the two
    # implementations have to refuse the same strings.
    if not _NUMBER.match(text):
        raise ValueError(f'"{raw}" is not a number')
    v = float(text)
    if not math.isfinite(v):
        raise ValueError(f'"{raw}" is not a number')
    return v


def _unsigned(text: str, raw: str, bits: int) -> int:
    """An unsigned integer of the given width, with negatives refused outright."""
    v = _integer(text, f"uint{bits}")
    if v < 0:
        raise ValueError(f'"{raw}" is negative, but the column is unsigned')
    if v > (1 << bits) - 1:
        raise ValueError(f'"{raw}" is out of range for uint{bits}')
    return v


def _to_signed(value_: int, bits: int) -> int:
    """The same bits read as a signed slot, which is where Parquet puts them."""
    limit = 1 << bits
    return value_ - limit if value_ >= limit // 2 else value_


def _days(text: str) -> int:
    """Days since the epoch — how Parquet stores a date."""
    m = _DATE.match(text)
    if not m:
        raise ValueError(f'"{text}" is not a date (expected YYYY-MM-DD)')
    year, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if not 1 <= month <= 12 or not 1 <= day <= days_in_month(year, month):
        raise ValueError(f'"{text}" is not a date (no such calendar day)')
    return to_epoch_millis(PlainDateTime(year, month, day)) // 86_400_000


def _millis(text: str, raw: str) -> int:
    """An ISO-8601 timestamp as milliseconds since the epoch; a bare one is read as UTC."""
    m = _TIMESTAMP.match(text)
    if not m:
        raise ValueError(f'"{raw}" is not a timestamp (expected ISO-8601)')
    year, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if not 1 <= month <= 12 or not 1 <= day <= days_in_month(year, month):
        raise ValueError(f'"{raw}" is not a timestamp (expected ISO-8601)')
    hour = int(m.group(4) or 0)
    minute = int(m.group(5) or 0)
    second = int(m.group(6) or 0)
    fraction = (m.group(7) or "").ljust(3, "0")[:3]
    millis = int(fraction) if fraction else 0

    total = to_epoch_millis(PlainDateTime(year, month, day, hour, minute, second, millis))
    offset = m.group(8)
    if offset and offset != "Z":
        sign = -1 if offset[0] == "-" else 1
        body = offset[1:].replace(":", "")
        total -= sign * (int(body[:2]) * 3600 + int(body[2:]) * 60) * 1000
    return total


def _decimal(text: str, precision: int, scale: int) -> int:
    """A decimal as its unscaled integer — refusing anything the declared type cannot hold."""
    m = _DECIMAL.match(text)
    if not m:
        raise ValueError(f'"{text}" is not a decimal')
    fraction = m.group(3) or ""
    if len(fraction) > scale:
        raise ValueError(
            f'"{text}" has more decimal places than the declared scale {scale} — refusing to round'
        )
    digits = m.group(2) + fraction.ljust(scale, "0")
    significant = digits.lstrip("0")
    if len(significant) > precision:
        raise ValueError(f'"{text}" exceeds the declared precision {precision}')
    unscaled = int(digits)
    if m.group(1) == "-":
        unscaled = -unscaled
    if unscaled < -(2**63) or unscaled > 2**63 - 1:
        raise ValueError(f'"{text}" does not fit a 64-bit decimal')
    return unscaled


def _uuid(text: str) -> bytes:
    hex_text = text.replace("-", "").lower()
    if not _HEX32.match(hex_text):
        raise ValueError(f'"{text}" is not a uuid')
    return bytes.fromhex(hex_text)
