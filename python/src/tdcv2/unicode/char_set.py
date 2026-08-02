"""``value="[a-z0-9]"`` — an inline character set, expanded.

The bracket form is the one people already know from regular expressions, which is why it is
spelled the same way. Everything outside brackets is taken literally, and whitespace between
entries is a separator rather than a character — a set written across two lines for readability
should not quietly include a newline.
"""

from __future__ import annotations

from .alphabets import code_points

_SEPARATORS = {" ", "\t", "\n", "\r"}


def parse(spec: str) -> list[str]:
    """The characters a spec names, in first-seen order and without duplicates."""
    chars = code_points(spec)
    out: dict[str, None] = {}
    i = 0
    while i < len(chars):
        c = chars[i]
        if c == "[":
            end = -1
            for j in range(i + 1, len(chars)):
                if chars[j] == "]":
                    end = j
                    break
            if end < 0:
                raise ValueError(f'character set: unterminated "[" in "{spec}"')
            _expand_group(chars[i + 1 : end], out, spec)
            i = end + 1
            continue
        if c == "," or c in _SEPARATORS:
            i += 1
            continue
        out[c] = None
        i += 1
    return list(out)


def _expand_group(group: list[str], out: dict[str, None], spec: str) -> None:
    """The inside of a bracket: literals, and ``a-z`` ranges."""
    j = 0
    while j < len(group):
        c = group[j]
        if j + 2 < len(group) and group[j + 1] == "-":
            lo = ord(c)
            hi = ord(group[j + 2])
            if hi < lo:
                raise ValueError(f'character set: reversed range "{c}-{group[j + 2]}" in "{spec}"')
            for cp in range(lo, hi + 1):
                out[chr(cp)] = None
            j += 3
            continue
        out[c] = None
        j += 1
