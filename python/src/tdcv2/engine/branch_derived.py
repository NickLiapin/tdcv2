"""A formula or a date offset standing in a BRANCH — inside a ``<case>``, or as one of the
``<gen if="…">`` branches of a sequence — rather than as a whole column.

Of the four derived constructs, these two read nothing but their own row. So a branch can have
them as cheaply as a whole column can: for each row the branch holds, compute that row. Before
this module, a date offset in a branch lost ``of=`` and ``plus=`` without a word and drew an
unrelated date, and a formula stopped the run with ``generator type "formula" is not ported
yet`` — on this engine; the streaming one computed it.

``running``, ``stat``, a formula that reads ``prev()`` and a pool reference are whole columns by
nature, and the validator keeps them out of branches (TDC295, TDC268). They never reach here.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import replace

from ..date.calendar import apply_offset, parse_offset
from ..date.formatter import format_date_time
from ..date.plain import to_epoch_millis
from ..expr.evaluate import as_value
from ..generators import date_offset as date_offset_gen
from ..generators import formula as formula_gen
from ..prng import seekable
from . import per_row


def is_row_local_derived(gen) -> bool:
    """A formula, or a date measured from another column: the two that read only their row."""
    return gen is not None and (gen.type == "formula" or date_offset_gen.is_offset(gen))


def _prev_in_branch(_name: str) -> str | None:
    """``prev()`` inside a branch. The validator refuses it (TDC295); this is the backstop."""
    raise formula_gen.FormulaError(
        "prev() reads the row before this one, so a formula using it has to be a <sequence> of "
        "its own — it cannot sit inside a <case> or be one branch of an if= sequence"
    )


def values(gen, count: int, run, instants_out: list[int | None] | None = None) -> list[str]:
    """The branch's values, one per position — ``""`` for a row the build will not keep."""
    if gen.type == "formula":
        return _formula(gen, count, run)
    return _date_offset(gen, count, run, instants_out)


def _formula(gen, count: int, run) -> list[str]:
    source = (gen.attrs.get("expr") or "").strip()
    out = [""] * count
    if not source:
        return out  # no expr= — the validator reports it
    decimals = formula_gen.decimals_of(gen.attrs)
    for i in range(count):
        row = per_row.absolute_row(run, i)
        if run.kept_rows is not None and row not in run.kept_rows:
            continue
        read = formula_gen.ColumnsRead()
        has, value = formula_gen.row_scope(
            lambda name, r=row: run.value_at(name, r) if run.value_at else None,
            lambda name: run.has_column is not None and run.has_column(name),
            row,
            read,
        )
        answer = as_value(source, has, value, _prev_in_branch)
        # A column this row does not have leaves the cell empty, as it does for a formula that is
        # a whole column: a zero nobody generated is not an answer.
        out[i] = "" if read.empty else formula_gen.render(answer, decimals, read)
    return out


def _date_offset(gen, count: int, run, instants_out: list[int | None] | None) -> list[str]:
    """The same measurement the whole-column offset makes, row by row.

    A ranged ``plus=`` draws its step from the row's own stream — ``(seed, stream, row)`` — so the
    step a row gets does not depend on which other rows the branch holds.
    """
    out = [""] * count
    stamps: list[int | None] = [None] * count
    source = date_offset_gen.source_of(gen.attrs)
    parsed = parse_offset(gen.attrs.get("plus"))
    known = run.has_column is not None and run.has_column(source)
    if known and parsed.ok and parsed.offset is not None:
        offset = parsed.offset
        fmt = (gen.attrs.get("format") or "").strip() or "L"
        instants = run.instants_of(source) if run.instants_of else None
        column = (run.stream_id or "").split("#")[0]
        keyed = per_row.keyed(run)
        for i in range(count):
            row = per_row.absolute_row(run, i)
            if run.kept_rows is not None and row not in run.kept_rows:
                continue
            text = run.value_at(source, row) if run.value_at else None
            if text is None or text.strip() == "":
                continue
            start = date_offset_gen.start_of_row(column, gen.attrs, instants, row, text)
            if start is None:
                continue
            draw = seekable.generator(keyed[0], keyed[1], row) if keyed else run.prng
            landed = apply_offset(start, offset, date_offset_gen.draw_steps(offset, draw))
            stamps[i] = to_epoch_millis(landed)
            out[i] = format_date_time(landed, fmt, run.config.locale)
    if instants_out is not None:
        instants_out.extend(stamps)
    return out


def keeping_only(run, rows: Iterable[int]):
    """The run, keeping only ``rows`` of what it builds — narrowed, never widened."""
    kept = frozenset(r for r in rows if run.kept_rows is None or r in run.kept_rows)
    return replace(run, kept_rows=kept)


def offset_sources(sequences) -> set[str]:
    """Every column some date offset measures from, wherever the offset stands.

    Those columns keep the instant they generated beside the text, so the offset works from the
    value whatever ``format=`` spelled it as.
    """
    sources: set[str] = set()

    def visit(gen) -> None:
        if date_offset_gen.is_offset(gen):
            sources.add(date_offset_gen.source_of(gen.attrs))

    def visit_case(case) -> None:
        for part in case.parts:
            if part.gen is not None:
                visit(part.gen)
            elif part.mix is not None:
                for inner in part.mix.cases:
                    visit_case(inner)
            elif part.switch is not None:
                visit_switch(part.switch)

    def visit_switch(sw) -> None:
        for entry in sw.entries:
            visit_case(entry.value)
        if sw.fallback is not None:
            visit_case(sw.fallback)

    for spec in sequences:
        visit(spec.gen)
        for branch in spec.branches or []:
            visit(branch.gen)
        if spec.mix is not None:
            for case in spec.mix.cases:
                visit_case(case)
        if spec.switch_spec is not None:
            visit_switch(spec.switch_spec)
    return sources
