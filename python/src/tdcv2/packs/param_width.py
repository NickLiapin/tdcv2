"""How many characters a composed pack's own ``<sequence>`` produces, when that is a FACT.

A pack parameter replaces one of the pack's sequences for the run:
``<gen type="template" value="usa.finance.aba_routing" prefix="12"/>`` swaps the pack's own
``prefix``. That is the documented way to pin part of an identifier.

The packs that carry a CHECK DIGIT compute it over a fixed layout, so a pinned value of the
wrong width does not shift the layout — it breaks it. Measured on ``usa.finance.aba_routing``,
whose ``prefix`` is 2 characters and ``tail`` is 6::

    prefix="12345"  ->  the run aborts: <at>: index 8 is out of range
    tail="678"      ->  326784 — six digits, and not a routing number

``check`` passed on both. The first names no file, line or code; the second says nothing at all
and writes data that looks right.

So the width is worked out here, and ONLY where it can be proven from the pack's own body.
Three shapes carry a width; everything else is absent and the caller stays silent, because a
refusal has to be a proof::

    <gen type="text" value="01,02,03"/>      every alternative is 2 -> 2
    <gen type="regex" value="[0-9]{6}"/>     one class, fixed count -> 6
    <gen type="number" value="0000..9999"/>  zero-padded, equal ends -> 4

Read by scanning the body rather than by parsing it — the same choice ``parameter_names``
makes, and for the same reason: the validator runs before anything is built, and parsing a
pack body here would mean reporting a pack author's syntax error at the caller's line.
"""

from __future__ import annotations

import re

# `<sequence name="X"> … </sequence>`, non-greedy so nested bodies do not swallow the next one.
_SEQUENCE_BLOCK = re.compile(
    r'<sequence\s+[^>]*name\s*=\s*"([^"]+)"[^>]*>(.*?)</sequence>', re.DOTALL
)
_GEN_TAG = re.compile(r"<gen\b([^>]*)/?>")
_ATTR = re.compile(r'(\w+)\s*=\s*"([^"]*)"')
# One class or escape repeated an exact number of times: `[0-9]{6}`, `\d{4}`.
_FIXED_REGEX = re.compile(r"^(?:\[[^\]]+\]|\\[dwsDWS]|[A-Za-z0-9])\{(\d+)\}$")
_NUMBER_RANGE = re.compile(r"^(-?\d+)\.\.(-?\d+)$")


def _fixed_width(type_: str, value: str | None) -> int | None:
    """The exact character count this generator always produces, or ``None``."""
    if not value:
        return None
    if type_ == "text":
        items = value.split(",")
        if len(items) < 2:
            return None  # a single literal is not a list
        width = len(items[0])
        return width if all(len(item) == width for item in items) else None
    if type_ == "regex":
        m = _FIXED_REGEX.match(value)
        return int(m.group(1)) if m else None
    if type_ == "number":
        m = _NUMBER_RANGE.match(value)
        if not m:
            return None
        low, high = m.group(1), m.group(2)
        # Only a zero-padded range has a fixed width: `1..9999` is 1 to 4 characters.
        return len(low) if len(low) == len(high) and low.startswith("0") else None
    return None


def parameter_widths(body: str) -> dict[str, int]:
    """Parameter name -> the width the pack's own sequence always produces."""
    out: dict[str, int] = {}
    for name, inner in _SEQUENCE_BLOCK.findall(body):
        gens = _GEN_TAG.findall(inner)
        # Exactly one `<gen>` and nothing else that produces a value: a compound sequence,
        # a <compute>, a <mix> or a <switch> has no single width to read.
        if len(gens) != 1 or re.search(r"<(compute|mix|switch|case)\b", inner):
            continue
        attrs = dict(_ATTR.findall(gens[0]))
        if "name" in attrs:
            continue  # a named <gen> is one field of a compound
        # A generator wrapped in repetition or formatting no longer produces the bare width.
        if any(key in attrs for key in ("repeat", "mask", "missing")):
            continue
        width = _fixed_width(attrs.get("type", ""), attrs.get("value"))
        if width is not None:
            out[name] = width
    return out
