"""``mask="w[-1], w[0..-2]"`` — a value rewritten by position.

The vocabulary is small on purpose: ``x`` is one character, ``w`` is one word, ``*`` is everything
not used yet, a backslash escapes what follows, and anything else is a literal. That is enough to
turn a full name into "Surname, Given", to mask a card down to its last four digits, or to build a
phone number out of digits a generator produced without any separators.

Indexes address the ORIGINAL input, so ``w[-1]`` is the last word of what came in, not of what has
been emitted so far. There are two channels that deliberately do not interfere: what an index
EMITS never depends on what has been consumed, and consumption only decides what the bare ``x``,
``w`` and ``*`` have left to take. That is why the same notation reads as a MOVE when nothing else
picks that position up, and as a COPY when something does — one rule covering both, instead of two
notations the config author has to choose between.

Lenient by design: an index past the end emits nothing, silently. The length of a value is not
known until the row is rendered, so there is nothing to validate against beforehand, and aborting
a million-row run over one short value is worse than a gap.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..lib import text

_SINGLE_INDEX = re.compile(r"^(-?\d+)$")
_INDEX_RANGE = re.compile(r"^(-?\d+)\.\.(-?\d+)$")


@dataclass(frozen=True, slots=True)
class _Slot:
    """One parsed element of a mask pattern.

    ``kind`` is one of ``char``, ``word``, ``char_at``, ``word_at``, ``rest`` and ``lit``.
    """

    kind: str
    start: int = 0
    end: int = 0
    literal: str = ""


@dataclass(frozen=True, slots=True)
class _Span:
    start: int
    end: int


def apply_mask(pattern: str, value: str) -> str:
    chars = list(value)
    used = [False] * len(chars)
    spans = _word_spans(chars)
    out: list[str] = []

    def next_free() -> int:
        i = 0
        while i < len(chars) and used[i]:
            i += 1
        return i

    for slot in parse(pattern):
        if slot.kind == "lit":
            out.append(slot.literal)

        elif slot.kind == "char":
            i = next_free()
            if i < len(chars):
                out.append(chars[i])
                used[i] = True

        elif slot.kind == "word":
            i = next_free()
            while i < len(chars) and not used[i] and not text.is_space(chars[i]):
                out.append(chars[i])
                used[i] = True
                i += 1
            if i < len(chars) and not used[i] and text.is_space(chars[i]):
                used[i] = True  # one delimiter travels with the word

        elif slot.kind == "char_at":
            for i in _walk(slot.start, slot.end, len(chars)):
                out.append(chars[i])
                used[i] = True

        elif slot.kind == "word_at":
            picked: list[str] = []
            for wi in _walk(slot.start, slot.end, len(spans)):
                span = spans[wi]
                for i in range(span.start, span.end):
                    used[i] = True
                # One adjacent delimiter goes with it, so what a later `*` prints does not
                # collapse into a double space.
                if span.end < len(chars) and text.is_space(chars[span.end]):
                    used[span.end] = True
                elif span.start > 0 and text.is_space(chars[span.start - 1]):
                    used[span.start - 1] = True
                picked.append("".join(chars[span.start : span.end]))
            out.append(" ".join(picked))

        elif slot.kind == "rest":
            for i in range(len(chars)):
                if not used[i]:
                    out.append(chars[i])
                    used[i] = True

    return "".join(out)


def parse(pattern: str) -> list[_Slot]:
    """A mask split into slots.

    A ``[`` opens an index ONLY directly after ``x`` or ``w``; anywhere else it is an ordinary
    literal, so ``mask="[tel.] xxx"`` needs no escaping. A backslash still escapes what follows.
    """
    chars = list(pattern)
    slots: list[_Slot] = []
    i = 0
    while i < len(chars):
        ch = chars[i]
        if ch == "\\" and i + 1 < len(chars):
            slots.append(_Slot("lit", literal=chars[i + 1]))
            i += 2
            continue
        if ch == "*":
            slots.append(_Slot("rest"))
            i += 1
            continue
        if ch not in ("x", "w"):
            slots.append(_Slot("lit", literal=ch))
            i += 1
            continue

        if i + 1 < len(chars) and chars[i + 1] == "[":
            close = _index_of(chars, "]", i + 2)
            if close != -1:
                body = "".join(chars[i + 2 : close])
                spec = _parse_index(body)
                if spec is None:
                    raise ValueError(
                        f'mask: invalid index "[{body}]" after "{ch}" — use {ch}[0], '
                        f'{ch}[0..4] or {ch}[-1]; ranges use ".." (a hyphen would clash '
                        f"with a negative index). For a literal bracket write {ch}\\["
                    )
                slots.append(
                    _Slot("char_at" if ch == "x" else "word_at", start=spec[0], end=spec[1])
                )
                i = close + 1
                continue
            # No closing bracket anywhere: plainly literal text, left alone.

        slots.append(_Slot("char" if ch == "x" else "word"))
        i += 1
    return slots


def _parse_index(body: str) -> tuple[int, int] | None:
    """``-3``, ``7``, ``0..4``, ``-2..-1`` — nothing else."""
    one = _SINGLE_INDEX.match(body)
    if one:
        n = int(one.group(1))
        return n, n
    span = _INDEX_RANGE.match(body)
    if not span:
        return None
    return int(span.group(1)), int(span.group(2))


def _walk(start: int, end: int, length: int) -> list[int]:
    """The indexes from ``start`` to ``end`` inclusive, descending when the range runs backwards."""
    a = length + start if start < 0 else start
    b = length + end if end < 0 else end
    step = 1 if a <= b else -1
    out = []
    i = a
    while (i <= b) if step > 0 else (i >= b):
        if 0 <= i < length:
            out.append(i)
        i += step
    return out


def _word_spans(chars: list[str]) -> list[_Span]:
    """Where the non-whitespace runs of ``chars`` start and end, in order."""
    spans: list[_Span] = []
    i = 0
    while i < len(chars):
        if text.is_space(chars[i]):
            i += 1
            continue
        start = i
        while i < len(chars) and not text.is_space(chars[i]):
            i += 1
        spans.append(_Span(start, i))
    return spans


def _index_of(chars: list[str], needle: str, start: int) -> int:
    for i in range(start, len(chars)):
        if chars[i] == needle:
            return i
    return -1
