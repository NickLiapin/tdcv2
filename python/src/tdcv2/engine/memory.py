"""The in-memory engine: materialize every column up front, then render row by row.

This is the engine the golden fixtures were captured from, so it is the one a port has to match.
The streaming engines compute a row from its index instead, and are a separate job.

The thing that decides whether output matches is not the algorithm but the ORDER THE SHARED
GENERATOR IS CONSUMED IN. Columns are built in declaration order, each drawing from one generator
seeded once. Building them in a different order, or giving each its own generator, produces
perfectly valid data that matches nothing.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from pathlib import Path

from ..compute import evaluate as compute_evaluate
from ..compute import evaluate_predicate
from ..date import gen as date_gen
from ..date.plain import to_epoch_millis
from ..distribution import hamilton, percent_mask
from ..expr import as_condition
from ..expr.match_key import match_key
from ..format import interpolate
from ..format.mask import apply_mask
from ..format.transforms import apply_case, is_case_transform
from ..generators import accumulate as accumulate_gen
from ..generators import advanced_regex, counter, imperfections, number, quantile, regex, symbol
from ..generators import date_offset as date_offset_gen
from ..generators import file as file_gen
from ..generators import formula as formula_gen
from ..generators import http as http_gen
from ..generators import repeat as repeat_gen
from ..generators import stat as stat_gen
from ..model.config import Config, Gen, Item, Line, SequenceSpec
from ..packs import DataPacks
from ..parser import config_builder
from ..pattern import gen as patterns
from ..prng import permute, rand, seekable
from ..prng.prng import Sfc32, create
from ..prng.seekable import open_unit
from ..sequence import assertions, uniq_simple
from ..sequence import pool as pool_mod
from ..sequence import uniq as uniq_lib
from ..stats import dist_params, timeseries
from ..stats import distribution as dist
from . import per_row, repeat_keyed

# How many redraws a <distinct> field gets before its source is called too small.
DISTINCT_FUSE = 100

# How many independent redraws before a uniq= config is declared genuinely impossible.
UNIQ_REDRAW_ATTEMPTS = 8

# How many redraws a <valid> constraint gets before the generator is called impossible.
VALID_FUSE = 100

# Pack bodies parse once per address and are then reused; a pack does not change mid-run.
_PACK_BODIES: dict[str, object] = {}


class EngineError(RuntimeError):
    """A run that cannot be completed — always with the number that would have worked."""


@dataclass(frozen=True, slots=True)
class Rendered:
    """A finished run: the text, and the columns it was rendered from.

    Both, because they answer different questions. A test that asserts on a field wants the
    column; a file on disk wants the text. Generating them separately would take two runs of the
    generator and could produce two different answers.
    """

    output: str
    columns: dict[str, list[str | None]]
    count: int

    def text(self) -> str:
        """The whole run as text — the same call the streaming engines answer."""
        return self.output

    def write_to(self, emit) -> None:
        emit(self.output)

    def value(self, column: str, row: int) -> str | None:
        values = self.columns.get(column)
        return None if values is None else values[row]

    def sequence_names(self) -> list[str]:
        """The declared sequences, in declaration order — not the built-in rows."""
        return [name for name in self.columns if not name.startswith("_")]


@dataclass(slots=True)
class _Run:
    """Everything the column builders need, gathered so the call sites stay readable."""

    config: Config
    packs: DataPacks
    now_millis: int
    base_dir: Path | None
    prng: Sfc32
    # Row links are shared across the whole render: two sequences naming one key must land on the
    # same rows, whichever sequence reaches it first.
    row_links: dict[str, tuple[str, list[int]]] = field(default_factory=dict)
    # The column being built, as the registry keys it — `Name`, or `Name.field` for a compound
    # field. It is the stream name the per-row derivation hashes, and it must be the SAME string
    # the streaming engine passes, or the two key their randomness differently.
    stream_id: str | None = None
    #: The column this build belongs to, when the caller is a one-row resolver with no
    #: ``stream_id`` of its own to lend. Only a pack generator reads it: its body is seeded from
    #: the column's identity. Carried under its own name rather than as ``stream_id``, because
    #: setting that on a one-row run switches on every whole-column layout inside it — measured,
    #: a ``<distinct>`` redraw changed its answer, and ``<distinct>`` has nothing to do with packs.
    column_stream_id: str | None = None
    # The ABSOLUTE row each drawn position belongs to, when the column does not cover every row.
    # See `per_row.for_stream` for why a parented column needs it.
    rows: list[int] | None = None
    # The exact layout each finished column got, by column name. Shared by reference across every
    # derived run, so a column declared later can see one built earlier.
    layouts: dict[str, per_row.ExactLayout] | None = None
    # A finished column's value at an ABSOLUTE row — what a `<switch>` inside a `<case>` looks
    # its subject up in. A nested switch is not a column and never reaches the registry, so it
    # cannot be resolved the way the env-level form is.
    value_at: Callable[[str, int], str | None] | None = None
    #: This build is ONE ROW of a bigger one. Set by every caller that narrows to a single row on
    #: purpose — the per-row loop below, one element of a repeat list, a redraw, a pack body built
    #: for one row — and by the streaming engine on its own one-row runs. Two things read it:
    #: the per-row loop, which must not re-enter itself, and anything that is only correct across
    #: a whole column, which must refuse rather than plan a quota over a single row.
    per_row: bool = False


def render(config: Config, packs: DataPacks, now_millis: int, base_dir: Path | None = None) -> str:
    return build(config, packs, now_millis, base_dir).output


def build(
    config: Config,
    packs: DataPacks,
    now_millis: int,
    base_dir: Path | None = None,
    on_progress=None,
) -> Rendered:
    count = config.count
    columns = _build_columns(config, count, packs, now_millis, base_dir)

    # The run is finished; now the config gets to check its own output — before a single line
    # is written, because a file that exists is a file someone will use.
    assertions.check(
        config.asserts,
        config.sequences,
        lambda name, row: columns[name][row] if name in columns else None,
        lambda name: name in columns,
        count,
    )

    each_info = _each_info(config)
    fx = config.fixtures
    out: list[str] = []
    _emit(out, fx.before, columns, 0, config.inject)

    # About one report per half-percent: cheap enough to leave on always.
    report_every = max(1, count // 200)
    for row in range(count):
        if on_progress is not None and row % report_every == 0:
            on_progress("render", row, count)
        _emit(out, fx.before_block, columns, row, config.inject)

        # The suppressed lines are dropped first. A delimiter belongs between the lines that
        # SURVIVE, so deciding that up front is what keeps a separator off the last one standing.
        active = [
            line
            for line in config.block
            if line.if_expr is None or _condition(line.if_expr, columns, row)
        ]
        # The OUTPUT lines, not the <line> ELEMENTS. One `<line each="Items">` produces as many
        # output lines as the list has elements, and the three per-line fixtures are documented
        # as wrapping "the lines of a record" — so they have to see what the reader sees. They
        # used to see the elements, and <delimiter_line> between the repetitions of an each= line
        # therefore did nothing at all: no comma between the members of an array, in silence.
        emitted: list[str] = []
        for line in active:
            emitted.extend(_render_line(line, columns, row, config.inject, each_info))
        for i, text in enumerate(emitted):
            _emit(out, fx.before_line, columns, row, config.inject)
            out.append(text)
            _emit(out, fx.after_line, columns, row, config.inject)
            if i < len(emitted) - 1:
                _emit(out, fx.delimiter_line, columns, row, config.inject)

        _emit(out, fx.after_block, columns, row, config.inject)
        if row < count - 1:
            _emit(out, fx.delimiter_block, columns, row, config.inject)

    _emit(out, fx.after, columns, count - 1, config.inject)
    # Said at the end as well as along the way: a phase a watcher sees CLOSE is a phase it
    # can tell from a stall. The sweep above reports every half-percent and so stops short.
    if on_progress is not None:
        on_progress("render", count, count)
    return Rendered("".join(out), columns, count)


def _emit(out: list[str], lines: list[Line], columns, row: int, inject: str) -> None:
    for line in lines:
        # A fixture line is one output line; extend rather than append, because _render_line
        # hands back the LINES now and a two-line fixture must not come out joined.
        out.extend(_render_line(line, columns, row, inject, {}))


def _each_info(config: Config) -> dict[str, repeat_gen.Spec]:
    """The repeating sequences, by name. A name that is not here is not a list."""
    out: dict[str, repeat_gen.Spec] = {}
    for spec in config.sequences:
        if spec.gen is None:
            continue
        parsed = repeat_gen.parse(spec.gen.attrs)
        if parsed is not None and spec.name:
            out[spec.name] = parsed
    return out


# ── pools ───────────────────────────────────────────────────────────────────────────────────


def build_pool_tables(
    config: Config, packs: DataPacks, now_millis: int, base_dir: Path | None
) -> dict[str, pool_mod.PoolTable]:
    """Compute every ``<pool>`` declared in the config, once, before any row exists.

    A pool is built by the ORDINARY column machinery with ``count`` set to the member count
    instead of the row count — which is the whole reason a ``<uniq>``, a ``<mix>``, an ``if=`` or
    a ``parent=`` inside a pool behaves exactly as it does outside one, with nothing here to make
    it so.
    """
    tables: dict[str, pool_mod.PoolTable] = {}
    for spec in config.pools:
        if not spec.name or spec.count < 1:
            continue  # the validator already said so
        inner = replace(
            config,
            count=spec.count,
            seed=pool_mod.pool_seed(config.seed, spec.name),
            sequences=spec.sequences,
            env_uniq_groups=spec.uniq_groups,
            env_distinct_groups=spec.distinct_groups,
            pools=[],
        )
        # The pools already built — so a MEMBER can reference one, exactly as a row does.
        # Declaration order is the whole cycle check: a pool sees only the pools above it.
        built = _build_columns(inner, spec.count, packs, now_millis, base_dir, tables)
        fields: list[str] = []
        columns: dict[str, list[str]] = {}
        for member in spec.sequences:
            # A member that references another pool publishes ONLY `name.field` — a record has
            # no value of its own — which is why this matches the dotted keys too.
            for key, values in built.items():
                if key != member.name and not key.startswith(f"{member.name}."):
                    continue
                fields.append(key)
                columns[key] = [v or "" for v in values]
        tables[spec.name] = pool_mod.PoolTable(spec.name, spec.count, fields, columns)
    return tables


def _running(spec: SequenceSpec, columns: dict[str, list[str | None]], count: int) -> None:
    """Publish a running total.

    Reads its source out of the columns rather than drawing anything: a running total
    consumes no randomness at all, which is why adding one leaves every other column
    exactly where it was.
    """
    attrs = spec.gen.attrs if spec.gen is not None else {}
    source = columns.get((attrs.get("of") or "").strip())
    op = accumulate_gen.read(attrs)
    if source is None or op is None:
        return  # the validator reports both

    reset_name = (attrs.get("reset") or "").strip()
    reset_at = columns.get(reset_name) if reset_name else None
    base = (attrs.get("base") or "").strip() or None
    columns[spec.name or ""] = accumulate_gen.apply_column(source[:count], op, base, reset_at)


def _stat(spec: SequenceSpec, columns: dict[str, list[str | None]], count: int) -> None:
    """Publish a statistic over the whole run: ONE value, on every row.

    Reads its source out of the columns rather than drawing anything, exactly as a running total
    does — which is why adding one leaves every other column where it was.
    """
    attrs = spec.gen.attrs if spec.gen is not None else {}
    source = columns.get((attrs.get("of") or "").strip())
    op = stat_gen.read_op(attrs)
    if source is None or op is None:
        return  # the validator reports both
    try:
        decimals = stat_gen.parse_decimals(attrs)
    except stat_gen.StatError:
        return  # a bad decimals= is a diagnostic, not a crash

    answer = stat_gen.statistic(source[:count], op, decimals)
    columns[spec.name or ""] = [answer] * count


def _ref_candidates(
    expression: str,
    equality: tuple[str, str] | None,
    buckets: dict[str, list[int]] | None,
    pool_name: str,
    table: pool_mod.PoolTable,
    columns: dict[str, list[str | None]],
    count: int,
    row: int,
) -> list[int]:
    """The members row ``row`` may draw from: all of them, or what a ``filter=`` leaves.

    Its own function because three callers need the same answer — the reference itself, and a
    config-level ``<distinct>`` or ``<uniq>`` deciding which member each of its references may
    still take. The group draws again from what this returns MINUS what the row has already
    given away, which is why the set matters and not just the pick.
    """
    if not expression:
        return list(range(table.count))
    if equality and buckets is not None:
        wanted = (columns.get(equality[1]) or [None] * count)[row] or ""
        eligible = buckets.get(match_key(wanted), [])
        detail = f' ({equality[1]}="{wanted}")'
    else:
        read: dict[str, str] = {}
        eligible = pool_mod.eligible_members(
            expression,
            table,
            lambda n, r=row: (columns[n][r] or "") if n in columns else None,
            read,
        )
        detail = pool_mod.row_values_detail(read)
    if not eligible:
        raise ValueError(pool_mod.no_candidate_message(pool_name, expression, row, detail))
    return eligible


def _draw_member(seed: str, ref_name: str, candidates: list[int], row: int, attempt: int) -> int:
    """Draw one of ``candidates`` for ``row``, on the reference's own stream.

    Attempt 0 is the plain stream, so a reference in no group produces exactly what it always
    did. A repair draw is a NEW stream named for the attempt. Both names are part of the
    cross-language contract.
    """
    stream = (
        pool_mod.ref_stream(ref_name)
        if attempt == 0
        else f"{pool_mod.ref_stream(ref_name)}#ed{attempt}"
    )
    slot = seekable.next_int(seed, stream, row, len(candidates))
    return candidates[slot] if slot < len(candidates) else 0


class _GroupRef:
    """What one reference in a group needs to answer for itself, gathered once."""

    __slots__ = ("buckets", "equality", "expression", "mask", "name", "pool", "table")

    def __init__(self, name, pool, table, expression, equality, buckets, mask):
        self.name = name
        self.pool = pool
        self.table = table
        self.expression = expression
        self.equality = equality
        self.buckets = buckets
        self.mask = mask


def _group_refs(group, config, columns, count, tables) -> list[_GroupRef]:
    """The references a config-level group holds, or nothing when it holds fewer than two."""
    refs: list[_GroupRef] = []
    for name in group:
        spec = next((s for s in config.sequences if s.name == name), None)
        if spec is None or spec.gen is None or spec.gen.type != "pool":
            continue
        pool_name = (spec.gen.attrs.get("value") or "").strip()
        table = tables.get(pool_name)
        if table is None or table.count < 1:
            continue
        expression = (spec.gen.attrs.get("filter") or "").strip()
        equality = (
            None
            if not expression
            else pool_mod.parse_equality_filter(expression, table, lambda n: n in columns)
        )
        buckets = pool_mod.bucket_by_field(table, equality[0]) if equality else None
        refs.append(
            _GroupRef(
                name,
                pool_name,
                table,
                expression,
                equality,
                buckets,
                _parent_mask(spec, columns, count),
            )
        )
    return refs if len(refs) >= 2 else []


def _pool_distinct_picks(refs, columns, count, seed) -> dict[str, list[int]]:
    """``<distinct>`` around two or more references to the same pool.

    A record has no value of its own to compare — ``${{Doctor}}`` is not a string — so the group
    keeps its promise by IDENTITY: no two of its references hand one row the same member.
    Settled here, while the members are being picked, rather than on the finished columns: a
    column declared after the group must read the repaired value, not the one about to collide.

    A collision is not retried blindly. The candidate set is known, so the member is drawn again
    from the candidates this row has not already given away.
    """
    out = {r.name: [-1] * count for r in refs}
    for row in range(count):
        taken: list[int] = []
        for r in refs:
            # A row this reference does not cover prints nothing, so it takes nothing:
            # counting it would let an absent column narrow a present one.
            if not r.mask[row]:
                continue
            candidates = _ref_candidates(
                r.expression, r.equality, r.buckets, r.pool, r.table, columns, count, row
            )
            pick = _draw_member(seed, r.name, candidates, row, 0)
            if pick in taken:
                free = [m for m in candidates if m not in taken]
                if not free:
                    raise EngineError(
                        f"<distinct> across sequences: row {row} has no member left for "
                        f'"{r.name}" — the sequences in this group have taken every candidate '
                        f"the pool offers. A group of {len(refs)} references needs "
                        f"{len(refs)} members to choose from."
                    )
                pick = _draw_member(seed, r.name, free, row, 1)
            taken.append(pick)
            out[r.name][row] = pick
    return out


def _pool_uniq_picks(refs, columns, count, seed) -> dict[str, list[int]]:
    """``<uniq>`` around two or more references to the same pool.

    One axis further out than ``<distinct>``: no two ROWS take the same combination of members.
    Kept by rearranging the sequence of picks rather than redrawing, so every reference keeps
    its multiset — and the fields follow for free, because a field is a pure function of the
    member. A row that receives another row's pick receives that member whole.
    """
    plain: dict[str, list[int]] = {}
    for r in refs:
        column = [-1] * count
        for row in range(count):
            if not r.mask[row]:
                continue
            candidates = _ref_candidates(
                r.expression, r.equality, r.buckets, r.pool, r.table, columns, count, row
            )
            column[row] = _draw_member(seed, r.name, candidates, row, 0)
        plain[r.name] = column

    # Only rows every reference covers carry a combination to keep unique.
    rows = [i for i in range(count) if all(plain[r.name][i] >= 0 for r in refs)]
    if not rows:
        return plain

    picked = [[str(plain[r.name][i]) for i in rows] for r in refs]
    arranged = uniq_lib.arrange(picked)
    if arranged.distinct < len(rows):
        label = " × ".join(r.name for r in refs)
        raise EngineError(_uniq_group_message(label, len(rows), arranged.distinct))
    for m, r in enumerate(refs):
        for k, row in enumerate(rows):
            plain[r.name][row] = int(arranged.columns[m][k])
    return plain


def _pool_reference(
    spec: SequenceSpec,
    columns: dict[str, list[str | None]],
    mask: list[bool],
    count: int,
    tables: dict[str, pool_mod.PoolTable],
    seed: str,
    config: Config | None = None,
    group_picks: dict[str, list[int]] | None = None,
) -> None:
    """Publish one member of a pool per row, under ``Ref.field`` for every field it has.

    One pick per ROW, shared by every field: that is what makes the first name and the last name
    in a row belong to the same doctor. Not one pick per field, which is exactly how
    "Дмитрий Иванова" would get out.
    """
    name = spec.name or ""
    pool_name = (spec.gen.attrs.get("value") or "").strip()
    table = tables.get(pool_name)
    if table is None or table.count < 1:
        return  # unknown pool — the validator reports it

    expression = (spec.gen.attrs.get("filter") or "").strip()
    equality = (
        None
        if not expression
        else pool_mod.parse_equality_filter(expression, table, lambda n: n in columns)
    )
    buckets = pool_mod.bucket_by_field(table, equality[0]) if equality else None

    # A `<distinct>` or `<uniq>` around this reference decides its picks, and decides them for
    # the whole group at once — a later member needs the ones before it, and a pick is not a
    # column anybody could read back.
    if config is not None and group_picks is not None and name not in group_picks:
        for groups, is_uniq in (
            (config.env_distinct_groups, False),
            (config.env_uniq_groups, True),
        ):
            for group in groups:
                if name not in group:
                    continue
                refs = _group_refs(group, config, columns, count, tables)
                if not refs:
                    continue
                settled = (
                    _pool_uniq_picks(refs, columns, count, seed)
                    if is_uniq
                    else _pool_distinct_picks(refs, columns, count, seed)
                )
                group_picks.update(settled)

    if group_picks is not None and name in group_picks:
        members = list(group_picks[name])
        for field_name in table.fields:
            column = table.columns.get(field_name, [])
            columns[f"{name}.{field_name}"] = [
                None if m < 0 else (column[m] if m < len(column) else "") for m in members
            ]
        return

    members = []
    for row in range(count):
        if not mask[row]:
            members.append(-1)
            continue
        eligible = _ref_candidates(
            expression, equality, buckets, pool_name, table, columns, count, row
        )
        members.append(_draw_member(seed, name, eligible, row, 0))

    for field_name in table.fields:
        column = table.columns.get(field_name, [])
        columns[f"{name}.{field_name}"] = [
            None if m < 0 else (column[m] if m < len(column) else "") for m in members
        ]


# ── columns ─────────────────────────────────────────────────────────────────────────────────


def _build_columns(
    config: Config,
    count: int,
    packs: DataPacks,
    now_millis: int,
    base_dir: Path | None,
    pool_tables: dict[str, pool_mod.PoolTable] | None = None,
) -> dict[str, list[str | None]]:
    """Every column materialized.

    A value of ``None`` means "this row is outside the column's parent filter", which renders as
    empty rather than as a neighbour's value shifted up.
    """
    # Before a single row exists: can the uniq groups cover `count` at all? The post-build check
    # asks the same question over the finished columns, which means reaching it costs the
    # allocation this refusal is meant to save.
    check_env_uniq_capacity(config, count)

    columns: dict[str, list[str | None]] = {}
    # A config-level group over pool references settles every one of its members at once,
    # the first time any of them is reached: a later member needs the picks of the ones
    # before it, and a pick is not a column to read back.
    pool_group_picks: dict[str, list[int]] = {}
    # The REAL value behind a date column's text, for the columns some offset measures from.
    #
    # A date cell holds a PRESENTATION: `02/03/2026` in an en locale, `03.02.2026` in a ru one,
    # `March 2` under format="MMMM D". Reading a date back out of that is guesswork at best and
    # impossible at worst — the last form has thrown the year away. So the column that produced
    # it keeps what it actually generated, and an offset measures from THAT. Only the columns
    # named by some `of=` are kept, so a config with no offset in it pays nothing.
    instants: dict[str, list[int | None]] = {}
    wants_instant = {
        date_offset_gen.source_of(spec.gen.attrs)
        for spec in config.sequences
        if date_offset_gen.is_offset(spec.gen)
    }

    # The built-ins first. They are positional, consume no randomness, and are therefore
    # identical for a given count no matter what else the config does.
    columns["_count"] = [str(i + 1) for i in range(count)]
    columns["_first"] = ["true" if i == 0 else "false" for i in range(count)]
    columns["_last"] = ["true" if i == count - 1 else "false" for i in range(count)]
    columns["_total"] = [str(count)] * count

    def _column_value_at(name: str, row: int) -> str | None:
        # Read lazily, so a nested <switch> sees the subject column whatever order the
        # registry filled up in — the validator has already checked it is declared first.
        column = columns.get(name)
        return None if column is None or row >= len(column) else column[row]

    run = _Run(
        config,
        packs,
        now_millis,
        base_dir,
        create(config.seed),
        layouts={},
        value_at=_column_value_at,
    )

    # Pools first, and off a DERIVED seed. A pool must be invisible to every column it does not
    # feed: adding one to a config leaves the ids, the ages and the names exactly where they
    # were, so an old snapshot still matches.
    tables = (
        pool_tables
        if pool_tables is not None
        else build_pool_tables(config, packs, now_millis, base_dir)
    )

    for spec in config.sequences:
        mask = _parent_mask(spec, columns, count)
        # In the order the column BUILDS them, which for a child is its rank inside the
        # parent's exact layout rather than plain row order.
        rows = per_row.ordered_rows(spec, mask, run.layouts)
        applicable = len(rows)

        # A reference to a <pool>: this row gets one member, and every field of that member is
        # published under `Ref.field`. Resolved HERE, in declaration order, so a later
        # `<switch on="Doc.city">` finds the field already registered.
        if spec.gen is not None and spec.gen.type == "pool":
            _pool_reference(
                spec, columns, mask, count, tables, config.seed, config, pool_group_picks
            )
            continue

        # A running total down a column. Resolved HERE, in declaration order, so it reads a
        # column that already exists — which is also why `of=` must name a sequence above it.
        if spec.gen is not None and spec.gen.type == "running":
            _running(spec, columns, count)
            continue

        # Arithmetic over the columns beside it. Resolved here for the same reason as the two
        # below: it reads columns that already exist, so every name in `expr=` has to be
        # declared above. Unlike them it needs only its OWN row, which is why it also streams.
        if spec.gen is not None and spec.gen.type == "formula":
            # `prev()` may look back one row only when the rows are computed in order,
            # which is what `mode="sequential"` promises and the streaming engines cannot.
            _formula(spec, columns, count, config.mode == "sequential")
            continue

        # A statistic over the whole run. Resolved here for the same reason and by the same
        # rule: it reads a column that already exists, so `of=` has to name a sequence above it.
        if spec.gen is not None and spec.gen.type == "stat":
            _stat(spec, columns, count)
            continue

        # A date measured from another date. Resolved here for the same reason: it reads a
        # column that already exists, so `of=` has to name a sequence above it.
        if date_offset_gen.is_offset(spec.gen):
            name = spec.name or ""
            source = columns.get(date_offset_gen.source_of(spec.gen.attrs))
            if source is not None:
                values, own = date_offset_gen.build(
                    name,
                    spec.gen.attrs,
                    source,
                    instants.get(date_offset_gen.source_of(spec.gen.attrs)),
                    count,
                    run.prng,
                    config.locale,
                    name in wants_instant,
                )
                columns[name] = values
                if own is not None:
                    instants[name] = own
            continue

        if spec.is_composed:
            _composed(spec, columns, rows, applicable, count, run)
            continue

        if spec.is_compound:
            _compound(spec, columns, rows, applicable, count, run)
            continue
        if spec.is_mix:
            _mix_column(spec, columns, rows, applicable, count, run)
            continue
        if spec.is_switch:
            columns[spec.name or ""] = _switch_values(
                spec.switch_spec, count, run, columns, spec.name or ""
            )
            continue
        if spec.is_computed:
            # Derived, not drawn: no PRNG at all. A check digit is a function of the values
            # already in the row, so it takes nothing from the stream and adding one shifts
            # nothing.
            columns[spec.name or ""] = [
                compute_evaluate(spec.compute, _row_lookup(columns, row)) for row in range(count)
            ]
            continue
        if spec.is_conditional:
            # Over every row, and without the parent mask — matching the reference. A conditional
            # already says which rows it applies to through its own conditions, so parent= on one
            # has nothing left to decide.
            columns[spec.name or ""] = _conditional(spec, count, run, columns)
            continue

        assert spec.gen is not None
        if spec.gen.type == "template" and "${{" in spec.gen.attr("value"):
            # `common.vehicle.model.${{Brand}}` — the pack to draw from is decided by another
            # column, so the address is not known until the row is. Built here rather than in the
            # generator, because this is the only place the sibling columns exist.
            columns[spec.name or ""] = _spread(
                rows, _dynamic_template(spec.gen, rows, columns, run), count
            )
            continue

        if spec.uniq and spec.gen.type not in ("increment", "decrement"):
            # A single column cannot be both proportional and unique, so — unlike
            # the compound path, which only rearranges — uniq changes the draw:
            # without replacement, one PRNG draw per pick (sequence/uniq_simple.py).
            produced = (
                []
                if applicable == 0
                else uniq_simple.build_unique_values(spec.name or "", spec.gen, applicable, run)
            )
            columns[spec.name or ""] = _spread(rows, produced, count)
            continue

        _plain_column(
            spec,
            columns,
            rows,
            applicable,
            count,
            run,
            instants,
            (spec.name or "") in wants_instant,
        )

    _enforce_env_distinct(config, columns, count, run)
    _enforce_env_uniq(config, columns, count)
    _resolve_http(config, columns, count, base_dir)
    return columns


def composes_own_value(items: list[Item]) -> bool:
    """Whether a composed body builds a value of its own.

    A body of nothing but named items — fields and constants — has none, and ``${{Name}}`` stays
    the literal marker that says you meant a field.
    """
    return any(
        item.constant_name is None and (item.gen is not None or item.text is not None)
        for item in items
    )


def _composed(
    spec: SequenceSpec,
    columns,
    rows: list[int],
    applicable: int,
    count: int,
    run: _Run,
) -> None:
    """The body in declaration order: unnamed items build the value, named ones are fields.

    One pass, because the order the gens draw in is part of the contract and taking the named ones
    first would shift every column after this sequence.
    """
    assert spec.items is not None
    composed = [""] * applicable
    produced: dict[str, list[str]] = {}

    # `uniq="true"` on a composed value. The value is a concatenation, so it is unique exactly
    # when the join is injective — true when ONE part is drawn and the rest are constants, since
    # appending a constant cannot make two different draws collide. Two drawn parts is the
    # variable-width trap and the validator refuses it (TDC220), so this stays None there.
    drawn_parts = [i for i in spec.items if i.gen is not None and i.field is None]
    uniq_part = drawn_parts[0] if spec.uniq and len(drawn_parts) == 1 else None

    # The stream names must be the ones the streaming engine gives the same body: a named field
    # is `Name.field`, an unnamed part is `Name#pN` counted among the unnamed ones only.
    # Numbering them any other way keys the same cell differently in the two engines.
    unnamed = 0

    for item in spec.items:
        if item.constant_name is not None:
            # A constant costs no draw at all — that is the whole reason it exists rather than a
            # one-value generator.
            produced[item.constant_name] = [item.text or ""] * applicable
            continue
        if item.text is not None:
            for i in range(applicable):
                composed[i] += item.text
            continue
        gen = item.field.gen if item.field is not None else item.gen
        assert gen is not None
        if item.field is not None:
            part_id = f"{spec.name}.{item.field.name}"
        else:
            part_id = f"{spec.name}#p{unnamed}"
            unnamed += 1
        part_run = per_row.with_rows(run, part_id, rows)
        if applicable == 0:
            values: list[str] = []
        elif item is uniq_part:
            values = uniq_simple.build_unique_values(spec.name or "", gen, applicable, run)
        else:
            values = _column_values(gen, applicable, part_run)
        if item.field is not None:
            produced[item.field.name] = values
            continue
        for i in range(applicable):
            composed[i] += values[i]

    if applicable > 0 and spec.distinct_groups is not None:
        # The groups name FIELDS, and a composed body carries its fields in `items` — so the
        # constraint is checked against a spec that spells them out.
        fields = [item.field for item in spec.items if item.field is not None]
        _enforce_distinct(replace(spec, fields=fields), produced, applicable, run, rows)

    if composes_own_value(spec.items):
        columns[spec.name] = _spread(rows, composed, count)
    for field_name, values in produced.items():
        columns[f"{spec.name}.{field_name}"] = _spread(rows, values, count)


def _compound(
    spec: SequenceSpec,
    columns,
    rows: list[int],
    applicable: int,
    count: int,
    run: _Run,
) -> None:
    """Every field shares the parent mask and draws from the shared stream in declaration order.

    That is what keeps a compound coherent: the city and the postcode of one generated address
    belong to the same row, not to two independent ones.
    """
    assert spec.fields is not None
    produced: dict[str, list[str]] = {}
    for f in spec.fields:
        field_run = per_row.with_rows(run, f"{spec.name}.{f.name}", rows)
        produced[f.name] = [] if applicable == 0 else _column_values(f.gen, applicable, field_run)

    if applicable > 0 and spec.distinct_groups is not None:
        _enforce_distinct(spec, produced, applicable, run, rows)
    if applicable > 0 and spec.uniq:
        _enforce_uniq(spec, produced, applicable, run)

    for f in spec.fields:
        columns[f"{spec.name}.{f.name}"] = _spread(rows, produced[f.name], count)


def _mix_column(
    spec: SequenceSpec,
    columns,
    rows: list[int],
    applicable: int,
    count: int,
    run: _Run,
) -> None:
    assert spec.mix is not None
    flags = [False] * applicable
    # The '#switch' suffix is a stable historical PRNG key — the streaming engine uses it
    # verbatim so a <mix> keeps the values of the <switch> it replaced. Both must spell it the
    # same way.
    mix_run = per_row.with_rows(run, f"{spec.name}#switch", rows)
    produced = [] if applicable == 0 else _mix_values(spec.mix, applicable, mix_run, flags)
    columns[spec.name or ""] = _spread(rows, produced, count)

    flag_name = spec.mix.flag
    if flag_name and flag_name.strip():
        # The ground-truth companion: which rows took a case declared anomalous. It shares the
        # parent mask, so the label is absent exactly where the value is.
        columns[flag_name] = _spread(rows, [str(on).lower() for on in flags], count)


def _plain_column(
    spec: SequenceSpec,
    columns,
    rows: list[int],
    applicable: int,
    count: int,
    run: _Run,
    instants: dict[str, list[int | None]] | None = None,
    keep_instants: bool = False,
) -> None:
    assert spec.gen is not None
    anomaly_flags = [False] * applicable
    # A column some `<gen type="date" of="…">` measures from keeps the instant it generated
    # beside the text it renders. Nothing else asks, so nothing else allocates.
    instants_out: list[int | None] | None = (
        [] if keep_instants and instants is not None and spec.gen.type == "date" else None
    )
    repeat = repeat_gen.parse(spec.gen.attrs)
    run = per_row.with_rows(run, spec.name or "", rows)

    key_pair = per_row.keyed(run)
    flag_name = spec.gen.attrs.get("anomaly_flag")
    repeat_flags: list[str] | None = (
        [] if repeat is not None and flag_name and flag_name.strip() else None
    )

    if applicable == 0:
        produced: list[str] = []
    elif repeat is not None and key_pair is not None:
        seed, stream_id = key_pair
        # A listed column lays every element of every row out at once and reads the slots the
        # length plan gave the row; anything drawn takes one sub-stream per element. Which of
        # the two is the streaming engine's own split.
        listed = per_row.listed_values(spec.gen, run)
        if listed is not None:
            values, percents = listed
            produced = repeat_keyed.build_layout(
                repeat,
                values,
                percents,
                applicable,
                run,
                seed,
                stream_id,
                _element_modifier(spec.gen, repeat, seed, stream_id),
            )
        else:
            produced = repeat_keyed.build_draws(
                repeat,
                applicable,
                run,
                seed,
                stream_id,
                _generate,
                _finish,
                repeat_flags,
                gen=spec.gen,
            )
    elif repeat is not None:
        # The per-value passes run inside, on the flat slot buffer, so anomaly, missing and
        # formatting come out per element of the list rather than over the joined cell.
        produced = repeat_gen.build(
            repeat,
            applicable,
            run.prng,
            lambda slots: _finish(
                _generate(spec.gen, slots, run), spec.gen.attrs, run.prng, [False] * slots
            ),
        )
    else:
        produced = _column_values(spec.gen, applicable, run, anomaly_flags, instants_out)

    columns[spec.name or ""] = _spread(rows, produced, count)
    # Attach the instants only if the build actually filled them for every row. A sink that was
    # asked for and left empty is NOT "this column has no date on any row" — it is "this build
    # never wrote one", and the two answers are opposite. Refusing to attach gives the text
    # reading, which either works or names the problem out loud.
    if instants_out is not None and instants is not None and len(instants_out) == applicable:
        # Laid over the real rows exactly as the values are: a filtered column builds compacted
        # and is spread afterwards, so the two must be spread the same way or an offset would
        # measure row 3 from row 1's date.
        spread: list[int | None] = [None] * count
        for i, row in enumerate(rows):
            spread[row] = instants_out[i] if i < len(instants_out) else None
        instants[spec.name or ""] = spread

    if flag_name and flag_name.strip():
        # Which rows the run chose to spike. It shares the parent mask, so the label is absent on
        # exactly the rows the value is absent from — a detector trained on this cannot learn
        # from a label the data never had. With `repeat` the label is a LIST parallel to the
        # values, saying which element spiked rather than merely that one did.
        labels = (
            repeat_flags if repeat_flags is not None else [str(on).lower() for on in anomaly_flags]
        )
        columns[flag_name] = _spread(rows, labels, count)


def _element_modifier(gen: Gen, spec, seed: str, stream_id: str):
    """``anomaly=``, ``missing=`` and the formatting layer for ONE element of a repeating
    listed column.

    The two probability draws come off the row's ``#anom`` and ``#miss`` streams with a budget
    of the row's maximum length, so element k always gets the same uniform however long its
    row turned out to be.
    """
    anomaly = imperfections.parse_anomaly(gen.attrs)
    missing = imperfections.parse_missing(gen.attrs)
    mask_attr = gen.attrs.get("mask")
    case_name = gen.attrs.get("case")
    has_anomaly = anomaly is not None and anomaly.probability > 0
    has_missing = missing is not None and missing.probability > 0
    has_format = mask_attr is not None or (case_name is not None and is_case_transform(case_name))
    if not has_anomaly and not has_missing and not has_format:
        return None

    anom_at = (
        repeat_keyed.element_uniforms(seed, stream_id, "#anom", spec.max) if has_anomaly else None
    )
    miss_at = (
        repeat_keyed.element_uniforms(seed, stream_id, "#miss", spec.max) if has_missing else None
    )

    def modify(row: int, value: str, k: int) -> str:
        out = value
        if anomaly is not None and anom_at is not None and anom_at(row, k) < anomaly.probability:
            out = imperfections.spike(out, anomaly.factor)
        if missing is not None and miss_at is not None and miss_at(row, k) < missing.probability:
            out = missing.token
        if mask_attr is not None:
            out = apply_mask(mask_attr, out)
        if case_name is not None and is_case_transform(case_name):
            out = apply_case(case_name, out)
        return out

    return modify


def _parent_mask(spec: SequenceSpec, columns, count: int) -> list[bool]:
    """Which rows a column applies to."""
    if spec.parent is None:
        return [True] * count
    dot = spec.parent.find(".")
    parent_name = spec.parent if dot < 0 else spec.parent[:dot]
    parent_value = None if dot < 0 else spec.parent[dot + 1 :]

    parent = columns.get(parent_name)
    if parent is None:
        raise EngineError(
            f'sequence "{spec.name}" references unknown parent "{parent_name}". '
            "Parent sequences must be declared before their children."
        )
    if parent_value is None:
        return [parent[i] is not None for i in range(count)]
    return [parent[i] == parent_value for i in range(count)]


def _dynamic_template(gen: Gen, rows: list[int], columns, run: _Run) -> list[str]:
    """A template whose address names another column.

    The row decides where its value comes from: a car's model list depends on its make, a
    region's cities on its country. That is the difference between data that is merely plausible
    per column and data that holds together across a record.

    One row at a time, necessarily — the address changes with it — and only on the rows the parent
    selected, so a filtered-out row draws nothing rather than drawing from whatever address an
    empty interpolation happens to produce.
    """
    template = gen.attr("value")
    locale = gen.attrs.get("local") or run.config.locale

    out: list[str] = []
    for row in rows:
        address = interpolate.apply(template, run.config.inject, _row_lookup(columns, row))
        weighted = _dynamic_weighted_values(address, locale, run)
        if weighted is not None:
            out.append(_weighted_pick(run.prng, *weighted))
            continue
        resolved = Gen("template", {**gen.attrs, "value": address, "local": locale})
        built = _generate(resolved, 1, replace(run, per_row=True))
        out.append(built[0] if built else "")
    return out


def _dynamic_weighted_values(
    address: str, locale: str, run: _Run
) -> tuple[list[str], list[float]] | None:
    """The values and shares of a WEIGHTED list pack, or ``None`` when this is not one.

    A weighted pack keeps its weights behind an interpolated address. The address is not known
    until the row is, so there is no column to lay an exact quota over — but the shares are
    still the shares, and a per-row draw can honour them. Sent through the generic build at a
    count of ONE it went the other way entirely: the exact layout planned a single slot and gave
    it to the heaviest value, so `person.${{Sex}}.firstName` was `Mary` and `James` on every
    row, on 389 shipped packs that declare `weighted: true`, while the SAME file read by a fixed
    address was exact to the row.
    """
    try:
        if not run.packs.exists(address, locale):
            return None
        entry = run.packs.load(address, locale)
    except (ValueError, OSError):
        return None
    if entry.is_generator or not entry.weighted or not entry.percents:
        return None
    return list(entry.values), list(entry.percents)


def _weighted_pick(prng, values: list[str], percents: list[float]) -> str:
    """One value from a weighted list, on ONE draw.

    A running subtraction rather than a cumulative table: the same arithmetic in the same order
    in all five implementations, so one seed gives one row everywhere. Shares that sum to zero
    fall back to a uniform pick rather than to the last value.
    """
    total = 0.0
    for p in percents:
        total += p
    if not total > 0:
        return values[int(prng.next() * len(values))] if values else ""
    r = prng.next() * total
    for i, value in enumerate(values):
        r -= percents[i]
        if r < 0:
            return value
    return values[-1] if values else ""


def _spread(rows: list[int], produced: list[str], count: int) -> list[str | None]:
    """Dense produced values laid back over the full row range, filtered rows left absent.

    Placed by the ROW LIST rather than by walking a mask, because a child does not build its
    rows in row order: its position inside the parent's subset is its RANK in the parent's
    exact layout. See ``per_row.ordered_rows``.
    """
    values: list[str | None] = [None] * count
    for i, row in enumerate(rows):
        values[row] = produced[i] if i < len(produced) else None
    return values


# ── the passes that run over a finished column ──────────────────────────────────────────────


def _finish(
    values: list[str],
    attrs: dict[str, str],
    prng: Sfc32,
    anomaly_flags: list[bool],
    run: _Run | None = None,
    gen_type: str | None = None,
    instants_out: list[int | None] | None = None,
) -> list[str]:
    """Outliers, then blanks, then formatting — and the order is the contract.

    Spiking after blanking would multiply an empty string, and formatting before either would
    format a value that is about to be replaced.

    The INLINE types never reach the per-row path — their value follows the position — so their
    two modifier draws are keyed here, on the same `#anom` and `#miss` streams the streaming
    engine uses. Every other type got there through a seekable generator already and must keep
    drawing off it in order.
    """
    out = list(values)

    keyed_inline = run is not None and gen_type in per_row.INLINE_ANOMALY_TYPES
    key_pair = per_row.keyed(run) if keyed_inline else None

    def draw_on(purpose: str):
        if key_pair is None:
            return lambda _i: prng.next()
        seed, stream_id = key_pair
        return lambda i: seekable.uniforms(
            seed, f"{stream_id}{purpose}", per_row.absolute_row(run, i), 1
        )[0]

    anomaly = imperfections.parse_anomaly(attrs)
    if anomaly is not None:
        imperfections.apply_anomaly(out, anomaly, draw_on("#anom"), anomaly_flags)
    missing = imperfections.parse_missing(attrs)
    if missing is not None:
        before = list(out)
        imperfections.apply_missing(out, missing, draw_on("#miss"))
        # A cell `missing=` blanked no longer shows the date it was built from, so the instant
        # behind it goes too — otherwise a column measuring from this one would produce a date on
        # a row whose source says nothing. `mask=`/`case=` below change only the SPELLING, which
        # is exactly what the instant outlives.
        if instants_out is not None:
            for i in range(min(len(out), len(instants_out))):
                if out[i] != before[i]:
                    instants_out[i] = None
        # And the ground-truth flag goes with it, for the same reason. `anomaly_flag` is sold as
        # the label an outlier detector is scored against, and the anomalies page promises the flag
        # and the spike "can never disagree" — but a blanked cell HAS no spike to agree with.
        if anomaly_flags is not None:
            for i in range(min(len(out), len(anomaly_flags))):
                if out[i] != before[i]:
                    anomaly_flags[i] = False

    mask = attrs.get("mask")
    if mask is not None:
        out = [apply_mask(mask, v) for v in out]
    case_name = attrs.get("case")
    if case_name is not None and is_case_transform(case_name):
        out = [apply_case(case_name, v) for v in out]
    return out


# ── mix, switch, conditional ────────────────────────────────────────────────────────────────


def _mix_values(mix, count: int, run: _Run, flags: list[bool] | None) -> list[str]:
    """A mix: the case chosen by an exact percentage layout, then that case's body assembled.

    The mirror of the streaming engine's, and deliberately so — both halves are keyed by
    ``(seed, stream_id)``, so the two engines put the same case on the same row and draw the
    same body for it.

    The thing to keep straight is which index is which. A row has three numbers here: its
    POSITION in the mix's domain, its SLOT (``permute(position)``, which the case quotas are
    cut from), and its ROW, the absolute index a per-row draw keys on. A case's body sees a
    domain of its own where position runs 0..quota-1 in SLOT order, not in row order — which
    is exactly what the streaming engine hands it.

    Grouping the rows by case BEFORE generating is what makes a nested mix mean what it says.
    The inner percentages then apply to the subset the outer case selected, so "20% of the
    readings are faulty, and half of those are out of range" comes out as ten per cent of
    everything rather than as two independent coin flips.
    """
    cases = mix.cases
    if not cases:
        return [""] * count

    if mix.percent is None or not mix.percent.strip():
        percents = [100.0 / len(cases)] * len(cases)
    else:
        percents = percent_mask.expand(mix.percent, len(cases))

    key_pair = per_row.keyed(run)
    if key_pair is None:
        # An inline mix inside a pack generator body: nothing to key by, so the older
        # arrangement stands.
        selected = hamilton.distribute(count, list(range(len(cases))), percents, run.prng)
        out = [""] * count
        if flags is not None:
            for i in range(count):
                flags[i] = cases[selected[i]].anomaly
        for c, case in enumerate(cases):
            rows = [i for i in range(count) if selected[i] == c]
            if not rows:
                continue
            values = _case_values(case, len(rows), run)
            for i, row in enumerate(rows):
                out[row] = values[i]
        return out

    seed, stream_id = key_pair
    counts = hamilton.counts_per_value(count, percents, create(f"{seed}|{stream_id}|pct"))
    layout_key = permute.key(seed, stream_id)

    # Case c owns slots [cum_lo[c], cum_lo[c] + counts[c]).
    cum_lo: list[int] = []
    acc = 0
    for c in counts:
        cum_lo.append(acc)
        acc += c

    # The permutation both ways. The streaming engine asks "which slot is this row?"; building a
    # case's body needs the reverse, "which row holds slot s?".
    slot_of = [0] * count
    position_of_slot = [0] * count
    for i in range(count):
        slot = permute.permute(i, count, layout_key)
        slot_of[i] = slot
        position_of_slot[slot] = i

    def case_of_slot(slot: int) -> int:
        for c in range(len(counts)):
            if slot < cum_lo[c] + counts[c]:
                return c
        return len(counts) - 1

    out = [""] * count
    for c, case in enumerate(cases):
        quota = counts[c]
        if quota == 0:
            continue
        lo = cum_lo[c]
        positions = [position_of_slot[lo + local] for local in range(quota)]
        rows = [per_row.absolute_row(run, p) for p in positions]
        values = _case_values(case, quota, per_row.with_rows(run, f"{stream_id}#c{c}", rows))
        for local, position in enumerate(positions):
            out[position] = values[local]

    if flags is not None:
        # The label reads the same slot->case mapping the value did, so the two cannot disagree
        # on a row — that is the point of a ground-truth column.
        for i in range(count):
            flags[i] = cases[case_of_slot(slot_of[i])].anomaly
    return out


def _case_values(case, count: int, run: _Run) -> list[str]:
    """A case body: its pieces concatenated, each built for the rows that chose this case.

    Parts are numbered among ALL of them, literals included — the streaming engine numbers
    them off the same list, and a different count here would key the same part under a
    different name.
    """
    out = [""] * count
    for p, part in enumerate(case.parts):
        part_run = run if run.stream_id is None else replace(run, stream_id=f"{run.stream_id}#p{p}")
        if part.text is not None:
            values = [part.text] * count
        elif part.gen is not None:
            values = _column_values(part.gen, count, part_run)
        elif part.mix is not None:
            values = _mix_values(part.mix, count, part_run, None)
        else:
            values = _nested_switch_values(part.switch, count, part_run)
        out = [out[i] + values[i] for i in range(count)]
    return out


def _nested_switch_values(spec, count: int, run: _Run) -> list[str]:
    """A ``<switch>`` written inside a ``<case>`` — the nested form.

    It looks its subject up over THE ROWS OF THE BRANCH IT SITS IN. ``run`` already carries
    those rows and this part's stream name, so position ``i`` here is the same cell the
    streaming engine resolves at ``absolute_row(run, i)``.

    A branch of a nested switch is never RANKED: its rows are an intersection of two
    partitions — the enclosing branch's and the inner subject's — and the streaming engines
    cannot number an intersection one row at a time. So a branch that declares a share is
    refused there, the router sends the config here, and the quota goes over the branch's own
    rows. A branch that declares none is built over the enclosing branch's rows, which is what
    the streaming engines do, so the two agree row for row.
    """
    stream_id = run.stream_id or ""
    entry_positions: list[list[int]] = [[] for _ in spec.entries]
    fallback_positions: list[int] = []
    for i in range(count):
        key = run.value_at(spec.on, per_row.absolute_row(run, i)) if run.value_at else None
        key = "" if key is None else key
        for e, entry in enumerate(spec.entries):
            if key in entry.keys:
                entry_positions[e].append(i)
                break
        else:
            fallback_positions.append(i)

    out = [""] * count

    def place(positions: list[int], case, part_id: str) -> None:
        if not positions:
            return
        if not _case_carries_percent(case):
            whole = _case_values(case, count, replace(run, stream_id=part_id))
            for i in positions:
                out[i] = whole[i]
            return
        rows = [per_row.absolute_row(run, i) for i in positions]
        values = _case_values(case, len(positions), per_row.with_rows(run, part_id, rows))
        for local, position in enumerate(positions):
            out[position] = values[local]

    for e, entry in enumerate(spec.entries):
        place(entry_positions[e], entry.value, f"{stream_id}#sw{e}")
    if spec.fallback is not None:
        place(fallback_positions, spec.fallback, f"{stream_id}#swdef")
    return out


def _switch_values(spec, count: int, run: _Run, columns, name: str) -> list[str | None]:
    """A switch: the subject's value looked up in the table.

    Built over EVERY row rather than only the matching ones, because a case may hold a generator
    and its draws are part of the stream whether or not that key came up. A row with no match and
    no default is empty — which is a value, not a failure: a country with no currency listed
    simply has none here.
    """
    # Group the rows by branch BEFORE generating, exactly as `_mix_values` does — that is what
    # makes a percentage inside a branch mean what it says. Every entry used to be built over the
    # WHOLE run and the values that landed on rows belonging to another branch were dropped, so a
    # `<mix percent="20,80">` inside `<case is="Male">` apportioned its 20% across all the rows
    # rather than across the men. Measured over 100 runs of 10 rows split 5/5: 0, 1 or 2
    # survivors, and 23 runs with none, where the config plainly asked for one man in five.
    subject = columns.get(spec.on)
    entry_positions: list[list[int]] = [[] for _ in spec.entries]
    fallback_positions: list[int] = []
    for i in range(count):
        key = "" if subject is None or subject[i] is None else subject[i]
        for e, entry in enumerate(spec.entries):
            if key in entry.keys:
                entry_positions[e].append(i)
                break
        else:
            fallback_positions.append(i)

    out: list[str | None] = [None] * count

    def place(positions: list[int], case, stream_id: str, keys: list[str] | None) -> None:
        # A branch no row chose draws nothing: a quota over zero rows is not a quota.
        if not positions:
            return
        rows = [per_row.absolute_row(run, p) for p in positions]
        order = None if keys is None else _branch_order(spec.on, keys, rows, run.layouts)
        if order is None:
            if not _case_carries_percent(case):
                # The streaming engines cannot number the rows of a multi-key branch or of
                # <default>, so they build those over the whole run and read the row they
                # want. This engine has to do the same or the two would answer differently on
                # a config neither of them refuses.
                whole = _case_values(case, count, replace(run, stream_id=stream_id))
                for position in positions:
                    out[position] = whole[position]
                return
            # It declares a share, so the streaming engines refuse it and the router sends the
            # whole config here: no other engine will ever produce this column, and it is free
            # to be exact. The quota goes over the branch's OWN rows, in row order.
            values = _case_values(case, len(positions), per_row.with_rows(run, stream_id, rows))
            for local, position in enumerate(positions):
                out[position] = values[local]
            return
        ordered = [positions[j] for j in order]
        ordered_rows = [rows[j] for j in order]
        values = _case_values(case, len(ordered), per_row.with_rows(run, stream_id, ordered_rows))
        for local, position in enumerate(ordered):
            out[position] = values[local]

    for e, entry in enumerate(spec.entries):
        place(entry_positions[e], entry.value, f"{name}#sw{e}", list(entry.keys))
    if spec.fallback is not None:
        place(fallback_positions, spec.fallback, f"{name}#swdef", None)
    return out


def _case_carries_percent(case) -> bool:
    """Does this ``<case>`` body declare a share that the denominator has to be right for?"""
    return any(
        (part.mix is not None and (part.mix.percent or "").strip() != "")
        or (part.gen is not None and part.gen.attr("percent").strip() != "")
        for part in case.parts
    )


def _branch_order(on: str, keys: list[str], rows: list[int], layouts) -> list[int] | None:
    """Where each of a branch's rows sits in the order the STREAMING engine numbers them.

    A branch keyed ``Male`` of ``<switch on="Gender">`` is the same subset as
    ``parent="Gender.Male"``, and both engines must lay a quota over it the same way. That
    order is NOT row order: it is the rank inside the subject's exact layout, which is what
    ``ordered_rows`` computes for a child and what the streaming engine's ``child_rank_at``
    hands out. Ordering by row instead put the right COUNT of values on the wrong rows, and the
    two engines disagreed on a config neither of them refused.

    ``None`` for a multi-key entry (``US|CA|MX``): its rows are a union of subsets, and ranks
    across a union do not compose from the per-value ranks.
    """
    if len(keys) != 1 or layouts is None:
        return None
    plan = layouts.get(on)
    key = keys[0]
    if plan is None or key not in plan.values:
        return None
    vi = plan.values.index(key)
    lo = plan.cum_hi[vi] - plan.counts[vi]

    order: list[int] = [-1] * len(rows)
    for local, row in enumerate(rows):
        slot = plan.slot_by_row.get(row)
        if slot is None:
            return None
        rank = slot - lo
        if rank < 0 or rank >= len(order):
            return None
        order[rank] = local
    return None if any(o < 0 for o in order) else order


def _conditional(spec: SequenceSpec, count: int, run: _Run, columns) -> list[str | None]:
    """The first branch whose condition holds wins.

    EVERY branch is generated in full, for every row, even though at most one value survives on
    each. That is not waste to be optimised away — the draws a branch takes are part of the
    stream, so generating only the winning branch would make the whole run depend on which branch
    happened to win, and two engines would stop agreeing.
    """
    assert spec.branches is not None
    if count == 0:
        return []

    # Each branch draws under its OWN stream — ``Name#if0``, ``Name#if1`` — the ids the
    # streaming engine gives them. They used to take the run's shared PRNG, which made a
    # branch's values depend on how many draws the columns before it had made: the same
    # config and seed then produced different data here than when streaming.
    built: list[list[str]] = []
    flag_names: list[str | None] = []
    flags: list[list[bool]] = []
    for b, branch in enumerate(spec.branches):
        spiked = [False] * count
        branch_run = replace(run, stream_id=f"{spec.name}#if{b}", rows=None)
        built.append(_column_values(branch.gen, count, branch_run, spiked))
        declared = (branch.gen.attrs.get("anomaly_flag") or "").strip()
        flag_names.append(declared or None)
        flags.append(spiked)

    # One column per DISTINCT name: branches sharing ``anomaly_flag="IsOutlier"`` share the
    # column, which is the point of writing it on each branch.
    flag_columns: dict[str, list[str | None]] = {}
    for name in flag_names:
        if name is not None and name not in flag_columns:
            flag_columns[name] = [None] * count

    out: list[str | None] = []
    for i in range(count):
        winner = None
        for b, branch in enumerate(spec.branches):
            if branch.if_expr is None or _condition(branch.if_expr, columns, i):
                winner = b
                break
        # No branch matched: the row is not covered, so neither the value nor any claim about
        # it exists — every flag column stays None here, masked exactly like the value.
        out.append(None if winner is None else built[winner][i])
        if winner is None:
            continue
        for name, column in flag_columns.items():
            # A covered row always has an answer. ``false`` — not empty — when the branch that
            # produced it cannot spike at all, because "no outlier" is the truth about that row
            # and a detector scored against the column needs it stated, not left blank.
            spiked = flag_names[winner] == name and flags[winner][i]
            column[i] = "true" if spiked else "false"
    columns.update(flag_columns)
    return out


# ── distinct and uniq ───────────────────────────────────────────────────────────────────────


def _enforce_distinct(
    spec: SequenceSpec,
    produced,
    count: int,
    run: _Run,
    rows: list[int] | None = None,
    *,
    shared_prng: bool = False,
) -> None:
    """``<distinct>`` — fields inside one group must differ from each other within a row.

    Redraw on collision, field by field, in declaration order. A person's city of birth and city
    of residence come from the same list and are usually different; without this they coincide
    about as often as the list is short.

    Redrawing appends to the stream, so the result stays deterministic. The fuse is there because
    a one-value list can never satisfy two fields, and spinning forever would say far less than
    naming the problem.

    ``shared_prng`` is for a PACK BODY, which is a nested build with no seed of its own: there is
    nothing to key a repair stream by, so the replacement comes off the prng the body was handed.
    The reference draws exactly this distinction, and a Spanish or Portuguese full name — two
    given names and two surnames, each pair ``<distinct>`` — is where it shows.
    """
    assert spec.fields is not None
    gen_by_field = {f.name: f.gen for f in spec.fields}
    seed = run.config.seed
    redraw_run = per_row.redraw(run)

    for group in spec.distinct_groups or []:
        fields = [name for name in group if name in produced and name in gen_by_field]
        if len(fields) < 2:
            continue

        for i in range(count):
            row = rows[i] if rows is not None and i < len(rows) else i
            seen: set[str] = set()
            for field_name in fields:
                values = produced[field_name]
                gen = gen_by_field[field_name]
                value = values[i]
                attempts = 0
                while value in seen:
                    if attempts >= DISTINCT_FUSE:
                        raise EngineError(
                            f'<distinct> in sequence "{spec.name}": could not find a value for '
                            f'field "{field_name}" different from the others after '
                            f"{DISTINCT_FUSE} attempts — its source likely has too few distinct "
                            "values."
                        )
                    attempts += 1
                    # Each attempt has a stream of its own, named for the field and the attempt
                    # number — the same names the streaming engine redraws under, so both
                    # engines land on the same replacement.
                    one = (
                        run
                        if shared_prng
                        else replace(
                            redraw_run,
                            prng=seekable.generator(
                                seed, f"{spec.name}.{field_name}#d{attempts}", row
                            ),
                        )
                    )
                    value = _generate(gen, 1, replace(one, per_row=True))[0]
                values[i] = value
                seen.add(value)


class _UniqInfeasibleError(Exception):
    """Raised by the arranger alone, so the retry can tell it from a real failure."""

    def __init__(self, achievable: int) -> None:
        super().__init__("uniq is infeasible")
        self.achievable = achievable


def _arrange_unique(spec: SequenceSpec, produced, count: int) -> None:
    assert spec.fields is not None
    columns = [produced[f.name] for f in spec.fields]

    # Already unique as drawn? Then there is nothing to rearrange, and moving values anyway
    # would only make this engine disagree with the exact one, which checks the same thing
    # first and leaves a passing draw untouched. Cheap enough to always ask: one pass, one set.
    # NUL joins the tuple because a generated value cannot contain it, so no two different
    # tuples can join into the same key.
    seen: set[str] = set()
    collided = False
    for i in range(count):
        key = "\0".join(c[i] if i < len(c) else "" for c in columns)
        if key in seen:
            collided = True
            break
        seen.add(key)
    if not collided:
        return

    column_counts = [uniq_lib.value_counts(c) for c in columns]

    # The cheap bound first: it cannot be reached, so there is no point building anything.
    upper = uniq_lib.upper_bound(column_counts)
    if count > upper:
        raise _UniqInfeasibleError(upper)

    arranged = uniq_lib.arrange(columns)
    if arranged.distinct < count:
        raise _UniqInfeasibleError(arranged.distinct)
    for i, f in enumerate(spec.fields):
        produced[f.name] = arranged.columns[i]


def _enforce_uniq(spec: SequenceSpec, produced, count: int, run: _Run) -> None:
    """``uniq="true"``, and a fresh draw when the first one happened to be unarrangeable.

    The arranger may only rearrange what was drawn — that is what keeps ``percent=`` exact. But
    when nothing pins the proportions, a lopsided draw is an accident of sampling rather than
    something to protect, and refusing the whole run over it blames the value lists for a problem
    they do not have: four values by eight values over twenty rows offers 32 combinations, and a
    draw of a×7 a×6 a×3 a×4 tops out at nineteen.

    So it draws again. This runs only where the previous behaviour failed, so no config that works
    today shifts by a byte. When the columns come from an exact quota, a redraw returns the same
    multiset in a different order and cannot help; that is detected after one attempt and reported
    as what it is, rather than retried seven more times for nothing.
    """
    assert spec.fields is not None
    try:
        _arrange_unique(spec, produced, count)
        return
    except _UniqInfeasibleError:
        pass

    first_signature = _uniq_signature(spec, produced)
    best = 0
    for attempt in range(UNIQ_REDRAW_ATTEMPTS):
        for f in spec.fields:
            produced[f.name] = _finish(
                _generate(f.gen, count, run), f.gen.attrs, run.prng, [False] * count
            )
        # The same value frequencies mean the draw is quota-fixed: every further attempt would
        # produce this multiset again.
        quota_fixed = attempt == 0 and _uniq_signature(spec, produced) == first_signature
        try:
            _arrange_unique(spec, produced, count)
            return
        except _UniqInfeasibleError as e:
            best = max(best, e.achievable)
            if quota_fixed:
                raise EngineError(_uniq_quota_message(spec.name, count, e.achievable)) from None
    raise EngineError(_uniq_redrawn_message(spec.name, count, best))


def _uniq_signature(spec: SequenceSpec, produced) -> str:
    """Per field, its value frequencies sorted — what changes when a draw is not quota-fixed."""
    assert spec.fields is not None
    return "|".join(
        ",".join(str(c) for c in sorted(uniq_lib.value_counts(produced[f.name])))
        for f in spec.fields
    )


def _uniq_quota_message(name: str | None, requested: int, achievable: int) -> str:
    """The proportions are the config's requirement, so the draw is not the engine's to change."""
    return (
        f'uniq: sequence "{name}" cannot produce {requested} unique combinations. Its values are '
        "drawn to an exact share (percent=, or a weighted pack), so their proportions are fixed "
        f"by the config, and those proportions allow at most {achievable} distinct rows. Add more "
        "values to a field (more distinct names, wider ranges…), relax the share, or lower the "
        "count."
    )


def _uniq_redrawn_message(name: str | None, requested: int, achievable: int) -> str:
    """Nothing pinned the draw, and redrawing still could not get there."""
    return (
        f'uniq: sequence "{name}" cannot produce {requested} unique combinations — '
        f"{UNIQ_REDRAW_ATTEMPTS} independent draws each topped out around {achievable} distinct "
        "rows. Its fields do not hold enough distinct values between them. Add more values to a "
        "field (more distinct names, wider ranges…) or lower the count."
    )


def _enforce_env_distinct(config: Config, columns, count: int, run: _Run) -> None:
    """Env-level ``<distinct>``: the wrapped sequences differ from each other on every row.

    The same idea as ``<distinct>`` inside one compound, one level up. A colliding sequence
    redraws until it differs, which is cheap because a collision is rare and the alternative —
    planning the whole group together — would tie sequences that are otherwise independent.
    """
    by_name = {spec.name: spec for spec in config.sequences}
    seed = config.seed
    redraw_run = per_row.redraw(run)

    for group in config.env_distinct_groups:
        members = _scalar_members(group, by_name, columns)
        if len(members) < 2:
            continue
        for i in range(count):
            seen: list[str] = []
            for name in members:
                values = columns[name]
                value = values[i]
                if value is None:
                    continue  # a row this sequence does not apply to
                attempts = 0
                while value in seen:
                    if attempts >= DISTINCT_FUSE:
                        raise EngineError(
                            "<distinct> across sequences: could not find a value for sequence "
                            f'"{name}" different from the others after {DISTINCT_FUSE} attempts '
                            "— its source likely has too few distinct values."
                        )
                    attempts += 1
                    # Named for the sequence and the attempt, exactly as the streaming engine
                    # names it, so the replacement is the same value on both engines.
                    one = replace(
                        redraw_run,
                        prng=seekable.generator(seed, f"{name}#ed{attempts}", i),
                    )
                    value = _one_scalar(by_name[name], one, columns, i)
                values[i] = value
                seen.append(value)


def _enforce_env_uniq(config: Config, columns, count: int) -> None:
    """Env-level ``<uniq>``: the tuple of the wrapped sequences is unique across the run.

    The values are already drawn, so this rearranges rather than redraws — each column keeps the
    multiset it produced and only the pairings change. That is what keeps a weighted member's
    proportions intact while the combinations become distinct.
    """
    by_name = {spec.name: spec for spec in config.sequences}

    for group in config.env_uniq_groups:
        members = _scalar_members(group, by_name, columns)
        if len(members) < 2:
            continue
        # Only the rows where every member has a value: a row one member skips has no tuple to
        # make unique, and forcing one would invent a value the config never asked for.
        rows = [i for i in range(count) if all(columns[name][i] is not None for name in members)]
        if not rows:
            continue

        label = " × ".join(members)
        by_row: dict[int, list[str]] = {}

        subjects = _subjects_of(members, by_name)
        blocks = _partition_rows(rows, subjects, columns)
        block_sizes = [len(b) for b in blocks]
        # Dealt before any block is looked at, so each one gets a fair share of every value
        # rather than whichever ones fell into it.
        #
        # TWO members are held back, for two different reasons. A `<switch>` answers the subject
        # of its own row, so moving it would put a male name in a female row. And the SUBJECT
        # itself is what the blocks were cut by: deal it and the block no longer describes the
        # rows in it. One block means nothing was cut and the deal is skipped — it is NOT a
        # no-op there, it regroups the column by value and so changes the arrangement.
        dealt: list[list[list[str]] | None] = [
            _deal_across_blocks([columns[name][i] for i in rows], block_sizes)
            if len(blocks) > 1 and by_name[name].switch_spec is None and name not in subjects
            else None
            for name in members
        ]

        # Every block is measured BEFORE any of them is refused, because the number the refusal
        # carries has to describe the run the user asked for. Refusing inside the loop reported
        # one block's ceiling against the whole run's count, which halves the answer on a
        # two-subject group: a shape that renders 23 rows was refused at 24 saying "at most 11",
        # 11 being what one of its two blocks holds. The reach of a cut group is the SUM over
        # its blocks, so that is what gets reported.
        grids = [
            [
                dealt[m][bi] if dealt[m] is not None else [columns[name][row] for row in block]
                for m, name in enumerate(members)
            ]
            for bi, block in enumerate(blocks)
        ]

        # Cheap: value counts, no arrangement. So every block can be measured before any of
        # them is refused.
        uppers = [
            uniq_lib.upper_bound([uniq_lib.value_counts(column) for column in grid])
            for grid in grids
        ]
        if any(len(block) > uppers[bi] for bi, block in enumerate(blocks)):
            raise EngineError(_uniq_group_message(label, len(rows), sum(uppers)))

        arrangements = [uniq_lib.arrange(grid) for grid in grids]
        if any(a.distinct < len(blocks[bi]) for bi, a in enumerate(arrangements)):
            raise EngineError(
                _uniq_group_message(label, len(rows), sum(a.distinct for a in arrangements))
            )

        for bi, block in enumerate(blocks):
            arranged = arrangements[bi]
            for k, row in enumerate(block):
                by_row[row] = [arranged.columns[m][k] for m in range(len(members))]

        # Blocks are made unique on their own; two of them could still meet on the same tuple
        # when the subjects share a value (a name in both lists). Rare, but silence here would
        # be a broken promise, so it is counted and refused.
        seen = {tuple(by_row[row]) for row in rows}
        if len(seen) < len(rows):
            raise EngineError(_uniq_group_message(label, len(rows), len(seen)))

        for m, name in enumerate(members):
            for row in rows:
                columns[name][row] = by_row[row][m]


def _static_capacity(spec: SequenceSpec) -> int | None:
    """The most distinct values this spec can produce, or ``None`` when unknowable."""
    gen = spec.gen
    if gen is None:
        return None  # a mix, a switch, a compound — not bounded here
    # `repeat=` makes the cell a LIST of draws, whose distinct combinations are a different and
    # larger count than one draw's. Not bounded here.
    if gen.attrs.get("repeat") is not None:
        return None

    if gen.type == "text":
        raw = gen.attrs.get("value")
        if raw is None:
            return None
        return len({part.strip() for part in raw.split(",")})

    if gen.type == "number":
        # A decimal range holds far more than its integer span, and `distribution=` draws a real
        # number: neither is the count of whole numbers between the bounds.
        if gen.attrs.get("decimals") is not None or gen.attrs.get("distribution") is not None:
            return None
        source = (gen.attrs.get("value") or gen.attrs.get("range") or "").strip()
        if not source:
            return None
        try:
            total = sum(r.max - r.min + 1 for r in number.parse_ranges(source))
        except Exception:
            # A range this cannot read is the validator's to report, not this check's.
            return None
        return total if total > 0 else None

    return None


def check_env_uniq_capacity(config: Config, count: int) -> None:
    """Can each ``<uniq>`` group cover ``count`` at all — asked before a single row is built.

    The group already had this check, and its message is the right one. But it ran over the
    FINISHED columns, so reaching it meant materialising them first: two lists of ten values and
    ``count="1000000000"`` died in the allocator instead, exactly where the warning is worth most,
    because the alternative is a long run that was never going to succeed.

    A member whose capacity is not knowable from its spec makes the group unbounded, and then this
    says nothing and the post-build check does its work as before. A refusal here is a PROOF, never
    a guess: no config that could have worked is turned away.
    """
    by_name = {spec.name: spec for spec in config.sequences}
    for group in config.env_uniq_groups:
        members = [
            by_name[name]
            for name in group
            if name in by_name
            and (by_name[name].gen is not None or by_name[name].is_mix or by_name[name].is_switch)
        ]
        if len(members) < 2:
            continue
        # A parent filter means fewer rows carry the tuple than `count`, and the exact number is
        # not known until the parent is built.
        if any(spec.parent for spec in members):
            continue

        ceiling: float = 1
        for spec in members:
            capacity = _static_capacity(spec)
            if capacity is None:
                ceiling = float("inf")
                break
            ceiling *= capacity
            if ceiling >= count:
                break

        if count > ceiling:
            raise EngineError(_uniq_group_message(" × ".join(group), count, int(ceiling)))


def _uniq_group_message(label: str, need: int, available: int) -> str:
    return (
        f'uniq: group "{label}" cannot produce {need} unique combinations — the values drawn for '
        f"these sequences allow at most {available} distinct rows. Add more values to a member "
        "(more distinct names, wider ranges…) or lower the count."
    )


def _subjects_of(members: list[str], by_name) -> list[str]:
    """The subjects the group's ``<switch>`` members are keyed by, in order, without repeats.

    Empty when no member is a switch, which is the ordinary case and leaves the behaviour
    exactly as it was.
    """
    subjects: list[str] = []
    for name in members:
        spec = by_name.get(name)
        on = spec.switch_spec.on if spec is not None and spec.switch_spec is not None else None
        if on is not None and on not in subjects:
            subjects.append(on)
    return subjects


def _deal_across_blocks(column: list[str], block_sizes: list[int]) -> list[list[str]]:
    """Spread one member's values across the blocks before anything is arranged inside them.

    A ``text`` list is laid out in exact shares over the WHOLE column, and then a ``<switch>``
    cuts the rows into blocks — so a block gets whichever values happened to fall there, not a
    fair share of them. Measured on a group of four over 29 rows: the male block came out
    ``[7,3,4]`` and ``[6,5,3]`` where an even deal is ``[5,5,4]`` and ``[5,5,4]``, and that is
    the difference between 13 achievable tuples and 14. The run was refused for want of data it
    had.

    Each value is split over the blocks in proportion to their sizes, largest remainder first,
    clamped to the room a block has left. The MULTISET is untouched — the same values in the
    same numbers, only distributed — so every declared percentage survives exactly.
    """
    order: list[str] = []
    counts: dict[str, int] = {}
    for value in column:
        if value not in counts:
            order.append(value)
        counts[value] = counts.get(value, 0) + 1

    total = len(column)
    out: list[list[str]] = [[] for _ in block_sizes]
    room = list(block_sizes)

    for value in order:
        want = counts[value]
        exact = [0.0 if total == 0 else want * size / total for size in block_sizes]
        share = [min(room[i], math.floor(e)) for i, e in enumerate(exact)]
        given = sum(share)

        # The remainder goes to the blocks with the largest fraction owed, ties by block order —
        # the same largest-remainder rule the percentages use, so two implementations cannot
        # disagree about who gets the odd one.
        owed = sorted(range(len(exact)), key=lambda i: (-(exact[i] - math.floor(exact[i])), i))
        for i in owed:
            if given >= want:
                break
            if share[i] < room[i]:
                share[i] += 1
                given += 1
        # A block that filled up sends its share on to the next with room.
        for i in range(len(share)):
            while given < want and share[i] < room[i]:
                share[i] += 1
                given += 1

        for i, n in enumerate(share):
            out[i].extend([value] * n)
            room[i] -= n
    return out


def _partition_rows(rows: list[int], subjects: list[str], columns) -> list[list[int]]:
    """Split the rows into blocks that may be shuffled among themselves.

    With no switch member there is one block holding every row — the old behaviour, bit for
    bit. With one, rows are grouped by the value of its subject, so male rows only ever trade
    with male rows: a switch's value answers the subject of ITS row.
    """
    if not subjects:
        return [list(rows)]
    blocks: dict[tuple, list[int]] = {}
    for row in rows:
        key = tuple(columns[s][row] if s in columns else None for s in subjects)
        blocks.setdefault(key, []).append(row)
    return list(blocks.values())


def _scalar_members(group: list[str], by_name, columns) -> list[str]:
    """The members of a group that are single-valued sequences and were actually built."""
    out = []
    for name in group:
        spec = by_name.get(name)
        if (
            spec is not None
            and (spec.gen is not None or spec.is_mix or spec.is_switch)
            and name in columns
        ):
            out.append(name)
    return out


def _one_scalar(spec: SequenceSpec, run: _Run, columns=None, row: int = 0) -> str:
    """One fresh value from a sequence — what a ``<distinct>`` collision redraws.

    A switch needs the ROW, which the other two do not: its branch is chosen by the subject
    column's value on that row, so a redraw has to land in the branch the original did — a
    ``<case is="p">`` row must come back with another p value. Without the row this returned the
    empty string, which the caller then accepted as "different from the others" and wrote into
    the cell: colliding rows came out BLANK, with no diagnostic, from a config the docs describe
    as supported.
    """
    # One row, so no whole-column plan may run over it — the same mark the streaming engine
    # puts on its one-row runs.
    run = replace(run, per_row=True)
    if spec.gen is not None:
        built = _finish(_generate(spec.gen, 1, run), spec.gen.attrs, run.prng, [False])
        return built[0] if built else ""
    if spec.is_mix:
        built = _mix_values(spec.mix, 1, run, [False])
        return built[0] if built else ""
    if spec.is_switch and spec.switch_spec is not None:
        return _one_switch(spec.switch_spec, run, columns, row)
    return ""


def _one_switch(switch_spec, run: _Run, columns, row: int) -> str:
    """One fresh value from the branch this row's subject selects.

    The FIRST entry whose keys hold the subject's value, else ``<default>``, else the empty
    string — exactly the precedence ``_switch_values`` uses when it builds the whole column.
    """
    subject = None if columns is None else columns.get(switch_spec.on)
    key = "" if subject is None or subject[row] is None else subject[row]
    chosen = None
    for entry in switch_spec.entries:
        if key in entry.keys:
            chosen = entry.value
            break
    if chosen is None:
        chosen = switch_spec.fallback
    if chosen is None:
        return ""
    built = _case_values(chosen, 1, run)
    return built[0] if built else ""


# ── generating ──────────────────────────────────────────────────────────────────────────────


def _column_values(
    gen: Gen,
    count: int,
    run: _Run,
    anomaly_flags: list[bool] | None = None,
    instants_out: list[int | None] | None = None,
) -> list[str]:
    """One generator's finished values for a whole column.

    Row by row when the generator allows it, off the very stream the streaming engine uses, so
    the two produce the same bytes from one seed. The modifiers are applied INSIDE that loop,
    with the row's own generator — `anomaly=` on a per-row type spends a draw from the row's
    stream, not from a column-wide one, and applying them afterwards would spend the wrong
    draws in the wrong order.

    Anything else keeps the older shape: generate the column, then finish it.
    """
    flags = anomaly_flags if anomaly_flags is not None else [False] * count
    if not per_row.per_row_buildable(gen, count, run):
        return _finish(
            _generate(gen, count, run, instants_out),
            gen.attrs,
            run.prng,
            flags,
            run,
            gen.type,
            instants_out,
        )

    seed, stream_id = per_row.keyed(run)  # type: ignore[misc]
    out: list[str] = []
    for i in range(count):
        row = per_row.absolute_row(run, i)
        # `rows=[row]` tells the one-row build which ABSOLUTE row it is, the way the reference's
        # own one-row path does. Anything derived from the row inside — a pack body's seed, a
        # distribution parameter written as an expression — otherwise reads position 0 and
        # answers for the first row on every row.
        one = replace(run, prng=seekable.generator(seed, stream_id, row), rows=[row], per_row=True)
        single = [False]
        # One row's instant lands in its own scratch list: the inner call knows nothing of `i`,
        # and handing it `instants_out` would append rows that a later `missing=` pass could no
        # longer line up with.
        scratch: list[int | None] | None = [] if instants_out is not None else None
        out.append(
            _finish(
                _generate(gen, 1, one, scratch),
                gen.attrs,
                one.prng,
                single,
                None,
                None,
                scratch,
            )[0]
        )
        flags[i] = single[0]
        if instants_out is not None and scratch is not None:
            instants_out.append(scratch[0] if scratch else None)
    return out


def _generate(
    gen: Gen, count: int, run: _Run, instants_out: list[int | None] | None = None
) -> list[str]:
    """One generator's values.

    Shared with the streaming engine, which calls it with a count of one and a generator private
    to the row. Two copies of this dispatch would be two places for the languages to drift apart
    from each other and from themselves.
    """
    config = run.config
    locale = config.locale
    prng = run.prng
    attrs = gen.attrs

    # Row by row, off the very stream the streaming engine uses, so the two engines produce the
    # same bytes from one seed. That engine already calls THIS function that way — one row, a
    # generator seeded from `(seed, stream_id, row)` — so there is no second implementation to
    # keep in step, only the same one called the same way. The recursive call has count = 1,
    # which the guard refuses, and that is what stops this from looping.
    # order="sequential" comes before everything else: it replaces the draw entirely, so the
    # percent= and the random pick below never happen. Row i is element i mod N.
    #
    # Only text and file, matching the reference. A sequential regex or date would have to mean
    # something invented here, and inventing it is how two implementations stop agreeing.
    if gen.type in ("text", "file") and attrs.get("order") == "sequential":
        values = (
            file_gen.load(attrs, run.base_dir, run.packs.data_roots)
            if gen.type == "file"
            else _split_text(gen.attr("value"))
        )
        cycle = attrs.get("cycle") != "false"
        return [_pick_sequential(values, i, cycle) for i in range(count)]

    # The same rule over a date range: row i is the i-th step from the start. The axis is
    # arithmetic rather than a list, so a long range costs nothing to walk.
    if gen.type == "date" and attrs.get("order") == "sequential":
        axis = date_gen.date_axis(attrs, locale, run.now_millis)
        cycle = attrs.get("cycle") != "false"

        # An OPEN axis has no size and never wraps: row i is simply the i-th step.
        def step_at(i: int) -> int:
            return i if axis.size is None else sequential_index(axis.size, i, cycle)

        # A WALKED date keeps its instant too. It is the pairing a real record asks for most —
        # orders march down the calendar, delivery is a few days after its own order — and this
        # branch returns before the drawn-date one, so without this the sink stayed empty and
        # the offset read every row as "this row has no date". A silent empty column, from a
        # config that was right.
        if instants_out is not None:
            for i in range(count):
                instants_out.append(to_epoch_millis(axis.value_at(step_at(i))))
        return [axis.at(step_at(i)) for i in range(count)]

    if gen.type == "increment":
        return counter.generate(attrs, count, True)
    if gen.type == "decrement":
        return counter.generate(attrs, count, False)
    if gen.type == "number":
        distribution = attrs.get("distribution")
        if distribution is not None and distribution.strip():
            return _distribute(attrs, count, prng, run)
        return number.generate(attrs, count, prng)
    if gen.type == "timeseries":
        return _timeseries(attrs, count, run)
    if gen.type == "file":
        row_key = _trim_to_none(attrs.get("row"))
        if row_key is not None:
            return _linked_file_values(row_key, attrs, count, run)
        # `read="quantile"` reads the SAME file as a distribution rather than a bag: sorted once,
        # a row lands anywhere on it, and the values between observations appear on their own.
        if quantile.is_quantile(attrs):
            return _quantile_values(attrs, count, prng, run)
        weighted = file_gen.load_weighted(attrs, run.base_dir, run.packs.data_roots)
        if weighted is not None:
            # The same apportionment percent= uses, so the file's counts come out exact rather
            # than approximate — and laid out the way the streaming engine lays it out, so a
            # weighted file column reads the same on every engine.
            exact = per_row.exact_text_layout(weighted.values, None, count, run, weighted.percents)
            if exact is not None:
                return exact
            return hamilton.distribute(count, weighted.values, weighted.percents, prng)
        return file_gen.generate(attrs, count, run.base_dir, prng, run.packs.data_roots)
    if gen.type == "pattern":
        return _pattern(attrs, count, run)
    if gen.type == "http":
        # Filled in a second pass, after every ordinary column exists: an http gen may read
        # another sequence through in=, and that sequence has to be there first.
        return [""] * count
    if gen.type == "regex":
        return regex.generate(attrs, count, config.regex_max_length, prng)
    if gen.type == "advanced_regex":
        return advanced_regex.generate(attrs, count, config.regex_max_length, prng)
    if gen.type == "symbol":
        return symbol.generate(attrs, count, prng)
    if gen.type == "date":
        return date_gen.generate(attrs, count, locale, run.now_millis, prng, instants_out)

    if gen.type == "text":
        values = _split_text(gen.attr("value"))
        percent = gen.attr("percent")
    elif gen.type == "template":
        path = gen.attr("value")
        # `local=` on the <gen> picks the pack, exactly as it does on the <env>. Reading only
        # the env locale here made a gen-level `local=` a NO-OP for every pack file that does
        # not declare `weighted: true` -- the weighted path resolves the address for itself
        # and was always right, which is why half the locales worked and half did not.
        # Measured: `<gen type="template" value="person.lastName" local="de"/>` gave
        # Voigt/Riedel/Winkelmann in the reference and `Smith Smith Smith` here. Not merely
        # the wrong language: `Smith` is the heaviest line of the weighted ENGLISH file, so
        # the column was a constant, and `check` called it valid.
        locale = attrs.get("local") or locale
        # Two template paths are generators rather than lists. They are resolved before the pack
        # registry is consulted, which is why no pack file is named after them.
        if path == "person.b_day":
            return [
                date_gen.render_birthday(attrs, locale, run.now_millis, prng) for _ in range(count)
            ]
        if path == "date.range":
            return [
                date_gen.render_date_range(attrs, locale, run.now_millis, prng)
                for _ in range(count)
            ]
        entry = run.packs.load(path, locale)
        if entry.is_generator:
            # The pack ships a rule rather than a list. Two shapes: a lone <gen>, or local
            # sequences feeding an output template — which is how an identifier with a check
            # digit is expressed as editable data instead of as engine code.
            return _run_pack_generator(entry, path, count, run, attrs)
        if entry.weighted:
            # A weighted pack is laid out exactly, not sampled: the counts in the file are
            # proportions the run has to hit, which is the same path percent= takes — and laid
            # out the way the streaming engine lays it out, so `Smith` gets its Census share on
            # the same rows on every engine.
            exact = per_row.exact_text_layout(entry.values, None, count, run, entry.percents or [])
            if exact is not None:
                return exact
            return hamilton.distribute(count, entry.values, entry.percents or [], prng)
        # A PLAIN pack stays a uniform pick — never the exact layout a literal list gets.
        #
        # The two used to agree by accident: a pack drawn inside a body had no column name, so
        # the layout bailed out and fell through to this same pick. Once bodies were given a
        # stream identity the layout started firing, and at one row it plans one slot and hands
        # it to one value — `usa.geo.streetNamed` came out as "Woodland" on all six rows. The
        # rule is the reference's, stated in its own source: a weighted pack is laid out
        # exactly, a plain one is picked uniformly.
        return [entry.values[math.floor(prng.next() * len(entry.values))] for _ in range(count)]
    else:
        raise EngineError(f'generator type "{gen.type}" is not ported yet')

    # The streaming engine has NO separate uniform path: no `percent=` simply means equal
    # shares, and either way it lays the values out exactly over the column and then permutes.
    # Doing the same here is what makes a listed column come out the same on every engine — one
    # mechanism, not a random pick plus a quota plan.
    exact = per_row.exact_text_layout(values, percent or None, count, run)
    if exact is not None:
        return exact
    if not percent:
        return [values[math.floor(prng.next() * len(values))] for _ in range(count)]
    # Through the shared mask reader, so a partial mask like percent="50" over three values
    # splits the remainder instead of throwing on the blanks.
    return hamilton.distribute(count, values, percent_mask.expand(percent, len(values)), prng)


def _distribute(attrs: dict[str, str], count: int, prng: Sfc32, run: _Run) -> list[str]:
    """A column drawn from a named distribution.

    Each row spends the same number of uniforms whatever the value turns out to be, which is what
    keeps a row computable from its index. Rejection sampling would be simpler to write and would
    break that — and it is also why a PARAMETER may be an expression while a per-row `repeat=` may
    not: how many draws a row spends follows from which distribution, never from its parameters.
    """
    dynamic = dist_params.expression_params(attrs)
    fixed = dist.parse(attrs) if not dynamic else None
    out = []
    for i in range(count):
        resolved = None
        if fixed is None:
            row = per_row.absolute_row(run, i)
            resolved = dist_params.resolve(
                attrs,
                dynamic,
                row,
                lambda ref, r=row: run.value_at is not None and run.value_at(ref, r) is not None,
                lambda ref, r=row: run.value_at(ref, r) if run.value_at else None,
            )
            # Nothing to draw from, so nothing is drawn: the row comes out empty, which is what
            # `formula` does with the same input. The uniforms are spent anyway, or blanking one
            # cell would slide every value after it.
            if resolved.empty:
                for _ in range(dist_params.draws(attrs)):
                    prng.next()
                out.append("")
                continue
        spec = fixed if fixed is not None else dist.parse(resolved.attrs)
        uniforms = [open_unit(prng.next()) for _ in range(spec.draws)]
        out.append(dist.format_sample(dist.sample(spec, uniforms), spec))
    return out


def _timeseries(attrs: dict[str, str], count: int, run: _Run) -> list[str]:
    spec = timeseries.parse(attrs)
    key_pair = per_row.keyed(run)
    out = []
    for i in range(count):
        z = 0.0
        if spec.has_noise():
            # The value follows the position; the noise follows the row, on the dedicated ':ts'
            # stream the streaming engine uses. Same two names, same two uniforms, same series.
            if key_pair is not None:
                seed, stream_id = key_pair
                u1, u2 = seekable.uniforms(seed, f"{stream_id}:ts", per_row.absolute_row(run, i), 2)
            else:
                u1, u2 = open_unit(run.prng.next()), open_unit(run.prng.next())
            z = timeseries.standard_normal(u1, u2)
        out.append(timeseries.format_value(timeseries.value_at(spec, i, z), spec.decimals))
    return out


def _pattern(attrs: dict[str, str], count: int, run: _Run) -> list[str]:
    resolved = patterns.of(attrs, run.base_dir, run.packs.data_roots)
    draws = patterns.draws(resolved)
    denom = count - 1 if count > 1 else 1
    key_pair = per_row.keyed(run)

    def band(i: int) -> float:
        # As with timeseries: the curve is read at the position, the one draw inside the band is
        # keyed by the row on the streaming engine's ':pat' stream.
        if not draws:
            return 0.0
        if key_pair is None:
            return open_unit(run.prng.next())
        seed, stream_id = key_pair
        return seekable.uniforms(seed, f"{stream_id}:pat", per_row.absolute_row(run, i), 1)[0]

    return [patterns.value_at(resolved, i / denom, band(i)) for i in range(count)]


def _formula(spec, columns: dict[str, list[str]], count: int, sequential: bool = False) -> None:
    """One `<gen type="formula">` column, from the columns already in the registry."""
    gen = spec.gen
    source = formula_gen.expression_of(gen.attrs)
    decimals = formula_gen.decimals_of(gen.attrs)
    own = spec.name or ""
    values: list[str] = []
    for i in range(count):
        # The previous row, for `prev()`. Two cases, and the first is the point:
        # THIS column reads `values[i - 1]`, the row just computed — a random walk
        # and a Markov chain are exactly that, and it works because this loop goes
        # in order. Another column reads whatever it holds at `i - 1`; registration
        # is in DECLARATION order, so a name declared above is already complete.
        def previous_row(name: str, r: int = i) -> str | None:
            if r == 0:
                return None
            if name == own:
                return values[r - 1]
            column = columns.get(name)
            return column[r - 1] if column is not None and r - 1 < len(column) else None

        answer = formula_gen.value_at_row(
            source,
            decimals,
            lambda name, r=i: (
                columns[name][r] if name in columns and r < len(columns[name]) else None
            ),
            lambda name: name in columns,
            i,
            previous_row if sequential else None,
        )
        values.append("" if answer is None else answer)
    columns[own] = values


def _quantile_values(attrs: dict[str, str], count: int, prng: Sfc32, run: _Run) -> list[str]:
    """One `read="quantile"` column.

    The drawn form is one uniform per row, so it needs nothing from the run but its PRNG. The
    exact sweep needs a seed and a column name to key its scatter by; an inline build has
    neither, and falls back to the drawn form.
    """
    values = file_gen.load(attrs, run.base_dir, run.packs.data_roots)
    src = quantile.source(values, (attrs.get("src") or "").strip())
    decimals = quantile.decimals_for(attrs, src)
    if quantile.is_exact_sample(attrs) and run.stream_id is not None:
        key = permute.key(run.config.seed, run.stream_id)
        return [quantile.exact_at(src, decimals, count, key, i) for i in range(count)]
    return [
        quantile.render(quantile.at(src.sorted_values, open_unit(prng.next())), decimals)
        for _ in range(count)
    ]


def _linked_file_values(row_key: str, attrs: dict[str, str], count: int, run: _Run) -> list[str]:
    """``row="key"`` — every sequence on the same key reads the same row of the file.

    The first sequence to use a key draws the plan — one row index per record — and every later
    one follows it. That is the whole point: a city and its postcode taken from one real record
    are consistent, where two independent draws produce a pairing no validator would accept.

    Because only the first draws, adding a second field to an existing link consumes no further
    randomness and leaves every other column exactly where it was.
    """
    source = file_gen.load_rows(attrs, run.base_dir, run.packs.data_roots)
    plan = run.row_links.get(row_key)

    if plan is None:
        weighted = file_gen.weighted_rows(attrs, source)
        if weighted is not None:
            # With weight=, the shared rows follow the file's counts exactly; every linked field
            # then reads those same rows.
            indexes = [
                int(i)
                for i in hamilton.distribute(count, weighted.values, weighted.percents, run.prng)
            ]
        else:
            indexes = [rand.next_int(run.prng, 0, len(source.rows)) for _ in range(count)]
        plan = (source.source_key, indexes)
        run.row_links[row_key] = plan
    else:
        if plan[0] != source.source_key:
            raise EngineError(f'sequence: row link "{row_key}" cannot mix different file sources')
        if len(plan[1]) != count:
            raise EngineError(
                f'sequence: row link "{row_key}" cannot be reused with a different row count'
            )

    return [file_gen.cell_at(source, index) for index in plan[1]]


def _split_text(value: str) -> list[str]:
    """A ``value="a, b, c"`` list, trimmed.

    A config writes the space after the comma because that is how a person writes a list, and the
    space is formatting rather than part of the value.
    """
    return [part.strip() for part in value.split(",")]


def sequential_index(size: int, index: int, cycle: bool) -> int:
    """Which of ``size`` positions row ``index`` reads, wrapping unless ``cycle="false"``.

    Split out from :func:`_pick_sequential` because a walked date range has positions without
    having a list: its values are computed from an index, and only this part applies.
    """
    if size <= 0:
        return 0
    if not cycle and index >= size:
        raise EngineError(
            f'order="sequential" cycle="false": the source has only {size} values, '
            f"so row {index + 1} has none — shorten count= or lengthen the source"
        )
    return index % size


def _pick_sequential(values: list[str], index: int, cycle: bool) -> str:
    """Element ``index mod N``, or a refusal once the data runs out under ``cycle="false"``.

    Looping is the default because a short list walked over many rows is the ordinary case —
    twelve months across a year of daily records. ``cycle="false"`` is for when running out is a
    mistake worth hearing about rather than something to paper over by starting again.
    """
    if not values:
        return ""
    return values[sequential_index(len(values), index, cycle)]


def _trim_to_none(value: str | None) -> str | None:
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed:
        raise EngineError("sequence: file row link must not be empty")
    return trimmed


# ── pack generators ─────────────────────────────────────────────────────────────────────────


#: Attributes on a `<gen type="template">` that steer the CALL rather than parameterise the
#: pack behind it. Everything else is a parameter that may replace a same-named local
#: sequence in the pack body. Kept in step with the reference's RESERVED_TEMPLATE_ATTRS.
RESERVED_TEMPLATE_ATTRS = frozenset(
    {
        "type",
        "value",
        "local",
        "name",
        "if",
        "comment",
        "anomaly",
        "anomaly_factor",
        "anomaly_flag",
        "missing",
        "missing_as",
        "mask",
        "case",
        "order",
        "cycle",
    }
)


def param_overrides(attrs: dict[str, str]) -> dict[str, str]:
    """The caller's parameters: every attribute that is not a control attribute."""
    return {k: v for k, v in attrs.items() if k not in RESERVED_TEMPLATE_ATTRS}


def _run_pack_generator(
    entry, path: str, count: int, run: _Run, attrs: dict[str, str] | None = None
) -> list[str]:
    # The body gets a SEED and a stream identity, like every other sequence.
    #
    # It used to get neither, and the body's local sequences drew off the prng they were handed.
    # So a weighted pack column MOVED when an unrelated sequence was added in front of it, the
    # same pack in two columns drew alike, and with no stream identity the body could not be
    # planned over a column at all — which is why every whole-column pack went to this engine.
    #
    # The ROW is part of the salt when the body is being built for ONE row, and that is not a
    # detail: a pack that does not need the whole column is built per row, and handed a
    # column-wide seed at count 1 the body's own exact-layout machinery plans one slot and gives
    # it to one value, so every row draws the same.
    #
    # `run.per_row` is in the test, not the count alone. A count of one does not make a build
    # per-row: a pack that needs the WHOLE column, in a run of count="1", is a column-wide build
    # that happens to hold a single row. Salted there, this engine answered a config differently
    # from the streaming ones, which build such a body their own way and never salt it.
    # `absolute_row`, not `run.rows[0]`: a build whose positions ARE its rows carries no row
    # list at all, and reading one off it left a NESTED body — a pack naming a second pack —
    # without the row on its seed. The reference's inner body is seeded `…|domain|0`; this one
    # was seeded `…|domain`, and a column of e-mail addresses came out with one domain repeated.
    body_row = per_row.absolute_row(run, 0) if run.per_row and count == 1 else None
    body_seed = f"{run.config.seed}|{run.stream_id or run.column_stream_id or ''}" + (
        "" if body_row is None else f"|{body_row}"
    )
    # The body inherits whether it is inside a one-row build. The row is already folded into
    # `body_seed` above; a body that ALSO planned per row would draw from a stream the salt
    # never meant.
    run = replace(
        per_row.redraw(run), config=replace(run.config, seed=body_seed), per_row=run.per_row
    )
    body = _PACK_BODIES.get(path)
    if body is None:
        source = entry.generator
        # A body holding <sequence> or <data> is composed; anything else is a lone <gen>.
        body = (
            config_builder.parse_pack_body(source)
            if "<sequence" in source or "<data" in source
            else config_builder.parse_gen_tag(source)
        )
        _PACK_BODIES[path] = body

    if isinstance(body, Gen):
        return _generate(body, count, run)

    overrides = param_overrides(attrs or {})
    local: dict[str, list[str | None]] = {}
    for spec in body.sequences:
        name = spec.name or ""
        # A caller attribute whose name matches this local sequence replaces it with a
        # constant column: `<gen type="template" value="common.internet.email"
        # domain="example.test"/>` is how a pack is parameterised. It consumes no prng,
        # so the rest of the body's deterministic stream is exactly where it would be.
        if name in overrides:
            local[name] = [overrides[name]] * count
            continue
        local.update(_materialize_local(spec, count, run, local))

    if body.validate is not None:
        _enforce_valid(body, local, count, run, overrides)

    return [
        interpolate.apply(body.output, run.config.inject, _row_lookup(local, row))
        for row in range(count)
    ]


def _materialize_local(
    spec: SequenceSpec, count: int, run: _Run, local
) -> dict[str, list[str | None]]:
    """One local sequence of a pack body, as the column or columns it contributes.

    A COMPOUND sequence contributes one column per field, named ``sequence.field`` — the same
    shape it has in a config, because the reference runs a pack body through the very sequence
    builder a config goes through. Every ``.tdc`` pack that ships is written this way.
    """
    name = spec.name or ""
    if spec.is_computed:
        return {name: [compute_evaluate(spec.compute, _row_lookup(local, i)) for i in range(count)]}
    if spec.is_compound:
        assert spec.fields is not None
        # Declaration order off the shared prng: a pack body is a nested build with no stream
        # of its own, so the fields of one row draw one after another rather than each keying
        # itself — which is what pairs a given name with the surname beside it.
        by_field: dict[str, list[str]] = {}
        for field in spec.fields:
            # Through the COLUMN builder, not the raw dispatch: a body sequence is a column
            # like any other, and the builder is what takes the per-row path off its own stream.
            # Calling `_generate` here left every pack body drawing from the threaded prng while
            # the other four implementations drew per row, so this engine disagreed with the
            # streaming ones on every whole-column pack, at every count.
            by_field[field.name] = list(
                _column_values(field.gen, count, replace(run, stream_id=f"{name}.{field.name}"))
            )
        # After every field exists, never during: a group's members must all be there before
        # the constraint between them means anything.
        if spec.distinct_groups:
            _enforce_distinct(spec, by_field, count, run, shared_prng=True)
        return {f"{name}.{field.name}": list(by_field[field.name]) for field in spec.fields}
    if spec.is_mix:
        assert spec.mix is not None
        # A `<mix percent>` is how a pack declares a share of its OWN — 60% of Spanish surnames
        # are two words. The '#switch' suffix is the key the streaming engine spells, and a pack
        # body is built there too: the two engines have to agree on the key or they disagree on
        # the value. Without this branch the sequence was not built at all and the assertion
        # below took the run down with a stack trace.
        mix_run = per_row.with_rows(run, f"{name}#switch", list(range(count)))
        return {name: list(_mix_values(spec.mix, count, mix_run, [False] * count))}
    assert spec.gen is not None
    # Keyed by its own name, exactly as a config's sequence is. Without this the body's
    # sequences had no stream of their own and no whole-column layout could fire inside one.
    # The column builder, for the reason given in the compound branch above.
    return {name: list(_column_values(spec.gen, count, replace(run, stream_id=name)))}


def _enforce_valid(pack, local, count: int, run: _Run, overrides: dict[str, str]) -> None:
    """Reject and redraw until the pack's ``<valid>`` predicate holds.

    Some identifiers have combinations that were never issued — a region code that does not exist,
    a date inside a national ID that never happened. Redrawing appends to the stream, so the
    result stays deterministic; the fuse is there because a constraint no draw can satisfy would
    otherwise hang the run rather than report itself.

    A PINNED sequence is never redrawn. A caller parameter replaces a local sequence with a
    constant, and redrawing it threw that constant away: a config asking for a particular base
    got values with nothing to do with it and no word of complaint. When the pin is all the guard
    reads there is nothing left to re-roll either, so the answer is fixed before the first attempt
    and saying so at once beats a hundred no-ops per row.
    """
    pinned = [s.name for s in pack.sequences if not s.is_computed and s.name in overrides]
    redrawable = any(not s.is_computed and s.name not in overrides for s in pack.sequences)

    for row in range(count):
        attempts = 0
        if not redrawable and not evaluate_predicate(pack.validate, _row_lookup(local, row)):
            named = ", ".join(f'{n}="{overrides[n]}"' for n in pinned) or "the pinned parameters"
            raise EngineError(
                f"pack generator <valid> rejects the value built from {named}, and every "
                "sequence the guard reads is pinned, so there is nothing left to redraw. Pass a "
                "value the pack accepts, or drop the parameter and let the pack draw its own."
            )
        while not evaluate_predicate(pack.validate, _row_lookup(local, row)):
            if attempts >= VALID_FUSE:
                raise EngineError(
                    f"pack generator <valid> constraint could not be satisfied for row {row} "
                    f"after {VALID_FUSE} attempts — the base cannot produce a valid value"
                )
            attempts += 1
            for spec in pack.sequences:
                if spec.is_computed or spec.name in overrides:
                    continue
                if spec.gen is None:
                    raise EngineError(
                        "pack generator <valid> requires simple <gen> base sequences; sequence "
                        f'"{spec.name}" is not supported'
                    )
                one = _finish(
                    _generate(spec.gen, 1, replace(run, per_row=True)),
                    spec.gen.attrs,
                    run.prng,
                    [False],
                )
                local[spec.name][row] = one[0]
            # Derived values follow their inputs, in declaration order.
            for spec in pack.sequences:
                if spec.is_computed:
                    local[spec.name][row] = compute_evaluate(spec.compute, _row_lookup(local, row))


# ── http, resolved after everything else ────────────────────────────────────────────────────


def _resolve_http(config: Config, columns, count: int, base_dir: Path | None) -> None:
    """Every ``type="http"`` column filled from its service, once the rest of the run exists.

    A second pass rather than a generator branch, because an http gen may read another sequence
    through ``in=``, and that sequence has to be finished first.

    One call per column, carrying the whole batch — a million rows is a handful of requests, not a
    million. The ``in=`` column travels as the request body, so a service can answer per input
    rather than out of thin air.

    The seed sent along is derived from the run's seed and the sequence name. The engine cannot
    make an http column reproducible, since the service decides the values; what it can do is give
    the service everything it needs to be reproducible on its own.
    """
    for spec in config.sequences:
        if spec.gen is None or spec.gen.type != "http":
            continue
        attrs = spec.gen.attrs
        in_name = attrs.get("in")
        inputs = None
        if in_name and in_name.strip():
            column = columns.get(in_name)
            inputs = [
                "" if column is None or column[i] is None else column[i] for i in range(count)
            ]

        # Resolved per sequence and never cached: two sequences may sign with two different
        # secrets, and a config naming an unset variable should say so in terms of the sequence
        # the reader wrote.
        secret_spec = attrs.get("secret")
        secret = None
        if secret_spec and secret_spec.strip():
            try:
                secret = http_gen.resolve_secret(secret_spec, str(base_dir) if base_dir else ".")
            except http_gen.SecretError as e:
                raise EngineError(f'http service for sequence "{spec.name}": {e}') from e

        request = http_gen.Request(
            src=attrs.get("src", ""),
            count=count,
            inputs=inputs,
            seed=http_gen.seed_for(config.seed, spec.name or ""),
            on_error=http_gen.parse_on_error(attrs.get("on_error")),
            timeout_ms=http_gen.parse_timeout(attrs.get("timeout")),
            secret=secret,
        )
        try:
            values = http_gen.fetch(request)
        except http_gen.ServiceError as e:
            raise EngineError(f'http service for sequence "{spec.name}" at {e.url} {e}') from e

        target = columns.get(spec.name or "")
        if target is not None:
            for i in range(min(count, len(values))):
                target[i] = values[i]


# ── rendering ───────────────────────────────────────────────────────────────────────────────


def _row_lookup(columns, row: int):
    """One row's view of the columns, shared by the interpolator and the compute layer."""

    def lookup(name: str) -> str | None:
        column = columns.get(name)
        if column is None:
            return None
        value = column[row]
        return "" if value is None else value

    return lookup


def _condition(expr: str, columns, row: int) -> bool:
    """An ``if`` evaluated against one row.

    A column that has no value on this row reads as EMPTY rather than as missing, so a condition
    on a child column is false on the rows its parent did not select — which is what a config
    expects when it asks about a field that only some records have.
    """
    return as_condition(
        expr,
        lambda name: name in columns,
        lambda name: columns[name][row] if columns[name][row] is not None else "",
    )


def _render_line(line: Line, columns, row: int, inject: str, each_info) -> list[str]:
    """One line — or, with ``each="NAME"``, one line per element of that list.

    The OUTPUT LINES, each with its newline already attached. A list with nothing in it produces
    none at all: a customer with no orders leaves no blank row behind. A list is returned rather
    than one joined string so the caller can put a fixture BETWEEN the lines an each= produced —
    which is what <delimiter_line> is for, and what it silently failed to do.
    """
    template = "".join(
        part.text
        for part in line.parts
        if part.if_expr is None or _condition(part.if_expr, columns, row)
    )

    list_name = None if line.each is None else line.each.strip()
    if not list_name:
        return [interpolate.apply(template, inject, _row_lookup(columns, row)) + "\n"]

    spec = each_info.get(list_name)
    column = columns.get(list_name)
    cell = "" if column is None or column[row] is None else column[row]
    separator = repeat_gen.DEFAULT_SEPARATOR if spec is None else spec.separator
    elements = repeat_gen.split(cell, separator)

    # Lanes: two repeating sequences write into the same child table, so each gets its own slice
    # of every card's key block rather than sharing one counter.
    lane = 0
    stride = 0
    for name, info in each_info.items():
        if name == list_name:
            lane = stride
        stride += info.max
    if stride == 0:
        stride = len(elements)

    out = []
    for k, element in enumerate(elements):
        lookup = _element_lookup(columns, row, list_name, element, k + 1, lane, stride)
        out.append(interpolate.apply(template, inject, lookup) + "\n")
    return out


def _element_lookup(columns, row: int, list_name: str, element: str, position: int, lane, stride):
    """The row's view with one element substituted for the list, plus the two positional built-ins.

    Shallow on purpose: every other column still resolves per record, which is exactly what makes
    a foreign key on the repeated line point at the right parent on every emitted row.
    """
    overlay = {
        list_name: element,
        "_item": str(position),
        "_item_id": str(repeat_gen.item_key(row + 1, position, lane, stride)),
    }
    base = _row_lookup(columns, row)

    def lookup(name: str) -> str | None:
        return overlay[name] if name in overlay else base(name)

    return lookup
