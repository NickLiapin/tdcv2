"""The parse tree into the model the engines work from.

Structure only: what shape each sequence is, which attributes it carries, how the output block is
laid out. Nothing here decides what a value will be — that is the engines' job, and keeping the
two apart is what lets three engines share one reading of a config.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..model.config import (
    AssertSpec,
    Branch,
    Case,
    CasePart,
    Config,
    DataPart,
    Field,
    Fixtures,
    Gen,
    Item,
    Line,
    Mix,
    PoolSpec,
    SequenceSpec,
    Switch,
    SwitchEntry,
)
from . import paired_data
from .generated.TDCParser import TDCParser

DEFAULT_COUNT = 10
DEFAULT_LOCALE = "en"
DEFAULT_INJECT = "${{%}}"
DEFAULT_REGEX_MAX_LENGTH = 1000

# The fixture blocks, in the order they are declared on `<env>`.
_FIXTURE_TAGS = (
    "before",
    "after",
    "before_block",
    "after_block",
    "delimiter_block",
    "before_line",
    "after_line",
    "delimiter_line",
)


@dataclass(frozen=True, slots=True)
class PackGenerator:
    """A composed pack generator: local sequences, an output template, and a ``<valid>`` rule."""

    sequences: list[SequenceSpec]
    output: str
    validate: Any = None



def _gen_of(child):
    """A ``<gen>``, whichever way it was punctuated.

    Four of the five implementations only ever looked for the SELF-CLOSING form, so
    ``<gen type="text" value="a,b"></gen>`` — the ordinary alternative spelling — was
    not seen as a generator at all, and the sequence was blamed for having none:
    "has no <gen> child", about a <gen> standing in plain sight.
    """
    el = child.selfClosingElement() or child.openCloseElement()
    return el if el is not None and el.name.text == "gen" else None

def build(document: TDCParser.DocumentContext, default_locale: str | None = None) -> Config:
    """The whole config, as the engines need it.

    ``default_locale`` fills in for a config that declares no ``<env local="…">`` — it comes from
    the project's ``tdcv2.config.json``, and it is a DEFAULT, never an override. Letting it beat
    what the config declares would make a config that says ``local="ru"`` produce English wherever
    a config file existed, which ``init`` always writes.
    """
    tdc = _find(document, "tdc")
    if tdc is None:
        raise ValueError("document has no <tdc> root element")

    env = _find(tdc.content(), "env")
    env_attrs = {} if env is None else attributes(env.attr())
    # regex_max_length sits on <tdc>, not <env>: it is a safety limit for the whole document
    # rather than a property of one run's data.
    regex_max_length = _regex_max_length(attributes(tdc.attr()).get("regex_max_length"))

    count = DEFAULT_COUNT
    raw_count = env_attrs.get("count")
    if raw_count is not None:
        count = int(raw_count.strip())

    sequences: list[SequenceSpec] = []
    fixtures: dict[str, list[Line]] = {tag: [] for tag in _FIXTURE_TAGS}
    env_uniq: list[list[str]] = []
    env_distinct: list[list[str]] = []
    pools: list[PoolSpec] = []
    asserts: list[AssertSpec] = []

    if env is not None:
        for child in env.content().element():
            # `<assert/>` is the one env child written self-closing, so it is read before the
            # open/close walk rather than lost by it.
            self_el = child.selfClosingElement()
            if self_el is not None:
                if self_el.name.text == "assert":
                    attrs = attributes(self_el.attr())
                    asserts.append(
                        AssertSpec(that=attrs.get("that", ""), says=attrs.get("says", ""))
                    )
                continue
            open_el = child.openCloseElement()
            if open_el is None:
                continue
            tag = open_el.name.text
            if tag == "sequence":
                sequences.append(_sequence(open_el))
            elif tag == "mix":
                sequences.append(_mix_sequence(open_el))
            elif tag == "switch":
                sequences.append(_switch_sequence(open_el))
            elif tag in ("uniq", "distinct"):
                # A wrapper says what must hold BETWEEN sequences; its children are ordinary
                # sequences and are declared as such.
                group = _wrapped_sequences(open_el, sequences)
                if len(group) >= 2:
                    (env_uniq if tag == "uniq" else env_distinct).append(group)
            elif tag == "pool":
                pools.append(_pool(open_el))
            elif tag in _FIXTURE_TAGS:
                fixtures[tag] = _lines(open_el.content())

    block = _find(tdc.content(), "block")
    if block is None:
        raise ValueError("<tdc> has no <block> child — nothing to render")

    return Config(
        count=count,
        seed=env_attrs.get("seed", ""),
        locale=env_attrs.get("local", default_locale or DEFAULT_LOCALE),
        inject=env_attrs.get("inject", DEFAULT_INJECT),
        regex_max_length=regex_max_length,
        sequences=sequences,
        block=_lines(block.content()),
        fixtures=Fixtures(**fixtures),
        mode=env_attrs.get("mode"),
        engine=env_attrs.get("engine"),
        env_uniq_groups=env_uniq,
        env_distinct_groups=env_distinct,
        pools=pools,
        asserts=asserts,
    )


def _pool(node) -> PoolSpec:
    """A ``<pool>``, read with the very same walk its enclosing ``<env>`` gets.

    That is the whole design in one function: nothing here knows what a member is, because a
    member of a pool is a member of an ``<env>``. Lenient about a missing name or an unreadable
    count — the validator is what says so, and declaring the failure twice lets the two drift.
    """
    attrs = attributes(node.attr())
    raw = (attrs.get("count") or "").strip()
    try:
        count = int(raw)
    except ValueError:
        count = 0

    sequences: list[SequenceSpec] = []
    uniq: list[list[str]] = []
    distinct: list[list[str]] = []
    for child in node.content().element():
        open_el = child.openCloseElement()
        if open_el is None:
            continue
        tag = open_el.name.text
        if tag == "sequence":
            sequences.append(_sequence(open_el))
        elif tag == "mix":
            sequences.append(_mix_sequence(open_el))
        elif tag == "switch":
            sequences.append(_switch_sequence(open_el))
        elif tag in ("uniq", "distinct"):
            group = _wrapped_sequences(open_el, sequences)
            if len(group) >= 2:
                (uniq if tag == "uniq" else distinct).append(group)

    return PoolSpec(
        name=attrs.get("name", ""),
        count=count,
        sequences=sequences,
        uniq_groups=uniq,
        distinct_groups=distinct,
    )


def _wrapped_sequences(wrapper, sequences: list[SequenceSpec]) -> list[str]:
    """The members inside an env-level ``<uniq>`` or ``<distinct>``, declared as they go.

    Wrapping changes what must hold between them, not what they are, so each is built exactly as
    it would have been on its own and the wrapper keeps only the names.

    A ``<mix>`` is a member like any other: a group rearranges whole columns between rows, and a
    mix keeps its value multiset whatever the order, so its percentages survive the move. A
    ``<switch>`` joins too, but the group may only move its value between rows that share a
    subject — see ``_partition_rows`` in the engine.
    """
    names: list[str] = []
    for inner in wrapper.content().element():
        open_el = inner.openCloseElement()
        if open_el is None:
            continue
        tag = open_el.name.text
        if tag == "sequence":
            spec = _sequence(open_el)
        elif tag == "mix":
            spec = _mix_sequence(open_el)
        elif tag == "switch":
            spec = _switch_sequence(open_el)
        else:
            continue
        sequences.append(spec)
        if spec.name:
            names.append(spec.name)
    return names



def _is_true(raw: str | None) -> bool:
    """A boolean attribute, read the way every other one in the DSL is read.

    ``uniq`` alone used to be compared against the bare literal ``"true"`` while the validator
    lowercased it first, so ``uniq="True"`` passed validation as a uniqueness promise and then
    did nothing — a column with duplicates that ``check`` had already called valid.
    """
    return (raw or "").strip().lower() == "true"

def _sequence(element) -> SequenceSpec:
    attrs = attributes(element.attr())
    name = attrs.get("name")
    parent = attrs.get("parent")

    gens: list[dict[str, str]] = []
    distinct_groups: list[list[str]] = []
    # The body in source order, kept beside `gens` so the ordinary shapes are read exactly as
    # they were and only a body that composes takes the new path.
    items: list[Item] = []
    saw_data = False
    unnamed_gens = 0

    for child in element.content().element():
        data_el = child.dataElement()
        if isinstance(data_el, TDCParser.DataWithBodyContext):
            saw_data = True
            text = paired_data.restore(data_el.dataContent().getText())
            constant = attributes(data_el.attr()).get("name")
            if constant:
                items.append(Item(text=text, constant_name=constant))
            elif text:
                items.append(Item(text=text))
            continue

        self_el = _gen_of(child)
        if self_el is not None:
            gen_attrs = attributes(self_el.attr())
            item, unnamed_gens = _item_of(gen_attrs, unnamed_gens)
            items.append(item)
            gens.append(gen_attrs)
            continue
        open_el = child.openCloseElement()
        if open_el is not None and open_el.name.text == "distinct":
            # A <distinct> wrapper holds gens that must differ from each other within one row.
            # Its children are ordinary fields; the wrapper only records the constraint.
            group: list[str] = []
            for inner in open_el.content().element():
                inner_gen = _gen_of(inner)
                if inner_gen is not None:
                    gen_attrs = attributes(inner_gen.attr())
                    item, unnamed_gens = _item_of(gen_attrs, unnamed_gens)
                    items.append(item)
                    gens.append(gen_attrs)
                    field_name = gen_attrs.get("name")
                    if field_name:
                        group.append(field_name)
            # A group of one carries no constraint — there is nothing for it to differ from.
            if len(group) >= 2:
                distinct_groups.append(group)

    # A <compute> sequence derives its value instead of drawing one, so it has no <gen> at all.
    # This is how a check digit lives as editable pack data rather than as engine code.
    compute = _find(element.content(), "compute")
    if compute is not None:
        return SequenceSpec(name=name, parent=parent, compute=compute)

    if not gens:
        raise ValueError(f'sequence "{name}" has no <gen> child')

    # Conditional first, exactly as the reference orders it: gens carrying `if` are branches,
    # and a branch has no need of a name.
    if any("if" in g for g in gens):
        branches = []
        for g in gens:
            gen_attrs = dict(g)
            # `if` is the branch's condition, not a setting the generator should see.
            condition = gen_attrs.pop("if", None)
            branches.append(Branch(condition, Gen(gen_attrs.get("type", ""), gen_attrs)))
        return SequenceSpec(name=name, parent=parent, branches=branches)

    # Composed when the body is not simply one unnamed gen or a set of named ones: the unnamed
    # gens and the literals build the sequence's own value and the named ones stay fields beside
    # it. Checked before compound, because a body with both readings is the composed one — that is
    # where ${{Name}} gets a value.
    if saw_data or (unnamed_gens > 0 and len(gens) > 1):
        return SequenceSpec(
            name=name,
            parent=parent,
            items=items,
            distinct_groups=distinct_groups or None,
            uniq=_is_true(attrs.get("uniq")),
        )

    # Compound when there is more than one gen, or when the only one is named — the second case
    # lets a one-field compound be written deliberately.
    if len(gens) > 1 or "name" in gens[0]:
        fields = [Field(g["name"], Gen(g.get("type", ""), g)) for g in gens if g.get("name")]
        return SequenceSpec(
            name=name,
            parent=parent,
            fields=fields,
            distinct_groups=distinct_groups or None,
            uniq=_is_true(attrs.get("uniq")),
        )

    # `uniq` travels to the simple shape too — a draw without replacement
    # (sequence/uniq_simple.py); dropping it silently was the bug that made
    # 100 "unique" names repeat.
    return SequenceSpec(
        name=name,
        parent=parent,
        gen=Gen(gens[0].get("type", ""), gens[0]),
        uniq=_is_true(attrs.get("uniq")),
    )


def _item_of(attrs: dict[str, str], unnamed: int) -> tuple[Item, int]:
    """One ``<gen>`` as a body item: a field when named, a drawn part otherwise."""
    gen = Gen(attrs.get("type", ""), attrs)
    field_name = attrs.get("name")
    if field_name:
        return Item(field=Field(field_name, gen)), unnamed
    return Item(gen=gen), unnamed + 1


def _mix_sequence(element) -> SequenceSpec:
    """A standalone ``<mix name="…">`` in ``<env>`` is a sequence in its own right."""
    attrs = attributes(element.attr())
    return SequenceSpec(name=attrs.get("name"), parent=attrs.get("parent"), mix=_mix(element))


def _mix(element) -> Mix:
    attrs = attributes(element.attr())
    cases = [
        _case(child.openCloseElement())
        for child in element.content().element()
        if child.openCloseElement() is not None and child.openCloseElement().name.text == "case"
    ]
    return Mix(attrs.get("percent"), attrs.get("flag"), cases)


def _case(element) -> Case:
    """A case body: literal text, generators and nested mixes, concatenated in order."""
    parts: list[CasePart] = []
    for child in element.content().element():
        data = child.dataElement()
        if isinstance(data, TDCParser.DataWithBodyContext):
            parts.append(CasePart(text=paired_data.restore(data.dataContent().getText())))
            continue
        self_el = child.selfClosingElement()
        if self_el is not None and self_el.name.text == "gen":
            gen_attrs = attributes(self_el.attr())
            parts.append(CasePart(gen=Gen(gen_attrs.get("type", ""), gen_attrs)))
            continue
        open_el = child.openCloseElement()
        if open_el is not None and open_el.name.text == "mix":
            parts.append(CasePart(mix=_mix(open_el)))
        elif open_el is not None and open_el.name.text == "switch":
            parts.append(CasePart(switch=_switch_body(open_el)))
    return Case(parts, attributes(element.attr()).get("anomaly") == "true")


def _switch_body(element) -> Switch:
    """The body of a ``<switch on="…">`` — its subject, entries and fallback.

    Shared by the env-level form, which becomes a column, and the form written inside a
    ``<case>``, which contributes a value. One reader, so the two cannot drift apart.
    """
    entries: list[SwitchEntry] = []
    fallback: Case | None = None

    for child in element.content().element():
        map_el = child.mapElement()
        if map_el is not None:
            entries.extend(_map_entries(_map_text(map_el)))
            continue
        open_el = child.openCloseElement()
        if open_el is None:
            continue
        if open_el.name.text == "case":
            keys = _split_keys(attributes(open_el.attr()).get("is", ""))
            if keys:
                entries.append(SwitchEntry(keys, _case(open_el)))
        elif open_el.name.text == "default":
            fallback = _case(open_el)

    return Switch(attributes(element.attr()).get("on", ""), entries, fallback)


def _switch_sequence(element) -> SequenceSpec:
    attrs = attributes(element.attr())
    return SequenceSpec(
        name=attrs.get("name"),
        parent=attrs.get("parent"),
        switch_spec=_switch_body(element),
    )


def _map_entries(text: str) -> list[SwitchEntry]:
    """A ``<map>`` body: ``KEY:VALUE`` entries separated by commas, multi-key via ``|``."""
    out: list[SwitchEntry] = []
    for raw_row in text.split(","):
        row = raw_row.strip()
        if not row or ":" not in row:
            continue
        key_part, _, value = row.partition(":")
        keys = _split_keys(key_part)
        if keys:
            out.append(SwitchEntry(keys, Case([CasePart(text=value.strip())], False)))
    return out


def _split_keys(raw: str) -> list[str]:
    return [key.strip() for key in raw.split("|") if key.strip()]


def _map_text(element) -> str:
    """The raw body of a ``<map>``; a self-closing one carries none."""
    if isinstance(element, TDCParser.MapWithBodyContext):
        return element.mapContent().getText()
    return ""


def _lines(content) -> list[Line]:
    out: list[Line] = []
    if content is None:
        return out
    for child in content.element():
        open_el = child.openCloseElement()
        if open_el is None or open_el.name.text != "line":
            continue
        parts: list[DataPart] = []
        for inner in open_el.content().element():
            data = inner.dataElement()
            if isinstance(data, TDCParser.DataWithBodyContext):
                data_attrs = attributes(data.attr())
                parts.append(
                    DataPart(
                        paired_data.restore(data.dataContent().getText()),
                        data_attrs.get("if"),
                        data_attrs.get("name"),
                        data_attrs.get("type"),
                    )
                )
        line_attrs = attributes(open_el.attr())
        out.append(Line(parts, line_attrs.get("if"), line_attrs.get("each")))
    return out


def parse_gen_tag(source: str) -> Gen:
    """A lone ``<gen …/>`` tag, as found in the body of a generator pack.

    Through the same grammar the rest of the config goes through, rather than a quick regular
    expression over the attributes. A pack body is config, written by the same people in the same
    language, and it should fail the same way when it is wrong.
    """
    from .facade import parse

    result = parse(source)
    if not result.ok:
        raise ValueError(f"pack generator did not parse: {result.problems}")
    for element in result.tree.element():
        self_el = element.selfClosingElement()
        if self_el is not None and self_el.name.text == "gen":
            attrs = attributes(self_el.attr())
            type_ = attrs.get("type", "")
            if not type_:
                raise ValueError('<gen> in a generator body is missing a "type" attribute')
            if type_ not in PRIMITIVE_GENERATOR_TYPES:
                raise ValueError(
                    f'generator type "{type_}" is not supported as a single-<gen> body '
                    f"(supported: {', '.join(PRIMITIVE_GENERATOR_TYPES)}); "
                    "to reference data, use <sequence>\u2026</sequence> + <data>"
                )
            return Gen(type_, attrs)
    raise ValueError(f"pack generator body has no <gen> tag: {source}")


def parse_pack_body(body: str) -> PackGenerator:
    """A composed pack generator: local sequences feeding an output template.

    The body is wrapped in a document before parsing, exactly as the reference does, so a pack
    written as a fragment goes through the same grammar as everything else.
    """
    from .facade import parse

    result = parse(f'<tdc><env count="1">{body}</env></tdc>')
    if not result.ok:
        raise ValueError(f"pack generator did not parse: {result.problems}")
    tdc = _find(result.tree, "tdc")
    env = None if tdc is None else _find(tdc.content(), "env")
    if env is None:
        raise ValueError("pack generator body has no <env>")

    sequences: list[SequenceSpec] = []
    output: str | None = None
    for child in env.content().element():
        open_el = child.openCloseElement()
        if open_el is not None and open_el.name.text == "sequence":
            refused = _whole_column_declaration(open_el) or _unreachable_parameter(open_el)
            if refused is not None:
                raise ValueError(refused)
            refused = _misplaced_in_sequence(open_el)
            if refused is not None:
                raise ValueError(refused)
            refused = _disallowed_gen_type(open_el)
            if refused is not None:
                raise ValueError(refused)
            sequences.append(_sequence(open_el))
            continue
        # A standalone `<mix name="…">` or `<switch name="…">` is a SEQUENCE, declared beside
        # the others rather than inside one — the same reading the config parser gives it two
        # functions up. Skipping them here left the `${{name}}` in the output template with
        # nothing to resolve against, so the pack emitted its own placeholder as data:
        # `${{p}}` on every row, exit 0, and `check` calling it valid. It is a documented shape
        # ("Exact percentages inside a generator") and two shipped packs use it.
        if open_el is not None and open_el.name.text in ("mix", "switch"):
            sequences.append(
                _mix_sequence(open_el)
                if open_el.name.text == "mix"
                else _switch_sequence(open_el)
            )
            continue
        data = child.dataElement()
        if isinstance(data, TDCParser.DataWithBodyContext):
            output = paired_data.restore(data.dataContent().getText())
    if output is None:
        raise ValueError("a composed pack generator needs a <data>...</data> output template")
    return PackGenerator(sequences, output, _find(env.content(), "valid"))


#: Constructs that belong somewhere other than directly inside a ``<sequence>``.
#:
#: The same five the validator refuses in a config with TDC013, and refused here for the same
#: reason — except that in a pack body nothing was refusing them at all. A ``<mix>`` written
#: inside a pack's ``<sequence>`` produced no value and no complaint in the reference:
#: ``${{p.m}}`` reached the output as eight literal characters, which is the one outcome worse
#: than an error, because the run looks like it worked.
#:
#: Distribution is an env-level construct: a pack declares its own shares with a ``<mix>`` at the
#: top of its body, beside the sequences rather than inside one.
MISPLACED_IN_SEQUENCE = ("mix", "switch", "case", "default", "map")


def _misplaced_in_sequence(sequence) -> str | None:
    """Why this pack sequence is refused, or ``None`` when its children all belong there."""
    content = sequence.content()
    for child in content.element() if content is not None else []:
        element = child.openCloseElement() or child.selfClosingElement()
        name = element.name.text if element is not None else None
        if name is None or name not in MISPLACED_IN_SEQUENCE:
            continue
        return (
            f"generator has <{name}> directly inside <sequence>, which is not allowed. "
            "A <mix> or <switch> is a named construct of its own — declare it beside the "
            "sequences in the pack body and reach it as ${{Name}}."
        )
    return None


#: Generator types a pack may use as its whole body.
#:
#: A pack is a value, so its body may only be something that PRODUCES one on its own. What is
#: missing from this list is what makes it worth having: ``file`` would read a path relative to
#: nothing in particular, ``http`` would put a network call behind an address that looks like a
#: word list, and ``template`` would let one pack call another and cycle.
PRIMITIVE_GENERATOR_TYPES = (
    "text",
    "number",
    "regex",
    "advanced_regex",
    "symbol",
    "date",
    "increment",
    "decrement",
)

#: Types allowed for a ``<gen>`` inside a composed pack's local sequences. ``template`` is allowed
#: here and not above: a composed body's whole purpose is to join values that come from data lists,
#: and a data list is a leaf, so no cycle is possible through one.
COMPOSED_GEN_TYPES = (*PRIMITIVE_GENERATOR_TYPES, "template")


def _disallowed_gen_type(element) -> str | None:
    """The first ``<gen>`` in this subtree whose type a pack may not use, said as a refusal.

    The parse tree is walked rather than the built spec: a ``<mix>`` nested inside a pack's
    ``<sequence>`` does not reach the spec here, so walking the spec would look straight past the
    one place a network call is easiest to hide.
    """
    for gen in _descendant_elements(element):
        if gen.name.text != "gen":
            continue
        type_ = attributes(gen.attr()).get("type", "")
        if type_ and type_ not in COMPOSED_GEN_TYPES:
            return (
                f'generator uses <gen type="{type_}"> which is not allowed inside a pack generator'
            )
    return None


def _descendant_elements(element):
    """Every element below this one, self-closing and paired alike, depth first."""
    content = element.content() if hasattr(element, "content") else None
    for child in content.element() if content is not None else []:
        self_el = child.selfClosingElement()
        if self_el is not None:
            yield self_el
            continue
        open_el = child.openCloseElement()
        if open_el is not None:
            yield open_el
            yield from _descendant_elements(open_el)


#: Whole-COLUMN declarations, which a pack body cannot honour.
#:
#: A pack describes how to build ONE value and is asked for one per row. These two say something
#: about the column as a whole — which values may repeat across rows, and in what order they come
#: out — and answering that needs the row count and every other row, neither of which a pack has.
#: Worse, one pack can be drawn from by several sequences in one config, so there is no single
#: column for the pack to be speaking about.
#:
#: ``<distinct>`` is deliberately NOT here. It reads like a sibling of ``uniq=`` and is not one: it
#: constrains fields against each other WITHIN one row, which is exactly what a pack can answer on
#: its own — and five shipped full-name packs rely on it to keep a person's two surnames from
#: coming out the same.
WHOLE_COLUMN_ATTRS = ("uniq", "order")


#: What the ENGINE reads off the calling ``<gen type="template">`` before the pack runs. A
#: ``<sequence>`` named one of these can never be set by a caller: the parameter simply does not
#: exist, however plainly the pack declares it. Kept in step with the reference.
_RESERVED_TEMPLATE_NAMES = frozenset(
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


def _unreachable_parameter(sequence) -> str | None:
    """A pack sequence whose name the engine takes for itself, so no caller can set it.

    A pack's parameters ARE its sequence names, and a handful of those names are read by the
    engine first — ``local=`` is the locale override, ``order=``/``case=``/``mask=`` are wrappers
    around whatever the pack produces. Measured before this was added: 34 shipped packs were in
    that state, including ``common.internet.email``, whose documented ``local=`` chose a LOCALE
    instead of the address's local part.
    """
    attrs = attributes(sequence.attr())
    name = attrs.get("name")
    if name is None or name not in _RESERVED_TEMPLATE_NAMES:
        return None
    return (
        f'generator declares <sequence name="{name}">, and "{name}" is read by the engine '
        "off the calling <gen> before this pack runs, so no caller can ever set it. Rename "
        "the sequence: a pack's parameters are its sequence names, and this one is taken."
    )


def _whole_column_declaration(sequence) -> str | None:
    """Why this pack sequence is refused, or ``None`` when there is nothing wrong with it."""
    attrs = attributes(sequence.attr())
    named = attrs.get("name")
    where = "<sequence>" if named is None else f'<sequence name="{named}">'
    for attr in WHOLE_COLUMN_ATTRS:
        if attrs.get(attr, "").strip() == "":
            continue
        return (
            f"generator declares {attr}= on {where}, which a pack cannot honour: a pack builds "
            f"ONE value and is asked for one per row, while {attr}= is a property of the whole "
            "column. Declare it on the sequence in the config that draws from this pack instead."
        )
    return None


# ── plumbing ────────────────────────────────────────────────────────────────────────────────


def attributes(attrs) -> dict[str, str]:
    """An element's attributes, with the lexer's quotes stripped."""
    out: dict[str, str] = {}
    for attr in attrs:
        raw = attr.attrValue.text
        out[attr.attrName.text] = raw[1:-1]
    return out


def _find(parent, name: str):
    """The first child element with this tag name, at one level down."""
    if parent is None:
        return None
    elements = parent.element() if hasattr(parent, "element") else []
    for child in elements:
        open_el = child.openCloseElement()
        if open_el is not None and open_el.name.text == name:
            return open_el
    return None


def _regex_max_length(raw: str | None) -> int:
    if raw is None or not raw.strip():
        return DEFAULT_REGEX_MAX_LENGTH
    try:
        value = int(raw.strip())
    except ValueError:
        return DEFAULT_REGEX_MAX_LENGTH
    return value if value > 0 else DEFAULT_REGEX_MAX_LENGTH
