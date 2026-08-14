"""``<gen type="increment">`` and its mirror — a value that comes from the row's position.

The only generator that draws nothing. Its value is a function of the row index, which is why a
counter is the same in every engine without any of them arranging anything.
"""

from __future__ import annotations

from ..lib import numbers


def generate(attrs: dict[str, str], count: int, ascending: bool) -> list[str]:
    """The column, whole or fractional.

    A whole counter stays on integer arithmetic, where it is exact however far it runs. A
    fractional one — ``value="9.99" step="0.50"``, the shape the counters page teaches — moves to
    the same floating point the reference uses, and is written the same way, so the two agree
    digit for digit. Note the value is the start plus ``step * i``, not ``i`` additions: repeated
    addition would accumulate its own error and drift away from the reference by the thousandth
    row.
    """
    raw_start = attrs.get("value")
    raw_step = attrs.get("step")
    if _is_whole(raw_start) and _is_whole(raw_step):
        start = _whole(raw_start, 0)
        step = _whole(raw_step, 1)
        return [str(start + step * i if ascending else start - step * i) for i in range(count)]

    start = _fraction(raw_start, 0.0)
    step = _fraction(raw_step, 1.0)
    return [
        numbers.to_text(start + step * i if ascending else start - step * i)
        for i in range(count)
    ]


def _is_whole(raw: str | None) -> bool:
    body = (raw or "").strip()
    if not body:
        return True
    try:
        int(body)
    except ValueError:
        return False
    return True


def _whole(raw: str | None, fallback: int) -> int:
    body = (raw or "").strip()
    return fallback if not body else int(body)


def _fraction(raw: str | None, fallback: float) -> float:
    body = (raw or "").strip()
    if not body:
        return fallback
    try:
        return float(body)
    except ValueError as e:
        raise ValueError(f'counter: "{body}" is not a number') from e


def value_at(attrs: dict[str, str], index: int, ascending: bool) -> str:
    """One row's value, for the engines that build a counter a row at a time.

    Shared with :func:`generate` so the streaming and the in-memory answer cannot drift — a
    counter is position, not chance, and the two paths disagreeing about it would be visible
    in every row.
    """
    raw_start = attrs.get("value")
    raw_step = attrs.get("step")
    if _is_whole(raw_start) and _is_whole(raw_step):
        start = _whole(raw_start, 0)
        step = _whole(raw_step, 1)
        return str(start + step * index if ascending else start - step * index)
    start_f = _fraction(raw_start, 0.0)
    step_f = _fraction(raw_step, 1.0)
    return numbers.to_text(
        start_f + step_f * index if ascending else start_f - step_f * index
    )
