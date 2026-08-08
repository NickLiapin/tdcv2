"""``<gen type="file" src="./products.txt"/>`` — values from the user's own file.

Two shapes. A plain list is one value per line, blanks skipped. With ``column=`` the file is read
as CSV and one column is taken from it — by header name, or by 1-based position when the column is
written as a number.

This is how a run gets the real thing: the actual product catalogue, the actual list of branch
codes. Generated data is only as convincing as the vocabulary it draws from, and no bundled pack
knows one particular company's part numbers.
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlparse
from urllib.request import url2pathname

from ..prng import rand
from ..prng.prng import Sfc32

_NUMBERED = re.compile(r"^[1-9][0-9]*$")
_LINE_BREAK = re.compile(r"\r?\n")

# Excel writes one of these ahead of the first header cell. JavaScript's `trim` counts it as
# whitespace and Python's `strip` does not, so it comes off by name.
_BOM = "﻿"


@dataclass(frozen=True, slots=True)
class Weighted:
    """Values and their shares, when ``weight="countColumn"`` names a second column.

    Without it a list is drawn uniformly, so Smith and Zabrowski turn up equally often. Real
    distributions are never flat — the commonest surnames cover a large part of a population and
    the tail is vanishingly rare — and flattening that is the first thing anyone looking at the
    data notices.

    The shares are honoured exactly, through the same apportionment ``percent=`` uses: weights of
    20000 and 10000 over 30000 rows give precisely 20000 and 10000, not "about twice as many". A
    weight is a raw count, not a percentage, because census and registry files publish counts and
    normalising them by hand is a pointless invitation to arithmetic errors.
    """

    values: list[str]
    percents: list[float]


@dataclass(frozen=True, slots=True)
class RowSource:
    """A CSV read as whole rows, for ``row="key"``.

    Several sequences naming the same key read different columns of the SAME row, so a generated
    city and its postcode come from one real record rather than from two unrelated ones. Without
    it, drawing a city and a postcode independently produces pairs that no validator and no human
    would accept.
    """

    rows: list[list[str]]
    header: list[str]
    column_index: int
    source_key: str


def generate(
    attrs: dict[str, str],
    count: int,
    base_dir: Path | None,
    prng: Sfc32,
    roots: list[Path] | None = None,
) -> list[str]:
    values = load(attrs, base_dir, roots)
    return [rand.pick(prng, values) for _ in range(count)]


def load(
    attrs: dict[str, str], base_dir: Path | None, roots: list[Path] | None = None
) -> list[str]:
    """The file's values in file order — what ``order="sequential"`` reads."""
    src = attrs.get("src")
    if src is None or not src.strip():
        raise ValueError('file generator: "src" is required')
    path = resolve(src.strip(), base_dir, roots)
    content = _read(path)

    column = _trim_to_none(attrs.get("column"))
    if "column" in attrs and column is None:
        raise ValueError("file generator: column must not be empty")

    values = _list_values(content) if column is None else _csv_column(content, column, attrs, path)
    if not values:
        raise ValueError(f'file generator: list at "{path}" is empty')
    return values


def load_weighted(
    attrs: dict[str, str], base_dir: Path | None, roots: list[Path] | None = None
) -> Weighted | None:
    """``None`` when the generator is not weighted, which is the ordinary case."""
    weight_column = _trim_to_none(attrs.get("weight"))
    if weight_column is None:
        return None
    column = _trim_to_none(attrs.get("column"))
    if column is None:
        raise ValueError(f'file generator: weight="{weight_column}" needs a "column" to weight')

    path = resolve(attrs["src"].strip(), base_dir, roots)
    rows = _non_blank_rows(_read(path), parse_delimiter(attrs.get("delimiter")))
    if not rows:
        raise ValueError(f'file generator: CSV file at "{path}" is empty')

    header = rows[0]
    value_index = column_index(header, column)
    weight_index = column_index(header, weight_column)
    if weight_index == value_index:
        raise ValueError(
            f'file generator: weight column "{weight_column}" is the same column as the values'
        )

    values: list[str] = []
    counts: list[float] = []
    for position, row in enumerate(rows[1:]):
        value = _cell(row, value_index)
        # The same refusal the plain path makes, for the same reason.
        if not value:
            raise ValueError(
                f'file generator: column "{column}" is empty on value row {position + 1} '
                f'— a blank cell would drop that row from the values and quietly change the proportions. Fill it in, remove the row, or point column= at a column that is complete.'
            )
        weight = _weight_of(row, weight_index, weight_column, value)
        # A zero weight means never drawn, so carrying it costs memory and buys nothing.
        if weight == 0:
            continue
        values.append(value)
        counts.append(weight)

    if not values:
        raise ValueError(
            f'file generator: no values with a positive weight in column "{weight_column}"'
        )
    return Weighted(values, _as_percents(counts))


def load_rows(
    attrs: dict[str, str], base_dir: Path | None, roots: list[Path] | None = None
) -> RowSource:
    column = _trim_to_none(attrs.get("column"))
    if column is None:
        raise ValueError('sequence: row-linked file generator requires a CSV "column" attribute')
    src = (attrs.get("src") or "").strip()
    path = resolve(src, base_dir, roots)
    delimiter = parse_delimiter(attrs.get("delimiter"))

    everything = _non_blank_rows(_read(path), delimiter)
    if not everything:
        raise ValueError(f'file generator: CSV file at "{src}" is empty')

    index = column_index(everything[0], column)
    skip_header = _parse_header_flag(attrs.get("header")) or not _NUMBERED.match(column)
    rows = everything[1:] if skip_header else everything

    if not rows:
        raise ValueError(f'file generator: CSV file at "{src}" has no data rows')
    if not any(_cell(row, index) for row in rows):
        raise ValueError(f'file generator: CSV column "{column}" at "{src}" has no values')

    # The header is kept: `rows` may have had it stripped, so a second column named later — a
    # weight column — has to be resolved against the original.
    #
    # Two sequences on one key must be reading one file; source_key identifies which.
    return RowSource(rows, everything[0], index, f"{path}|{delimiter}|{str(skip_header).lower()}")


def cell_at(source: RowSource, row_index: int) -> str:
    """One row's cell in the linked column, trimmed and never absent."""
    return _cell(source.rows[row_index], source.column_index)


def weighted_rows(attrs: dict[str, str], source: RowSource) -> Weighted | None:
    """Row indexes drawn to the exact quota of a weight column.

    The row-linked counterpart of :func:`load_weighted`, so every field on the link follows the
    same weighted rows.
    """
    weight_column = _trim_to_none(attrs.get("weight"))
    if weight_column is None:
        return None
    weight_index = column_index(source.header, weight_column)
    if weight_index == source.column_index:
        raise ValueError(
            f'file generator: weight column "{weight_column}" is the same column as the values'
        )

    indexes: list[str] = []
    counts: list[float] = []
    for i, row in enumerate(source.rows):
        value = cell_at(source, i)
        if not value:
            continue
        weight = _weight_of(row, weight_index, weight_column, value)
        if weight == 0:
            continue
        indexes.append(str(i))
        counts.append(weight)

    if not indexes:
        raise ValueError(
            f'file generator: weight column "{weight_column}" has no rows with a positive weight'
        )
    return Weighted(indexes, _as_percents(counts))


#: The prefix that says "look in the configured data folders, not next to the config".
DATA_ALIAS = "@data/"


def resolve(src: str, base_dir: Path | None, roots: list[Path] | None = None) -> Path:
    """Where a ``src=`` points, in the order the reference implementation looks.

    A plain relative path means the file next to the CONFIG, not next to whatever directory the
    program happened to be started from — otherwise the same config would work from one shell and
    fail from another. When it is not there, the configured data folders are tried, so a config can
    be moved without rewriting every source.

    ``@data/x.txt`` skips the config's folder entirely and names the data folders outright. That is
    what makes a config portable between machines whose data lives in different places: the path in
    the config stays the same and only ``--data-path`` (or ``dataPaths`` in the project config)
    differs. With no data folder configured at all the alias cannot mean anything, and saying so is
    better than reporting a missing file.
    """
    text = src.strip()
    candidates = list(roots or [])

    if text.startswith("file://"):
        return Path(url2pathname(urlparse(text).path))

    if text.startswith(DATA_ALIAS):
        alias = text[len(DATA_ALIAS) :].strip()
        if not alias:
            raise ValueError("file generator: @data source path must not be empty")
        if not candidates:
            raise ValueError(
                'file generator: "@data/..." needs at least one data folder — '
                "pass --data-path, or name one in tdcv2.config.json"
            )
        return _first_readable([root / alias for root in candidates])

    path = Path(text)
    if path.is_absolute():
        return path

    beside = Path(os.path.normpath(base_dir / path)) if base_dir is not None else path
    if beside.is_file() or not candidates:
        return beside
    return _first_readable([beside, *(root / path for root in candidates)])


def _first_readable(attempts: list[Path]) -> Path:
    """The first candidate that exists, or the first one tried so the error names something real."""
    for candidate in attempts:
        if candidate.is_file():
            return candidate
    return attempts[0]


def parse_rows(content: str, delimiter: str = ",") -> list[list[str]]:
    """RFC 4180: quoted fields, doubled quotes inside them, and either line ending."""
    rows: list[list[str]] = []
    row: list[str] = []
    field: list[str] = []
    in_quotes = False
    quoted_field = False

    i = 0
    length = len(content)
    while i < length:
        ch = content[i]
        if in_quotes:
            if ch == '"':
                if i + 1 < length and content[i + 1] == '"':
                    field.append('"')
                    i += 1
                else:
                    in_quotes = False
            else:
                field.append(ch)
            i += 1
            continue

        if ch == '"' and not field and not quoted_field:
            in_quotes = True
            quoted_field = True
        elif ch == delimiter:
            row.append("".join(field))
            field = []
            quoted_field = False
        elif ch in ("\n", "\r"):
            if ch == "\r" and i + 1 < length and content[i + 1] == "\n":
                i += 1
            row.append("".join(field))
            field = []
            quoted_field = False
            rows.append(row)
            row = []
        else:
            field.append(ch)
        i += 1

    if in_quotes:
        raise ValueError("file generator: unterminated quoted CSV field")
    if field or row or not content.endswith("\n"):
        row.append("".join(field))
        rows.append(row)
    return rows


def parse_delimiter(value: str | None) -> str:
    if value is None:
        return ","
    # A single character is taken as written, tab included, so that resolving twice is harmless:
    # trimming a real tab would leave nothing and fall back to a comma.
    if len(value) == 1:
        return value
    normalized = value.strip()
    if not normalized:
        return ","
    aliases = {"comma": ",", "semicolon": ";", "tab": "\t", "\\t": "\t", "pipe": "|"}
    resolved = aliases.get(normalized.lower(), normalized)
    if len(resolved) != 1:
        raise ValueError("file generator: delimiter must be one character")
    return resolved


def column_index(header_row: list[str], column: str) -> int:
    if _NUMBERED.match(column):
        return int(column) - 1
    for i, cell in enumerate(header_row):
        if cell.replace(_BOM, "").strip() == column:
            return i
    raise ValueError(f'file generator: CSV column "{column}" was not found in the header row')


def _read(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except OSError as e:
        raise ValueError(f'file generator: cannot read "{path}"') from e


def _list_values(content: str) -> list[str]:
    return [line for line in (raw.strip() for raw in _LINE_BREAK.split(content)) if line]


def _csv_column(content: str, column: str, attrs: dict[str, str], path: Path) -> list[str]:
    rows = _non_blank_rows(content, parse_delimiter(attrs.get("delimiter")))
    if not rows:
        raise ValueError(f'file generator: CSV file at "{path}" is empty')

    index = column_index(rows[0], column)
    # A named column implies a header row; a numbered one only skips it when told to, because a
    # file of pure data has no header to skip.
    skip_header = _parse_header_flag(attrs.get("header")) or not _NUMBERED.match(column)

    # A blank cell is REFUSED, not skipped. Dropping it takes the row out of the pool, so the
    # file's own proportions stop being the run's: measured on a three-person CSV with one
    # empty email, 60 rows produced 28 and 32 of the other two and no sign of the third. The
    # weighted path refuses the same shape one column over, for the same stated reason.
    values = [_cell(row, index) for row in rows[1 if skip_header else 0 :]]
    for position, cell in enumerate(values):
        if not cell:
            raise ValueError(
                f'file generator: column "{column}" is empty on value row {position + 1} of '
                f'"{path}" — a blank cell would drop that row from the values and quietly change the proportions. Fill it in, remove the row, or point column= at a column that is complete.'
            )
    if not values:
        raise ValueError(f'file generator: CSV column "{column}" at "{path}" has no values')
    return values


def _non_blank_rows(content: str, delimiter: str) -> list[list[str]]:
    return [row for row in parse_rows(content, delimiter) if any(cell.strip() for cell in row)]


def _cell(row: list[str], index: int) -> str:
    return row[index].strip() if index < len(row) else ""


def _weight_of(row: list[str], index: int, weight_column: str, value: str) -> float:
    raw = _cell(row, index)
    # A blank cell must not slide through as a weight of zero, which would delete the value from
    # the run. A product vanishing from a catalogue because one cell of an export was empty is
    # discovered far too late — and missing data and a deliberate zero are different statements,
    # only one of which is actionable.
    if not raw:
        raise ValueError(
            f'file generator: weight column "{weight_column}" is empty for value "{value}" '
            "— write 0 to exclude it, or fill in the count"
        )
    try:
        # Python alone reads "1_000" as a thousand. A weight column is data from someone else's
        # export, and the three implementations have to reject the same cells.
        weight = float("nan") if "_" in raw else float(raw)
    except ValueError:
        weight = float("nan")
    if weight != weight or weight in (float("inf"), float("-inf")) or weight < 0:
        raise ValueError(
            f'file generator: weight "{raw}" for value "{value}" is not a non-negative number'
        )
    return weight


def _as_percents(counts: list[float]) -> list[float]:
    total = sum(counts)
    return [count / total * 100 for count in counts]


def _parse_header_flag(value: str | None) -> bool:
    if value is None:
        return False
    normalized = value.strip().lower()
    if normalized in ("true", "1"):
        return True
    if normalized in ("false", "0"):
        return False
    raise ValueError("file generator: header must be true or false")


def _trim_to_none(value: str | None) -> str | None:
    if value is None:
        return None
    trimmed = value.strip()
    return trimmed or None
