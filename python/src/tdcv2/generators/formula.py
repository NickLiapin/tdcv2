"""``<gen type="formula" expr="Weight / (Height * Height)">`` — arithmetic over the
columns beside it.

A whole COLUMN read from other columns, like ``running`` and ``stat``, but unlike them it needs
only its OWN row: row nine million is `Weight[9M] / Height[9M]²` and nothing before it. So it
streams and it parallelises, where a running total cannot.

Two rules decide what a cell holds, and both are the same ones ``stat`` already follows:

* without ``decimals=`` the value is printed whole, with it the answer is rounded;
* a source cell that is EMPTY makes the answer empty. A cell a ``parent=`` filter switched off is
  not a zero, and `0 / 0` is not the honest reading of it.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field

from ..expr import as_value
from ..lib import numbers

_NUMERIC = re.compile(r"^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$")


class FormulaError(ValueError):
    """An expression that cannot produce a value for the cell."""


@dataclass
class ColumnsRead:
    """What one row's evaluation read, so a refusal can point at the cause."""

    #: A referenced column was empty on this row.
    empty: bool = False
    #: The first column that held TEXT rather than a number, and what it held.
    text: tuple[str, str] | None = field(default=None)


def expression_of(attrs: dict[str, str]) -> str:
    """``expr=``, which a formula cannot do without."""
    source = (attrs.get("expr") or "").strip()
    if not source:
        raise FormulaError('<gen type="formula"> needs expr="…"')
    return source


def decimals_of(attrs: dict[str, str]) -> int | None:
    """``decimals=`` when the config declared one, else the value is printed whole."""
    raw = (attrs.get("decimals") or "").strip()
    if not raw:
        return None
    try:
        value = int(raw)
    except ValueError as err:
        raise FormulaError(f'decimals="{raw}" is not a whole number from 0 to 10') from err
    if value < 0 or value > 10:
        raise FormulaError(f'decimals="{raw}" is not a whole number from 0 to 10')
    return value


def render(value: object, decimals: int | None, read: ColumnsRead | None = None) -> str:
    """One evaluated answer, as the text that goes in the cell.

    NaN is how "arithmetic on text" arrives here. In an ``if=`` it merely makes every comparison
    false and the branch quietly does not fire; in a COLUMN it would print, and a file full of
    ``NaN`` nobody was warned about is the defect this project keeps closing. So it is refused —
    and the refusal names the column that held the text, because the scope recorded what the
    expression actually read.
    """
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        number = float(value)
        if number != number:  # NaN
            text = read.text if read is not None else None
            raise FormulaError(
                "the expression has no number as its answer — 0/0, the square root of a "
                "negative, or another sum with no value"
                if text is None
                else f'the expression is not a number: column "{text[0]}" holds "{text[1]}", '
                "which is text rather than a number"
            )
        if number in (float("inf"), float("-inf")):
            raise FormulaError(
                "the expression answers infinity — a division by zero, or a number too large "
                "to hold"
            )
        if decimals is None:
            return numbers.to_text(number) if not isinstance(value, int) else str(value)
        return numbers.to_fixed(number, decimals)
    text_value = str(value)
    return text_value if decimals is None else numbers.to_fixed(numbers.parse(text_value), decimals)


def row_scope(
    value_at: Callable[[str], str | None],
    has_column: Callable[[str], bool],
    iteration: int,
    read: ColumnsRead | None = None,
) -> tuple[Callable[[str], bool], Callable[[str], str]]:
    """The ``has``/``value`` pair one row's evaluation reads through.

    ``has`` and ``value`` stay separate for the same reason they do in a condition: an absent name
    is not an empty one. A name the registry does not know is its own text — that is what lets
    ``if="Gender == Male"`` go unquoted — so only a name it DOES know can make the row empty.
    """

    def has(name: str) -> bool:
        return name == "_count" or has_column(name)

    def value(name: str) -> str:
        if name == "_count":
            return str(iteration + 1)
        cell = value_at(name) or ""
        if read is not None and has_column(name):
            if cell == "":
                read.empty = True
            elif read.text is None and not _NUMERIC.match(cell):
                read.text = (name, cell)
        return cell

    return has, value


def value_at_row(
    source: str,
    decimals: int | None,
    value_at: Callable[[str], str | None],
    has_column: Callable[[str], bool],
    iteration: int,
) -> str | None:
    """One row's answer, or ``None`` when a column it read was empty."""
    read = ColumnsRead()
    has, value = row_scope(value_at, has_column, iteration, read)
    answer = as_value(source, has, value)
    if read.empty:
        return None
    return render(answer, decimals, read)
