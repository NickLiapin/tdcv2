"""``<assert that="Rows == 700" says="…">`` — a config that checks its own output.

What is worth asserting is not what the config already states. You wrote ``percent="70"``
and you assert 70 percent — you have tested that TDC can count. What the config does NOT
state is where the value ends up: a ``parent=`` filter removes rows, a second condition
removes more, and the share that reaches the file is 42 percent with nothing to say so.

Three existing mechanisms, no new language. ``that=`` is the ``if=`` expression language,
the numbers come from ``<gen type="stat">``, and ``says=`` is the sentence the reader gets
in a CI log months later.

Every name the expression reads must be WHOLE-RUN CONSTANT — otherwise ``Amount > 100``
reads row 0 and reports on one row out of a thousand, a check that passed because it barely
looked, wearing a badge that says verified. Which names an expression reads is discovered by
handing the evaluator a scope that records what it is asked for, so no parser knows this
feature exists.
"""

from __future__ import annotations

from collections.abc import Callable
from collections.abc import Sequence as SequenceType
from dataclasses import dataclass

from ..expr.evaluate import as_condition
from ..model.config import AssertSpec, SequenceSpec

#: Built-ins that are the same on every row, so an assertion may read them. ``_count`` is
#: deliberately absent: it says which row you are on, which is what an assertion must not
#: depend on.
_WHOLE_RUN_BUILTINS = frozenset({"_total"})

#: Attributes that make a cell that may or may not be there, so the spec settles nothing.
_UNSETTLING = ("missing", "anomaly", "if", "repeat")


class AssertionFailedError(RuntimeError):
    """A run whose output did not hold up its own config's claim."""


@dataclass(frozen=True, slots=True)
class _Reading:
    """One name the expression asked for, and what row 0 held for it."""

    name: str
    value: str


def _constant_by_construction(spec: SequenceSpec | None) -> bool:
    """Constant from the SPEC alone, without reading a single row.

    Reading the column is the honest test and stays below, but it costs a pass over the run —
    and on a streaming engine that pass regenerates every value. Measured at two million rows
    it cost a third of a second per name, which at a billion rows is minutes spent proving
    what the spec already said. So this runs first and, like the ``uniq`` capacity check, only
    ever answers "definitely constant": anything it cannot prove falls through to the scan, so
    no config is refused that would have been accepted.
    """
    if spec is None or spec.gen is None:
        return False  # a compound, a mix, a switch — read it
    if spec.parent is not None:
        return False  # a filtered column is empty on the rows the filter excluded
    if any(spec.gen.attrs.get(attr) is not None for attr in _UNSETTLING):
        return False
    if spec.gen.type == "stat":
        return True  # one number for the whole run, by definition
    if spec.gen.type == "text":
        raw = spec.gen.attrs.get("value")
        return raw is not None and "," not in raw  # a list of one
    return False


def _constancy(
    name: str,
    value_at: Callable[[str, int], str | None],
    spec: SequenceSpec | None,
    count: int,
) -> str:
    """``constant``, ``varies`` or ``empty-on-some-rows``.

    An EMPTY cell fails the rule as surely as a different one: a column a ``parent=`` filter
    leaves blank on half the run has no whole-run value at all, and the condition would compare
    against whatever row 0 happened to hold.
    """
    if name in _WHOLE_RUN_BUILTINS:
        return "constant"
    if _constant_by_construction(spec):
        return "constant"
    seen: str | None = None
    for row in range(count):
        value = value_at(name, row)
        if not value:
            return "empty-on-some-rows"
        if seen is None:
            seen = value
        elif value != seen:
            return "varies"
    return "constant" if seen is not None else "empty-on-some-rows"


def check(
    asserts: SequenceType[AssertSpec],
    specs: SequenceType[SequenceSpec],
    value_at: Callable[[str, int], str | None],
    known: Callable[[str], bool],
    count: int,
) -> None:
    """Check every assertion against the finished run, raising on the first that fails.

    ``value_at`` and ``known`` are supplied by the engine, because a column is an array on one
    engine and a function of the row on another — and an assertion has to mean the same thing
    on both.
    """
    by_name = {spec.name: spec for spec in specs if spec.name}
    for spec in asserts:
        read: list[_Reading] = []

        def value_of(name: str, sink: list[_Reading] = read) -> str:
            # Only a real column is recorded. A name that is not declared is not data at all —
            # the expression language reads it as its own literal text, which is what lets
            # `Kind == a` go unquoted — so it has nothing to be constant about, and the
            # validator is the one that asks whether it was a typo.
            value = value_at(name, 0) or ""
            if known(name):
                sink.append(_Reading(name, value))
            return value

        try:
            held = as_condition(spec.that, known, value_of)
        except Exception as error:
            raise AssertionFailedError(f'assert: cannot read "{spec.that}" — {error}') from error

        # The honesty rule, applied to every name the expression touched. The evaluator walks
        # both sides of `&&` rather than short-circuiting — in all five implementations, since
        # they share this walk — so which names are checked does not depend on operand order.
        for reading in read:
            constancy = _constancy(reading.name, value_at, by_name.get(reading.name), count)
            if constancy == "constant":
                continue
            why = (
                f'"{reading.name}" is not the same on every row, so this would have checked '
                "the first row and called the run verified"
                if constancy == "varies"
                else f'"{reading.name}" is empty on some rows, so the run has no single value '
                "for it — this would have checked whatever the first row happened to hold"
            )
            raise AssertionFailedError(
                f'assert ("{spec.that}"): {why}. An assertion reads whole-run values: give it '
                f'a <gen type="stat" of="{reading.name}" op="…"/> column, or _total.'
            )

        if not held:
            detail = ", ".join(f"{r.name} = {r.value if r.value else '(empty)'}" for r in read)
            shown = f"{spec.that}   with {detail}" if detail else spec.that
            raise AssertionFailedError(f"assert failed: {spec.says}\n  {shown}")
