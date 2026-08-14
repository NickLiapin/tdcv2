"""The typed columns a ``<block>`` declares, and the types they carry.

A ``<data>`` with a ``name`` is a column; one without is decorative text and columnar output
ignores it. Which ``<line>`` it sits on does not matter — the columns are every named ``<data>`` in
document order. That keeps the text block and the schema the same construct, so a config gains
typed output without learning a second way to describe itself.

A column's type is resolved in one order, and the order is the point: an explicit ``type=`` wins;
failing that, the generator feeding the column is asked; failing that, it is text. Nothing is ever
guessed from the rendered VALUES, because that is exactly how ``007`` turns into ``7``.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..model.config import Config, Gen, SequenceSpec
from . import column_type
from .column_type import ColumnType, Kind


@dataclass(frozen=True, slots=True)
class Declared:
    """One declared column: its name, the text it renders from, and its type if it declared one."""

    name: str
    template: str
    type: ColumnType | None


def resolve(column: Declared, config: Config) -> ColumnType | None:
    """A column's type, resolved.

    Absent for a column with no declared type whose source cannot be told confidently — the caller
    falls back to text, which never corrupts anything.
    """
    if column.type is not None:
        return column.type
    source = sole_reference(column.template, config.inject)
    return None if source is None else derive_output(source, config)


def sole_reference(template: str, inject: str) -> str | None:
    """The single sequence a template refers to, when it is exactly one substitution.

    Composite text has no single source type: ``${{First}} ${{Last}}`` is a sentence, not a number
    that happens to be spelled with a space in it.
    """
    marker = inject.find("%")
    if marker < 0:
        return None
    prefix = inject[:marker]
    suffix = inject[marker + 1 :]
    text = template.strip()
    if not text.startswith(prefix) or not text.endswith(suffix):
        return None
    inner = text[len(prefix) : len(text) - len(suffix)]
    # A second marker means more than one substitution, or literal text between them.
    if not inner or prefix in inner or "|" in inner:
        return None
    return inner.strip()


def derive_output(name: str, config: Config) -> ColumnType | None:
    """The type of a column fed by ``name``, as a LIST when its generator repeats.

    A repeating generator puts several values in one cell, so the column is a list of whatever one
    value would have been. When the element cannot be typed the list survives anyway — ``repeat``
    says this IS a list, and flattening it back into comma-joined text would throw away structure
    that is known for certain.
    """
    element = derive(name, config)
    if separator_of(name, config) is None:
        return element
    inner = str(element) if element is not None else _element_fallback(name, config)
    return column_type.parse_output(f"[]{inner}")


def derive(name: str, config: Config) -> ColumnType | None:
    """A column's type from the generator that feeds it, or nothing when it cannot be told.

    The reliable middle step: a column that came from ``type="number"`` with no decimals is an
    int64, which is knowledge rather than inference. Everything uncertain returns nothing and
    becomes text.
    """
    # A ground-truth flag column is minted by a gen's anomaly_flag or a <mix flag=>, and is never
    # declared as a <sequence> of its own — so it has to be found by looking.
    for spec in config.sequences:
        if spec.is_mix and spec.mix.flag is not None and name == spec.mix.flag.strip():
            return column_type.parse("bool")
        for gen in _gens_of(spec):
            flag = gen.attrs.get("anomaly_flag")
            if flag is not None and name == flag.strip():
                return column_type.parse("bool")

    spec = _spec_named(name, config)
    if spec is not None and spec.is_mix:
        return _derive_mix(spec.mix, config)
    gen = None if spec is None else spec.gen
    return None if gen is None else _derive_gen(gen, config)


def _derive_gen(gen: Gen, config: Config) -> ColumnType | None:
    """The rules for one generator, shared between a plain sequence and a mix's cases."""
    # Output formatting rewrites the text, so the value is no longer of its raw type.
    if gen.attrs.get("mask") is not None or gen.attrs.get("case") is not None:
        return None
    missing = gen.attrs.get("missing")
    nullable = missing is not None and missing.strip() != "" and _positive(missing)

    # A pattern draws a NUMBER from a shape — ``y_range="1..30"`` is a range of numbers whatever
    # the curve looks like — so it types exactly like a timeseries.
    if gen.type in ("number", "timeseries", "pattern"):
        return _with_nullable("double" if _decimals(gen) > 0 else "int64", nullable)
    if gen.type in ("increment", "decrement"):
        # A counter is whole until the config says otherwise. ``value="9.99"`` or ``step="0.50"``
        # — the fractional steps the counters page teaches — make every cell fractional, and
        # calling that an int64 does not merely mislabel it: the Parquet writer refuses the first
        # row and the run dies, on a config that prints perfectly well as text.
        fractional = _is_fractional(gen.attrs.get("value")) or _is_fractional(gen.attrs.get("step"))
        return _with_nullable("double" if fractional else "int64", nullable)
    if gen.type == "running":
        # A running total is the arithmetic of the column it reads, so its type is that column's
        # — recursively, since ``of=`` may name another derived one. ``decimals=`` on the running
        # gen itself makes it fractional whatever the source was.
        if _decimals(gen) > 0:
            return _with_nullable("double", nullable)
        return _numeric_source(gen.attrs.get("of", ""), config, nullable)
    if gen.type == "stat":
        # A statistic's type follows the OPERATION, which is declared. Counting is whole by
        # definition; a mean, a median and a standard deviation are not, whatever they are
        # computed from; a sum, a minimum and a maximum keep the source column's type.
        if _decimals(gen) > 0:
            return _with_nullable("double", nullable)
        op = (gen.attrs.get("op") or "").strip()
        if op == "count":
            return _with_nullable("int64", nullable)
        if op in ("mean", "median", "stddev"):
            return _with_nullable("double", nullable)
        if op in ("sum", "min", "max"):
            return _numeric_source(gen.attrs.get("of", ""), config, nullable)
        return None
    if gen.type == "formula":
        # A formula's type is knowable exactly when the config declared how many digits it wants,
        # and not otherwise: ``expr="A + 1"`` is a whole number, ``expr="A / 2"`` is not, and
        # ``expr="A > 5 ? over : under"`` is a WORD. So ``decimals=`` is the one honest signal.
        places = _declared_decimals(gen)
        if places is None:
            return None
        return _with_nullable("double" if places > 0 else "int64", nullable)
    if gen.type == "file":
        # A file is a bag of whatever the file holds, so an ordinary read stays text.
        # ``read="quantile"`` is the exception, and not by inspection of the values: the file MUST
        # be numeric or the run refuses, so the column is a number by construction.
        #
        # Which number is decided by the config alone, because this layer never opens the file.
        # ``decimals="0"`` is the one declaration that promises whole values; without it the
        # precision comes from the source and may be fractional, so the safe answer is a double.
        if (gen.attrs.get("read") or "").strip() != "quantile":
            return None
        return _with_nullable("int64" if _declared_decimals(gen) == 0 else "double", nullable)
    if gen.type == "date":
        # The default rendering is locale-shaped (05/25/1996), not ISO, so a date column is only
        # safe to infer when the config asked for ISO. Otherwise it stays text, and the author can
        # still say type="date" if they mean it.
        return _with_nullable("date", nullable) if gen.attrs.get("format") == "YYYY-MM-DD" else None
    if gen.type == "template":
        return (
            _with_nullable("uuid", nullable)
            if gen.attrs.get("value", "").endswith(".uuid")
            else None
        )
    return None


def _derive_mix(mix, config: Config) -> ColumnType | None:
    """A ``<mix>`` column's type, when every branch agrees on one.

    Deliberately strict: each case must be exactly one generator, and all of them must derive to
    the same type. A mix of a number and a word is text, and any doubt falls back to text — the
    rule that keeps a leading zero from being optimised away.
    """
    if not mix.cases:
        return None
    agreed: ColumnType | None = None
    for case in mix.cases:
        if len(case.parts) != 1 or case.parts[0].gen is None:
            return None
        type_ = _derive_gen(case.parts[0].gen, config)
        if type_ is None:
            return None
        if agreed is None:
            agreed = type_
        elif agreed.kind is not type_.kind or agreed.nullable != type_.nullable:
            return None
    return agreed


def separator_of(name: str, config: Config) -> str | None:
    """The separator of the generator feeding ``name``, or nothing when it does not repeat.

    A list column splits its rendered text on exactly this, so the text view and the typed view can
    never disagree about where one value ends and the next begins.
    """
    spec = _spec_named(name, config)
    gen = None if spec is None else spec.gen
    if gen is None:
        return None
    repeat = gen.attrs.get("repeat")
    if repeat is None or not repeat.strip():
        return None
    return gen.attrs.get("separator", ",")


def _element_fallback(name: str, config: Config) -> str:
    """The element type for a repeating generator whose values cannot be typed.

    Text stays text, but ``missing=`` still makes the ELEMENT nullable — that is what it blanks.
    """
    spec = _spec_named(name, config)
    missing = None if spec is None or spec.gen is None else spec.gen.attrs.get("missing")
    nullable = missing is not None and missing.strip() != "" and _positive(missing)
    return "string|null" if nullable else "string"


def check_unique(columns: list[Declared]) -> None:
    """A duplicate name refused before anything is written — two columns cannot share one."""
    seen: set[str] = set()
    for column in columns:
        if column.name in seen:
            raise ValueError(f'duplicate column name "{column.name}"')
        seen.add(column.name)


def _spec_named(name: str, config: Config) -> SequenceSpec | None:
    for spec in config.sequences:
        if spec.name == name:
            return spec
    return None


def _gens_of(spec: SequenceSpec) -> list[Gen]:
    out = []
    if spec.gen is not None:
        out.append(spec.gen)
    if spec.is_compound and spec.fields:
        out.extend(f.gen for f in spec.fields if f.gen is not None)
    return out


def _is_fractional(text: str | None) -> bool:
    """A written number with a fractional part — ``9.99`` and ``0.50``, but not ``10`` or ``""``."""
    body = (text or "").strip()
    if not body:
        return False
    try:
        value = float(body)
    except ValueError:
        return False
    return value == value and value not in (float("inf"), float("-inf")) and value != int(value)


def _with_nullable(name: str, nullable: bool) -> ColumnType:
    return column_type.parse(f"{name}|null" if nullable else name)


def _decimals(gen: Gen) -> int:
    try:
        return int(float(gen.attrs.get("decimals", "0")))
    except ValueError:
        return 0


def _declared_decimals(gen: Gen) -> int | None:
    """``decimals=`` as the config WROTE it — ``None`` when it said nothing at all.

    Different from :func:`_decimals`, which reads an absent attribute as zero. Two generators need
    the difference: a formula is typed only when the config declared one, and a quantile read is
    whole only when it declared zero.
    """
    raw = (gen.attrs.get("decimals") or "").strip()
    if raw == "":
        return None
    try:
        return int(float(raw))
    except ValueError:
        return None


def _numeric_source(of: str, config: Config, nullable: bool) -> ColumnType | None:
    """The type of the column ``of=`` names, when it is a number.

    Anything else — or a source this file cannot type — stays text rather than guessing: only a
    numeric source gives a numeric total.
    """
    source = (of or "").strip()
    if source == "":
        return None
    from_type = derive(source, config)
    if from_type is None or from_type.kind not in (Kind.INT64, Kind.DOUBLE):
        return None
    return _with_nullable("int64" if from_type.kind is Kind.INT64 else "double", nullable)


def _positive(raw: str) -> bool:
    try:
        return float(raw.strip()) > 0
    except ValueError:
        return False
