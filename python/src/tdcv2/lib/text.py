"""Whitespace, as the reference implementation counts it.

Every implementation has to split words and trim edges in the same places, or a mask that reorders
a full name lands differently in one language than in another. Python's own definition is close
but not equal — it counts the ASCII separator controls as space and does not count the byte-order
mark — so the set is written out here and used instead of ``str.strip`` and ``\\s``.
"""

from __future__ import annotations

import re

# WhiteSpace and LineTerminator, exactly. U+FEFF is in it (Excel writes one ahead of a CSV
# header); U+001C..U+001F are not, though Python would count them.
SPACE_CLASS = (
    "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
)

SPACE = re.compile(f"[{SPACE_CLASS}]")
NOT_SPACE_RUN = re.compile(f"[^{SPACE_CLASS}]+")
_EDGES = re.compile(f"^[{SPACE_CLASS}]+|[{SPACE_CLASS}]+$")


def is_space(ch: str) -> bool:
    """True for one character JavaScript's ``\\s`` would match."""
    return ch != "" and SPACE.match(ch) is not None


def trim(value: str) -> str:
    """``value.trim()`` as JavaScript performs it."""
    return _EDGES.sub("", value)
