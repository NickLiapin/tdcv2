"""``<pool>`` — a small table computed once, before the rows.

Twenty doctors for two thousand patients. The problem an ordinary sequence cannot solve: a
doctor is not a VALUE, he is a RECORD, and his gender, first name and last name have to agree
with each other. A column of thirty names cannot keep ``Male`` next to ``Дмитрий``; a table of
thirty rows can.

A pool is not read directly — ``${{Doctors.lastName}}`` would give the dot a second meaning
next to ``${{Sequence.Field}}``. A sequence draws from it instead, and that hands us the hardest
rule for free: one sequence holds one value per row, so every field read from the same reference
in the same row comes from the same member.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..expr import evaluate as expr
from ..expr.match_key import match_key
from ..prng import seekable

# Measured on the reference: about 320 bytes a member with four fields, so a million members
# cost a third of a gigabyte before the first row. See ``validator`` for the diagnostics.
POOL_WARN_MEMBERS = 100_000
POOL_MAX_MEMBERS = 1_000_000


@dataclass(slots=True)
class PoolTable:
    """A computed pool: ``count`` members, each a set of named fields.

    Column-first because that is how a member is read — a row asks for one field of one member,
    never for a whole member at once.
    """

    name: str
    count: int
    fields: list[str]
    columns: dict[str, list[str]]


def pool_seed(seed: str, pool_name: str) -> str:
    """The seed a pool's own values are drawn from. Part of the cross-language contract.

    Derived rather than taken off the main stream, so adding a pool to a config leaves every
    other column exactly where it was and an old snapshot still matches.
    """
    return f"{seed}#pool:{pool_name}"


def ref_stream(ref_name: str) -> str:
    """The PRNG stream a reference draws its member from. Seekable by row."""
    return f"pool-ref:{ref_name}"


def pick_member(seed: str, ref_name: str, table: PoolTable, row: int) -> int:
    return seekable.next_int(seed, ref_stream(ref_name), row, table.count)


def parse_equality_filter(
    expression: str, table: PoolTable, is_column
) -> tuple[str, str] | None:
    """Recognise ``field == Column`` (either way round), and nothing else.

    BOTH sides must be what they look like. Without the ``is_column`` test,
    ``filter="clinic == North"`` — where North is a bare word, which the expression language has
    always allowed and which is the obvious way to write "northern doctors only" — reads as a
    comparison against a column named North, finds nothing, and refuses the run.

    A dotted name is a name too. ``Doctors.clinic`` is the qualified spelling TDC232 tells the
    author to reach for when a name is both a field and a column — and it used to fall off this
    fast path and scan every member: measured at 108 s against 0.05 s for the bare spelling of
    the same filter, on 40,000 rows over a pool of 2,000. Taking the advice must not cost that.
    """
    parts = expression.split("==")
    if len(parts) != 2:
        return None
    left, right = parts[0].strip(), parts[1].strip()
    if not _name(left) or not _name(right):
        return None

    def as_field(text: str) -> str | None:
        prefix = f"{table.name}."
        bare = text[len(prefix) :] if text.startswith(prefix) else text
        return bare if bare in table.fields else None

    left_field = as_field(left)
    if left_field is not None and is_column(right):
        return (left_field, right)
    right_field = as_field(right)
    if right_field is not None and is_column(left):
        return (right_field, left)
    return None


def _name(text: str) -> bool:
    """A bare name, or one qualified with a dot — ``clinic``, ``Doctors.clinic``."""
    parts = text.split(".")
    return bool(parts) and all(_plain(part) for part in parts)


def _plain(text: str) -> bool:
    return bool(text) and (text[0].isalpha() or text[0] == "_") and all(
        c.isalnum() or c == "_" for c in text
    )


def bucket_by_field(table: PoolTable, field: str) -> dict[str, list[int]]:
    """member value → the members holding it. Built once per reference.

    Keyed by ``match_key`` rather than by the raw text, so the bucket answers the same question
    ``==`` would: a member holding ``"01"`` is found by a row producing ``"1"``, exactly as the
    general expression path finds it.
    """
    buckets: dict[str, list[int]] = {}
    column = table.columns.get(field, [])
    for m in range(table.count):
        buckets.setdefault(match_key(column[m] if m < len(column) else ""), []).append(m)
    return buckets


def row_values_detail(values: dict[str, str]) -> str:
    """``(Clinic="North", Budget="40")`` — what the row held, for the refusal below."""
    if not values:
        return ""
    return " (" + ", ".join(f'{name}="{value}"' for name, value in values.items()) + ")"


def eligible_members(
    expression: str, table: PoolTable, row_value, read_row_values: dict[str, str] | None = None
) -> list[int]:
    """The members for which ``expression`` holds on this row.

    A qualified ``Pool.field`` always means the member's field; a bare name means the member's
    field first and the row's column second. A name that is both is refused by the validator
    (TDC232), so this never has to guess.
    """
    prefix = f"{table.name}."
    out: list[int] = []
    for m in range(table.count):

        def lookup(name: str, m: int = m) -> str | None:
            if name.startswith(prefix):
                qualified = table.columns.get(name[len(prefix) :])
                if qualified is not None:
                    return qualified[m] if m < len(qualified) else ""
            column = table.columns.get(name)
            if column is not None:
                return column[m] if m < len(column) else ""
            # What the evaluator asked for IS what the filter reads, including through && and a
            # ternary. Recorded rather than parsed out of the expression, so the "nobody matched"
            # refusal can name the row's own values on the general path too — it used to name
            # them only on the bucketed `field == Column` one, and the reader was left unable to
            # tell a missing member from a wrong filter.
            value = row_value(name)
            if read_row_values is not None and value is not None:
                read_row_values[name] = value
            return value

        if expr.as_condition(
            expression,
            lambda name, f=lookup: f(name) is not None,
            lambda name, f=lookup: f(name) or "",
        ):
            out.append(m)
    return out


def no_candidate_message(pool_name: str, expression: str, row: int, detail: str) -> str:
    return (
        f'pool "{pool_name}": no member satisfies filter="{expression}" for row {row + 1}'
        f"{detail}. A filter narrows the members a row may draw from; when it narrows them to "
        "none there is nothing to substitute. Add a member that matches, or widen the filter."
    )
