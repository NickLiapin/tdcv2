"""PLAIN encoding — the simplest Parquet value layout.

Values back to back, little-endian, with no dictionary and no compression of their own. Correct and
portable, which is what a first version should be. Denser encodings can be added later without
changing anything a reader accepts.
"""

from __future__ import annotations

import struct


def int32(values: list[int]) -> bytes:
    return struct.pack(f"<{len(values)}i", *values)


def int64(values: list[int]) -> bytes:
    return struct.pack(f"<{len(values)}q", *values)


def doubles(values: list[float]) -> bytes:
    return struct.pack(f"<{len(values)}d", *values)


def floats(values: list[float]) -> bytes:
    return struct.pack(f"<{len(values)}f", *values)


def byte_array(values: list[str]) -> bytes:
    """Each value is a four-byte little-endian length followed by its bytes."""
    out = bytearray()
    for value in values:
        encoded = value.encode("utf-8")
        out += struct.pack("<I", len(encoded))
        out += encoded
    return bytes(out)


def fixed(values: list[bytes]) -> bytes:
    """Fixed-width values — a sixteen-byte UUID, say — carry no length prefix."""
    return b"".join(values)


def booleans(values: list[bool]) -> bytes:
    """Booleans are bit-packed, least significant bit first."""
    out = bytearray((len(values) + 7) // 8)
    for i, value in enumerate(values):
        if value:
            out[i >> 3] |= 1 << (i & 7)
    return bytes(out)


def float16(values: list[float]) -> bytes:
    return b"".join(struct.pack("<H", half_bits(v)) for v in values)


def half_bits(value: float) -> int:
    """IEEE-754 half precision as sixteen bits.

    Parquet has no physical type for it — a FLOAT16 lives in a two-byte fixed array — so the bits
    are assembled by hand. Rounding is half-to-even, matching every other implementation: a
    different rule would put different bytes in the file for the same input, which is exactly what
    a cross-language guarantee forbids.
    """
    (x,) = struct.unpack("<I", struct.pack("<f", value))

    sign = ((x >> 31) & 1) << 15
    exponent = (x >> 23) & 0xFF
    mantissa = x & 0x7FFFFF

    # Infinity keeps a zero mantissa; a NaN must keep a non-zero one, or it would arrive as
    # infinity on the other side.
    if exponent == 0xFF:
        return sign | 0x7C00 | (0 if mantissa == 0 else 0x0200)

    unbiased = exponent - 127
    if unbiased > 15:
        return sign | 0x7C00  # beyond half's range

    if unbiased >= -14:
        # Normal: thirteen of the twenty-three mantissa bits dropped, rounding half to even.
        keep = mantissa >> 13
        if _rounds_up(mantissa & 0x1FFF, 0x1000, keep):
            keep += 1
        half = unbiased + 15
        if keep == 0x400:
            keep = 0  # the mantissa carried into the exponent
            half += 1
        return sign | 0x7C00 if half >= 0x1F else sign | (half << 10) | keep

    if unbiased < -25:
        return sign  # smaller than any subnormal, so a signed zero

    # Subnormal: the implicit leading one restored, then shifted down to fit.
    full = mantissa | 0x800000
    shift = -unbiased - 1
    keep = full >> shift
    if _rounds_up(full & ((1 << shift) - 1), 1 << (shift - 1), keep):
        keep += 1
    return sign | keep


def half_to_float(bits: int) -> float:
    """Half-precision bits back to a number."""
    sign = -1.0 if bits & 0x8000 else 1.0
    exponent = (bits >> 10) & 0x1F
    mantissa = bits & 0x03FF
    if exponent == 0:
        return sign * (2.0**-14) * (mantissa / 1024.0)
    if exponent == 0x1F:
        return sign * float("inf") if mantissa == 0 else float("nan")
    return sign * (2.0 ** (exponent - 15)) * (1 + mantissa / 1024.0)


def _rounds_up(dropped: int, half_point: int, keep: int) -> bool:
    """Round half to even, the IEEE-754 default.

    The simpler round-half-up is the version most often copied around, and it disagrees on exact
    ties: 2049 becomes 2050 rather than 2048. Ties are common in generated data, so the wrong rule
    here would quietly put different bytes in the file than every other Parquet writer produces.
    """
    if dropped > half_point:
        return True
    return dropped == half_point and (keep & 1) == 1
