"""Which engine runs a config.

A config does not name an engine — it states a CONSTRAINT, and the router picks the fastest engine
that can honour it. ``mode="memory"`` means the whole run may be held at once; ``mode="disk"``
means it may not, and the choice between the two streaming engines follows from what the config
actually asks for. Naming an engine outright with ``engine="1|2|3"`` is available and skips all of
this, which is what makes it useful for a benchmark and a poor default for everything else.

The interesting decisions are the ones that route a disk-mode config BACK to memory. Each marks
something whose answer depends on the whole column — an interpolated pack address, an exact share
declared inside a pack, a weighted draw of a linked row. Answered a row at a time they do not fail;
they quietly produce data that is wrong in a way nobody notices, which is the worst outcome
available and the reason these checks exist.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass

from ..generators import advanced_regex
from ..model.config import Config, Gen
from ..packs import DataPacks

#: How each engine is named next to its number.
ENGINE_LABELS = {1: "in memory", 2: "streaming", 3: "exact, on disk"}


@dataclass(frozen=True)
class EngineChoice:
    """The engine a run uses, and why — what ``check`` prints.

    ``downgraded`` is true when engine 3 was asked for and engine 1 runs the config instead.
    """

    engine: int
    why: str
    downgraded: bool = False

    def describe(self) -> str:
        """One line for ``check``: the engine, its name, and the reason."""
        named = f"engine {self.engine} ({ENGINE_LABELS[self.engine]})"
        if self.downgraded:
            return f"runs on {named}, not engine 3: {self.why}"
        return f"runs on {named}: {self.why}"


def resolve(config: Config, packs: DataPacks | None = None) -> int:
    """The engine a config runs on: 1 in memory, 2 streaming, 3 exact on disk."""
    return explain(config, packs).engine


def explain(config: Config, packs: DataPacks | None = None) -> EngineChoice:
    """The engine a config runs on, and the reason in words.

    Engine 3 asked for by name runs a config the disk route sends to engine 1 on engine 1, and
    says so. It always did that, silently, at the last moment — the lazy build refused and the
    in-memory engine took over — which left nothing for ``check`` to report and, past the row
    count where a run splits itself into threads, handed each worker a refusal it could not take
    over from. Deciding it here, before the run, is the same answer every implementation gives.
    """
    forced = _trim_to_none(config.engine)
    mode_for_conflict = _trim_to_none(config.mode)
    # `engine=` wins over `mode=` — except when the two contradict. `mode="sequential"`
    # is not a preference about speed, it is a promise that row N is computed after row
    # N-1, which only engine 1 keeps. Letting `engine="2"` override it silently produced
    # the worst possible message: a run failing with "add mode=sequential" to a config
    # that already said it.
    if mode_for_conflict == "sequential" and forced is not None and forced != "1":
        raise ValueError(
            f'engine="{forced}" contradicts mode="sequential": rows must be computed in '
            "order, and only engine 1 does that. Drop one of the two."
        )
    if forced is not None:
        if forced not in ("1", "2", "3"):
            raise ValueError(
                f'invalid engine "{forced}" — expected "1" (in-memory), "2" (streaming), '
                'or "3" (exact-on-disk)'
            )
        if forced == "3":
            disk = _disk_route(config)
            if disk.engine == 1:
                return EngineChoice(1, disk.why, downgraded=True)
        return EngineChoice(int(forced), f'engine="{forced}" on <env>')

    mode = _trim_to_none(config.mode)
    if mode == "memory":
        return EngineChoice(1, 'mode="memory" on <env>')
    # Rows strictly in order, so `prev()` has a previous row. Engine 2 resolves ANY row
    # in O(1) without touching the one before it — that is its design, and it is what
    # this mode cannot be built on. The cost is engine 1's: the run is held in memory.
    if mode == "sequential":
        return EngineChoice(1, 'mode="sequential" on <env>')
    if mode == "stream":
        # The old name for asking for Engine 2 outright, from before mode described the constraint
        # rather than the engine. Kept working; the router is not consulted.
        return EngineChoice(2, 'mode="stream" on <env>')
    if mode is not None and mode != "disk":
        raise ValueError(f'invalid mode "{mode}" — expected "memory", "disk" or "sequential"')
    return _disk_route(config)


def _disk_route(config: Config) -> EngineChoice:
    """``mode="disk"``, the default: the fastest engine the config allows, and why."""
    # No mode at all means disk: a config says how big its run is, not how to hold it, and the
    # engine that can stream is the right default for a generator whose whole point is volume.

    # A template address that names a field resolves per row against the other columns; only the
    # in-memory engine has them all.
    dynamic = _gen_owner(
        config, lambda gen: gen.type == "template" and _is_dynamic(gen.attr("value"))
    )
    if dynamic is not None:
        return EngineChoice(1, f'"{dynamic}" picks its pack per row')
    # weight= with row= draws a linked record to an exact quota, which needs the global total.
    weighted_row = _gen_owner(
        config,
        lambda gen: (
            gen.type == "file"
            and _trim_to_none(gen.attrs.get("weight")) is not None
            and _trim_to_none(gen.attrs.get("row")) is not None
        ),
    )
    if weighted_row is not None:
        return EngineChoice(
            1, f'"{weighted_row}" draws a weighted row of a file (weight= with row=)'
        )
    # A pack generator that declares its own shares used to be routed here, and for a real
    # reason: resolved a row at a time the quota was computed over a single row and every row went
    # to the largest share. The streaming builder plans such a body over the COLUMN now, so the
    # reason is gone — and keeping the rule after the refusal went was worse than nothing, because
    # the config still landed on the engine that holds the whole table. Measured on a 5,000,000-row
    # `hu.person.male.fullName` column: the in-memory engine wanted 2 GB and died under a 512 MB
    # cap, while the streaming path finished the same run inside 512 MB.
    #
    # One shape still belongs here — a body carrying its own `<valid>` — and it arrives the way
    # every other unstreamable config does: the streaming builder refuses it by name.
    # uniq on a DRAWN value takes WITHOUT REPLACEMENT — simple or composed alike — the pool and the
    # taken-set span the whole column, which only the in-memory engine holds.
    for s in config.sequences:
        if s.uniq and (
            s.gen.type not in ("increment", "decrement")
            if s.gen is not None
            else any(
                i.gen is not None
                and i.field is None
                and i.gen.type not in ("increment", "decrement")
                for i in (s.items or [])
            )
        ):
            return EngineChoice(1, f'uniq="true" on "{s.name}"')
    # A network call is not reproducible, so it never runs on the reproducible path.
    http = _gen_owner(config, lambda gen: gen.type == "http")
    if http is not None:
        return EngineChoice(1, f'"{http}" calls a web service')
    # A <switch> branch that declares a share the streaming engines cannot lay over the right
    # rows. They refuse such a branch rather than apportion it over the wrong denominator, and a
    # refusal reached at build time is not a fallback for every caller. Decide it here,
    # statically, where every path sees the same answer.
    switch_share = _unstreamable_switch_percent(config)
    if switch_share is not None:
        return EngineChoice(1, f'a share inside "{switch_share}" needs the whole column')
    # A column derived from other rows — a running total, a statistic, a date offset — is
    # refused by name by the streaming builder. Deciding it here keeps that refusal from reaching
    # a parallel worker, which has nothing to fall back to.
    running = _gen_owner(config, lambda gen: gen.type == "running")
    if running is not None:
        return EngineChoice(1, f'"{running}" adds up the rows before it')
    stat = _gen_owner(config, lambda gen: gen.type == "stat")
    if stat is not None:
        return EngineChoice(1, f'"{stat}" is computed over every row')
    offset = _gen_owner(
        config, lambda gen: gen.type == "date" and _trim_to_none(gen.attrs.get("of")) is not None
    )
    if offset is not None:
        return EngineChoice(1, f'"{offset}" is a date offset from another column')
    # `parent="Name"` with no value narrows a column to the rows where the parent produced
    # anything, which needs the parent's whole column. Same reason as the three above.
    for spec in config.sequences:
        parent = (spec.parent or "").strip()
        if parent and ("." not in parent or parent[parent.index(".") + 1 :] == ""):
            return EngineChoice(1, f'"{spec.name}" has parent="{parent}" with no value')
    exact = _exact_reason(config)
    if exact is not None:
        return EngineChoice(3, exact)
    return EngineChoice(2, "every column can be built one row at a time")


def _case_carries_percent(case) -> bool:
    """Does this ``<case>`` body declare a share that the denominator has to be right for?"""
    if case is None:
        return False
    return any(
        (part.mix is not None and (part.mix.percent or "").strip() != "")
        or (part.gen is not None and part.gen.attr("percent").strip() != "")
        for part in case.parts
    )


def _unstreamable_switch_percent(config: Config) -> str | None:
    """A ``<switch>`` branch whose share the streaming engines cannot honour.

    They can subset a branch keyed on ONE value of a plain values list — the same bijection
    ``parent="Gender.Male"`` uses. They cannot rank a multi-key branch (``US|CA|MX`` is a union,
    and ranks across a union do not compose from the per-value ranks), nor ``<default>`` (a
    complement, which nothing enumerates), nor any branch whose subject is not a finite values
    list to begin with.

    Deliberately conservative: anything it cannot prove streamable goes to engine 1, which costs
    speed on an exotic config and never costs correctness.
    """
    by_name = {spec.name: spec for spec in config.sequences}

    def plain_list_values(name: str) -> list[str] | None:
        subject = by_name.get(name)
        gen = None if subject is None else subject.gen
        if gen is None or gen.type != "text":
            return None
        if gen.attr("order") == "sequential" or gen.attr("repeat").strip() != "":
            return None
        return [v.strip() for v in gen.attr("value").split(",")]

    def nested_switches(case) -> list:
        """Every ``<switch>`` written inside this ``<case>`` body, at any depth."""
        found: list = []

        def visit(body) -> None:
            if body is None:
                return
            for part in body.parts:
                if part.switch is not None:
                    found.append(part.switch)
                    for entry in part.switch.entries:
                        visit(entry.value)
                    visit(part.switch.fallback)
                elif part.mix is not None:
                    for inner in part.mix.cases:
                        visit(inner)

        visit(case)
        return found

    for spec in config.sequences:
        sw = spec.switch_spec
        bodies = []
        if sw is not None:
            bodies.extend(entry.value for entry in sw.entries)
            bodies.append(sw.fallback)
        if spec.mix is not None:
            bodies.extend(spec.mix.cases)
        # A NESTED switch is never rankable — its branch covers an intersection of two
        # partitions, and there is no O(1) rank inside one. So any share it declares, at any
        # depth, decides engine 1.
        for body in bodies:
            for nested in nested_switches(body):
                if _case_carries_percent(nested.fallback) or any(
                    _case_carries_percent(e.value) for e in nested.entries
                ):
                    return spec.name

        if sw is None:
            continue
        if _case_carries_percent(sw.fallback):
            return spec.name
        values = plain_list_values(sw.on)
        for entry in sw.entries:
            if not _case_carries_percent(entry.value):
                continue
            if len(entry.keys) != 1 or values is None or entry.keys[0] not in values:
                return spec.name
    return None


def needs_exact(config: Config) -> bool:
    """Whether disk mode needs the exact engine rather than the streaming one.

    Everything here is a case where a per-row answer and a whole-column answer differ: ANY
    uniqueness, a child of a parent whose values are not a finite list, a weighted choice inside
    a pattern. Ordinary exact percentages, switch, distinct and text parent-child all stream.

    ``uniq`` is here in full, and that is a deliberate cost. A group REARRANGES the columns it
    covers — every column keeps its multiset, so every declared share survives — and that cannot
    be decided a row at a time. The streaming engine could only offer a different answer, and two
    answers from one seed is the thing this whole design exists to prevent.
    """
    return _exact_reason(config) is not None


def _exact_reason(config: Config) -> str | None:
    """Why disk mode needs the exact engine, in words; None when it does not."""
    by_name = {spec.name: spec for spec in config.sequences}

    for spec in config.sequences:
        if spec.uniq:
            return f'uniq="true" on "{spec.name}"'
        weighted = f'"{spec.name}" has a weighted choice in advanced_regex'
        if spec.gen is not None and _is_weighted_advanced_regex(spec.gen):
            return weighted
        for f in _fields_of(spec):
            if _is_weighted_advanced_regex(f.gen):
                return weighted
        parent = _trim_to_none(spec.parent)
        if parent is not None and not _parent_is_finite_text(by_name, parent):
            return f'"{spec.name}" has parent="{parent}", which is not a list of values'
    if config.env_uniq_groups:
        group = ", ".join(f'"{name}"' for name in config.env_uniq_groups[0])
        return f"a <uniq> group over {group}"
    return None


def _parent_is_finite_text(by_name, reference: str) -> bool:
    dot = reference.find(".")
    parent = by_name.get(reference if dot < 0 else reference[:dot])
    return parent is not None and parent.gen is not None and parent.gen.type == "text"


def _is_weighted_advanced_regex(gen: Gen) -> bool:
    return gen.type == "advanced_regex" and advanced_regex.has_weighted_choice(gen.attr("value"))


def _has_percent(gen: Gen) -> bool:
    return bool(gen.attrs.get("percent"))


def _needs_whole_column(packs: DataPacks, path: str, locale: str) -> bool:
    """Whether a pack GENERATOR apportions a share over the whole column.

    Two ways to earn it.

    A ``percent=`` anywhere in a generator's body — on its ``<mix>``, on a ``<gen>``, on a compound
    field — makes its quota a property of the run rather than of a row.

    And a body that DRAWS from a weighted list, which the body does not say. A weighted list is
    laid out to an exact Hamilton quota over the run, so each value takes its measured share of the
    rows; asked for one row, that plan is computed over a column of one and the row goes to the
    largest share, every time, for every seed. Twelve shipped full-name packs were in that state —
    ``hu.person.male.fullName`` returned the same name on all forty rows of a forty-row run —
    because the body says ``value="hu.person.lastName"`` and nothing in that line says the list on
    the other end carries weights.

    Only a generator is ever marked. A weighted list drawn DIRECTLY by a config is not this
    problem: the streaming engine lays one out across the column already, and marking it here
    would take `en.person.lastName` off the streaming engines for nothing. The weighted leaf
    matters one level down, inside a body, which is what ``_draws_whole_column`` is for.

    The router asks this before sending a config to an engine that resolves one row at a time.
    """
    entry = packs.load(path, locale)
    if not entry.is_generator:
        return False
    return _body_needs_whole_column(packs, entry.generator or "", locale, frozenset({path}))


def _body_needs_whole_column(
    packs: DataPacks, body: str, locale: str, seen: frozenset[str]
) -> bool:
    """The share test over one generator body: its own ``percent=``, or what it draws from."""
    from ..parser import config_builder

    try:
        composed = config_builder.parse_pack_body(body)
    except (ValueError, AttributeError):
        # A single bare <gen>: it declares a share only through its own percent=.
        return "percent=" in body

    for spec in composed.sequences:
        if spec.is_mix and spec.mix.percent and spec.mix.percent.strip():
            return True
        for gen in [spec.gen, *(f.gen for f in _fields_of(spec))]:
            if gen is None:
                continue
            if _has_percent(gen):
                return True
            if _draws_whole_column(packs, gen, locale, seen):
                return True
    return False


def _draws_whole_column(packs: DataPacks, gen, locale: str, seen: frozenset[str]) -> bool:
    """Does a ``<gen>`` in a pack body reach a weighted list, directly or through another pack?"""
    if gen.type != "template":
        return False
    target = gen.attrs.get("value", "")
    if not target or _is_dynamic(target) or target in seen:
        return False  # `target in seen` is the cycle guard; the pack loader reports the cycle
    inner = gen.attrs.get("local") or locale
    try:
        if not packs.exists(target, inner):
            return False
        entry = packs.load(target, inner)
        # HERE a weighted list is the leaf the walk is looking for — it is the thing the body
        # draws from, and its quota is what the body inherits.
        if entry.weighted:
            return True
        if not entry.is_generator:
            return False
        return _body_needs_whole_column(packs, entry.generator or "", inner, seen | {target})
    except (ValueError, OSError):
        return False


def _is_dynamic(value: str) -> bool:
    """``common.vehicle.model.${{Brand}}`` — an address that is not known until the row is."""
    return "${{" in value


def _gen_owner(config: Config, test: Callable[[Gen], bool]) -> str | None:
    """The first sequence holding a ``<gen>`` — simple or a compound's field — that passes."""
    for spec in config.sequences:
        if spec.gen is not None and test(spec.gen):
            return spec.name
        for f in _fields_of(spec):
            if f.gen is not None and test(f.gen):
                return spec.name
    return None


def _fields_of(spec):
    """A compound's fields, or nothing — a simple sequence has none rather than an empty list."""
    return spec.fields if spec.is_compound and spec.fields else []


def _trim_to_none(value: str | None) -> str | None:
    if value is None:
        return None
    trimmed = value.strip()
    return trimmed or None
