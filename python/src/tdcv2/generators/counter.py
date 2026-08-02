"""``<gen type="increment">`` and its mirror — a value that comes from the row's position.

The only generator that draws nothing. Its value is a function of the row index, which is why a
counter is the same in every engine without any of them arranging anything.
"""

from __future__ import annotations


def generate(attrs: dict[str, str], count: int, ascending: bool) -> list[str]:
    start = _number(attrs.get("value"), 0)
    step = _number(attrs.get("step"), 1)
    return [str(start + step * i if ascending else start - step * i) for i in range(count)]


def _number(raw: str | None, fallback: int) -> int:
    if raw is None or not raw.strip():
        return fallback
    return int(raw.strip())
