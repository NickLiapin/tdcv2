"""``${{Name}}`` and ``${{Name|upper|mask:xxx}}`` inside a ``<data>``.

The marker itself is configurable through ``<env inject="...">``: the ``%`` in it stands for the
name and everything around it is the delimiter. A config generating shell scripts can set
``inject="<<%>>"`` and stop fighting with dollar signs.

A name that matches no sequence is left exactly as it was written, marker and all. Replacing it
with an empty string would hide a typo inside data that still looks well-formed; leaving
``${{Gendre}}`` in the output makes it obvious on the first row.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass

from .transforms import apply_filter

DEFAULT_INJECT = "${{%}}"

# The greedy first group picks the RIGHTMOST usable `%`, which is what lets an exotic wrapper
# such as inject="%{%}%" hold a literal percent sign of its own.
_INJECT_SHAPE = re.compile(r"(.+)%(.+)")

_PATTERN_CACHE: dict[str, re.Pattern[str] | None] = {}
_TEMPLATE_CACHE: dict[str, list[str | _Reference]] = {}


@dataclass(frozen=True, slots=True)
class _Filter:
    kind: str
    arg: str | None


@dataclass(frozen=True, slots=True)
class _Reference:
    name: str
    filters: list[_Filter]
    original: str
    """The marker as written, so an unknown name can be put back untouched."""


def apply(template: str, inject: str, lookup: Callable[[str], str | None]) -> str:
    """``template`` with every known reference replaced by its value on this row.

    ``lookup`` answers ``None`` for a name it does not know — a typo, which stays visible — and a
    string for one it does, including the empty string for a row a parent filtered out.
    """
    segments = compile_template(template, inject)
    if len(segments) == 1 and isinstance(segments[0], str):
        return segments[0]

    out: list[str] = []
    for segment in segments:
        if isinstance(segment, str):
            out.append(segment)
            continue
        value = lookup(segment.name)
        if value is None:
            out.append(segment.original)
            continue
        for f in segment.filters:
            value = apply_filter(f.kind, f.arg, value)
        out.append(value)
    return "".join(out)


def compile_template(template: str, inject: str) -> list[str | _Reference]:
    """The template split into literals and references, once.

    The render loop asks for the same ``<data>`` text on every row, so compiling once turns a
    per-row regex substitution — a measured hot spot — into a plain join.
    """
    key = f"{inject}\x00{template}"
    cached = _TEMPLATE_CACHE.get(key)
    if cached is not None:
        return cached

    pattern = _pattern(inject)
    segments: list[str | _Reference] = []
    if pattern is None:
        # An inject with no `%` names nothing, so there is nothing to substitute.
        segments.append(template)
    else:
        last = 0
        for m in pattern.finditer(template):
            if m.start() > last:
                segments.append(template[last : m.start()])
            name, filters = parse_reference(m.group(1))
            segments.append(_Reference(name, filters, m.group()))
            last = m.end()
        if last < len(template):
            segments.append(template[last:])
        if not segments:
            segments.append("")
    _TEMPLATE_CACHE[key] = segments
    return segments


def parse_reference(raw: str) -> tuple[str, list[_Filter]]:
    """``NAME ( "|" filter )*``, where a filter is a bare word or ``word:arg``.

    The argument runs to the next ``|``, which is why a mask pattern may contain anything except a
    pipe.
    """
    parts = raw.split("|")
    name = parts[0].strip()
    filters: list[_Filter] = []
    for piece in parts[1:]:
        colon = piece.find(":")
        if colon < 0:
            kind = piece.strip()
            if kind:
                filters.append(_Filter(kind, None))
        else:
            kind = piece[:colon].strip()
            if kind:
                filters.append(_Filter(kind, piece[colon + 1 :].strip()))
    return name, filters


def _pattern(inject: str) -> re.Pattern[str] | None:
    """``None`` when the inject has no ``%`` slot at all."""
    key = inject if inject else DEFAULT_INJECT
    if key in _PATTERN_CACHE:
        return _PATTERN_CACHE[key]

    shape = _INJECT_SHAPE.fullmatch(key)
    compiled = (
        None
        if shape is None
        else re.compile(f"{re.escape(shape.group(1))}(.+?){re.escape(shape.group(2))}")
    )
    _PATTERN_CACHE[key] = compiled
    return compiled
