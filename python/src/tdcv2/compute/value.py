"""The three value types the compute layer has, and the coercions between them.

Exactly three: ``int`` (signed 64-bit), ``str``, and ``list``. No boolean, no float. The layer
exists to write down check digits — a Luhn, a control character, a mod-11 weight sum — and every
one of those is integer arithmetic over characters. A float would introduce rounding into a place
where a single wrong digit invalidates the whole number, and a boolean would only be a value if
predicates were expressions, which they deliberately are not.

Coercion is narrow on purpose. Arithmetic accepts a ONE-character digit string, because reading a
digit out of a number and adding it is the whole job; a multi-character string needs
``<to_number>``, so a config never silently means something other than it says.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Kept explicit so an overflow is a deterministic error in every implementation rather than a
# silent wrap in one of them.
INT64_MIN = -(2**63)
INT64_MAX = 2**63 - 1

_DIGIT = re.compile(r"^[0-9]$")
_INTEGER = re.compile(r"^-?[0-9]+$")


class ComputeError(ValueError):
    """A failure while evaluating a compute tree.

    Structural problems — an unknown tag, a missing child — are the validator's business and are
    caught before the run. This is for what only the values can reveal.
    """


@dataclass(frozen=True, slots=True)
class Value:
    kind: str
    """``int``, ``str`` or ``list``."""

    number: int = 0
    text: str = ""
    items: tuple[Value, ...] = ()


def int_value(v: int) -> Value:
    return Value("int", number=guard64(v))


def str_value(v: str) -> Value:
    return Value("str", text=v)


def list_value(items) -> Value:
    return Value("list", items=tuple(items))


def guard64(v: int) -> int:
    if v < INT64_MIN or v > INT64_MAX:
        raise ComputeError(f"integer overflow: {v} is outside the signed 64-bit range")
    return v


def coerce_int(value: Value, context: str = "arithmetic") -> int:
    """A value as an integer for arithmetic.

    An int passes through; a SINGLE digit character converts; anything else is an error. A
    multi-digit string has to be converted with ``<to_number>``, which keeps the intent
    unambiguous — "the third character" and "the number 375" are different things.
    """
    if value.kind == "int":
        return value.number
    if value.kind == "str":
        if _DIGIT.match(value.text):
            return int(value.text)
        hint = (
            " — wrap it in <to_number> to convert a multi-digit string"
            if _INTEGER.match(value.text)
            else ""
        )
        raise ComputeError(f'expected an integer in {context}, got the string "{value.text}"{hint}')
    raise ComputeError(f"expected an integer in {context}, got a list")


def coerce_str(value: Value) -> str:
    """An int or str as its text. A list is never a string."""
    if value.kind == "str":
        return value.text
    if value.kind == "int":
        return str(value.number)
    raise ComputeError("cannot use a list where a string is expected")


def to_output(value: Value) -> str:
    """The final result: an int or a str renders; a list is an error."""
    if value.kind == "list":
        raise ComputeError("compute result must be an int or str, not a list")
    return coerce_str(value)


def parse_int_strict(s: str) -> int:
    """``<to_number>``: all decimal digits, with an optional leading minus."""
    if not _INTEGER.match(s):
        raise ComputeError(f'<to_number>: "{s}" is not a valid integer')
    return guard64(int(s))


def euclidean_mod(a: int, b: int) -> int:
    """A remainder that is always in ``[0, |b|)``.

    Languages disagree about the sign of ``%`` for negative operands, and a check digit computed
    with the wrong sign is wrong everywhere the number is later validated. So the rule is written
    down rather than inherited.
    """
    if b == 0:
        raise ComputeError("<mod>: the modulus (second child) must not be zero")
    # Python's % already takes the sign of the divisor, so a positive divisor is all it needs.
    return a % (-b if b < 0 else b)


def floor_div(a: int, b: int) -> int:
    """Division rounded toward negative infinity — which is what Python's ``//`` already does."""
    if b == 0:
        raise ComputeError("<divide>: the divisor (second child) must not be zero")
    return a // b
