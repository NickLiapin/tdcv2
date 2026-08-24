"""A run written as a typed binary file instead of as text.

The same preparation as the text renderer — one engine, one registry — so a config exported to
Parquet holds exactly the data it would have printed for that seed. Only the serialisation differs:
instead of formatting a record, each named ``<data>`` becomes a typed column.

Rows go out in row groups, each built, written and released before the next one starts, so memory
stays bounded however large the run is.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass

from ..format import interpolate
from ..model.config import Config
from . import column_type
from . import columns as columns_lib
from .column_type import ColumnType
from .parquet import convert, writer

# Rows per row group. Bounds peak memory and lets a reader skip whole groups. It is also the unit
# parallel generation would split on, because a group's bytes do not depend on where it sits.
ROW_GROUP_ROWS = 50_000

# An untyped column is text. Never guess from the values — a string never corrupts data.
DEFAULT_TYPE = column_type.parse("string")


@dataclass(frozen=True, slots=True)
class _Plan:
    """Everything decided before a single row is rendered."""

    declared: list[columns_lib.Declared]
    columns: list[writer.Column]
    types: list[ColumnType]
    separators: list[str | None]


def write(config: Config, rows, out: Callable[[bytes], None], on_progress=None) -> None:
    """The run written to a sink as a ``.parquet`` file."""
    plan = _plan(config)
    writer.write(plan.columns, _batches(plan, config, rows, on_progress), out)


def to_bytes(config: Config, rows) -> bytes:
    """The same, in memory — for a small output and for tests."""
    out = bytearray()
    write(config, rows, out.extend)
    return bytes(out)


def schema_of(config: Config) -> list[writer.Column]:
    """The resolved schema, for telling the user which types were chosen."""
    return _plan(config).columns


def _plan(config: Config) -> _Plan:
    declared: list[columns_lib.Declared] = []
    for line in config.block:
        for part in line.parts:
            name = None if part.name is None else part.name.strip()
            if not name:
                continue  # decorative text, not a column
            type_ = None
            if part.type is not None:
                try:
                    type_ = column_type.parse_output(part.type)
                except ValueError as e:
                    raise ValueError(f'column "{name}": {e}') from None
            declared.append(columns_lib.Declared(name, part.text, type_))

    if not declared:
        raise ValueError(
            'Parquet output needs at least one named column — add name="…" to a <data> in the '
            "<block>"
        )
    columns_lib.check_unique(declared)

    types: list[ColumnType] = []
    separators: list[str | None] = []
    built: list[writer.Column] = []
    for column in declared:
        type_ = columns_lib.resolve(column, config) or DEFAULT_TYPE
        types.append(type_)
        # A declared []T needs a separator too; a comma when the column was typed by hand rather
        # than derived from a repeating generator.
        if type_.is_list:
            source = columns_lib.sole_reference(column.template, config.inject)
            separator = None if source is None else columns_lib.separator_of(source, config)
            separators.append(separator or ",")
        else:
            separators.append(None)
        built.append(writer.Column(column.name, type_))
    return _Plan(declared, built, types, separators)


def _batches(
    plan: _Plan, config: Config, rows, on_progress=None
) -> Iterator[list[list[writer.Cell]]]:
    count = rows.count if isinstance(rows.count, int) else rows.count()
    start = 0
    while start < count:
        # Once per row group, which is fifty thousand rows: coarser than the text path's
        # half-percent, and it has to be — a row group is the unit this writer works in, and
        # there is no moment inside one where a partial group means anything.
        if on_progress is not None:
            on_progress("render", start, count)
        end = min(start + ROW_GROUP_ROWS, count)
        batch: list[list[writer.Cell]] = [[] for _ in plan.columns]

        for row in range(start, end):
            lookup = _lookup(rows, row)
            for i, column in enumerate(plan.declared):
                text = interpolate.apply(column.template, config.inject, lookup)
                type_ = plan.types[i]
                try:
                    if type_.is_list:
                        # An empty cell is an EMPTY LIST, not a list holding one blank — splitting
                        # "" on a comma would otherwise conjure a phantom element.
                        elements = [] if text == "" else text.split(plan.separators[i])
                        batch[i].append(writer.Cell(texts=elements))
                    else:
                        batch[i].append(writer.Cell(value=convert.value(text, type_)))
                except ValueError as e:
                    raise ValueError(f'column "{column.name}", row {row + 1}: {e}') from None
        start = end
        yield batch


def _lookup(rows, row: int):
    names = set(rows.sequence_names())

    def lookup(name: str) -> str | None:
        value = rows.value(name, row)
        if value is None and name not in names:
            return None
        return "" if value is None else value

    return lookup
