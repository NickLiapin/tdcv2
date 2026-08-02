"""The declared type of an output column: ``type="int64"``, ``type="decimal(18,2)|null"``.

Every text output is a string, which means whoever reads the file has to guess all over again
which column is a number and which only looks like one — and guesses wrong, turning ``007`` into
``7``. A declared type says it once, in the config, where the person who knows the answer is
already writing.

Only parsing lives here. What a type becomes on disk belongs to the writer, so a second format
could reuse this without inheriting Parquet's opinions.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from enum import Enum


class Kind(Enum):
    BOOL = "bool"
    INT32 = "int32"
    INT64 = "int64"
    # Unsigned integers store the same bytes and are annotated so a reader knows the top bit is
    # magnitude rather than sign.
    UINT8 = "uint8"
    UINT16 = "uint16"
    UINT32 = "uint32"
    UINT64 = "uint64"
    FLOAT = "float"
    FLOAT16 = "float16"
    DOUBLE = "double"
    STRING = "string"
    ENUM = "enum"
    DATE = "date"
    TIMESTAMP = "timestamp"
    DECIMAL = "decimal"
    UUID = "uuid"
    JSON = "json"
    LIST = "list"
    """A list of the element type — ``type="[]int64"``."""


# The widest decimal an int64 can hold; 10^19 overflows a signed 64-bit integer.
MAX_DECIMAL_PRECISION = 18

_HEAD = re.compile(r"^([a-zA-Z0-9_]+)\s*(?:\(([^)]*)\))?$")


@dataclass(frozen=True, slots=True)
class ColumnType:
    kind: Kind
    nullable: bool = False
    """``|null`` — the column may hold a real NULL rather than an empty string."""

    precision: int = 0
    scale: int = 0
    element: ColumnType | None = None
    """A list's element type, or nothing when this is not a list."""

    @property
    def is_list(self) -> bool:
        return self.kind is Kind.LIST

    def __str__(self) -> str:
        if self.kind is Kind.LIST:
            return f"[]{self.element}"
        base = (
            f"decimal({self.precision},{self.scale})"
            if self.kind is Kind.DECIMAL
            else self.kind.value
        )
        return f"{base}|null" if self.nullable else base


def parse_output(raw: str) -> ColumnType:
    """A ``type="…"`` that may be a list.

    In ``[]int64|null`` the ``|null`` binds to the ELEMENT — read left to right, "a list of (int64
    or nothing)". That is what ``missing=`` on a repeating generator needs: it blanks individual
    elements, never the list itself. There is no nullable list, because an empty cell IS an empty
    list and there is no way to say "no list at all".
    """
    text = raw.strip()
    if not text.startswith("[]"):
        return parse(text)
    inner = text[2:].strip()
    if not inner:
        raise ValueError("list type needs an element type, e.g. []int64")
    if inner.startswith("[]"):
        raise ValueError(f'nested lists are not supported, got "{text}"')
    return ColumnType(Kind.LIST, False, 0, 0, parse(inner))


def parse(raw: str) -> ColumnType:
    """A scalar ``type="…"``. The message is meant for whoever wrote it."""
    segments = raw.split("|")
    head = segments[0].strip()
    if not head:
        raise ValueError("column type must not be empty")

    nullable = False
    for segment in segments[1:]:
        modifier = segment.strip().lower()
        if modifier == "null":
            nullable = True
        else:
            raise ValueError(
                f'unknown type modifier "{segment.strip()}" (only "null" is supported)'
            )

    match = _HEAD.match(head)
    kind = _kind_of(match.group(1)) if match else None
    if kind is None or kind is Kind.LIST:
        raise ValueError(f'unknown column type "{head}"')
    params = match.group(2) if match else None

    if kind is not Kind.DECIMAL:
        if params is not None:
            raise ValueError(f'only decimal takes parameters, got "{head}"')
        return ColumnType(kind, nullable)

    if params is None:
        raise ValueError("decimal requires (precision,scale), e.g. decimal(18,2)")
    parts = params.split(",")
    if len(parts) != 2:
        raise ValueError(f'decimal requires (precision,scale), got "{head}"')
    precision = _integer_or(parts[0].strip())
    scale = _integer_or(parts[1].strip())
    if precision is None or precision < 1 or precision > MAX_DECIMAL_PRECISION:
        raise ValueError(
            f"decimal precision must be an integer 1..{MAX_DECIMAL_PRECISION}, "
            f'got "{parts[0].strip()}"'
        )
    if scale is None or scale < 0 or scale > precision:
        raise ValueError(
            f'decimal scale must be an integer 0..precision ({precision}), got "{parts[1].strip()}"'
        )
    return ColumnType(kind, nullable, precision, scale)


def _kind_of(name: str) -> Kind | None:
    lowered = name.lower()
    for kind in Kind:
        if kind is not Kind.LIST and kind.value == lowered:
            return kind
    return None


def _integer_or(text: str) -> int | None:
    try:
        return int(text)
    except ValueError:
        return None
