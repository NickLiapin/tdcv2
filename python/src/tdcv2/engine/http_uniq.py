"""``uniq="true"`` on a ``<gen type="http">`` sequence: a CHECK of the answers.

Everywhere else ``uniq`` is a property of a draw — take without replacement, or rearrange — and a
service's answer is neither: it belongs to the row it was asked for, and the service answers each
row once. So the run cannot MAKE the column unique. What it can do is refuse to write a file that
claims to be unique and is not: every answer is read once, before the first row goes out, and the
first repeat stops the run with the two rows that share it.

The hunt is an external sort, so it holds a sort buffer, not the column. A blank answer is no value
at all (``on_error="empty"``, a ``parent=`` row the child does not hold, a ``missing=`` draw) and
repeats freely. Mirrors ``typescript/src/sequence/http-uniq.ts``.
"""

from __future__ import annotations

from collections.abc import Callable

from ..model.config import Config
from . import external_sort
from .exact_uniq import INDEX_WIDTH, SEP


def sequences(config: Config) -> list[str]:
    """The sequences whose ``uniq="true"`` is a check of a service's answers."""
    return [
        spec.name
        for spec in config.sequences
        if spec.uniq and spec.gen is not None and spec.gen.type == "http"
    ]


def check(name: str, value: Callable[[int], str | None], count: int) -> None:
    """Raise, naming the first repeated answer, unless every non-blank answer differs."""

    def records():
        for row in range(count):
            key = value(row) or ""
            if key:
                yield f"{key}{SEP}{row:0{INDEX_WIDTH}d}"

    # The groups arrive in key order; the one reported is the first a reader of the file would
    # meet — the lowest row that repeats an answer above it.
    first: list[int] | None = None
    repeats = 0
    current: str | None = None
    group: list[int] = []

    def close(group: list[int]) -> None:
        nonlocal first, repeats
        if len(group) < 2:
            return
        repeats += len(group) - 1
        if first is None or group[1] < first[1]:
            first = group

    for record in external_sort.sort(records(), 0, None):
        split = record.rfind(SEP)
        key = record[:split]
        if key != current:
            close(group)
            group = []
            current = key
        group.append(int(record[split + 1 :]))
    close(group)
    if first is None:
        return
    a, b = first[0], first[1]
    more = f" ({repeats} rows repeat an earlier answer)" if repeats > 1 else ""
    raise UniqAnswerError(
        f'uniq="true" on "{name}": the service answered "{value(a) or ""}" on row {a + 1} and '
        f"again on row {b + 1}{more} — uniq on an http column checks the answers; it cannot ask "
        "the service for others"
    )


class UniqAnswerError(RuntimeError):
    """A service repeated an answer in a column marked ``uniq="true"``."""
