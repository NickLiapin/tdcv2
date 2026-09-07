"""``MAP`` columns: ``type="{}int64"`` over a cell that reads ``alpha:1,beta:2``.

Parquet stores a map as a repeated group of key/value pairs, so the shape is the LIST shape with
two leaves instead of one::

    required group <name> (MAP) {
        repeated group key_value {
            required BYTE_ARRAY key (STRING);
            required|optional <physical> value;
        }
    }

The maximum repetition level is 1 for both leaves. The maximum definition level is 1 for the key —
it is REQUIRED, as the format insists, because a pair with no key is not a pair — and 1 or 2 for
the value depending on whether it is nullable.

The KEY is always text. A cell arrives here as text, and Parquet forbids a null key, so a second
type parameter would double the syntax to buy a conversion nobody has asked for.

Kept apart from the writer so the level streams can be checked against ones worked out by hand.
Getting them wrong produces a file readers accept and then reassemble incorrectly, which is the
worst failure this writer has.
"""

from __future__ import annotations

from dataclasses import dataclass

KEY_MAX_DEF = 1
"""The key leaf's maximum definition level. Always 1: the key is REQUIRED inside a pair."""


@dataclass(frozen=True, slots=True)
class Entry:
    """One pair. ``value`` of ``None`` is a NULL value, which only a nullable map can hold."""

    key: str
    value: str | None


@dataclass(frozen=True, slots=True)
class Built:
    """The two leaves' values, and the level streams describing their shape."""

    keys: list[str]
    present: list[str]
    rep_levels: list[int]
    key_def_levels: list[int]
    value_def_levels: list[int]
    max_value_def: int


def value_max_def(value_nullable: bool) -> int:
    """The maximum definition level for a map value that is, or is not, nullable."""
    return 2 if value_nullable else 1


def parse_cell(text: str, separator: str, value_nullable: bool) -> list[Entry]:
    """Split one cell into pairs — ``alpha:1,beta:2`` on the column's separator.

    The key is everything before the FIRST ``:``, the value everything after, so a value may hold
    colons (a timestamp does) and a key may not. That asymmetry is the one worth having: keys are
    short labels, values are whatever the column generates.

    Three things are refused rather than guessed at, and each would otherwise produce a map quietly
    missing an entry: a piece with no ``:`` at all (is it a key with no value, or the reverse?); an
    empty key, which Parquet has no way to store; and a key that repeats inside one row, because
    readers disagree about which of the two wins and some drop the row's map entirely.
    """
    # An empty cell is an EMPTY MAP, not a map holding one blank pair — the same rule a list
    # follows, for the same reason.
    if text == "":
        return []

    entries: list[Entry] = []
    seen: set[str] = set()
    for piece in text.split(separator):
        at = piece.find(":")
        if at < 0:
            raise ValueError(
                f'map entry "{piece}" has no ":" — a map cell reads '
                f"key:value{separator}key:value"
            )
        key = piece[:at]
        if not key:
            raise ValueError(f'map entry "{piece}" has an empty key')
        if key in seen:
            raise ValueError(f'map key "{key}" appears twice in one cell')
        seen.add(key)
        value = piece[at + 1 :]
        entries.append(Entry(key, None if value_nullable and value == "" else value))
    return entries


def build(rows: list[list[Entry]], value_nullable: bool) -> Built:
    """The key, value, repetition and definition streams for one map column.

    An empty map still occupies one level slot in BOTH leaves: definition 0 is the statement "this
    row has no pairs". Without it the row would vanish from the column, and every row after it
    would shift up by one.
    """
    deepest = value_max_def(value_nullable)
    keys: list[str] = []
    present: list[str] = []
    rep_levels: list[int] = []
    key_def_levels: list[int] = []
    value_def_levels: list[int] = []

    for row in rows:
        if not row:
            rep_levels.append(0)
            key_def_levels.append(0)
            value_def_levels.append(0)
            continue
        for k, entry in enumerate(row):
            rep_levels.append(0 if k == 0 else 1)
            key_def_levels.append(KEY_MAX_DEF)
            keys.append(entry.key)
            if entry.value is None:
                value_def_levels.append(deepest - 1)  # the pair exists, the value does not
                continue
            value_def_levels.append(deepest)
            present.append(entry.value)

    return Built(keys, present, rep_levels, key_def_levels, value_def_levels, deepest)
