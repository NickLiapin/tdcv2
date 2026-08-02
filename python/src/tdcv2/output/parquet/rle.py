"""The RLE / bit-packed hybrid, which dictionary indices and level streams both ride on.

Two shapes share one stream, told apart by the low bit of a varint header. An RLE run is
``varint(count << 1)`` followed by the repeated value; a bit-packed run is
``varint((groups << 1) | 1)`` followed by groups of eight values packed at the given bit width,
least significant bit first.

Which shape is used matters more than it sounds. A categorical column — "Moscow", "Paris", "Berlin"
— is shuffled across rows, so consecutive repeats are rare and an RLE-only encoder spends about two
bytes per value, barely better than the text it replaced. Bit-packing spends BITS: two per value for
three categories, a sixteen-fold difference on the same data. So packing is the default and RLE is
kept for the genuinely constant case.
"""

from __future__ import annotations

from . import thrift


def dictionary_bit_width(count: int) -> int:
    """Bits needed to address ``count`` distinct entries; one for a single entry."""
    if count <= 1:
        return 0 if count == 0 else 1
    bits = 0
    while (1 << bits) < count:
        bits += 1
    return bits


def dictionary_indices(indices: list[int], bit_width: int) -> bytes:
    """Dictionary indices for a data page.

    The result begins with one byte holding the bit width. That byte belongs to the page body
    rather than to the hybrid stream, and a reader expects it in exactly that place.
    """
    out = bytearray([bit_width])
    if indices:
        first = indices[0]
        constant = all(index == first for index in indices)
        # A column holding one value all the way down collapses to a few bytes; anything else
        # packs, because shuffled categories have no runs worth exploiting.
        out += (
            _rle_run(first, len(indices), bit_width)
            if constant
            else _bit_packed(indices, bit_width)
        )
    return bytes(out)


def levels(values: list[int], bit_width: int) -> bytes:
    """A level stream, RLE-encoded.

    Definition levels say how deep a value actually exists — for a flat column, 1 present and 0 for
    NULL; for a list, also an empty list and a null element. Repetition levels say where a new
    record starts (0) and where a list continues (1). Both are the same encoding, so one function
    serves both.

    Only RLE runs are emitted, one per stretch of equal levels. Valid, simple, and compact in
    practice: real data is long runs of "present".
    """
    if not values:
        return b""
    value_bytes = (bit_width + 7) // 8
    out = bytearray()

    start = 0
    while start < len(values):
        value = values[start]
        end = start + 1
        while end < len(values) and values[end] == value:
            end += 1
        out += thrift.varint((end - start) << 1)
        v = value
        for _ in range(value_bytes):
            out.append(v & 0xFF)
            v >>= 8
        start = end
    return bytes(out)


def _rle_run(value: int, count: int, bit_width: int) -> bytes:
    """One RLE run: the same value repeated."""
    out = bytearray(thrift.varint(count << 1))
    rest = value & 0xFFFFFFFF
    for _ in range((bit_width + 7) // 8):
        out.append(rest & 0xFF)
        rest >>= 8
    return bytes(out)


def _bit_packed(values: list[int], bit_width: int) -> bytes:
    """One bit-packed run covering every value, zero-padded to a multiple of eight."""
    groups = (len(values) + 7) // 8
    out = bytearray(thrift.varint((groups << 1) | 1))

    acc = 0
    bits = 0
    for i in range(groups * 8):
        value = values[i] & 0xFFFFFFFF if i < len(values) else 0
        acc |= value << bits
        bits += bit_width
        while bits >= 8:
            out.append(acc & 0xFF)
            acc >>= 8
            bits -= 8
    if bits > 0:
        out.append(acc & 0xFF)
    return bytes(out)
