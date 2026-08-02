"""Snappy compression, written here rather than taken from a library.

Two reasons, and the second is the real one. First, no runtime dependency — the whole writer exists
to avoid one. Second, two different Snappy implementations may emit different, both valid, output
for the same input, because the format leaves match-finding entirely to the encoder. This project
promises that its implementations produce byte-identical files, and that promise survives only if
all of them run the same matcher. This one does, by construction.

The format: a varint holding the uncompressed length, then a stream of elements. An element is
either a literal (bytes copied out as they are) or a copy (go back this far and take this many).
The tag byte's low two bits say which, and copies come in sizes depending on how far back they
reach.

The matcher is a plain hash table over four-byte sequences. Not the strongest possible — Snappy
permits any encoder whose output decodes back to the input — but fast, allocation-light and, above
all, exactly reproducible.
"""

from __future__ import annotations

# Table size: larger finds more matches and costs more memory. Fixed so every port agrees.
_HASH_BITS = 14
_HASH_SIZE = 1 << _HASH_BITS

# A copy can reach back at most this far.
_MAX_OFFSET = 1 << 16

# One copy element carries at most this many bytes; a longer match emits several.
_MAX_COPY_LENGTH = 64

# Below this, a match is not worth a copy element.
_MIN_MATCH = 4


def compress(data: bytes) -> bytes:
    """The input compressed. The result always decodes back to it exactly."""
    out = bytearray()
    _varint(out, len(data))
    size = len(data)
    if size == 0:
        return bytes(out)

    table = [-1] * _HASH_SIZE
    literal_start = 0
    at = 0

    while at + _MIN_MATCH <= size:
        # Multiply-shift hash; the constant is Snappy's own, kept so the table behaves the same
        # way in every implementation.
        slot = ((_read_uint32(data, at) * 0x1E35A7BD) & 0xFFFFFFFF) >> (32 - _HASH_BITS)
        candidate = table[slot]
        table[slot] = at

        near = candidate >= 0 and at - candidate < _MAX_OFFSET
        if not near or _read_uint32(data, candidate) != _read_uint32(data, at):
            at += 1
            continue

        _literal(out, data, literal_start, at - literal_start)

        # The match extended as far as it goes, emitting several copies when it is long.
        matched = _MIN_MATCH
        while at + matched < size and data[candidate + matched] == data[at + matched]:
            matched += 1
        offset = at - candidate
        remaining = matched
        while remaining > 0:
            piece = min(remaining, _MAX_COPY_LENGTH)
            _copy(out, offset, piece)
            remaining -= piece

        at += matched
        literal_start = at

    _literal(out, data, literal_start, size - literal_start)
    return bytes(out)


def _read_uint32(data: bytes, at: int) -> int:
    b0 = data[at] if at < len(data) else 0
    b1 = data[at + 1] if at + 1 < len(data) else 0
    b2 = data[at + 2] if at + 2 < len(data) else 0
    b3 = data[at + 3] if at + 3 < len(data) else 0
    return b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)


def _varint(out: bytearray, value: int) -> None:
    rest = value
    while rest >= 0x80:
        out.append((rest & 0x7F) | 0x80)
        rest >>= 7
    out.append(rest)


def _literal(out: bytearray, data: bytes, start: int, length: int) -> None:
    """A literal run: the tag, an optional extended length, then the bytes."""
    if length <= 0:
        return
    n = length - 1
    if n < 60:
        out.append(n << 2)
    else:
        # 60..63 in the tag mean "one to four length bytes follow", little-endian.
        width = 0
        rest = n
        while rest > 0:
            width += 1
            rest >>= 8
        out.append((59 + width) << 2)
        rest = n
        for _ in range(width):
            out.append(rest & 0xFF)
            rest >>= 8
    out += data[start : start + length]


def _copy(out: bytearray, offset: int, length: int) -> None:
    """A copy element.

    The one-byte-offset form is smaller but reaches only 2047 bytes back and carries four to eleven
    bytes; everything else uses the two-byte form.
    """
    if _MIN_MATCH <= length <= 11 and offset < 2048:
        out.append(0x01 | ((length - _MIN_MATCH) << 2) | ((offset >> 8) << 5))
        out.append(offset & 0xFF)
        return
    out.append(0x02 | ((length - 1) << 2))
    out.append(offset & 0xFF)
    out.append((offset >> 8) & 0xFF)
