"""A PNG decoder, so a drawn picture can be a data source.

Someone sketches a curve — in a drawing app, on paper, photographed — and that sketch becomes the
shape of a column. That is the whole point of the raster path, and it needs the pixels, so the
decoder is here rather than in a dependency: a third-party image library would have to exist,
agree with itself, and be installable in all three languages.

What real exports actually produce is supported: 8-bit and 16-bit grayscale, RGB, gray+alpha and
RGBA, plus 8-bit palette with tRNS. Sub-byte depths and Adam7 interlacing raise a clear
"re-export" error instead of decoding wrongly — a picture read incorrectly would still produce
data, and nobody would notice.
"""

from __future__ import annotations

import struct
import zlib
from dataclasses import dataclass

SIGNATURE = b"\x89PNG\r\n\x1a\n"

# Channels carried by each colour type: grayscale, RGB, palette index, gray+alpha, RGBA.
_CHANNELS = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}


@dataclass(frozen=True, slots=True)
class Image:
    width: int
    height: int
    rgba: bytearray
    """Row-major RGBA, four bytes per pixel: ``rgba[(y*width + x)*4 + c]``."""


def is_png(data: bytes) -> bool:
    """Whether the signature is there — which is how a ``src`` is told PNG from SVG."""
    return data[: len(SIGNATURE)] == SIGNATURE


def decode(data: bytes) -> Image:
    if not is_png(data):
        raise ValueError("pattern: src is not a PNG image")

    width = height = bit_depth = color_type = interlace = 0
    seen_header = False
    palette: bytes | None = None
    transparency: bytes | None = None
    idat: list[bytes] = []

    pos = 8
    while pos + 8 <= len(data):
        (length,) = struct.unpack_from(">I", data, pos)
        chunk_type = data[pos + 4 : pos + 8]
        start = pos + 8
        body = data[start : start + length]

        if chunk_type == b"IHDR":
            width, height = struct.unpack_from(">II", data, start)
            bit_depth = data[start + 8]
            color_type = data[start + 9]
            interlace = data[start + 12]
            seen_header = True
        elif chunk_type == b"PLTE":
            palette = body
        elif chunk_type == b"tRNS":
            transparency = body
        elif chunk_type == b"IDAT":
            idat.append(body)
        elif chunk_type == b"IEND":
            break

        pos = start + length + 4  # past the body and its CRC

    if not seen_header:
        raise ValueError("pattern: PNG has no IHDR header")
    if interlace != 0:
        raise ValueError("pattern: interlaced PNG is unsupported — re-export without interlacing")
    channels = _CHANNELS.get(color_type)
    if channels is None:
        raise ValueError(f"pattern: unsupported PNG color type {color_type}")
    if not (bit_depth == 8 or (bit_depth == 16 and color_type != 3)):
        raise ValueError(
            f"pattern: PNG bit depth {bit_depth} (color type {color_type}) is unsupported "
            "— re-export as 8-bit"
        )

    raw = zlib.decompress(b"".join(idat))
    bytes_per_sample = 2 if bit_depth == 16 else 1
    bpp = channels * bytes_per_sample
    stride = width * bpp
    pixels = _defilter(raw, height, stride, bpp)
    rgba = _to_rgba(pixels, width, height, color_type, bit_depth, palette, transparency)
    return Image(width, height, rgba)


def luminance(r: int, g: int, b: int) -> float:
    """Perceptual luminance 0..255 of an RGB triple, Rec. 601."""
    return 0.299 * r + 0.587 * g + 0.114 * b


def _defilter(raw: bytes, height: int, stride: int, bpp: int) -> bytearray:
    """The scanline filters reversed — None, Sub, Up, Average, Paeth."""
    out = bytearray(height * stride)
    at = 0
    for y in range(height):
        filter_type = raw[at]
        at += 1
        row = y * stride
        prev = row - stride
        for x in range(stride):
            cur = raw[at]
            at += 1
            a = out[row + x - bpp] if x >= bpp else 0
            b = out[prev + x] if y > 0 else 0
            c = out[prev + x - bpp] if y > 0 and x >= bpp else 0
            if filter_type == 0:
                value = cur
            elif filter_type == 1:
                value = cur + a
            elif filter_type == 2:
                value = cur + b
            elif filter_type == 3:
                value = cur + ((a + b) >> 1)
            elif filter_type == 4:
                value = cur + _paeth(a, b, c)
            else:
                raise ValueError(f"pattern: PNG scanline uses unknown filter {filter_type}")
            out[row + x] = value & 0xFF
    return out


def _paeth(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    return b if pb <= pc else c


def _to_rgba(
    pixels: bytearray,
    width: int,
    height: int,
    color_type: int,
    bit_depth: int,
    palette: bytes | None,
    transparency: bytes | None,
) -> bytearray:
    """The defiltered samples expanded into RGBA, resolving palette, alpha and bit depth."""
    rgba = bytearray(width * height * 4)
    channels = _CHANNELS.get(color_type, 1)
    step = 2 if bit_depth == 16 else 1  # only the high byte of a 16-bit sample is read
    bpp = channels * step

    for i in range(width * height):
        src = i * bpp
        dst = i * 4
        a = 255
        if color_type == 0:
            r = g = b = pixels[src]
        elif color_type == 2:
            r, g, b = pixels[src], pixels[src + step], pixels[src + 2 * step]
        elif color_type == 3:
            index = pixels[src]
            r = palette[index * 3] if palette else 0
            g = palette[index * 3 + 1] if palette else 0
            b = palette[index * 3 + 2] if palette else 0
            a = transparency[index] if transparency and index < len(transparency) else 255
        elif color_type == 4:
            r = g = b = pixels[src]
            a = pixels[src + step]
        else:
            r, g, b = pixels[src], pixels[src + step], pixels[src + 2 * step]
            a = pixels[src + 3 * step]
        rgba[dst] = r
        rgba[dst + 1] = g
        rgba[dst + 2] = b
        rgba[dst + 3] = a
    return rgba
