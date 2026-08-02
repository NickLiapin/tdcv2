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

from ..generators import advanced_regex
from ..model.config import Config, Gen
from ..packs import DataPacks


def resolve(config: Config, packs: DataPacks | None = None) -> int:
    """The engine a config runs on: 1 in memory, 2 streaming, 3 exact on disk."""
    forced = _trim_to_none(config.engine)
    if forced is not None:
        if forced not in ("1", "2", "3"):
            raise ValueError(
                f'invalid engine "{forced}" — expected "1" (in-memory), "2" (streaming), '
                'or "3" (exact-on-disk)'
            )
        return int(forced)

    mode = _trim_to_none(config.mode)
    if mode == "memory":
        return 1
    if mode == "stream":
        # The old name for asking for Engine 2 outright, from before mode described the constraint
        # rather than the engine. Kept working; the router is not consulted.
        return 2
    if mode is not None and mode != "disk":
        raise ValueError(f'invalid mode "{mode}" — expected "memory" or "disk"')
    # No mode at all means disk: a config says how big its run is, not how to hold it, and the
    # engine that can stream is the right default for a generator whose whole point is volume.

    # A template address that names a field resolves per row against the other columns; only the
    # in-memory engine has them all.
    if _any_gen(config, lambda gen: gen.type == "template" and _is_dynamic(gen.attr("value"))):
        return 1
    # weight= with row= draws a linked record to an exact quota, which needs the global total.
    if _any_gen(
        config,
        lambda gen: (
            gen.type == "file"
            and _trim_to_none(gen.attrs.get("weight")) is not None
            and _trim_to_none(gen.attrs.get("row")) is not None
        ),
    ):
        return 1
    # A pack generator that declares its own shares apportions them over the whole column.
    if packs is not None and _any_gen(config, lambda gen: _declares_shares(gen, config, packs)):
        return 1
    # uniq on a DRAWN value takes WITHOUT REPLACEMENT — simple or composed alike — the pool and the
    # taken-set span the whole column, which only the in-memory engine holds.
    if any(
        s.uniq
        and (
            s.gen.type not in ("increment", "decrement")
            if s.gen is not None
            else any(
                i.gen is not None
                and i.field is None
                and i.gen.type not in ("increment", "decrement")
                for i in (s.items or [])
            )
        )
        for s in config.sequences
    ):
        return 1
    # A network call is not reproducible, so it never runs on the reproducible path.
    if _any_gen(config, lambda gen: gen.type == "http"):
        return 1
    return 3 if needs_exact(config) else 2


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
    by_name = {spec.name: spec for spec in config.sequences}

    if config.env_uniq_groups:
        return True

    for spec in config.sequences:
        if spec.uniq:
            return True
        if spec.gen is not None and _is_weighted_advanced_regex(spec.gen):
            return True
        for f in _fields_of(spec):
            if _is_weighted_advanced_regex(f.gen):
                return True
        parent = _trim_to_none(spec.parent)
        if parent is not None and not _parent_is_finite_text(by_name, parent):
            return True
    return False


def _parent_is_finite_text(by_name, reference: str) -> bool:
    dot = reference.find(".")
    parent = by_name.get(reference if dot < 0 else reference[:dot])
    return parent is not None and parent.gen is not None and parent.gen.type == "text"


def _is_weighted_advanced_regex(gen: Gen) -> bool:
    return gen.type == "advanced_regex" and advanced_regex.has_weighted_choice(gen.attr("value"))


def _has_percent(gen: Gen) -> bool:
    return bool(gen.attrs.get("percent"))


def _declares_shares(gen: Gen, config: Config, packs: DataPacks) -> bool:
    if gen.type != "template":
        return False
    path = gen.attr("value")
    if not path or _is_dynamic(path):
        return False
    locale = gen.attrs.get("local") or config.locale
    try:
        return _needs_whole_column(packs, path, locale)
    except (ValueError, OSError):
        # An address that does not resolve is the validator's problem, not the router's.
        return False


def _needs_whole_column(packs: DataPacks, path: str, locale: str) -> bool:
    """Whether a pack generator apportions a share over the whole column.

    A ``percent=`` anywhere in a generator's body — on its ``<mix>``, on a ``<gen>``, on a compound
    field — makes its quota a property of the run rather than of a row. The router asks this before
    sending a config to an engine that resolves one row at a time.
    """
    from ..parser import config_builder

    entry = packs.load(path, locale)
    if not entry.is_generator:
        return False
    body = entry.generator or ""
    try:
        composed = config_builder.parse_pack_body(body)
    except (ValueError, AttributeError):
        # A single bare <gen>: it declares a share only through its own percent=.
        return "percent=" in body

    for spec in composed.sequences:
        if spec.is_mix and spec.mix.percent and spec.mix.percent.strip():
            return True
        if spec.gen is not None and _has_percent(spec.gen):
            return True
        for f in _fields_of(spec):
            if f.gen is not None and _has_percent(f.gen):
                return True
    return False


def _is_dynamic(value: str) -> bool:
    """``common.vehicle.model.${{Brand}}`` — an address that is not known until the row is."""
    return "${{" in value


def _any_gen(config: Config, test: Callable[[Gen], bool]) -> bool:
    """Every ``<gen>`` in the config, simple or a compound's field."""
    for spec in config.sequences:
        if spec.gen is not None and test(spec.gen):
            return True
        for f in _fields_of(spec):
            if f.gen is not None and test(f.gen):
                return True
    return False


def _fields_of(spec):
    """A compound's fields, or nothing — a simple sequence has none rather than an empty list."""
    return spec.fields if spec.is_compound and spec.fields else []


def _trim_to_none(value: str | None) -> str | None:
    if value is None:
        return None
    trimmed = value.strip()
    return trimmed or None
