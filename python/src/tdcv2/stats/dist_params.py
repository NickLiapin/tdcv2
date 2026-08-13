"""A distribution parameter written as an EXPRESSION rather than a number.

``lambda="Traffic * 0.5"`` is an intensity driven by another column; ``sd="0.5 + 0.01 * _count"``
is a sensor that grows noisier as the run goes on. A bare number stays the ordinary case and
costs nothing — the spec is parsed once, exactly as before, and only a config that names a column
comes here.

Why this is allowed at all, when a per-row ``repeat=`` is not: how many uniform draws a row
consumes depends on WHICH distribution, never on its parameters. The parameter changes the value
the draws are turned into, not their number, so the row stays computable without its
predecessors — the property every engine is built on.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable

from ..expr import as_value
from ..lib import numbers

#: Every parameter any of the nine distributions reads.
PARAMS = (
    "mean",
    "sd",
    "meanlog",
    "sdlog",
    "rate",
    "alpha",
    "xmin",
    "shape",
    "scale",
    "lambda",
    "beta",
    "s",
    "n",
    "min",
    "max",
)

_PLAIN_NUMBER = re.compile(r"^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$")
_NUMERIC = re.compile(r"^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$")

#: The two distributions sampled from a PAIR of uniforms (Box-Muller); every other reads one.
_TWO_DRAW = frozenset({"normal", "lognormal"})


@dataclass(frozen=True)
class Resolved:
    """The attributes with every expression-valued parameter replaced by its answer."""

    attrs: dict[str, str]
    #: A referenced column was empty on this row, so nothing can be drawn.
    empty: bool


def expression_params(attrs: dict[str, str]) -> list[str]:
    """The parameters this generator wrote as an expression rather than a number."""
    found = []
    for name in PARAMS:
        raw = attrs.get(name)
        if raw is None or not raw.strip():
            continue
        if not _PLAIN_NUMBER.match(raw):
            found.append(name)
    return found


def draws(attrs: dict[str, str]) -> int:
    """How many uniforms a row of this distribution spends, known from the NAME alone.

    Wanted by a row that cannot be drawn at all — a parameter read an empty cell — which must
    still spend what a drawn row would. Otherwise blanking one cell would slide every value after
    it, and a ``parent=`` filter would quietly rewrite the rest of the column.
    """
    return 2 if (attrs.get("distribution") or "").strip().lower() in _TWO_DRAW else 1


def resolve(
    attrs: dict[str, str],
    dynamic: list[str],
    row: int,
    has_column: Callable[[str], bool],
    value_at: Callable[[str], str | None],
) -> Resolved:
    """``attrs`` with each expression parameter evaluated on this row.

    A name the registry knows, holding nothing, marks the row EMPTY: that is a row a ``parent=``
    filter switched off or a ``missing=`` blank, and it is not a zero. It has to be noticed here,
    at the lookup, because an unresolved bare word evaluates to the WORD — the way
    ``if="Tier == hi"`` reads ``hi`` — and the two cannot be told apart afterwards.
    """
    out = dict(attrs)
    empty = False
    text: tuple[str, str] | None = None

    for name in dynamic:
        source = attrs.get(name)
        if source is None:
            continue
        seen_empty = False
        seen_text: tuple[str, str] | None = None

        def has(ref: str) -> bool:
            return ref == "_count" or has_column(ref)

        def read(ref: str, _row: int = row) -> str:
            nonlocal seen_empty, seen_text
            if ref == "_count":
                return str(_row + 1)
            cell = value_at(ref)
            if has_column(ref):
                if cell is None or not cell.strip():
                    seen_empty = True
                elif seen_text is None and not _NUMERIC.match(cell):
                    seen_text = (ref, cell)
            return cell if cell is not None else ""

        answer = as_value(source, has, read)
        empty = empty or seen_empty
        if seen_text is not None and text is None:
            text = seen_text

        if isinstance(answer, bool):
            continue
        if isinstance(answer, (int, float)) and answer == answer and abs(answer) != float("inf"):
            out[name] = numbers.to_text(float(answer))
            continue
        # A bare column reference resolves to the cell's TEXT — `mean="M"` where M holds "100".
        # Arithmetic would have produced a number, but naming a column and nothing else is the
        # simplest way to write this and must work too.
        if isinstance(answer, str) and answer.strip() and _NUMERIC.match(answer):
            out[name] = answer.strip()
            continue
        # Nothing numeric came out, and a column is the reason. Say which — the distribution's own
        # message would only repeat that the parameter is "not a number", which the author can
        # already see. Same wording as the formula generator, for the same mistake.
        if not empty and text is not None:
            raise ValueError(
                f'{name}: the expression is not a number: column "{text[0]}" holds "{text[1]}", '
                "which is text rather than a number"
            )

    return Resolved(out, empty)
