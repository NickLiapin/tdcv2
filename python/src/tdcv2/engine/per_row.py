"""How the in-memory engine derives a column the way the streaming engine does.

The two engines were built on different ideas of randomness. Engine 1 threaded one PRNG
through every sequence in declaration order, so a column's values depended on how many draws
the columns before it had made; engines 2 and 3 derive each cell from ``(seed, stream_id,
row)`` and are independent of one another. Two architectures, and no seed could ever make
them agree.

This module is engine 1 adopting the second scheme — the port of the reference's
``sequence/per-row.ts``, with the same names so the two can be read side by side. It holds
the pieces that decide how: which generators may be built row by row, what a column is
called on the wire, and the exact layout a list of values gets.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import TYPE_CHECKING

from ..distribution import hamilton, percent_mask
from ..generators import advanced_regex
from ..generators import file as file_gen
from ..prng import permute
from ..prng.prng import create

if TYPE_CHECKING:  # pragma: no cover - typing only
    from ..model import Gen
    from .memory import _Run


@dataclass(frozen=True, slots=True)
class ExactLayout:
    """What a column's exact layout gave each row.

    Kept so a child that filters on this column can be ordered the way the streaming engine
    orders it: a child's position inside its parent's subset is its RANK in the parent's
    layout, not its ordinal among the matching rows, and the two are different orders.
    """

    values: list[str]
    counts: list[int]
    #: Cumulative upper bound per value: value v owns slots [cum_hi[v-1], cum_hi[v]).
    cum_hi: list[int]
    slot_by_row: dict[int, int]


def for_stream(run: _Run, stream_id: str, mask: list[bool] | None = None) -> _Run:
    """The same run, told which column it is building.

    Independent generators derive from ``(seed, stream_id, row)`` so this engine and the
    streaming one agree; everything else ignores it. A fresh object rather than a mutable
    field — two columns must never see each other's name.

    The mask, when the column has one, records the ABSOLUTE row each drawn position belongs
    to. A parented column is built compacted, one value per applicable row, while the
    streaming engine derives it at the row's real index.
    """
    rows = rows_of(mask) if mask is not None and not all(mask) else None
    return replace(run, stream_id=stream_id, rows=rows)


def with_rows(run: _Run, stream_id: str, rows: list[int]) -> _Run:
    """The run for a column whose drawn positions are known rows outright.

    A ``<mix>`` case is the reason this exists: its rows are not a contiguous run and not a
    mask over the whole set either — they are whichever rows the percentage layout gave it.
    """
    return replace(run, stream_id=stream_id, rows=list(rows))


def redraw(run: _Run) -> _Run:
    """The run a REDRAW happens under: one row, no column name of its own.

    A ``<distinct>`` repair asks a generator for another value, and the streaming engine asks
    with a context like this — so no whole-column layout can fire on a build of one row and
    hand back the same value it was trying to replace. The caller supplies the stream through
    the PRNG it passes.
    """
    return replace(run, stream_id=None, rows=None, layouts=None, per_row=True)


def rows_of(mask: list[bool]) -> list[int]:
    """The absolute row index of each position a masked column draws."""
    return [i for i, on in enumerate(mask) if on]


def keyed(run: _Run) -> tuple[str, str] | None:
    """The seed and column name this build draws under, when it has both.

    An inline generator or a nested build has no column of its own, so there is nothing to
    key by and the caller falls back to the shared PRNG.
    """
    if run.stream_id is None:
        return None
    return (run.config.seed, run.stream_id)


def absolute_row(run: _Run, position: int) -> int:
    """The absolute row a drawn position belongs to.

    Index-dependent generators — counters, timeseries, a pattern stretched over the run —
    read the POSITION for their value, and the streaming engine does the same. Their random
    draws are keyed by the row instead, which is why the two numbers have to be told apart.
    """
    if run.rows is None:
        return position
    return run.rows[position] if position < len(run.rows) else position


#: Generators whose value for a row depends on nothing but that row. The streaming engine
#: already builds these one row at a time; this list is what lets the in-memory engine do the
#: same. A generator is off it when its column is a PLAN rather than a series of draws —
#: ``text`` most clearly, since even an unweighted list is spread evenly over the column and
#: permuted rather than picked per row (``exact_text_layout`` handles that instead). The rest
#: are conditional and checked in ``per_row_buildable``.
PER_ROW_TYPES = frozenset(
    {"number", "regex", "symbol", "date", "template", "file", "advanced_regex"}
)

#: Types the streaming engine builds INLINE — it reads the row's position rather than
#: deriving a value from the row — and whose ``anomaly=``/``missing=`` draws it therefore
#: takes from dedicated ``#anom`` and ``#miss`` streams instead of from the generator's own.
INLINE_ANOMALY_TYPES = frozenset({"text", "increment", "decrement", "timeseries", "pattern"})


def weighted_template_pack(gen: Gen, run: _Run) -> tuple[list[str], list[float]] | None:
    """A ``<gen type="template">`` pointing at a pack that carries its own shares.

    The same resolution the streaming engine does, so both draw the same pack by the same
    quota. A synthetic address (``person.b_day`` and its kind) is resolved inside the
    generator and has no pack file behind it, so asking the registry would throw rather
    than answer.
    """
    if gen.type != "template":
        return None
    address = gen.attrs.get("value", "")
    locale = gen.attrs.get("local") or run.config.locale
    if not address or not run.packs.exists(address, locale):
        return None
    entry = run.packs.load(address, locale)
    return (entry.values, entry.percents) if entry.weighted and entry.percents else None


def per_row_buildable(gen: Gen, count: int, run: _Run) -> bool:
    """Can this generator be built row by row?

    The recursion stops on ``run.per_row``, not on the count. The per-row loop builds each row by
    calling the generator again with a count of one, and that inner call must take the ordinary
    path or the loop never ends. It used to stop on ``count <= 1`` instead, which refused a
    GENUINE one-row column along with it — a run of ``count="1"``, or a ``<mix>`` case whose
    quota came to a single row. Those fell back to the threaded PRNG while the streaming engines
    drew from the seekable stream, so one config produced two different datasets depending on
    which engine ran it. A one-row build is one row either way; what tells the two apart is
    whether we are already inside one.
    """
    if count <= 0 or run.stream_id is None or run.per_row:
        return False
    if gen.type not in PER_ROW_TYPES:
        return False
    attrs = gen.attrs
    # order="sequential" reads the position, never the randomness.
    if attrs.get("order") == "sequential":
        return False
    # A weighted file column and a pack that declares shares are both exact quotas over the
    # whole column: the streaming engine lays them out the way it lays out weighted text, so
    # this engine must too, not draw per row.
    if attrs.get("weight") is not None:
        return False
    # `sample="exact"` on a quantile read is a PLAN too: every row takes its own point on the
    # sorted sample, and which point follows from a scatter over the whole column. Built a row at
    # a time it would see a count of one and hand every row the median.
    if (attrs.get("sample") or "").strip() == "exact":
        return False
    if weighted_template_pack(gen, run) is not None:
        return False
    # A pack GENERATOR may declare a share too. Its values are computed rather than listed,
    # so there is no list to lay out — the whole column is built at once or the quota is
    # wrong, and the streaming engine refuses it outright.
    if gen.type == "template" and _pack_needs_whole_column(gen, run):
        return False
    # A PLAIN pack — a value list with no weights — is laid out over the whole column now,
    # exactly as a plain text list is, so it must not be drawn per row either. A per-row pick
    # leaves every value's count to chance, and inside a <uniq> that chance decided whether
    # the run collects.
    if gen.type == "template" and _plain_pack_values(gen, run) is not None:
        return False
    # A PLAIN file list, same reason — its weighted cousin is excluded by `weight=` above, a
    # `row=`-linked read below, and a quantile read stays per-row: it is a distribution, not
    # a bag, and the streaming engine expects it to arrive a row at a time.
    if gen.type == "file" and (attrs.get("read") or "").strip() != "quantile":
        return False
    # A weighted choice inside an advanced_regex — `(?%{RU:70|US:20|DE:10})` — is a quota over
    # the column like any other share. Decided one row at a time it awards every row to the
    # largest share: 100% RU, not 70/20/10.
    if gen.type == "advanced_regex" and advanced_regex.has_weighted_choice(attrs.get("value", "")):
        return False
    # `row=` links several columns to ONE row of a file. That choice belongs to the row as a
    # whole, not to any single column reading from it.
    if (attrs.get("row") or "").strip():
        return False
    # `percent=` on ANY type, not just text: a number can apportion its LENGTH groups the same
    # exact way (`length="2,10-12" percent="85,15"`).
    if attrs.get("percent") is not None:
        return False
    # `repeat=` apportions the LENGTHS exactly across the column — how many rows get two
    # elements, how many get five. That plan is separate, and taking this path would skip it.
    return attrs.get("repeat") is None


def _plain_pack_values(gen: Gen, run: _Run) -> list[str] | None:
    """The value list of a PLAIN pack — no weights, no generator body — or ``None``."""
    address = gen.attrs.get("value", "")
    locale = gen.attrs.get("local") or run.config.locale
    if not address or not run.packs.exists(address, locale):
        return None
    entry = run.packs.load(address, locale)
    if entry.is_generator or entry.weighted or not entry.values:
        return None
    return list(entry.values)


def _pack_needs_whole_column(gen: Gen, run: _Run) -> bool:
    from . import router

    address = gen.attrs.get("value", "")
    locale = gen.attrs.get("local") or run.config.locale
    if not address or not run.packs.exists(address, locale):
        return False
    try:
        return router._needs_whole_column(run.packs, address, locale)
    except (ValueError, OSError):
        # An address that does not resolve is the validator's problem, not this one's.
        return False


def listed_values(gen: Gen, run: _Run) -> tuple[list[str], list[float]] | None:
    """The value list and the shares a column lays out, when its values are LISTED.

    Three of them, and the streaming engine sends all three down one path: a ``text`` list, a
    weighted file column, a weighted pack. It has no separate uniform case, so an unweighted
    ``text`` list arrives here too, with equal shares. Anything else returns ``None`` and is
    drawn per row.
    """
    attrs = gen.attrs
    if attrs.get("order") == "sequential":
        return None
    if attrs.get("weight") is not None:
        # `row=` links whole rows of the file; the choice is not this column's.
        if (attrs.get("row") or "").strip():
            return None
        weighted = file_gen.load_weighted(attrs, run.base_dir, run.packs.data_roots)
        return (weighted.values, weighted.percents) if weighted is not None else None
    pack = weighted_template_pack(gen, run)
    if pack is not None:
        return pack
    if gen.type != "text":
        return None
    values = [v.strip() for v in (attrs.get("value") or "").split(",")]
    mask = attrs.get("percent")
    percents = (
        percent_mask.expand(mask, len(values))
        if mask is not None and mask != ""
        else [100.0 / len(values)] * len(values)
    )
    return (values, percents)


def exact_text_layout(
    values: list[str],
    percent_attr: str | None,
    count: int,
    run: _Run,
    percents: list[float] | None = None,
) -> list[str] | None:
    """A list of values laid out exactly, the way the streaming engine lays it out.

    ``counts_per_value`` turns the shares into a whole number of slots per value; ``permute``
    scatters those slots over the rows with a key derived from the column's name. Row i gets
    the value whose slot range contains ``permute(i)``. Both halves are keyed by ``(seed,
    stream_id)``, so the in-memory and the streaming engine land on the same arrangement.

    Returns ``None`` when this run cannot do it — no column name (an inline generator, or a
    nested build) — and the caller keeps the older draw.
    """
    key_pair = keyed(run)
    if key_pair is None or not values or count <= 0:
        return None
    seed, stream_id = key_pair
    shares = percents
    if shares is None:
        shares = (
            percent_mask.expand(percent_attr, len(values))
            if percent_attr is not None and percent_attr != ""
            else [100.0 / len(values)] * len(values)
        )

    counts = hamilton.counts_per_value(count, shares, create(f"{seed}|{stream_id}|pct"))
    layout_key = permute.key(seed, stream_id)
    cum_hi: list[int] = []
    acc = 0
    for c in counts:
        acc += c
        cum_hi.append(acc)

    out: list[str] = []
    slot_by_row: dict[int, int] = {}
    for i in range(count):
        slot = permute.permute(i, count, layout_key)
        slot_by_row[absolute_row(run, i)] = slot
        # Binary search rather than a linear scan: a wide column (many values) would
        # otherwise make the render O(count x values).
        lo, hi = 0, len(cum_hi) - 1
        while lo < hi:
            mid = (lo + hi) // 2
            if slot < cum_hi[mid]:
                hi = mid
            else:
                lo = mid + 1
        out.append(values[lo])

    # Remembered for any child that filters on this column: which slot a row got is what
    # decides its RANK inside the parent's subset, and the streaming engine hands a child
    # exactly that rank as its position.
    if run.layouts is not None and run.stream_id is not None:
        run.layouts[run.stream_id] = ExactLayout(list(values), counts, cum_hi, slot_by_row)
    return out


def ordered_rows(spec, mask: list[bool], layouts: dict[str, ExactLayout] | None) -> list[int]:
    """The rows a sequence builds, in the order it builds them.

    For an unparented column that is simply every row. For a child it is the rows the parent
    selected, ordered by their RANK inside the parent's exact layout — which is not their row
    order. The streaming engine hands a child that rank as its position, so a parented column
    would otherwise arrange its own quota over a differently ordered subset and land every
    value on the wrong row.

    Falls back to row order when the parent kept no layout — a bare ``parent="Name"`` with no
    value, or a parent the streaming engine would refuse as a parent anyway.
    """
    applicable = rows_of(mask)
    parent = getattr(spec, "parent", None)
    if not parent or "." not in parent:
        return applicable
    name, _, value = parent.partition(".")
    plan = layouts.get(name) if layouts is not None else None
    if plan is None or value not in plan.values:
        return applicable
    vi = plan.values.index(value)
    lo = plan.cum_hi[vi] - plan.counts[vi]

    ordered: list[int | None] = [None] * len(applicable)
    for row in applicable:
        slot = plan.slot_by_row.get(row)
        if slot is None:
            return applicable
        rank = slot - lo
        if rank < 0 or rank >= len(ordered):
            return applicable
        ordered[rank] = row
    return [r for r in ordered if r is not None]
