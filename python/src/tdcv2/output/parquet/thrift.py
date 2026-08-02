"""Thrift's compact protocol, write side only.

Parquet keeps its page headers and its entire footer in this encoding, so a file cannot be produced
without it. Small and completely specified — and unforgiving: one wrong byte and no reader will
open the file, with nothing to say about which byte. That is why it lives on its own and is checked
against known bytes.
"""

from __future__ import annotations

# Compact type ids. A boolean carries its value in the field header rather than after it.
BOOLEAN_TRUE = 1
BOOLEAN_FALSE = 2
BYTE = 3
I16 = 4
I32 = 5
I64 = 6
DOUBLE = 7
BINARY = 8
LIST = 9
SET = 10
MAP = 11
STRUCT = 12


def varint(value: int) -> bytes:
    """Unsigned LEB128: seven bits per byte, the top bit meaning "more follows"."""
    if value < 0:
        raise ValueError("varint must be non-negative")
    out = bytearray()
    v = value
    while True:
        b = v & 0x7F
        v >>= 7
        if v > 0:
            b |= 0x80
        out.append(b)
        if v == 0:
            return bytes(out)


def zigzag32(value: int) -> int:
    """A signed 32-bit value folded onto an unsigned one, so small magnitudes stay short."""
    return ((value << 1) ^ (value >> 31)) & 0xFFFFFFFF


def zigzag64(value: int) -> int:
    return ((value << 1) ^ (value >> 63)) & 0xFFFFFFFFFFFFFFFF


class Writer:
    __slots__ = ("_last_field_id", "_out", "_stack")

    def __init__(self) -> None:
        self._out = bytearray()
        # Field ids are written as a delta from the previous field of the same struct.
        self._last_field_id = 0
        self._stack: list[int] = []

    def bytes(self) -> bytes:
        return bytes(self._out)

    def __len__(self) -> int:
        """How many bytes so far — what page and footer offsets are filled in from."""
        return len(self._out)

    def struct_begin(self) -> None:
        self._stack.append(self._last_field_id)
        self._last_field_id = 0

    def struct_end(self) -> None:
        self._out.append(0x00)  # struct stop
        self._last_field_id = self._stack.pop() if self._stack else 0

    def field_begin(self, field_id: int, type_: int) -> None:
        """The short form when the id delta fits in four bits, the long form otherwise."""
        delta = field_id - self._last_field_id
        if 0 < delta <= 15:
            self._out.append((delta << 4) | type_)
        else:
            self._out.append(type_)
            self._out += varint(zigzag32(field_id))
        self._last_field_id = field_id

    def bool(self, field_id: int, value: bool) -> None:
        """A boolean has no value bytes: true and false are two different field types."""
        self.field_begin(field_id, BOOLEAN_TRUE if value else BOOLEAN_FALSE)

    def i8(self, field_id: int, value: int) -> None:
        """Thrift's ``i8`` — one raw byte, NOT zigzagged the way i16/i32/i64 are.

        ``LogicalType.IntType.bitWidth`` is declared i8, and writing it as an i32 would shift every
        field after it by a byte.
        """
        self.field_begin(field_id, BYTE)
        self._out.append(value & 0xFF)

    def i32(self, field_id: int, value: int) -> None:
        self.field_begin(field_id, I32)
        self._out += varint(zigzag32(value))

    def i64(self, field_id: int, value: int) -> None:
        self.field_begin(field_id, I64)
        self._out += varint(zigzag64(value))

    def binary(self, field_id: int, value: bytes) -> None:
        self.field_begin(field_id, BINARY)
        self._out += varint(len(value))
        self._out += value

    def string(self, field_id: int, value: str) -> None:
        self.binary(field_id, value.encode("utf-8"))

    def list_begin(self, field_id: int, element_type: int, size: int) -> None:
        """Open a list field.

        Its elements follow with the ``list_*`` writers and carry no field headers of their own; a
        list of structs uses :meth:`struct_begin` and :meth:`struct_end`.
        """
        self.field_begin(field_id, LIST)
        if size < 15:
            self._out.append((size << 4) | element_type)
        else:
            self._out.append((0x0F << 4) | element_type)
            self._out += varint(size)

    def list_i32(self, value: int) -> None:
        self._out += varint(zigzag32(value))

    def list_i64(self, value: int) -> None:
        self._out += varint(zigzag64(value))

    def list_string(self, value: str) -> None:
        encoded = value.encode("utf-8")
        self._out += varint(len(encoded))
        self._out += encoded
