"""The streaming engine: a row is computed from its own index, and nothing else is kept.

The in-memory engine materializes every column before writing a byte, so a run costs memory
proportional to its size. That is the right trade for a thousand rows and impossible for a billion.
Here each value is a function of the row number, so memory is proportional to the WIDTH of one row
and a file of any length costs the same.

Two things make that possible, and both live in ``prng``: draws keyed by ``seed | stream | index``
instead of taken in order, and a permutation that can be evaluated at one position. The second is
what keeps an exact ``percent=`` exact — the quota is laid out and then shuffled by a bijection
nobody has to materialize. The same trick carries everything that divides a column into shares:
``<mix>``, weighted packs, weighted file columns, ``repeat=`` lengths, and the length groups of a
weighted number.

What this engine will not do, it refuses BY NAME rather than approximating. A weighted choice
inside ``advanced_regex``, a percent-weighted ``uniq``, a template address that interpolates a
field: each needs the whole column at once, and answering from one row would produce data that
looks right and is not. Those configs belong to another engine, and the router sends them there.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from ..compute import evaluate as compute_evaluate
from ..date import gen as date_gen
from ..distribution import hamilton, percent_mask
from ..expr import as_condition
from ..expr.match_key import match_key
from ..format import interpolate
from ..format.mask import apply_mask
from ..format.transforms import apply_case, is_case_transform
from ..generators import advanced_regex, imperfections, number, quantile
from ..generators import counter as counter_gen
from ..generators import date_offset as date_offset_gen
from ..generators import file as file_gen
from ..generators import formula as formula_gen
from ..generators import repeat as repeat_gen
from ..lib import numbers
from ..model.config import Case, Config, Gen, Line, SequenceSpec
from ..packs import DataPacks
from ..pattern import gen as patterns
from ..prng import permute, seekable
from ..prng.prng import create
from ..sequence import assertions
from ..sequence import pool as pool_mod
from ..stats import timeseries
from . import memory
from .memory import composes_own_value

# The types whose value is built here, and whose modifiers therefore apply here too.
INLINE_TYPES = frozenset({"text", "increment", "decrement", "timeseries", "pattern"})

# How many redraws <distinct> gets before it gives up. A fuse, not a tuning knob: without one,
# three fields over a pool of two values would loop for as long as the run lasts and look like a
# hang rather than the impossible request it is.
DISTINCT_FUSE = 64

# Beyond this many combinations a uniq index no longer fits a double exactly.
SAFE_UNIQ_CAP = 9007199254740992


class UnsupportedError(RuntimeError):
    """A config this engine cannot answer row by row; the router picks another.

    The message is carried verbatim. A prefix added here would reach the user only because of
    which package they installed, and would land on refusals that already word themselves fully
    — which is how one refusal came to read four ways across the five implementations.
    """


def unsupported(feature: str, name: str) -> UnsupportedError:
    """The one refusal sentence, worded as the reference words it."""
    return UnsupportedError(
        f'stream mode: {feature} ("{name}") is not supported yet — '
        'run without mode="stream" (the in-memory engine handles it), or remove it.'
    )


class StreamError(RuntimeError):
    """A config this engine understands and still cannot satisfy."""


Column = Callable[[int], "str | None"]


def _case_carries_percent(case: Case | None) -> bool:
    """Does this ``<case>`` body declare a share that the denominator has to be right for?"""
    if case is None:
        return False
    return any(
        (part.mix is not None and (part.mix.percent or "").strip() != "")
        or (part.gen is not None and part.gen.attr("percent").strip() != "")
        for part in case.parts
    )


@dataclass(frozen=True, slots=True)
class Domain:
    """The rows a sequence applies to: how many, and where a given row sits among them."""

    size: int
    pop_index_at: Callable[[int], int | None]


@dataclass(frozen=True, slots=True)
class Parent:
    """What a column has to expose to be a parent: its values, their quotas, and a child's rank."""

    has_value: Callable[[str], bool]
    quota_of: Callable[[str], int]
    child_rank_at: Callable[[int, str], int | None]


@dataclass(frozen=True, slots=True)
class Built:
    """One generator's contribution: its column, whether a child may filter on it, and its flag."""

    column: Column
    parent: Parent | None = None
    flag_name: str | None = None
    flag: Column | None = None


def _draw_pool_member(
    seed: str, ref_name: str, candidates: list[int], row: int, attempt: int
) -> int:
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


class StreamEngine:
    __slots__ = (
        "base_dir",
        "columns",
        "config",
        "count",
        "exact_uniq",
        "now_millis",
        "on_progress",
        "on_uniq_plan",
        "packs",
        "parents",
        "pool_tables",
        "seed",
        "uniq_plan",
    )

    def __init__(
        self,
        config: Config,
        packs: DataPacks,
        now_millis: int,
        base_dir: Path | None,
        exact_uniq: bool = False,
        on_progress=None,
        uniq_plan=None,
        on_uniq_plan=None,
    ) -> None:
        self.uniq_plan = uniq_plan
        self.on_uniq_plan = on_uniq_plan
        self.config = config
        self.packs = packs
        self.now_millis = now_millis
        self.base_dir = base_dir
        self.seed = config.seed
        self.count = config.count
        self.columns: dict[str, Column] = {}
        self.parents: dict[str, Parent] = {}
        self.exact_uniq = exact_uniq
        self.on_progress = on_progress
        # Pools are computed before anything streams — small, and off a derived seed, so the
        # bounded-memory promise is untouched and no other column moves.
        self.pool_tables = memory.build_pool_tables(config, packs, now_millis, base_dir)
        self._build_columns()
        # Same check the in-memory engine makes, on the same finished run — an assertion that
        # only held on one engine would be a check that depends on how the file was produced.
        assertions.check(
            config.asserts,
            config.sequences,
            self.value,
            lambda name: name in self.columns,
            self.count,
        )

    # ── the public shape ────────────────────────────────────────────────────────────────────

    def sequence_names(self) -> list[str]:
        return [name for name in self.columns if not name.startswith("_")]

    def value(self, column: str, row: int) -> str | None:
        found = self.columns.get(column)
        return None if found is None else found(row)

    def text(self) -> str:
        out: list[str] = []
        self.write_to(out.append)
        return "".join(out)

    def write_to(self, emit: Callable[[str], None]) -> None:
        """Straight to a sink, one record at a time.

        Nothing accumulates: a caller can hand this a file writer and the run's memory stays flat
        however many records it produces.
        """
        self.write_rows(emit, 0, self.count)

    def write_rows(self, emit: Callable[[str], None], start: int, stop: int) -> None:
        """Rows ``[start, stop)`` only, formatted as if the whole run were being written.

        The opening fixture belongs to the run rather than to a row, so it goes out only with the
        shard that starts at zero, and the closing one only with the shard that ends at the last
        row; the block delimiter still looks at the run's real length, so the piece that ends
        mid-run keeps its trailing separator. Concatenating consecutive shards therefore gives
        exactly the bytes ``write_to`` would have produced — which is what lets several processes
        split one run between them (see ``engine/parallel.py``).
        """
        fx = self.config.fixtures
        each_info = self._each_info()

        if start == 0:
            self._emit(emit, fx.before, 0, each_info)
        # About one report per half-percent: cheap enough to leave on always.
        total = stop - start
        report_every = max(1, total // 200)
        for row in range(start, stop):
            if self.on_progress is not None and (row - start) % report_every == 0:
                self.on_progress("render", row - start, total)
            self._emit(emit, fx.before_block, row, each_info)

            active = [
                line
                for line in self.config.block
                if line.if_expr is None or self._condition(line.if_expr, row)
            ]
            # The OUTPUT lines, not the <line> ELEMENTS — see the note in the in-memory
            # engine. The two must agree byte for byte, so they count the same thing.
            emitted: list[str] = []
            for line in active:
                emitted.extend(self._render_line(line, row, each_info))
            for i, text in enumerate(emitted):
                self._emit(emit, fx.before_line, row, each_info)
                emit(text)
                self._emit(emit, fx.after_line, row, each_info)
                if i < len(emitted) - 1:
                    self._emit(emit, fx.delimiter_line, row, each_info)

            self._emit(emit, fx.after_block, row, each_info)
            if row < self.count - 1:
                self._emit(emit, fx.delimiter_block, row, each_info)
        if stop == self.count:
            self._emit(emit, fx.after, self.count - 1, each_info)
        # Said at the end as well as along the way: a phase a watcher sees CLOSE is a phase it
        # can tell from a stall. The sweep above reports every half-percent and so stops short.
        if self.on_progress is not None:
            self.on_progress("render", total, total)

    # ── pools ───────────────────────────────────────────────────────────────────────────────

    def _pool_candidates(self, params, row: int) -> list[int]:
        """The members row ``row`` may draw from: all of them, or what a ``filter=`` leaves."""
        _, pool_name, table, expression, equality, buckets = params
        if not expression:
            return list(range(table.count))
        if equality and buckets is not None:
            driver = self.columns.get(equality[1])
            wanted = driver(row) if driver else ""
            eligible = buckets.get(match_key(wanted or ""), [])
            detail = f''' ({equality[1]}="{wanted or ""}")'''
        else:
            read: dict[str, str] = {}
            eligible = pool_mod.eligible_members(
                expression,
                table,
                lambda n, r=row: (self.columns[n](r) or "") if n in self.columns else None,
                read,
            )
            detail = pool_mod.row_values_detail(read)
        if not eligible:
            raise ValueError(pool_mod.no_candidate_message(pool_name, expression, row, detail))
        return eligible

    def _pool_member_alone(self, params, row: int) -> int:
        """This reference's own pick, with no group having a say."""
        return _draw_pool_member(
            self.config.seed, params[0], self._pool_candidates(params, row), row, 0
        )

    def _pool_member_in_group(self, group, wanted: str, row: int) -> int:
        """Walk the group in declaration order; a member already taken is drawn again."""
        taken: list[int] = []
        for params in group:
            ref_name = params[0]
            candidates = self._pool_candidates(params, row)
            pick = _draw_pool_member(self.config.seed, ref_name, candidates, row, 0)
            if pick in taken:
                free = [m for m in candidates if m not in taken]
                if not free:
                    raise ValueError(
                        f"<distinct> across sequences: row {row} has no member left for "
                        f'"{ref_name}" — the sequences in this group have taken every candidate '
                        f"the pool offers. A group of {len(group)} references needs "
                        f"{len(group)} members to choose from."
                    )
                pick = _draw_pool_member(self.config.seed, ref_name, free, row, 1)
            if ref_name == wanted:
                return pick
            taken.append(pick)
        return 0

    def _pool_group(self, spec, params):
        """The `<distinct>` group this reference belongs to, whole, or ``None``."""
        name = spec.name or ""
        group = next(
            (g for g in self.config.env_distinct_groups if name in g),
            None,
        )
        if group is None:
            return None
        members = []
        for other_name in group:
            if other_name == name:
                members.append(params)
                continue
            other = next((s for s in self.config.sequences if s.name == other_name), None)
            if other is None or other.gen is None or other.gen.type != "pool":
                continue
            other_pool = (other.gen.attrs.get("value") or "").strip()
            other_table = self.pool_tables.get(other_pool)
            if other_table is None or other_table.count < 1:
                continue
            other_expr = (other.gen.attrs.get("filter") or "").strip()
            other_eq = (
                None
                if not other_expr
                else pool_mod.parse_equality_filter(
                    other_expr, other_table, lambda n: n in self.columns
                )
            )
            other_buckets = (
                pool_mod.bucket_by_field(other_table, other_eq[0]) if other_eq else None
            )
            members.append(
                (other_name, other_pool, other_table, other_expr, other_eq, other_buckets)
            )
        return members if len(members) >= 2 else None

    def _build_pool_reference(self, spec) -> None:
        """A pool reference as LAZY columns.

        A pool is small and computed before the run starts, so it never threatens the streaming
        engines' bounded memory: what streams is the two thousand patients, not the thirty
        doctors. And because the member pick is seekable by row, row 900,000 gets its doctor
        without the 899,999 before it existing — the same member the in-memory engine hands it.
        """
        pool_name = (spec.gen.attrs.get("value") or "").strip()
        table = self.pool_tables.get(pool_name)
        if table is None or table.count < 1:
            return  # unknown pool — the validator reports it

        name = spec.name or ""
        expression = (spec.gen.attrs.get("filter") or "").strip()
        equality = (
            None
            if not expression
            else pool_mod.parse_equality_filter(expression, table, lambda n: n in self.columns)
        )
        buckets = pool_mod.bucket_by_field(table, equality[0]) if equality else None

        params = (name, pool_name, table, expression, equality, buckets)
        # If a config-level `<distinct>` holds this reference, remember the whole group
        # against its name. Built from the config, because a sibling's pick is not a column.
        group = self._pool_group(spec, params)

        def member_at(row: int) -> int:
            # Inside a group the answer is not this reference's alone: the ones declared
            # before it have already taken members out of this row.
            if group is not None:
                return self._pool_member_in_group(group, name, row)
            return self._pool_member_alone(params, row)

        for field_name in table.fields:
            column = table.columns.get(field_name, [])

            def resolve(row: int, col=column) -> str:
                m = member_at(row)
                return col[m] if m < len(col) else ""

            self.columns[f"{name}.{field_name}"] = resolve

    # ── columns ─────────────────────────────────────────────────────────────────────────────

    def _build_columns(self) -> None:
        count = self.count
        self.columns["_count"] = lambda row: str(row + 1)
        self.columns["_first"] = lambda row: "true" if row == 0 else "false"
        self.columns["_last"] = lambda row: "true" if row == count - 1 else "false"
        self.columns["_total"] = lambda row: str(count)

        by_name = {spec.name: spec for spec in self.config.sequences}

        for spec in self.config.sequences:
            # A reference to a <pool>. The table was computed before the run, so only the per-row
            # PICK happens here — and it is seekable, so it costs the streaming engines nothing.
            # A reference under a parent needs the parent's materialised column to know which rows
            # exist at all, so that one goes to the in-memory engine rather than being guessed at.
            if spec.gen is not None and spec.gen.type == "pool":
                if spec.parent:
                    raise unsupported("a pool reference with parent=", spec.name)
                # A `<uniq>` over references keeps its promise by REARRANGING the picks, and
                # an arrangement cannot be found a row at a time — it needs the whole column.
                # `<distinct>` is settled per row and streams fine; this one goes to memory,
                # the same way a running total does.
                if any(spec.name in g for g in self.config.env_uniq_groups):
                    raise unsupported(
                        "a pool reference inside a config-level <uniq>", spec.name
                    )
                self._build_pool_reference(spec)
                continue
            # A running total is the one construct that genuinely cannot be answered from a
            # row index: row 900,000,000 IS the sum of everything before it. That is not a
            # gap in the streaming builder, it is what "running" means — so it is refused by
            # name and the router hands the config to the in-memory engine.
            if spec.gen is not None and spec.gen.type == "running":
                raise UnsupportedError(
                    f'a running total ("{spec.name}") is the accumulation of every row before '
                    "it, so it cannot be computed one row at a time; the in-memory engine "
                    "handles it (run without a forced streaming engine)"
                )
            # A statistic over the whole run is the stronger form of the same thing: it is not
            # knowable from the rows SO FAR either, because the rows after this one are part of
            # the answer. Refused by name, and the router hands the config to memory.
            if spec.gen is not None and spec.gen.type == "stat":
                raise UnsupportedError(
                    f'a statistic ("{spec.name}") is computed over every row of the run, '
                    "including the ones after this one, so it cannot be computed one row at a "
                    "time; the in-memory engine handles it (run without a forced streaming "
                    "engine)"
                )
            # A pack generator whose value is a whole-column quota — because the body declares a
            # share, or because it DRAWS from a weighted list. Either way the apportionment is
            # over the run, and computing it a row at a time hands every row to the largest
            # share: `hu.person.male.fullName` returned "Nagy László" on all six rows of a
            # six-row run, here, silently, while the reference refused the same config. The
            # router already sends such a config to memory; this is the backstop for a forced
            # streaming engine, and its absence is what let the wrong answer out.
            if self._pack_needs_whole_column(spec.gen):
                # …unless this engine can plan the body over the column itself, which it now
                # can: the body's own sequences are built by a nested engine at the COLUMN's
                # count, so the share is apportioned over the column and each row mapped into
                # it, exactly as a top-level `percent=` sequence has always been.
                if self._build_whole_column_pack(spec):
                    continue
                raise UnsupportedError(
                    f'a pack generator ("{spec.name}") whose value is apportioned across the '
                    "whole column cannot be resolved one row at a time — every row would take "
                    "the largest share; the in-memory engine handles it (run without a forced "
                    "streaming engine)"
                )
            # A date measured from another date reads a SIBLING column as the row is built,
            # and the streaming path has no way to do that yet — the same reason a dynamic
            # template defers. Refused by name, and the router hands the config to memory.
            if date_offset_gen.is_offset(spec.gen):
                raise UnsupportedError(
                    f'a date measured from another column ("{spec.name}") reads that column as '
                    "the row is built, and the streaming path has no way to do that yet; the "
                    "in-memory engine handles it (run without a forced streaming engine)"
                )
            if spec.uniq:
                self._build_uniq(spec)
                continue
            if spec.is_conditional:
                self._build_conditional(spec)
                continue
            if spec.is_switch:
                self._build_switch(spec)
                continue
            if spec.is_computed:
                # Derived from other columns and nothing else, so it resolves per row for free.
                self.columns[spec.name or ""] = self._computed_column(spec)
                continue
            if spec.is_mix:
                # "#switch" is what the reference keys a top-level mix by — the construct was
                # named that before it was named <mix>, and the stream id is part of the seed
                # contract.
                self._register(
                    spec.name or "",
                    self._build_mix(f"{spec.name}#switch", spec.mix, self._domain_of(spec)),
                )
                continue
            if spec.is_composed:
                self._build_composed(spec)
                continue
            if spec.is_compound:
                self._build_compound(spec)
                continue
            self._register(
                spec.name or "",
                self._build_gen(spec.name or "", spec.gen, self._domain_of(spec)),
            )

        for group in self.config.env_distinct_groups:
            self._apply_env_distinct(group, by_name)

        # Env-level <uniq> comes last, for the same reason <distinct> comes second-to-last: the
        # constraint is about a tuple, so every member has to exist before it can be looked at.
        for group in self.config.env_uniq_groups:
            self._apply_env_uniq(group, by_name)

    def _computed_column(self, spec: SequenceSpec) -> Column:
        def column(row: int) -> str | None:
            return compute_evaluate(spec.compute, lambda name: self._value_or_none(name, row))

        return column

    def _register(self, name: str, built: Built) -> None:
        self.columns[name] = built.column
        if built.parent is not None:
            self.parents[name] = built.parent
        if built.flag_name is not None and built.flag is not None:
            self.columns[built.flag_name] = built.flag

    def _build_composed(self, spec: SequenceSpec) -> None:
        """The body in declaration order, each part on a stream of its own.

        Parts are numbered among the UNNAMED ones (``#p0``, ``#p1``, …), so adding a literal
        between two gens moves nothing. A row outside the parent's filter has no value in any part,
        and the composed cell is absent rather than a string of bare literals.
        """
        assert spec.items is not None
        domain = self._domain_of(spec)
        parts: list[str | Column] = []
        fields: dict[str, Column] = {}
        unnamed = 0
        # A named field that draws, read only when no unnamed part does. It answers the one
        # question the literals cannot — whether this row is inside the parent's filter — so the
        # ordinary path costs nothing.
        witness: Column | None = None

        for item in spec.items:
            if item.constant_name is not None:
                constant = item.text or ""
                column = _constant_column(domain, constant)
                self.columns[f"{spec.name}.{item.constant_name}"] = column
                continue
            if item.text is not None:
                parts.append(item.text)
                continue
            if item.field is not None:
                built = self._build_gen(f"{spec.name}.{item.field.name}", item.field.gen, domain)
                self.columns[f"{spec.name}.{item.field.name}"] = built.column
                fields[item.field.name] = built.column
                if witness is None:
                    witness = built.column
                continue
            built = self._build_gen(f"{spec.name}#p{unnamed}", item.gen, domain)
            unnamed += 1
            parts.append(built.column)

        self._apply_distinct(spec, fields)

        if not composes_own_value(spec.items):
            return

        drawn = unnamed

        def column(row: int) -> str | None:
            text = ""
            active = False
            for part in parts:
                if isinstance(part, str):
                    text += part
                    continue
                value = part(row)
                if value is None:
                    continue
                active = True
                text += value
            if drawn:
                return text if active else None
            # Nothing unnamed draws here, so the value is the literals alone — constant, but
            # still absent on a row this sequence does not apply to. A named field draws for
            # exactly those rows and is asked instead.
            if witness is not None and witness(row) is None:
                return None
            return text

        self.columns[spec.name or ""] = column

    def _build_compound(self, spec: SequenceSpec) -> None:
        assert spec.fields is not None
        domain = self._domain_of(spec)
        fields: dict[str, Column] = {}
        for f in spec.fields:
            # A field's column only: the fields of a compound are parts of one thing, and a
            # parent= or an anomaly_flag= pointing at one is not something the reference offers.
            built = self._build_gen(f"{spec.name}.{f.name}", f.gen, domain)
            self.columns[f"{spec.name}.{f.name}"] = built.column
            fields[f.name] = built.column
        self._apply_distinct(spec, fields)

    def _domain_of(self, spec: SequenceSpec) -> Domain:
        """The rows a sequence covers.

        A child of ``parent="Gender.Male"`` exists only on the male rows, and its own draws are
        numbered WITHIN that subset — otherwise the values it produces would depend on how many
        rows the parent happened to give it, which is not knowable one row at a time.
        """
        reference = _trim_to_none(spec.parent)
        if reference is None:
            return Domain(self.count, lambda row: row)
        dot = reference.find(".")
        if dot < 0:
            raise unsupported(f'bare parent="{reference}" (use parent="Name.Value")', spec.name)
        parent_name = reference[:dot]
        parent_value = reference[dot + 1 :]

        parent = self.parents.get(parent_name)
        if parent is None:
            raise unsupported(
                f'parent "{parent_name}" (the parent must be a finite-value '
                "<sequence> declared earlier)",
                spec.name,
            )
        if not parent.has_value(parent_value):
            raise StreamError(
                f'sequence "{spec.name}" filters on parent value "{reference}", '
                "which the parent never produces."
            )
        return Domain(
            parent.quota_of(parent_value), lambda row: parent.child_rank_at(row, parent_value)
        )

    # ── one generator ───────────────────────────────────────────────────────────────────────

    def _build_gen(self, stream_id: str, gen: Gen, domain: Domain) -> Built:
        attrs = gen.attrs
        type_ = gen.type

        if type_ == "advanced_regex" and advanced_regex.has_weighted_choice(attrs.get("value", "")):
            # Its shares are exact over a whole column; a per-row draw would send every row to the
            # largest branch and look plausible doing it.
            raise unsupported('advanced_regex weighted choice "(?%{…})"', stream_id)
        if type_ == "http":
            # A network call is not a draw: neither reproducible from a row index nor
            # answerable synchronously, which is what a lazy per-row resolver needs.
            raise UnsupportedError(
                f'<gen type="http"> ("{stream_id}") is a network call, so it is neither '
                "reproducible nor answerable one row at a time; the in-memory engine "
                "handles it (run without a forced streaming engine)"
            )
        if type_ == "template" and "${{" in attrs.get("value", ""):
            raise UnsupportedError(
                f'template value "{attrs.get("value", "")}" interpolates a field; '
                "the in-memory engine resolves it per row"
            )

        # An empty subset — a parent value with no rows of its own. Always inactive.
        if domain.size == 0:
            return Built(lambda row: None)

        weight_column = _trim_to_none(attrs.get("weight")) if type_ == "file" else None
        if weight_column is not None and _trim_to_none(attrs.get("row")) is not None:
            raise UnsupportedError(
                "weight= combined with row= needs an exact quota over the whole file; "
                "the in-memory engine handles it (run without a forced streaming engine)"
            )
        weighted_pack = self._weighted_template_pack(gen)

        repeat = repeat_gen.parse(attrs)
        mod = self._modifier_for(stream_id, attrs, 1 if repeat is None else repeat.max)

        # The lengths of a repeating cell are themselves an exact quota, planned before any value
        # exists so a row's slice follows from its own position rather than from its predecessors.
        repeat_plan = (
            None
            if repeat is None
            else repeat_gen.plan(
                repeat,
                domain.size,
                hamilton.counts_per_value(
                    domain.size,
                    repeat_gen.length_percents(repeat),
                    create(f"{self.seed}|{stream_id}|replen"),
                ),
            )
        )
        repeat_key = permute.key(self.seed, f"{stream_id}#replen")

        def repeat_pos_at(row: int) -> int | None:
            r = domain.pop_index_at(row)
            return None if r is None else permute.permute(r, domain.size, repeat_key)

        # order="sequential": row r takes element r mod N. Index-based, so it needs no draw.
        if type_ in ("text", "file") and attrs.get("order") == "sequential" and not weight_column:
            values = (
                file_gen.load(attrs, self.base_dir, self.packs.data_roots)
                if type_ == "file"
                else _split_text(attrs.get("value", ""))
            )
            cycle = attrs.get("cycle") != "false"

            def sequential(row: int) -> str | None:
                r = domain.pop_index_at(row)
                return None if r is None else _pick_sequential(values, r, cycle)

            return self._inline_built(mod, sequential, stream_id, gen, domain)

        # The same rule over a date range. The axis is arithmetic rather than a list, which is
        # what lets this stay seekable and bounded however long the range is.
        if type_ == "date" and attrs.get("order") == "sequential":
            axis = date_gen.date_axis(
                attrs, attrs.get("local") or self.config.locale, self.now_millis
            )
            cycle = attrs.get("cycle") != "false"

            def walked(row: int) -> str | None:
                r = domain.pop_index_at(row)
                if r is None:
                    return None
                # An OPEN axis has no size and never wraps: row r is simply the r-th step.
                if axis.size is None:
                    return axis.at(r)
                return axis.at(memory.sequential_index(axis.size, r, cycle))

            return self._inline_built(mod, walked, stream_id, gen, domain)

        if type_ in ("increment", "decrement"):
            up = type_ == "increment"

            def counted(row: int) -> str | None:
                r = domain.pop_index_at(row)
                if r is None:
                    return None
                return counter_gen.value_at(attrs, r, up)

            return self._inline_built(mod, counted, stream_id, gen, domain)

        if type_ == "timeseries":
            spec = timeseries.parse(attrs)
            noisy = spec.has_noise()

            def series(row: int) -> str | None:
                r = domain.pop_index_at(row)
                if r is None:
                    return None
                z = 0.0
                if noisy:
                    u = seekable.uniforms(self.seed, f"{stream_id}:ts", row, 2)
                    z = timeseries.standard_normal(u[0], u[1])
                return numbers.to_fixed(timeseries.value_at(spec, r, z), spec.decimals)

            return self._inline_built(mod, series, stream_id, gen, domain)

        if type_ == "pattern":
            drawing = patterns.of(attrs, self.base_dir, self.packs.data_roots)
            draws = patterns.draws(drawing)
            denom = domain.size - 1 if domain.size > 1 else 1

            def drawn(row: int) -> str | None:
                r = domain.pop_index_at(row)
                if r is None:
                    return None
                u = seekable.uniforms(self.seed, f"{stream_id}:pat", row, 1)[0] if draws else 0.0
                return patterns.value_at(drawing, r / denom, u)

            return self._inline_built(mod, drawn, stream_id, gen, domain)

        # Arithmetic over the columns beside it. It needs only its OWN row, so unlike a running
        # total it streams: the lazy registry answers the siblings at the same row, and nothing is
        # carried between rows.
        if type_ == "formula":
            source = formula_gen.expression_of(attrs)
            decimals = formula_gen.decimals_of(attrs)

            def computed(row: int) -> str | None:
                r = domain.pop_index_at(row)
                if r is None:
                    return None
                answer = formula_gen.value_at_row(
                    source,
                    decimals,
                    lambda name, rr=row: (
                        (self.columns[name](rr) or "") if name in self.columns else None
                    ),
                    lambda name: name in self.columns,
                    r,
                )
                return "" if answer is None else answer

            return Built(_wrap(mod, computed))

        # `read="quantile"` reads the file as a sorted sample. The DRAWN form needs no branch —
        # one uniform per row, so the generic per-row path answers it identically. The EXACT
        # sweep does need one: it maps the row into a scatter over the WHOLE run, and the generic
        # path is handed a count of one and could not know how many rows there are.
        if type_ == "file" and quantile.is_quantile(attrs) and quantile.is_exact_sample(attrs):
            values = file_gen.load(attrs, self.base_dir, self.packs.data_roots)
            src = quantile.source(values, (attrs.get("src") or "").strip())
            decimals = quantile.decimals_for(attrs, src)
            sweep_key = permute.key(self.seed, stream_id)
            size = domain.size

            def swept(row: int) -> str | None:
                r = domain.pop_index_at(row)
                if r is None:
                    return None
                return quantile.exact_at(src, decimals, size, sweep_key, r)

            return Built(_wrap(mod, swept))

        # A row-linked file: every field on the key must land on the same record for a given row,
        # and a different one per row. The in-memory engine plans that for the whole column; here
        # the index is re-derived from a stream keyed by the LINK, so the fields agree without one.
        if type_ == "file" and not weight_column and _trim_to_none(attrs.get("row")) is not None:
            row_key = _trim_to_none(attrs.get("row"))
            source = file_gen.load_rows(attrs, self.base_dir, self.packs.data_roots)
            link_stream = f"filerowlink|{row_key}"

            def linked(row: int) -> str | None:
                if domain.pop_index_at(row) is None:
                    return None
                index = seekable.next_int(self.seed, link_stream, row, len(source.rows))
                return file_gen.cell_at(source, index)

            return Built(_wrap(mod, linked))

        # An exact quota: text, a weighted file column, or a weighted pack. All three say what
        # share of the run each value takes, and all three honour it the same way.
        if type_ == "text" or weight_column is not None or weighted_pack is not None:
            if weight_column is not None:
                weighted = file_gen.load_weighted(attrs, self.base_dir, self.packs.data_roots)
                assert weighted is not None
                values, percents = weighted.values, weighted.percents
            elif weighted_pack is not None:
                values, percents = weighted_pack
            else:
                values = _split_text(attrs.get("value", ""))
                percent_attr = attrs.get("percent")
                percents = (
                    percent_mask.expand(percent_attr, len(values))
                    if percent_attr
                    else _evenly(len(values))
                )
            return self._quota_column(
                stream_id, values, percents, domain, repeat, repeat_plan, repeat_pos_at, mod, attrs
            )

        # `length="2,10-12" percent="85,15"`: which length group a row gets is an exact quota over
        # the column, so it cannot come from the row's own draw — an apportionment over a single
        # cell always awards it to the largest share, turning 85/15 into 100/0. Plan the groups,
        # map the row into one, and let the digits still come from its own seekable draw.
        length_choices = number.weighted_length_choices(attrs)
        if length_choices is not None:
            percents = percent_mask.expand(attrs.get("percent", ""), len(length_choices))
            cum_hi = _cumulative(
                hamilton.counts_per_value(
                    domain.size, percents, create(f"{self.seed}|{stream_id}|lenpct")
                )
            )
            key = permute.key(self.seed, f"{stream_id}#lenpct")

            def by_length(row: int) -> str | None:
                r = domain.pop_index_at(row)
                if r is None:
                    return None
                group = length_choices[_run_for(cum_hi, permute.permute(r, domain.size, key))]
                pinned = Gen(type_, number.pin_length(attrs, group))
                return _first(
                    self._gen_values(
                        pinned,
                        seekable.generator(self.seed, stream_id, row),
                        None,
                        stream_id=stream_id,
                    )
                )

            return self._inline_built(mod, by_length, stream_id, gen, domain)

        # With `repeat`, each element of the cell is an independent draw on a stream of its own, so
        # the cell is reproducible without the row ever knowing what its neighbours produced.
        if repeat is not None:
            single = Gen(type_, repeat_gen.without(attrs))
            plan = repeat_plan
            assert plan is not None

            def repeated(row: int) -> str | None:
                p = repeat_pos_at(row)
                if p is None:
                    return None
                # A drawn generator has no pool to draw down, so `distinct` is rejection
                # sampling on fresh sub-streams — the same ids the reference uses, so the
                # two agree value for value.
                parts: list[str] = []
                for k in range(plan.length_at(p)):

                    def draw_at(suffix: str, k: int = k, row: int = row) -> str:
                        return _first(
                            self._gen_values(
                                single,
                                seekable.generator(self.seed, f"{stream_id}#e{k}{suffix}", row),
                                None,
                                stream_id=f"{stream_id}#e{k}{suffix}",
                            )
                        )

                    parts.append(
                        repeat_gen.redraw_until_fresh(parts, type_, draw_at)
                        if repeat.distinct
                        else draw_at("")
                    )
                return repeat_gen.join(parts, repeat)

            flag_name = _trim_to_none(attrs.get("anomaly_flag"))
            if flag_name is None or imperfections.parse_anomaly(attrs) is None:
                return Built(repeated)

            # With `repeat` the flag is a LIST parallel to the values: one boolean could not say
            # which element of the batch was the one that spiked.
            def repeated_flags(row: int) -> str | None:
                p = repeat_pos_at(row)
                if p is None:
                    return None
                # Under `distinct` the surviving value may have come off `#e{k}r3` rather
                # than the first attempt, so the flag has to be resolved on the SAME
                # sub-stream. Replaying the draw is what finds out which one won; asking
                # the first attempt would flag a value that was thrown away.
                flags = []
                seen: list[str] = []
                for k in range(plan.length_at(p)):
                    suffix = ""
                    if repeat.distinct:

                        def draw_at(s: str, k: int = k, row: int = row) -> str:
                            return _first(
                                self._gen_values(
                                    single,
                                    seekable.generator(self.seed, f"{stream_id}#e{k}{s}", row),
                                    None,
                                    stream_id=f"{stream_id}#e{k}{s}",
                                )
                            )

                        chosen, suffix = repeat_gen.redraw_until_fresh_at(seen, type_, draw_at)
                        seen.append(chosen)
                    spiked = [False]
                    self._gen_values(
                        single,
                        seekable.generator(self.seed, f"{stream_id}#e{k}{suffix}", row),
                        spiked,
                        stream_id=f"{stream_id}#e{k}{suffix}",
                    )
                    flags.append(str(spiked[0]).lower())
                return repeat.separator.join(flags)

            return Built(repeated, None, flag_name, repeated_flags)

        # Everything else draws independently, from a generator private to the row. Those types
        # apply their own modifiers inside, so this path must not wrap them again.
        def drawn_alone(row: int) -> str | None:
            r = domain.pop_index_at(row)
            if r is None:
                return None
            return _first(
                self._gen_values(
                    gen, seekable.generator(self.seed, stream_id, row), None, row, stream_id
                )
            )

        return Built(
            drawn_alone,
            None,
            _anomaly_flag_name(attrs),
            self._anomaly_flag_column(stream_id, gen, domain),
        )

    def _inline_built(self, mod, raw: Column, stream_id: str, gen: Gen, domain: Domain) -> Built:
        """An inline column, plus the ``anomaly_flag`` column beside it when one is declared.

        The types built here never route through the per-row builder, so the flag they would
        otherwise inherit from it has to be attached explicitly. Leaving it off did not fail
        loudly: the column simply did not exist, and ``${{IsOut}}`` reached the output as its
        own literal text.
        """
        return Built(
            _wrap(mod, raw),
            None,
            _anomaly_flag_name(gen.attrs),
            self._anomaly_flag_column(stream_id, gen, domain, raw),
        )

    def _anomaly_flag_column(
        self, stream_id: str, gen: Gen, domain: Domain, raw_at: Column | None = None
    ) -> Column | None:
        """The flag that marks which rows were spiked.

        It has to agree with the value on every row, so it is decided exactly the way the value's
        own outlier was: the seekable draw for the types built here, and a re-run of the row's own
        build for the types that draw independently. Deciding it any other way would give a flag
        that is right on average and wrong per row, which is worse than no flag at all.
        """
        anomaly = imperfections.parse_anomaly(gen.attrs)
        if anomaly is None or _trim_to_none(gen.attrs.get("anomaly_flag")) is None:
            return None
        inline = gen.type in INLINE_TYPES
        p = anomaly.probability
        # A cell ``missing=`` blanked has no spike left to label. The independently-drawn types
        # get this from the in-memory builder they re-run; the inline ones decide here, so the
        # same rule has to be written down twice.
        missing = imperfections.parse_missing(gen.attrs)
        miss_p = missing.probability if missing is not None else 0.0

        def flag(row: int) -> str | None:
            if domain.pop_index_at(row) is None:
                return None
            if inline:
                if (
                    miss_p > 0
                    and seekable.uniforms(self.seed, f"{stream_id}#miss", row, 1)[0] < miss_p
                ):
                    return "false"
                drawn = seekable.uniforms(self.seed, f"{stream_id}#anom", row, 1)[0]
                # Selection is only half of it: a spike replaces a NUMBER, so a selected word is
                # left exactly as it was. ``raw_at`` is the value BEFORE the modifiers ran — it
                # has to be the raw one, because once ``missing=`` has blanked a cell a word and
                # a spiked number look alike.
                raw = None if raw_at is None else raw_at(row)
                return str(drawn < p and _is_number(raw)).lower()
            spiked = [False]
            self._gen_values(
                gen, seekable.generator(self.seed, stream_id, row), spiked, stream_id=stream_id
            )
            return str(spiked[0]).lower()

        return flag

    def _gen_values(
        self,
        gen: Gen,
        prng,
        flags_out: list[bool] | None,
        row: int | None = None,
        stream_id: str | None = None,
    ) -> list[str]:
        """One row's worth of an independently-drawn generator.

        The values and the modifiers come off the SAME generator, in that order, because that is
        the order the in-memory engine takes them in. Splitting them across two streams would give
        a different column for the same seed, which is the one thing neither engine may do.
        """
        # A distribution parameter written as an expression reads a SIBLING column, so the
        # one-row run needs the registry the way the in-memory engine has it — and it needs to
        # know which row it is on, or `_count` and the sibling would both answer for row one.
        run = memory._Run(
            self.config,
            self.packs,
            self.now_millis,
            self.base_dir,
            prng,
            rows=None if row is None else [row],
            # The COLUMN's name travels with the one-row run under its OWN name, because the
            # in-memory engine's one-row path has it and anything derived from it has to come out
            # the same on both engines. A pack generator is the case that showed it: its body is
            # seeded from the column's identity. Not as ``stream_id``, deliberately — that would
            # switch on every whole-column layout inside a one-row build, and it changed what a
            # ``<distinct>`` redraw answered.
            column_stream_id=stream_id,
            value_at=lambda name, r: (
                (self.columns[name](r) or "") if name in self.columns else None
            ),
        )
        repeat = repeat_gen.parse(gen.attrs)
        if repeat is None:
            return memory._finish(
                memory._generate(gen, 1, run),
                gen.attrs,
                prng,
                [False] if flags_out is None else flags_out,
            )
        return repeat_gen.build(
            repeat,
            1,
            prng,
            lambda slots: memory._finish(
                memory._generate(gen, slots, run), gen.attrs, prng, [False] * slots
            ),
        )

    def _build_whole_column_pack(self, spec) -> bool:
        """Build a share-declaring pack body here, over the column, rather than refusing it.

        A nested engine over the body's own sequences, at this column's count and under a seed
        salted with this column's name — the same seed the in-memory engine gives the body, so
        the two assemble the same rows. Returns False for the one shape still left to memory: a
        body carrying its own ``<valid>``, where rejecting a row and redrawing it is a
        whole-column decision with no lazy form yet.
        """
        from dataclasses import replace as _replace

        from ..parser import config_builder

        gen = spec.gen
        address = gen.attrs.get("value", "")
        locale = gen.attrs.get("local") or self.config.locale
        try:
            entry = self.packs.load(address, locale)
        except (ValueError, OSError):
            return False
        source = entry.generator or ""
        if "<sequence" not in source and "<data" not in source:
            return False
        body = config_builder.parse_pack_body(source)
        if body.validate is not None:
            return False

        inner = StreamEngine(
            _replace(
                self.config,
                sequences=list(body.sequences),
                seed=f"{self.seed}|{spec.name}",
                count=self.count,
            ),
            self.packs,
            self.now_millis,
            self.base_dir,
        )
        inner._build_columns()
        output = body.output
        inject = self.config.inject

        def column(row: int) -> str | None:
            return interpolate.apply(
                output,
                inject,
                lambda name: (inner.columns[name](row) if name in inner.columns else None),
            )

        self.columns[spec.name] = column
        return True

    def _pack_needs_whole_column(self, gen: Gen | None) -> bool:
        """Is this ``<gen>`` a pack generator that only answers correctly over a whole column?"""
        if gen is None or gen.type != "template":
            return False
        address = gen.attrs.get("value", "")
        locale = gen.attrs.get("local") or self.config.locale
        if not address or "${{" in address:
            return False
        from . import router

        try:
            if not self.packs.exists(address, locale):
                return False
            return router._needs_whole_column(self.packs, address, locale)
        except (ValueError, OSError):
            # An address that does not resolve is the validator's problem, not this one's.
            return False

    def _weighted_template_pack(self, gen: Gen) -> tuple[list[str], list[float]] | None:
        """A ``<gen type="template">`` pointing at a pack that carries its own shares."""
        if gen.type != "template":
            return None
        address = gen.attrs.get("value", "")
        locale = gen.attrs.get("local") or self.config.locale
        # A synthetic address (person.b_day and its kind) is resolved inside the generator and has
        # no pack file behind it, so asking the registry for it would throw rather than answer.
        if not address or not self.packs.exists(address, locale):
            return None
        entry = self.packs.load(address, locale)
        return (entry.values, entry.percents) if entry.weighted and entry.percents else None

    def _quota_column(
        self, stream_id, values, percents, domain, repeat, repeat_plan, repeat_pos_at, mod, attrs
    ) -> Built:
        """A column whose values are apportioned exactly, resolved one row at a time.

        The counts are computed once — the same apportionment the in-memory engine uses — and laid
        out as contiguous runs of slots. A row asks the permutation which slot it owns and looks up
        the run that contains it. No row needs to know about any other, and the totals still come
        out exactly as declared.

        With ``repeat=`` the quota is planned over ELEMENTS rather than rows, because a row holding
        three values consumes three of them.
        """
        slot_count = repeat_plan.total_slots if repeat_plan is not None else domain.size
        counts = hamilton.counts_per_value(
            slot_count, percents, create(f"{self.seed}|{stream_id}|pct")
        )
        cum_hi = _cumulative(counts)
        key = permute.key(self.seed, stream_id)

        def slot_at(row: int, k: int) -> int | None:
            """The slot a row's k-th element owns, or ``None`` when the row is filtered out."""
            if repeat_plan is None:
                r = domain.pop_index_at(row)
                return None if r is None else permute.permute(r, slot_count, key)
            p = repeat_pos_at(row)
            if p is None:
                return None
            return permute.permute(repeat_plan.slot_start_at(p) + k, slot_count, key)

        if repeat is not None:

            def column(row: int) -> str | None:
                p = repeat_pos_at(row)
                if p is None:
                    return None
                # `distinct` cannot read a pre-laid-out slot — a row that must not repeat
                # itself has to CHOOSE. One uniform per pick off the row's own `#dist`
                # stream, budgeted at the maximum length, so the row still resolves alone
                # and the in-memory engine lands on the same values.
                if repeat.distinct:
                    draws = seekable.uniforms(self.seed, f"{stream_id}#dist", row, repeat.max)
                    counter = [0]

                    def next_uniform() -> float:
                        at = counter[0]
                        counter[0] += 1
                        return draws[at] if at < len(draws) else 1.0

                    picked = repeat_gen.draw_distinct(
                        values,
                        percents,
                        repeat_plan.length_at(p),
                        next_uniform,
                        lambda: "the value list",
                    )
                    return repeat_gen.join(
                        [
                            raw if mod is None else _none_to_empty(mod(row, raw, at))
                            for at, raw in enumerate(picked)
                        ],
                        repeat,
                    )
                parts = []
                for k in range(repeat_plan.length_at(p)):
                    slot = slot_at(row, k)
                    raw = "" if slot is None else values[_run_for(cum_hi, slot)]
                    parts.append(raw if mod is None else _none_to_empty(mod(row, raw, k)))
                return repeat_gen.join(parts, repeat)

        else:

            def base(row: int) -> str | None:
                slot = slot_at(row, 0)
                return None if slot is None else values[_run_for(cum_hi, slot)]

            column = _wrap(mod, base)

        # A finite set of values with known quotas is exactly what a child can filter on — unless
        # the cell holds a LIST, in which case parent="Name.value" has nothing coherent to match.
        repeating = repeat is not None

        def child_rank_at(row: int, value: str) -> int | None:
            slot = slot_at(row, 0)
            if slot is None or value not in values:
                return None
            i = values.index(value)
            lo = 0 if i == 0 else cum_hi[i - 1]
            # Its rank inside the run is its position among the rows that share this value.
            return slot - lo if lo <= slot < cum_hi[i] else None

        parent = Parent(
            has_value=lambda value: not repeating and value in values,
            quota_of=lambda value: counts[values.index(value)] if value in values else 0,
            child_rank_at=child_rank_at,
        )
        return Built(
            column,
            parent,
            _anomaly_flag_name(attrs),
            self._quota_flags(
                stream_id, values, cum_hi, slot_at, repeat, repeat_plan, repeat_pos_at, attrs
            ),
        )

    def _quota_flags(
        self, stream_id, values, cum_hi, slot_at, repeat, repeat_plan, repeat_pos_at, attrs
    ):
        """The ``anomaly_flag`` column beside an exactly-apportioned one.

        It used to be absent: this path returned no flag at all, so a declared
        ``anomaly_flag="Bad"`` registered nothing and ``${{Bad}}`` reached the output as its own
        literal text — a column of `${{Bad}}` in the data, from a config the reference renders
        correctly. The value and the draw are both functions of the row here, so the flag is
        computable one row at a time like everything else on this engine.

        It reports what HAPPENED, not what was selected: ``anomaly`` multiplies a number and
        leaves anything else alone, so a selected word is not an outlier and must not be marked.
        """
        anomaly = imperfections.parse_anomaly(attrs)
        if anomaly is None or _anomaly_flag_name(attrs) is None:
            return None
        element_draws = 1 if repeat is None else repeat.max

        def spiked_at(row: int, k: int) -> bool:
            slot = slot_at(row, k)
            if slot is None:
                return False
            raw = values[_run_for(cum_hi, slot)]
            drawn = seekable.uniforms(self.seed, f"{stream_id}#anom", row, element_draws)[k]
            if drawn >= anomaly.probability:
                return False
            return imperfections.is_spikeable(raw)

        def flag(row: int) -> str | None:
            if repeat is None:
                return None if slot_at(row, 0) is None else str(spiked_at(row, 0)).lower()
            p = repeat_pos_at(row)
            if p is None:
                return None
            # With `repeat` the flag is a LIST parallel to the values: one boolean could not say
            # which element of the batch was the one that spiked.
            return repeat_gen.join(
                [str(spiked_at(row, k)).lower() for k in range(repeat_plan.length_at(p))], repeat
            )

        return flag

    # ── mix, switch, conditional ────────────────────────────────────────────────────────────

    def _build_mix(self, stream_id: str, mix, domain: Domain) -> Built:
        """``<mix>``: several ways to build one value, in stated proportions.

        The same shape as a weighted text column — the shares are apportioned over the run and the
        row's slot decides its case — with one addition: each case gets a DOMAIN of its own, so a
        generator inside it is numbered within the rows that chose that case. Without that, two
        cases drawing from the same pack would take the same values in the same order.
        """
        cases = mix.cases
        flag_name = _trim_to_none(mix.flag)

        if domain.size == 0 or not cases:

            def empty(row: int) -> str | None:
                return None if domain.pop_index_at(row) is None else ""

            def flag(row: int) -> str | None:
                return None if domain.pop_index_at(row) is None else "false"

            return Built(empty, None, flag_name, None if flag_name is None else flag)

        percents = (
            percent_mask.expand(mix.percent, len(cases)) if mix.percent else _evenly(len(cases))
        )
        counts = hamilton.counts_per_value(
            domain.size, percents, create(f"{self.seed}|{stream_id}|pct")
        )
        cum_hi = _cumulative(counts)
        key = permute.key(self.seed, stream_id)

        def slot_at(row: int) -> int | None:
            r = domain.pop_index_at(row)
            return None if r is None else permute.permute(r, domain.size, key)

        resolvers = []
        for c in range(len(cases)):
            lo = 0 if c == 0 else cum_hi[c - 1]
            hi = cum_hi[c]
            case_domain = Domain(
                counts[c],
                lambda row, lo=lo, hi=hi: (
                    slot - lo if (slot := slot_at(row)) is not None and lo <= slot < hi else None
                ),
            )
            resolvers.append(self._case_resolver(cases[c], f"{stream_id}#c{c}", case_domain))

        def column(row: int) -> str | None:
            slot = slot_at(row)
            return None if slot is None else resolvers[_run_for(cum_hi, slot)](row)

        if flag_name is None:
            return Built(column)

        def flag_column(row: int) -> str | None:
            slot = slot_at(row)
            if slot is None:
                return None
            return str(cases[_run_for(cum_hi, slot)].anomaly).lower()

        return Built(column, None, flag_name, flag_column)

    def _case_resolver(self, case, stream_id: str, domain: Domain) -> Callable[[int], str]:
        """A case body assembled from its pieces: literal text, a generator, or a nested mix."""
        parts: list[Column] = []
        for p, part in enumerate(case.parts):
            if part.text is not None:
                parts.append(lambda row, text=part.text: text)
            elif part.gen is not None:
                parts.append(self._build_gen(f"{stream_id}#p{p}", part.gen, domain).column)
            elif part.mix is not None:
                # A nested mix contributes its value only; flag= is a top-level idea.
                parts.append(self._build_mix(f"{stream_id}#p{p}", part.mix, domain).column)
            else:
                parts.append(self._nested_switch(f"{stream_id}#p{p}", part.switch, domain))

        def resolve(row: int) -> str:
            return "".join(_none_to_empty(part(row)) for part in parts)

        return resolve

    def _nested_switch(self, stream_id: str, sw, domain: Domain) -> Column:
        """A ``<switch>`` written inside a ``<case>`` — the nested form.

        Every branch resolves over the SAME domain as the case it sits in. A branch's own rows
        are an intersection of two partitions — the enclosing branch's and the inner subject's
        — and there is no O(1) rank inside an intersection, which is what an exact share would
        need. So a nested branch that declares one is refused here and the router sends the
        config to the in-memory engine. A branch that declares none needs no rank: the row
        decides which branch answers, and both engines read the same row.
        """

        def refuse(where: str):
            return unsupported(
                f'a percentage inside {where} of a nested <switch on="{sw.on}">', stream_id
            )

        entries = []
        for e, entry in enumerate(sw.entries):
            if _case_carries_percent(entry.value):
                raise refuse(f'<case is="{"|".join(entry.keys)}">')
            entries.append(
                (entry.keys, self._case_resolver(entry.value, f"{stream_id}#sw{e}", domain))
            )
        if _case_carries_percent(sw.fallback):
            raise refuse("<default>")
        fallback = (
            None
            if sw.fallback is None
            else self._case_resolver(sw.fallback, f"{stream_id}#swdef", domain)
        )

        def column(row: int) -> str | None:
            key = _none_to_empty(self.value(sw.on, row))
            for keys, resolve in entries:
                if key in keys:
                    return resolve(row)
            return None if fallback is None else fallback(row)

        return column

    def _build_conditional(self, spec: SequenceSpec) -> None:
        # Over every row, and without the parent mask — matching the reference. A conditional
        # already says which rows it applies to through its own conditions.
        assert spec.branches is not None
        full = Domain(self.count, lambda row: row)
        made = [
            self._build_gen(f"{spec.name}#if{b}", branch.gen, full)
            for b, branch in enumerate(spec.branches)
        ]
        branches = [m.column for m in made]

        def column(row: int) -> str | None:
            for b, branch in enumerate(spec.branches):
                if branch.if_expr is None or self._condition(branch.if_expr, row):
                    return branches[b](row)
            return None

        self.columns[spec.name or ""] = column

        # A branch carrying ``anomaly_flag="NAME"`` mints the companion ground-truth column.
        # It answers over the SAME conditions: the row's flag comes from whichever branch
        # produced the row's value. A branch that did not declare this name answers ``false``
        # — not empty — because the row IS covered and "no outlier" is the truth about it;
        # a row no branch matched gets None, masking the flag exactly like the value.
        declared: list[str] = []
        for m in made:
            name = (m.flag_name or "").strip()
            if name and name not in declared:
                declared.append(name)
        for flag_name in declared:

            def flag_column(row: int, flag_name: str = flag_name) -> str | None:
                for b, branch in enumerate(spec.branches):
                    if branch.if_expr is not None and not self._condition(branch.if_expr, row):
                        continue
                    owner = (made[b].flag_name or "").strip()
                    if owner != flag_name or made[b].flag is None:
                        return "false"
                    return made[b].flag(row) or "false"
                return None

            self.columns[flag_name] = flag_column

    def _build_switch(self, spec: SequenceSpec) -> None:
        sw = spec.switch_spec
        full = Domain(self.count, lambda row: row)
        subject = self.parents.get(sw.on)

        def branch_domain(keys: list[str]) -> Domain | None:
            """The rows that chose this branch, numbered within themselves.

            Every branch used to get ``full``, which made a ``<mix percent="20,80">`` inside
            ``<case is="Male">`` apportion its 20% over ALL the rows; the ones that landed on
            female rows were then discarded. The subset was never out of reach — ``Parent``
            answers both questions a branch needs, and ``_domain_of`` uses them for
            ``parent="Gender.Male"`` today.

            One key only. A multi-key entry (``US|CA|MX``) is the union of subsets, and ranks
            across a union do not compose from the per-value ranks — the interleaving is what
            decides them. Refused below rather than approximated.
            """
            if subject is None or len(keys) != 1:
                return None
            key = keys[0]
            if not subject.has_value(key):
                return None
            parent = subject
            return Domain(parent.quota_of(key), lambda row: parent.child_rank_at(row, key))

        entries = []
        for e, entry in enumerate(sw.entries):
            domain = branch_domain(entry.keys)
            if domain is None and _case_carries_percent(entry.value):
                # Cannot be resolved lazily over the right subset, and resolving it over the
                # wrong one is what this change exists to stop. Refuse, and the run falls back
                # to the in-memory engine, which can.
                raise unsupported(
                    f'a percentage inside <case is="{"|".join(entry.keys)}"> of '
                    f'<switch on="{sw.on}">',
                    spec.name,
                )
            entries.append(
                self._case_resolver(
                    entry.value, f"{spec.name}#sw{e}", full if domain is None else domain
                )
            )

        if _case_carries_percent(sw.fallback):
            # <default> holds the rows no entry matched — a complement, which Parent does not
            # enumerate. Same refusal, same fallback.
            raise unsupported(f'a percentage inside <default> of <switch on="{sw.on}">', spec.name)
        fallback = (
            None
            if sw.fallback is None
            else self._case_resolver(sw.fallback, f"{spec.name}#swdef", full)
        )

        def column(row: int) -> str | None:
            key = _none_to_empty(self.value(sw.on, row))
            for e, entry in enumerate(sw.entries):
                if key in entry.keys:
                    return entries[e](row)
            return None if fallback is None else fallback(row)

        self.columns[spec.name or ""] = column

    # ── distinct ────────────────────────────────────────────────────────────────────────────

    def _apply_distinct(self, spec: SequenceSpec, fields: dict[str, Column]) -> None:
        """``<distinct>``: fields of one record that must not repeat each other.

        Two independent draws from the same pool collide about as often as chance says they
        should, which reads as a bug in a record where a person cannot be their own manager. The
        repair is per row and needs nothing else: a colliding field redraws on a fresh stream until
        it differs, and every implementation redraws in the same order on the same streams.
        """
        if spec.distinct_groups is None:
            return
        groups = [[f for f in group if f in fields] for group in spec.distinct_groups]
        groups = [g for g in groups if len(g) >= 2]
        if not groups:
            return

        assert spec.fields is not None
        gen_by_field = {f.name: f.gen for f in spec.fields}

        def repair(row: int) -> dict[str, str | None]:
            values = {name: column(row) for name, column in fields.items()}
            for group in groups:
                seen: set[str] = set()
                for field_name in group:
                    value = values[field_name]
                    if value is None:
                        continue  # an inactive row, filtered out by its parent
                    gen = gen_by_field.get(field_name)
                    attempt = 0
                    while value in seen and gen is not None:
                        attempt += 1
                        if attempt > DISTINCT_FUSE:
                            raise StreamError(
                                f'stream mode: <distinct> in sequence "{spec.name}": could not '
                                f'find a value for field "{field_name}" different from the others '
                                f"after {DISTINCT_FUSE} attempts — its source likely has too few "
                                "distinct values."
                            )
                        key = f"{spec.name}.{field_name}#d{attempt}"
                        value = _first(
                            self._gen_values(
                                gen,
                                seekable.generator(self.seed, key, row),
                                None,
                                stream_id=key,
                            )
                        )
                    values[field_name] = value
                    seen.add(value)
            return values

        memo = _RowRepair(repair)
        for field_name in {name for group in groups for name in group}:
            self.columns[f"{spec.name}.{field_name}"] = lambda row, name=field_name: memo.at(
                row
            ).get(name)

    def _apply_env_distinct(self, group: list[str], by_name) -> None:
        """Env-level ``<distinct>``: the named sequences differ from each other on every row.

        Layered over the columns already built rather than folded into them, because the constraint
        is between sequences that are otherwise independent. A collision redraws on a fresh stream,
        in a fixed order, so every implementation repairs the same row the same way.
        """
        members: list[str] = []
        gen_by_name: dict[str, Gen] = {}
        for name in group:
            member = by_name.get(name)
            if member is None or name not in self.columns:
                continue
            if member.is_mix:
                raise unsupported(f'<distinct> member "{name}" is a <mix>', name)
            if member.is_switch:
                raise unsupported(f'<distinct> member "{name}" is a <switch>', name)
            if member.gen is None:
                raise unsupported(f'<distinct> member "{name}" (must be a simple sequence)', name)
            members.append(name)
            gen_by_name[name] = member.gen
        if len(members) < 2:
            return

        base = {name: self.columns[name] for name in members}

        def repair(row: int) -> dict[str, str | None]:
            values = {name: base[name](row) for name in members}
            seen: set[str] = set()
            for name in members:
                value = values[name]
                if value is None:
                    continue  # an inactive row, filtered out by its parent
                attempt = 0
                while value in seen:
                    attempt += 1
                    if attempt > DISTINCT_FUSE:
                        raise StreamError(
                            "stream mode: <distinct> across sequences: could not find a value for "
                            f'sequence "{name}" different from the others after {DISTINCT_FUSE} '
                            "attempts — its source likely has too few distinct values."
                        )
                    value = _first(
                        self._gen_values(
                            gen_by_name[name],
                            seekable.generator(self.seed, f"{name}#ed{attempt}", row),
                            None,
                            stream_id=f"{name}#ed{attempt}",
                        )
                    )
                values[name] = value
                seen.add(value)
            return values

        memo = _RowRepair(repair)
        for name in members:
            self.columns[name] = lambda row, key=name: memo.at(row).get(key)

    # ── uniq ────────────────────────────────────────────────────────────────────────────────

    def _build_uniq(self, spec: SequenceSpec) -> None:
        """``uniq="true"``: no two records share the same combination.

        A group REARRANGES whole columns so each keeps its multiset — a promise about the
        finished column, which no engine can keep a row at a time. This one could only offer
        something else (a mixed-radix bijection over the combination space, uniform over
        combinations, ignoring the values actually drawn), and one seed would then mean two
        datasets. It says so instead. The router sends every uniq to the exact engine; this is
        the backstop for a forced one.
        """
        if self.exact_uniq:
            self._build_exact_uniq(spec)
            return
        raise unsupported("uniq (a whole-column rearrangement)", spec.name)

    def _apply_env_uniq(self, group: list[str], by_name) -> None:
        """Env-level ``<uniq>``: the tuple of several sequences is unique across the run.

        The in-memory engine draws the whole table, finds the repeated tuples and swaps values
        until none is left. That is exact and it does not scale: repeats grow as the SQUARE of the
        row count.

        Here the columns stay seekable — each is already a function of the row number — and only
        the repeats are touched. The repair streams every tuple through a sort to find them, which
        is bounded memory, then rearranges the few offenders in RAM. Its own refusal hands a
        pathologically tight config back to the in-memory engine, so nothing is lost when the
        space really is too small.

        **This changes the arrangement.** A repaired dataset is not the one the in-memory engine
        produced from the same seed. Both are correct — every tuple distinct, every column's
        multiset untouched, so the percentages hold — but they are different arrangements.
        """
        # Imported here: the exact engine and this one refer to each other.
        from . import exact_uniq

        members = [name for name in group if name in self.columns]
        if len(members) < 2:
            return
        label = " × ".join(members)

        resolvers = [
            (lambda row, column=self.columns[name]: column(row) or "") for name in members
        ]

        # The columns a switch member is keyed by. Empty for an ordinary group, and then every row
        # may trade with every other, as it always could.
        subjects: list[str] = []
        for name in members:
            spec = by_name.get(name)
            on = spec.switch_spec.on if spec is not None and spec.switch_spec is not None else None
            if on is not None and on not in subjects and on in self.columns:
                subjects.append(on)

        block_of: Callable[[int], str] | None = None
        if subjects:
            keyed = [self.columns[name] for name in subjects]
            # Any injective key groups the same rows; the separator cannot appear in a value.
            block_of = lambda row: exact_uniq.JOIN.join(  # noqa: E731
                column(row) or "" for column in keyed
            )

        # Told rather than worked out, when a coordinator already did it — and told back when
        # this IS the coordinator. The label is the key on both sides.
        plan = None
        if self.uniq_plan is not None or self.on_uniq_plan is not None:
            plan = exact_uniq.Plan(
                preset=(self.uniq_plan or {}).get(label),
                on_computed=(
                    None
                    if self.on_uniq_plan is None
                    else (lambda moved, key=label: self.on_uniq_plan(key, moved))
                ),
            )
        repaired = exact_uniq.repair(
            members,
            resolvers,
            self.count,
            f'"{label}"',
            self.base_dir,
            block_of,
            self.on_progress,
            plan,
        )
        for name in members:
            self.columns[name] = repaired[name]

    def _build_exact_uniq(self, spec: SequenceSpec) -> None:
        """Each column built to its declared shares, then verified distinct.

        Where the streaming version trades exact percentages for uniqueness, this one keeps both —
        at the cost of a pass over the run to check, and a repair when the check finds collisions.
        """
        # Imported here: the exact engine and this one refer to each other.
        from .exact_uniq import Field, arrange

        # A simple uniq is a draw WITHOUT REPLACEMENT over the whole column, not an arrangement
        # of fields — state neither disk engine holds. Refused so the caller falls back to the
        # in-memory engine, which is where that draw lives.
        if not spec.is_compound or not spec.fields:
            raise unsupported("uniq on a simple sequence (a whole-column draw)", spec.name)
        if _trim_to_none(spec.parent) is not None:
            raise unsupported("uniq combined with a parent", spec.name)
        fields = []
        for f in spec.fields:
            gen = f.gen
            if gen.type != "text":
                raise unsupported(
                    f'uniq field "{f.name}" of type "{gen.type}" (only text lists)', spec.name
                )
            values = list(dict.fromkeys(_split_text(gen.attrs.get("value", ""))))
            if not values:
                raise unsupported(f'uniq field "{f.name}" with an empty value list', spec.name)
            percent_attr = gen.attrs.get("percent")
            percents = (
                percent_mask.expand(percent_attr, len(values))
                if percent_attr
                else _evenly(len(values))
            )
            fields.append(Field(f"{spec.name}.{f.name}", values, percents))

        for name, resolver in arrange(
            fields, self.count, self.seed, f'"{spec.name}"', self.base_dir, self.on_progress
        ).items():
            self.columns[name] = resolver

    # ── modifiers ───────────────────────────────────────────────────────────────────────────

    def _modifier_for(self, stream_id: str, attrs: dict[str, str], element_draws: int):
        """The per-row passes an inline-built value still needs: outliers, blanks, formatting."""
        anomaly = imperfections.parse_anomaly(attrs)
        missing = imperfections.parse_missing(attrs)
        has_anomaly = anomaly is not None and anomaly.probability > 0
        has_missing = missing is not None and missing.probability > 0
        mask = attrs.get("mask")
        case_name = attrs.get("case")
        has_format = mask is not None or (case_name is not None and is_case_transform(case_name))

        if not has_anomaly and not has_missing and not has_format:
            return None

        def modify(row: int, value: str | None, element: int) -> str | None:
            if value is None:
                return None
            out = value
            # Each modifier draws on a stream of its own, so adding one never disturbs the values.
            # With `repeat` a row needs one draw per element, so the row's draws are pulled at once
            # and indexed — asking for one draw and asking for the first of many give the same
            # number.
            if has_anomaly:
                drawn = seekable.uniforms(self.seed, f"{stream_id}#anom", row, element_draws)[
                    element
                ]
                if drawn < anomaly.probability:
                    out = imperfections.spike(out, anomaly.factor)
            if has_missing:
                drawn = seekable.uniforms(self.seed, f"{stream_id}#miss", row, element_draws)[
                    element
                ]
                if drawn < missing.probability:
                    out = missing.token
            if mask is not None:
                out = apply_mask(mask, out)
            if case_name is not None and is_case_transform(case_name):
                out = apply_case(case_name, out)
            return out

        return modify

    # ── rendering ───────────────────────────────────────────────────────────────────────────

    def _each_info(self) -> dict[str, repeat_gen.Spec]:
        out: dict[str, repeat_gen.Spec] = {}
        for spec in self.config.sequences:
            if spec.gen is None:
                continue
            parsed = repeat_gen.parse(spec.gen.attrs)
            if parsed is not None and spec.name:
                out[spec.name] = parsed
        return out

    def _emit(self, emit, lines: list[Line], row: int, each_info) -> None:
        for line in lines:
            # A fixture line is one output line, and _render_line hands back the LINES.
            for text in self._render_line(line, row, {}):
                emit(text)

    def _render_line(self, line: Line, row: int, each_info) -> list[str]:
        template = "".join(
            part.text
            for part in line.parts
            if part.if_expr is None or self._condition(part.if_expr, row)
        )

        list_name = _trim_to_none(line.each) if line.each else None
        if list_name is None:
            return [interpolate.apply(template, self.config.inject, self._lookup(row)) + "\n"]

        spec = each_info.get(list_name)
        separator = repeat_gen.DEFAULT_SEPARATOR if spec is None else spec.separator
        elements = repeat_gen.split(_none_to_empty(self.value(list_name, row)), separator)

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
            lookup = self._element_lookup(row, list_name, element, k + 1, lane, stride)
            out.append(interpolate.apply(template, self.config.inject, lookup) + "\n")
        return out

    def _value_or_none(self, name: str, row: int) -> str | None:
        column = self.columns.get(name)
        if column is None:
            return None
        value = column(row)
        return "" if value is None else value

    def _lookup(self, row: int):
        return lambda name: self._value_or_none(name, row)

    def _element_lookup(self, row, list_name, element, position, lane, stride):
        overlay = {
            list_name: element,
            "_item": str(position),
            "_item_id": str(repeat_gen.item_key(row + 1, position, lane, stride)),
        }
        base = self._lookup(row)
        return lambda name: overlay[name] if name in overlay else base(name)

    def _condition(self, expression: str, row: int) -> bool:
        return as_condition(
            expression,
            lambda name: name in self.columns,
            lambda name: _none_to_empty(self.value(name, row)),
        )


class _RowRepair:
    """One row's repaired values, kept for as long as that row is the one being asked about.

    The fields of a row are asked for one after another, so a single-entry memo turns N lookups
    into one repair rather than N.
    """

    __slots__ = ("_compute", "_row", "_values")

    def __init__(self, compute) -> None:
        self._compute = compute
        self._row = -1
        self._values: dict[str, str | None] = {}

    def at(self, row: int) -> dict[str, str | None]:
        if row != self._row:
            self._values = self._compute(row)
            self._row = row
        return self._values


# ── entry points ────────────────────────────────────────────────────────────────────────────


def render(config: Config, packs: DataPacks, now_millis: int, base_dir: Path | None = None) -> str:
    return StreamEngine(config, packs, now_millis, base_dir).text()


def rows(
    config: Config,
    packs: DataPacks,
    now_millis: int,
    base_dir: Path | None = None,
    exact_uniq: bool = False,
    on_progress=None,
    uniq_plan=None,
    on_uniq_plan=None,
) -> StreamEngine:
    """The run as addressable records, computed on demand.

    Iterating this holds one row at a time, so a caller can walk a run far larger than memory and
    read the same values the in-memory engine would have given them.

    ``exact_uniq`` decides how a ``uniq="true"`` sequence is built: false gives uniform distinct
    combinations, which is all this engine can promise on its own; true builds each column to its
    exact quota instead and verifies the result on disk.
    """
    return StreamEngine(
        config, packs, now_millis, base_dir, exact_uniq, on_progress, uniq_plan, on_uniq_plan
    )


def plan_uniq(
    config: Config,
    packs: DataPacks,
    now_millis: int,
    base_dir: Path | None,
    exact_uniq: bool,
    on_progress,
    on_uniq_plan,
) -> None:
    """Work out every env-level ``<uniq>`` arrangement and produce not one row.

    Building the columns IS the analysis — that is where the collisions are found and the
    rearrangement decided — so this costs exactly one pass and hands each answer over as it lands.
    """
    StreamEngine(config, packs, now_millis, base_dir, exact_uniq, on_progress, None, on_uniq_plan)


# ── small helpers ───────────────────────────────────────────────────────────────────────────


def _run_for(cum_hi: list[int], slot: int) -> int:
    """Which run of the cumulative bounds holds this slot — binary search, for wide columns."""
    lo, hi = 0, len(cum_hi) - 1
    while lo < hi:
        mid = (lo + hi) >> 1
        if slot < cum_hi[mid]:
            hi = mid
        else:
            lo = mid + 1
    return lo


def _cumulative(counts: list[int]) -> list[int]:
    out = []
    acc = 0
    for c in counts:
        acc += c
        out.append(acc)
    return out


def _wrap(mod, column: Column) -> Column:
    return column if mod is None else (lambda row: mod(row, column(row), 0))


def _is_number(text: str | None) -> bool:
    """Whether a spike could have landed on this value — only a number can be multiplied."""
    if text is None:
        return False
    try:
        value = float(text.strip())
    except ValueError:
        return False
    return value == value and value not in (float("inf"), float("-inf"))


def _split_text(value: str) -> list[str]:
    return [part.strip() for part in value.split(",")]


def _evenly(n: int) -> list[float]:
    return [100.0 / n] * n


def _first(values: list[str]) -> str:
    return values[0] if values else ""


def _pick_sequential(values: list[str], index: int, cycle: bool) -> str:
    if not values:
        return ""
    if not cycle and index >= len(values):
        raise StreamError(
            f'order="sequential" cycle="false": the source has only {len(values)} values, '
            f"so row {index + 1} has none — shorten count= or lengthen the source"
        )
    return values[index % len(values)]


def _anomaly_flag_name(attrs: dict[str, str]) -> str | None:
    """The companion column named by ``anomaly_flag=``, or nothing when there is none."""
    return (
        None
        if imperfections.parse_anomaly(attrs) is None
        else _trim_to_none(attrs.get("anomaly_flag"))
    )


def _long_attr(raw: str | None, fallback: int) -> int:
    if raw is None or not raw.strip():
        return fallback
    return int(raw.strip())


def _none_to_empty(value: str | None) -> str:
    return "" if value is None else value


def _trim_to_none(value: str | None) -> str | None:
    if value is None:
        return None
    trimmed = value.strip()
    return trimmed or None


def _constant_column(domain: Domain, text: str) -> Column:
    """A constant field: the same value on every row the sequence covers, and no draw at all."""

    def column(row: int) -> str | None:
        return None if domain.pop_index_at(row) is None else text

    return column
