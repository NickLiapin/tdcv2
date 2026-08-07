"""The parts of a config the engines work from.

A deliberately small model: what the shared fixtures exercise, and no more. Growing it one
verified fixture at a time is the point — a wider model with nothing checking it would just be a
guess about what the reference does.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


@dataclass(frozen=True, slots=True)
class Gen:
    """A single ``<gen>``: its type plus every attribute, unparsed."""

    type: str
    attrs: dict[str, str]

    def attr(self, name: str, fallback: str = "") -> str:
        return self.attrs.get(name, fallback)


@dataclass(frozen=True, slots=True)
class CasePart:
    """One piece of a ``<case>`` body: literal text, a generator, a nested mix or a nested switch.

    A case concatenates its pieces, which is what lets a branch read as ``A-`` followed by a
    pattern rather than as a separate prefix column.

    A nested ``<switch>`` contributes a value only — it has no ``name``, so nothing can
    interpolate it — and it looks its subject up over the rows of the branch it sits in.
    """

    text: str | None = None
    gen: Gen | None = None
    mix: Mix | None = None
    switch: Switch | None = None


@dataclass(frozen=True, slots=True)
class Case:
    """One branch of a ``<mix>`` or ``<switch>``.

    ``anomaly`` is a label only. It injects nothing; the branch's own generator produces the
    outlier, and the flag column marks who chose it.
    """

    parts: list[CasePart]
    anomaly: bool = False


@dataclass(frozen=True, slots=True)
class Mix:
    """``<mix name="X" percent="80,20">`` — several ways to build one value, apportioned exactly.

    Different from a conditional sequence: a conditional asks about another column, a mix asks
    for a share of the run. It is how a column gets a rare shape — 2% malformed addresses, 5%
    legacy-format ids — in a stated proportion rather than an approximate one.
    """

    percent: str | None
    flag: str | None
    cases: list[Case]


@dataclass(frozen=True, slots=True)
class SwitchEntry:
    """One ``<switch>`` entry: its keys, and how to build the value when one of them matches."""

    keys: list[str]
    value: Case


@dataclass(frozen=True, slots=True)
class Switch:
    """``<switch name="X" on="Subject">`` — a lookup table.

    A pure function of the subject's value, so unlike everything else here it consumes no
    randomness of its own beyond what its cases' generators use. Currency from country, tax rate
    from region: the pairing is a fact, not a choice.
    """

    on: str
    entries: list[SwitchEntry]
    fallback: Case | None = None


@dataclass(frozen=True, slots=True)
class Field:
    """One named field of a compound sequence."""

    name: str
    gen: Gen


@dataclass(frozen=True)
class Item:
    """One item of a composed sequence's body, in source order.

    A named ``<gen>`` or ``<data>`` is a field; an unnamed one is part of the
    sequence's own value. Exactly one of the three is set — and ``constant_name``
    beside ``text`` makes a named ``<data>``, the only field that costs no draw.
    """

    field: Field | None = None
    gen: Gen | None = None
    text: str | None = None
    constant_name: str | None = None


@dataclass(frozen=True, slots=True)
class Branch:
    """One branch of a conditional sequence: a condition and what to build when it holds."""

    if_expr: str | None
    gen: Gen


@dataclass(frozen=True, slots=True)
class SequenceSpec:
    """One declared column, in whichever of its several shapes."""

    name: str | None
    parent: str | None = None
    gen: Gen | None = None
    fields: list[Field] | None = None
    #: A body read as ONE ordered list: unnamed items concatenate into the
    #: sequence's own value, named ones are fields beside it.
    #:
    #: One list rather than two, because a sequence's gens draw in declaration
    #: order and that order is part of the cross-language contract. Splitting the
    #: body into "fields" and "parts" would make the draw order something to
    #: remember instead of something the shape guarantees.
    items: list[Item] | None = None
    branches: list[Branch] | None = None
    compute: Any = None
    mix: Mix | None = None
    switch_spec: Switch | None = None
    distinct_groups: list[list[str]] | None = None
    uniq: bool = False

    @property
    def is_mix(self) -> bool:
        return self.mix is not None

    @property
    def is_switch(self) -> bool:
        return self.switch_spec is not None

    @property
    def is_computed(self) -> bool:
        return self.compute is not None

    @property
    def is_compound(self) -> bool:
        return self.fields is not None

    @property
    def is_composed(self) -> bool:
        return self.items is not None

    @property
    def is_conditional(self) -> bool:
        return self.branches is not None


@dataclass(frozen=True, slots=True)
class DataPart:
    """One ``<data>`` piece of a line.

    ``name`` is present when the piece is a COLUMN rather than decoration; text output ignores
    it, and a columnar format uses it. ``type`` is a declared column type, or nothing to let the
    generator feeding it decide.
    """

    text: str
    if_expr: str | None = None
    name: str | None = None
    type: str | None = None


@dataclass(frozen=True, slots=True)
class Line:
    """One ``<line>`` of output: its ``<data>`` children, in order.

    ``if_expr`` drops the line whole when false — and it is dropped before the delimiters are
    placed, so the line above it does not keep a separator pointing at nothing.
    """

    parts: list[DataPart]
    if_expr: str | None = None
    each: str | None = None


@dataclass(frozen=True, slots=True)
class Fixtures:
    """Text emitted around the repeating body.

    Each is a list of lines, empty when the config does not declare that block. The three scopes
    nest: the ``*_block`` pair wraps one record, the ``*_line`` pair wraps every line inside it,
    and the two delimiters go only BETWEEN records and between lines, never after the last one.
    That last distinction is the whole reason a JSON config can be written at all — it is what
    keeps a trailing comma off the final record.
    """

    before: list[Line] = field(default_factory=list)
    after: list[Line] = field(default_factory=list)
    before_block: list[Line] = field(default_factory=list)
    after_block: list[Line] = field(default_factory=list)
    delimiter_block: list[Line] = field(default_factory=list)
    before_line: list[Line] = field(default_factory=list)
    after_line: list[Line] = field(default_factory=list)
    delimiter_line: list[Line] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class PoolSpec:
    """A ``<pool>``: how many members, and how each one is built.

    A pool is a miniature ``<env>`` — its body holds the same ``<sequence>``, ``<mix>``,
    ``<switch>``, ``<uniq>`` and ``<distinct>``, and means the same thing by them. So it carries
    the fields an ``<env>`` does, and the engine builds it with the ordinary machinery, handed
    the member count where it usually gets the row count.
    """

    name: str
    count: int
    sequences: list[SequenceSpec] = field(default_factory=list)
    uniq_groups: list[list[str]] = field(default_factory=list)
    distinct_groups: list[list[str]] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class AssertSpec:
    """One ``<assert that="…" says="…"/>`` as written.

    A statement about the whole run, like ``<uniq>`` and ``<distinct>``, which is why it sits
    in ``<env>`` rather than beside a column.
    """

    that: str
    says: str


@dataclass(frozen=True, slots=True)
class Config:
    """Everything a run needs, parsed out of the document."""

    count: int
    seed: str
    locale: str
    inject: str
    regex_max_length: int
    sequences: list[SequenceSpec]
    block: list[Line]
    fixtures: Fixtures
    mode: str | None = None
    engine: str | None = None
    env_uniq_groups: list[list[str]] = field(default_factory=list)
    env_distinct_groups: list[list[str]] = field(default_factory=list)
    pools: list[PoolSpec] = field(default_factory=list)
    asserts: list[AssertSpec] = field(default_factory=list)

    def override(
        self, count: int | None = None, seed: str | None = None, locale: str | None = None
    ) -> Config:
        """A copy with the runtime parameters replaced; ``None`` keeps what ``<env>`` declared.

        Code wins over the file. A test that pins a seed needs that value to hold even when the
        config it borrowed carries a seed of its own — otherwise the override would be advice
        rather than a setting.
        """
        from dataclasses import replace

        return replace(
            self,
            count=self.count if count is None else count,
            seed=self.seed if seed is None else seed,
            locale=self.locale if locale is None else locale,
        )

    def with_engine(self, engine: str) -> Config:
        """A copy pinned to one engine — what the library's ``engine`` option sets."""
        from dataclasses import replace

        return replace(self, engine=engine)
