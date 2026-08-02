"""``accumulate=`` — a running total inside one record's ``repeat`` list.

A cell holding ``100,150,150`` becomes ``100,250,400``. That is the shape most "I need a
running total" questions actually have: a receipt's subtotal, the elapsed time of a
session, the odometer over the legs of a trip. The accumulation lives inside ONE record,
which is why it costs nothing — a record is computed whole anyway, so rows stay
independent and streaming, ``--jobs`` and ``get_at`` are untouched.

The one decision worth defending is the arithmetic. Five implementations have to produce
the same bytes, and floating point does not: ``0.1 + 0.2`` prints differently in
JavaScript, Python, Java, C# and Rust. So the sum is done on SCALED INTEGERS. Every
element is read as a fixed-point number, the widest fraction in the list sets the scale,
and the total is formatted back at that scale by hand. Python's own ints are unbounded,
which makes this the easy port — the hard ones are the languages that had to pick a width.

``min`` and ``max`` are different in a useful way: their result IS one of the inputs, so
the winning element's own text is returned unchanged. A value that arrived as ``007``
stays ``007``.
"""

from __future__ import annotations

import re

#: What a running accumulation can do. Each keeps a value that only ever moves one way.
OPS = ("sum", "min", "max")

_NUMBER = re.compile(r"^[+-]?\d+(\.\d+)?$")


class AccumulateError(Exception):
    """A misspelled op, or an element that is not a number."""


def read(attrs: dict[str, str]) -> str | None:
    """Read ``accumulate=`` where an unknown op simply means "none".

    The engine path uses this one. By the time a value is drawn the validator has already
    refused a misspelled op (TDC238), so raising here would only turn a reported problem
    into a crash.
    """
    raw = (attrs.get("accumulate") or "").strip()
    return raw if raw in OPS else None


def parse(attrs: dict[str, str]) -> str | None:
    """The same, but strict — the validator's copy, which turns a bad op into a diagnostic."""
    raw = (attrs.get("accumulate") or "").strip()
    if raw == "":
        return None
    if raw not in OPS:
        raise AccumulateError(f'accumulate="{raw}" is not one of {", ".join(OPS)}')
    return raw


def _parse_fixed(text: str) -> tuple[int, int]:
    """One element as ``(value, scale)`` — the value scaled by ``10**scale``.

    Deliberately strict. A generator that produces words has no running total, and quietly
    treating ``abc`` as zero would hand back a column that adds up to something and means
    nothing.
    """
    trimmed = text.strip()
    if not _NUMBER.match(trimmed):
        raise AccumulateError(
            f'accumulate=: "{text}" is not a number, so there is nothing to accumulate. '
            "A running total needs numeric elements — accumulate= belongs on a numeric "
            "generator."
        )
    dot = trimmed.find(".")
    if dot < 0:
        return int(trimmed), 0
    return int(trimmed[:dot] + trimmed[dot + 1 :]), len(trimmed) - dot - 1


def _format_fixed(value: int, scale: int) -> str:
    """Back to text at ``scale`` decimal places, with no float in the path."""
    if scale == 0:
        return str(value)
    negative = value < 0
    digits = str(-value if negative else value).rjust(scale + 1, "0")
    return f"{'-' if negative else ''}{digits[:-scale]}.{digits[-scale:]}"


def apply(parts: list[str], op: str) -> list[str]:
    """Turn a list into its running accumulation.

    An EMPTY element stays empty and leaves the accumulator alone. That is what
    ``missing=`` produces, and "no reading that day" should not reset a meter or count as
    a zero-value transaction.
    """
    # One pass to learn the widest fraction, so every element is compared and summed at
    # the same scale. Done first because the scale of the total must not depend on which
    # elements happened to come earlier.
    scale = 0
    numbers: list[tuple[int, int] | None] = []
    for part in parts:
        if part.strip() == "":
            numbers.append(None)
            continue
        number = _parse_fixed(part)
        scale = max(scale, number[1])
        numbers.append(number)

    out: list[str] = []
    acc: int | None = None
    acc_text = ""
    for part, number in zip(parts, numbers, strict=True):
        if number is None:
            out.append(part)
            continue
        scaled = number[0] * 10 ** (scale - number[1])
        if acc is None:
            acc, acc_text = scaled, part
        elif op == "sum":
            acc += scaled
        elif (scaled < acc) == (op == "min"):
            acc, acc_text = scaled, part
        # min/max return an element that already exists, so its own spelling is kept;
        # sum produces a new number and is formatted at the shared scale.
        out.append(_format_fixed(acc, scale) if op == "sum" else acc_text)
    return out


def apply_column(
    values: list[str | None],
    op: str,
    base: str | None,
    reset_at: list[str | None] | None,
) -> list[str | None]:
    """The same fold, but down a COLUMN instead of across a list.

    ``<gen type="running">`` is this: row i's value is the accumulation of every row up to
    it. Reusing :func:`apply` rather than writing a second fold is deliberate — the
    arithmetic, the scale rule and the treatment of an empty cell then cannot drift apart
    between the two features.

    ``base`` is prepended and its result dropped, which is exactly "start from an opening
    balance": it joins the scale pool, so an opening ``1000.00`` widens the whole column
    to two decimals the way a reader would expect.

    ``reset_at`` splits the column into segments, each accumulated on its own — one
    running balance per account rather than one for the file.
    """
    out: list[str | None] = [None] * len(values)
    start = 0
    while start < len(values):
        if reset_at is None:
            end = len(values)
        else:
            end = start + 1
            while end < len(values) and reset_at[end] == reset_at[start]:
                end += 1
        segment = [v or "" for v in values[start:end]]
        parts = segment if base is None else [base, *segment]
        running = apply(parts, op)
        offset = 0 if base is None else 1
        for i in range(start, end):
            # A row outside a parent filter has no value, and gains none: the accumulator
            # passed over it without counting it.
            out[i] = None if values[i] is None else running[i - start + offset]
        start = end
    return out
