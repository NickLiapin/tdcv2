"""The ``<compute>`` tree, checked before it runs.

Compute is a small language of its own, and its mistakes are the quiet kind: a ``<use>`` nobody
bound reads as empty, a ``<choose>`` with no fallback produces nothing when every branch misses, a
second ``<result>`` silently wins over the first. None of that stops a run — it produces a check
digit that is wrong, in a file of a million records that all look plausible.

So the whole tree is walked here: unknown tags, bindings, arity, encodings, and the wrapper children
each construct needs. Diagnostics TDC180 through TDC189.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..errors import Diagnostic
from ..errors.diagnostic import closest_match
from ..format.mask import apply_mask

_ENCODINGS = frozenset({"base36", "ascii", "unicode", "hex", "binary", "octal"})

#: Every tag of the compute language, and the attributes each one reads -- the same table as the
#: reference's ``compute/attributes.ts``, in the same order, because the order is the order a near
#: name is looked for in. A name not listed for its tag is refused (TDC015): nothing checked these
#: names before, and ``<join seperator="-">`` quietly joined with nothing.
_ATTRIBUTES: dict[str, tuple[str, ...]] = {
    # literals and references
    "int": ("v",), "str": ("v",), "list": ("v",), "field": ("name",), "use": ("name",),
    "current": (), "current_index": (), "acc": (),
    # binding
    "let": ("name",),
    # collections
    "each": (), "reduce": (), "join": ("sep",), "split": ("sep",), "at": ("default",),
    "length": (),
    # arithmetic
    "add": (), "subtract": (), "multiply": (), "divide": (), "mod": (),
    # encoding and conversion
    "encode": ("as",), "to_number": (), "pad": ("width", "fill"), "concat": (), "upper": (),
    "lower": (), "capitalize": (), "title": (), "mask": ("pattern",), "slice": ("from", "to"),
    "replace": ("from", "to"), "trim": (), "group": ("size", "sep"),
    # conditionals and the role wrappers
    "choose": (), "when": (), "otherwise": (), "test": (), "then": (), "result": (), "over": (),
    "do": (), "init": (), "in": (), "index": (),
    # predicates
    "equals": (), "greater_than": (), "less_than": (), "is_digit": (),
}  # fmt: skip

_KNOWN_TAGS = frozenset(_ATTRIBUTES)

#: Accepted on every compute tag and read by none: a note for the reader, as on every other tag.
_ANY_TAG_ATTRIBUTE = "comment"

#: Common spellings of an attribute under another name, and the one the tag reads. Offered only
#: when the tag does read it: ``separator=`` is what ``<gen>`` calls it, so it is what a hand used
#: to ``<gen>`` writes on a ``<join>``.
_OTHER_SPELLINGS = {
    "separator": "sep",
    "seperator": "sep",
    "delimiter": "sep",
    "value": "v",
    "val": "v",
}


# Tags the compute spec describes but this version does not ship, so the diagnostic explains the
# gap instead of reading like a typo.
def _candidates(names: list[str], most: int = 6) -> str:
    """A list of allowed names, truncated the way every long list in a diagnostic is."""
    if len(names) <= most:
        return ", ".join(names)
    return ", ".join(names[:most]) + f", … ({len(names) - most} more)"


#: Tags that used to be called something else.
#:
#: Without this a renamed tag falls through to "unknown compute tag", which tells a reader
#: their spelling is wrong and not what the right one is. The rename is the one moment when
#: the engine knows exactly what was meant, so it says so.
_RENAMED_TAGS = {
    "var": (
        "use",
        "It never declared anything — <let> binds a name and this reads it back, which is "
        "what the new name says. Rename the tag; the name= attribute is unchanged.",
    ),
}

_HINTS_BY_TAG = {
    "param": (
        "<param> belongs to the compute-def/use feature, which is not implemented yet. "
        'An inline <compute> takes no parameters — read the value with <field name="…"/> instead.'
    )
}

#: The four tags that answer TRUE or FALSE rather than producing a value. They are compute
#: tags, so the unknown-tag check waves them through wherever they appear; this set is what
#: keeps a predicate out of a value position, where the evaluator's own complaint arrived
#: only at render time and named no file, line or code.
_PREDICATE_TAGS = frozenset({"equals", "greater_than", "less_than", "is_digit"})

# The two `<field>` names that arrive as NUMBERS rather than text. Everything else a `<field>`
# can name is a rendered value, text until `<to_number>` says otherwise. Their type is known
# before the run, which is what makes the TDC286 refusal a proof rather than a guess.
_NUMERIC_BUILTIN_FIELDS = frozenset({"_count", "_total"})

_POSITIVE_INT = re.compile(r"^[1-9][0-9]*$")
_INTEGER = re.compile(r"^-?\d+$")


@dataclass(frozen=True, slots=True)
class _Node:
    """One node of the tree, flattened out of the two shapes the grammar produces."""

    name: str
    attrs: dict[str, str]
    children: list
    line: int
    column: int


@dataclass(frozen=True, slots=True)
class _Scope:
    """What is visible where: the bound variables, and which bodies we are inside."""

    variables: frozenset[str]
    in_iteration: bool
    in_reduce: bool
    known_fields: set[str] | None
    #: A ``<let>`` above lost its ``name=`` to a misspelled attribute, so an unbound ``<use>`` may
    #: well be the one it meant. The misspelling is reported on the ``<let>``; blaming the
    #: ``<use>`` as well points one tag too far down.
    lost_binding: bool = False

    def with_vars(self, names, lost_binding: bool | None = None) -> _Scope:
        lost = self.lost_binding if lost_binding is None else lost_binding
        return _Scope(frozenset(names), self.in_iteration, self.in_reduce, self.known_fields, lost)

    def iterating(self, reduce: bool) -> _Scope:
        return _Scope(
            self.variables,
            True,
            reduce or self.in_reduce,
            self.known_fields,
            self.lost_binding,
        )


class ComputeCheck:
    __slots__ = ("diagnostics",)

    def __init__(self, diagnostics: list[Diagnostic]) -> None:
        self.diagnostics = diagnostics

    def check(self, compute_element, known_fields: set[str] | None) -> None:
        """One ``<compute>``.

        ``known_fields`` is what ``<field>`` may read, or ``None`` when the caller does not know —
        a pack generator's body is checked without the run's sequences in view.
        """
        scope = _Scope(frozenset(), False, False, known_fields)
        # ``<compute>`` itself reads no attribute, so it is judged against an empty list.
        for attr in compute_element.attr():
            self._unread_attribute("compute", (), attr)
        self._attribute_names(_children(compute_element))

        # Documented as "at most once". A second one silently wins and the first is discarded, so
        # a config can compute something entirely different from what its author read top to
        # bottom.
        seen_result = False
        for child in _children(compute_element):
            node = _node(child)
            if node is None or node.name != "result":
                continue
            if seen_result:
                self._report(
                    node,
                    "TDC189",
                    "<compute> has more than one <result>",
                    "Only the last one would be used and the earlier ones silently dropped. "
                    "Keep a single <result>.",
                )
            seen_result = True

        # ``<result>`` is documented as the single exit of a ``<compute>``, and it was not
        # authoritative: the block kept the LAST value-producing child whatever its tag, so a
        # stray sibling written after ``<result>`` silently overrode it — the very fault TDC189
        # exists to prevent between two ``<result>``s.
        #
        # A ``<compute>`` with NO ``<result>`` is left alone on purpose: a body that is simply
        # the value-producing tree is a shape the docs teach and the shared cases use.
        if seen_result:
            for child in _children(compute_element):
                node = _node(child)
                if node is None or node.name in ("result", "let"):
                    continue
                self._report(
                    node,
                    "TDC189",
                    f"<{node.name}> sits beside <result> in the same <compute>",
                    "The value comes from <result>, and a sibling written after it used to "
                    "override that in silence. Move this inside <result>, bind it with <let>, "
                    "or delete it.",
                )

        owner = _Node("compute", {}, [], compute_element.start.line, compute_element.start.column)
        self._slot(_children(compute_element), scope, owner, extras_reported=seen_result)

    def _attribute_names(self, children: list) -> None:
        """Refuse every attribute a compute tag does not read -- the TDC015 ``<gen>`` always had.

        A pass of its own over the whole subtree rather than a check inside the walk: the walk
        deliberately skips what it cannot judge -- a misspelled slot, an unknown tag, a predicate
        out of place -- and an attribute inside one of those is no less misspelled for it. An
        unknown tag is TDC180's; there is no list to hold its attributes against.
        """
        for child in children:
            element = child.openCloseElement() or child.selfClosingElement()
            if element is None:
                self._raw_text(child)
                continue
            known = _ATTRIBUTES.get(element.name.text)
            if known is not None:
                for attr in element.attr():
                    self._unread_attribute(element.name.text, known, attr)
            if child.openCloseElement() is not None:
                self._attribute_names(_children(element))

    def _raw_text(self, element) -> None:
        """``<data>`` or ``<map>`` inside a ``<compute>``.

        They hold raw text, and the compute language has no text -- every value is a tag. The walk
        skipped them, so ``check`` called the config valid and the run then stopped on the first
        row, naming no file and no line.
        """
        tag = "data" if element.dataElement() is not None else "map"
        self.diagnostics.append(
            Diagnostic.error(
                "TDC180",
                f"<{tag}> is not part of the compute language",
                "Inside <compute> every value is a tag, and raw text is never read — the run "
                'would stop on it. A literal is <str v="…"/>; a column is <field name="…"/>.',
                element.start.line,
                element.start.column,
            )
        )

    def _unread_attribute(self, tag: str, known: tuple[str, ...], attr) -> None:
        name = attr.attrName.text
        if name == _ANY_TAG_ATTRIBUTE or name in known:
            return
        other = _OTHER_SPELLINGS.get(name, "")
        suggestion = closest_match(name, list(known)) or (other if other in known else "")
        listed = (
            f"Attributes of <{tag}>: {_candidates(sorted(known))}."
            if known
            else f"<{tag}> takes no attributes."
        )
        text = attr.attrValue.text
        quoted = len(text) >= 2 and text.startswith('"') and text.endswith('"')
        self.diagnostics.append(
            Diagnostic.error(
                "TDC015",
                f'<{tag}> has no "{name}" attribute',
                listed
                + " Any other name would be ignored, and the value computed as if it were not "
                "written.",
                attr.attrValue.line,
                attr.attrValue.column + (1 if quoted else 0),
                f'did you mean "{suggestion}"?' if suggestion else "",
            )
        )

    def _slot(
        self, children: list, scope: _Scope, owner: _Node, extras_reported: bool = False
    ) -> None:
        """``<let>`` prefixes bind for the siblings after them, and the last child is the value.

        A slot holds ONE value, and the evaluator honours that literally: it computes every child
        and keeps the last. So a second value did not fail -- it replaced the first, in silence
        (``<result><str v="a"/><str v="b"/></result>`` printed ``b``), and a slot with no value
        passed ``check`` and stopped the run. Both are refused here, on the tag that owns the slot.
        ``extras_reported`` is set where the extra values already have a refusal of their own.
        """
        bound = set(scope.variables)
        lost_binding = scope.lost_binding
        values: list[_Node] = []
        for child in children:
            node = _node(child)
            if node is None:
                continue
            if node.name != "let":
                values.append(node)
            if node.name == "let" and _written_under_another_name(node, "name"):
                lost_binding = True
                self._slot(node.children, scope.with_vars(bound), node)
                continue
            if node.name == "let":
                name = node.attrs.get("name", "")
                if name in bound:
                    self._report(
                        node,
                        "TDC185",
                        f'<let name="{name}"> shadows an outer binding of the same name',
                        None,
                    )
                self._slot(node.children, scope.with_vars(bound), node)
                bound.add(name)
            else:
                self._expr(child, scope.with_vars(bound, lost_binding))
        # Raw text in the slot has its own refusal (TDC180); "holds no value" would be its echo.
        raw_text = any(_node(child) is None for child in children)
        if not values:
            if not raw_text:
                self._report(
                    owner,
                    "TDC187",
                    f"<{owner.name}> holds no value",
                    "It needs one value inside it, after any <let>s. With nothing there the run "
                    "would stop on the first row.",
                )
        elif not extras_reported:
            last = values[-1]
            for dropped in values[:-1]:
                self._report(
                    dropped,
                    "TDC189",
                    f"<{dropped.name}> is dropped — <{owner.name}> holds one value, and only the "
                    "last is used",
                    f"This one would be computed and thrown away, and <{last.name}> after it "
                    "would win. Keep one value here: name the others with <let>, or join them "
                    "with <concat>.",
                )

    def _wrapper(self, node: _Node, wrapper: str, scope: _Scope) -> None:
        """A construct needing one named wrapper child, like ``<each><over>…</over></each>``."""
        for child in node.children:
            inner = _node(child)
            if inner is not None and inner.name == wrapper:
                self._slot(inner.children, scope, inner)
                return
        self._report(node, "TDC187", f"<{node.name}> requires a <{wrapper}> child", None)

    def _expr(self, element, scope: _Scope) -> None:
        node = _node(element)
        if node is None:
            return
        name = node.name
        # A predicate answers TRUE or FALSE, so it is not a value. It is a compute tag, so
        # the unknown-tag check below waves it through wherever it appears — and
        # `<result><greater_than>…</greater_than></result>` then passed check and died
        # mid-run with a message carrying no code, no line and no file.
        if name in _PREDICATE_TAGS:
            self._report(
                node,
                "TDC180",
                f"<{name}> is a predicate, not a value — it is valid only inside <test>",
                "A predicate answers true or false, and this position wants something to "
                f"print. Wrap it: <choose><when><test><{name}>…</{name}></test></when>"
                "<then>…</then></choose>.",
            )
            return
        renamed = _RENAMED_TAGS.get(name)
        if renamed is not None:
            self._report(node, "TDC288", f"<{name}> has been renamed to <{renamed[0]}>", renamed[1])
            return
        if name not in _KNOWN_TAGS:
            # The reference falls back to naming the tags a <compute> takes when the unknown one
            # has no note of its own. Without the fallback the refusal said only that the tag is
            # unknown, and left the reader to go and find the list -- on the one diagnostic whose
            # whole job is to point at it.
            self._report(
                node,
                "TDC180",
                f"unknown compute tag <{name}>",
                _HINTS_BY_TAG.get(name)
                or f"Allowed inside <compute>: {_candidates(sorted(_KNOWN_TAGS))}.",
            )
            return

        if name in ("current", "current_index"):
            if not scope.in_iteration:
                self._report(
                    node, "TDC181", f"<{name}/> is only valid inside a <do> iteration body", None
                )
        elif name == "acc":
            if not scope.in_reduce:
                self._report(
                    node, "TDC181", "<acc/> is only valid inside a <reduce> <do> body", None
                )
        elif name == "use":
            key = node.attrs.get("name", "")
            if scope.lost_binding or _written_under_another_name(node, "name"):
                pass
            elif key not in scope.variables:
                self._report(
                    node, "TDC182", f'<use name="{key}"> is not bound by an enclosing <let>', None
                )
        elif name == "field":
            key = node.attrs.get("name", "")
            if _written_under_another_name(node, "name"):
                pass
            elif scope.known_fields is not None and key not in scope.known_fields:
                self._report(
                    node,
                    "TDC182",
                    f'<field name="{key}"> refers to a value that is not in scope',
                    None,
                )
        elif name == "int":
            raw = node.attrs.get("v", "").strip()
            if not _INTEGER.match(raw) and not _written_under_another_name(node, "v"):
                self._report(
                    node,
                    "TDC188",
                    f'<int v="{node.attrs.get("v", "")}"> is not an integer',
                    'Write a whole number, e.g. <int v="42"/>. For text use <str v="…"/>.',
                )
        elif name == "str":
            pass  # A literal string: nothing about it can be wrong here.
        elif name in ("list", "add", "multiply", "concat"):
            # `<list>` has two spellings and reads only the first: with `v=` set, the children are
            # never evaluated. Nobody writes both on purpose — it means one was meant to replace
            # the other, and the engine kept whichever the author was not looking at.
            if name == "list" and node.attrs.get("v") is not None and _count_nodes(node) > 0:
                self._report(
                    node,
                    "TDC189",
                    "<list> has both v= and children",
                    "Only v= is read; the children are silently dropped. Keep one spelling: "
                    'v="1,2,3" for a literal list, or child elements for a computed one.',
                )
            for child in node.children:
                self._expr(child, scope)
        elif name == "group":
            # A size the engine cannot use turns grouping OFF and says nothing, so the column
            # comes out looking like the tag was never written. `size="2.5"` is worse: measured
            # "12 34 567", grouped by neither 2 nor 3.
            size = node.attrs.get("size")
            if size is not None and not _POSITIVE_INT.match(size.strip()):
                self._report(
                    node,
                    "TDC188",
                    f'<group size="{size}"> is not a whole number of characters',
                    "Write a positive whole number. A size the engine cannot use would turn "
                    "grouping off and leave the value unchanged, with nothing to show why.",
                )
            self._slot(node.children, scope, node)
        elif name in ("mod", "divide"):
            count = _count_nodes(node)
            if count != 2:
                self._report(
                    node, "TDC183", f"<{name}> requires exactly 2 children, found {count}", None
                )
            for child in node.children:
                self._expr(child, scope)
        elif name == "subtract":
            if _count_nodes(node) < 1:
                self._report(node, "TDC183", "<subtract> requires at least one child", None)
            for child in node.children:
                self._expr(child, scope)
        elif name == "each":
            self._slot_names(node, ("over", "do"))
            self._wrapper(node, "over", scope)
            self._wrapper(node, "do", scope.iterating(False))
        elif name == "reduce":
            self._slot_names(node, ("over", "init", "do"))
            self._wrapper(node, "over", scope)
            self._wrapper(node, "init", scope)
            self._wrapper(node, "do", scope.iterating(True))
        elif name == "at":
            self._slot_names(node, ("in", "index"))
            self._wrapper(node, "in", scope)
            self._wrapper(node, "index", scope)
        elif name == "encode":
            as_what = node.attrs.get("as", "")
            if as_what not in _ENCODINGS and not _written_under_another_name(node, "as"):
                self._report(node, "TDC186", f'<encode>: unknown encoding "{as_what}"', None)
            self._numeric_builtin_argument(node.children, "encode")
            self._slot(node.children, scope, node)
        elif name == "mask":
            # The filter form of the same fault is TDC256 in validate.py. A mask with no pattern
            # has nothing to keep, and the engine answered that literally: it returned the empty
            # string, so the column came out blank.
            pattern = (node.attrs.get("pattern") or "").strip()
            if _written_under_another_name(node, "pattern"):
                pass  # reported as the misspelling it is; "needs a pattern=" would be its echo
            elif not pattern:
                self._report(
                    node,
                    "TDC256",
                    "<mask> needs a pattern= — without one it returns the empty string",
                    None,
                )
            else:
                # And the pattern itself. ``mask=`` on a gen and the ``mask:`` filter are both
                # pre-checked; this route was not, so the documented easy typo — ``x[1-2]``, a
                # hyphen where the range wants ``..`` — passed ``check`` and aborted the run with
                # no code, no file and no line. The empty input is enough: parsing happens before
                # anything is consumed.
                try:
                    apply_mask(pattern, "")
                except ValueError as err:
                    self._report(
                        node,
                        "TDC199",
                        str(err),
                        'Indices are 0-based; ranges use "..", e.g. pattern="x[0..3]" or '
                        'pattern="w[-1], w[0]".',
                    )
            self._slot(node.children, scope, node)
        elif name == "choose":
            self._choose(node, scope)
        elif name == "over":
            self._report(
                node,
                "TDC181",
                "<over> is only valid inside <each> or <reduce>",
                "It names the list being walked. Outside those tags there is nothing to walk.",
            )
        elif name in ("when", "test"):
            # A value position cannot hold either: the evaluator has no case for them outside the
            # <choose> that reads them, and stopped the run with "unknown compute tag <when>".
            self._report(
                node,
                "TDC181",
                "<when> is only valid inside <choose>"
                if name == "when"
                else "<test> is only valid inside <when>",
                "It is one branch of a <choose>, and outside one there is nothing to choose "
                "between. Wrap it: <choose><when><test>…</test><then>…</then></when>"
                "<otherwise>…</otherwise></choose>.",
            )
        elif name == "let":
            # Reaching here means an operand position -- a slot binds its <let>s before walking
            # the value. The evaluator stopped on it with no file and no line.
            self._report(
                node,
                "TDC180",
                "<let> is a binding, not a value — it is valid only ahead of the value in a slot",
                "A <let> names a value for the siblings after it, inside <result>, <then>, <do> "
                "and the like. Here it stands where a value is read. Move it up into the "
                "enclosing slot.",
            )
        else:
            self._slot(node.children, scope, node)

    def _slot_names(self, node: _Node, slots: tuple[str, ...]) -> None:
        """A child in a SLOT position that names no slot this tag has.

        ``<choose>``, ``<when>``, ``<each>``, ``<reduce>`` and ``<at>`` do not evaluate their
        children in order — each looks up the slots it knows by name and ignores everything else.
        So a misspelled slot name was never walked, never validated, and never run. Measured on
        the compute overview's own Luhn example with ``<when>`` spelled ``<wen>``: the
        ``<otherwise>`` won every row and every card number came out invalid, while ``check``
        called the config valid.

        The stray part is deliberately NOT walked: what the author meant is unknown, so every
        rule applied inside is a guess about the intended shape — and walking the misspelled
        ``<wen>`` as a value slot reported its perfectly correct ``<test><equals>`` as a predicate
        in a value position, a second error on markup that needs no change.
        """
        for child in node.children:
            inner = _node(child)
            if inner is None or inner.name in slots:
                continue
            allowed = " and ".join(f"<{s}>" for s in slots)
            self._report(
                inner,
                "TDC180",
                f"<{node.name}> has no <{inner.name}> part",
                f"Inside <{node.name}> only {allowed} are read; anything else is silently "
                "ignored, so a misspelling here changes the result without any other sign.",
            )

    def _choose(self, node: _Node, scope: _Scope) -> None:
        self._slot_names(node, ("when", "otherwise"))
        has_otherwise = False
        for child in node.children:
            inner = _node(child)
            if inner is None:
                continue
            if inner.name == "when":
                self._when(inner, scope)
            elif inner.name == "otherwise":
                has_otherwise = True
                self._slot(inner.children, scope, inner)
        if not has_otherwise:
            # Without it, a row matching no branch computes nothing at all — and an empty check
            # digit is indistinguishable from a value that happens to be blank.
            self._report(node, "TDC184", "<choose> requires an <otherwise> branch", None)

    def _when(self, node: _Node, scope: _Scope) -> None:
        self._slot_names(node, ("test", "then"))
        test = None
        for child in node.children:
            inner = _node(child)
            if inner is not None and inner.name == "test":
                test = inner
                break
        if test is None:
            self._report(node, "TDC187", "<when> requires a <test> child", None)
        else:
            # One question, read first. An empty <test> passed check and stopped the run; a second
            # predicate was never asked, and the branch was taken on the first alone. Neither is
            # walked further: nothing will ever run them.
            predicates = [p for p in (_node(child) for child in test.children) if p is not None]
            if not predicates:
                self._report(
                    test,
                    "TDC187",
                    "<test> holds no predicate",
                    "It needs one question to answer — <equals>, <greater_than>, <less_than> or "
                    "<is_digit>. With nothing there the run would stop on the first row.",
                )
            else:
                self._predicate(predicates[0], scope)
            for extra in predicates[1:]:
                self._report(
                    extra,
                    "TDC189",
                    f"<{extra.name}> is never asked — <test> holds one predicate, and only the "
                    "first is read",
                    "The branch is taken on the first predicate alone. To ask two things, put a "
                    "second <choose> inside <then>.",
                )
        self._wrapper(node, "then", scope)

    def _comparison_literals(self, node: _Node) -> None:
        """A `<str>` literal under a comparison, holding something that is not a number.

        The three comparisons work on NUMBERS. A string of digits is accepted and read as
        one — `<equals><str v="7"/><int v="7"/></equals>` is true — so the tag is not
        "integers only", and refusing every `<str>` would break a config that works. What
        cannot work is a `<str>` whose text is not a number: measured, the run stopped with
        `expected an integer in <equals>, got the string "ab"`, naming no file, no line and
        no code, on a config `check` had called valid.

        Only a LITERAL is checked. What a `<field>` or a `<use>` will hold is not known
        before the run, and a refusal here has to be a proof.
        """
        for child in node.children:
            inner = _node(child)
            if inner is None or inner.name != "str":
                continue
            raw = inner.attrs.get("v", "")
            if _INTEGER.match(raw.strip()):
                continue
            self._report(
                inner,
                "TDC287",
                f'<{node.name}> compares numbers, and <str v="{raw}"> is not one',
                'A <str> holding digits is read as the number it spells, so <str v="7"/> is '
                "fine. This one is not a number, so the run would stop on the first row. Use "
                "<int>, or <to_number> around the value you meant to compare.",
            )

    def _numeric_builtin_argument(self, children, tag: str) -> None:
        """`<is_digit>` and `<encode>` both want ONE CHARACTER OF TEXT, and both took a number.

        The two failures look nothing alike, which is why only one was ever noticed.
        `<is_digit>` answered "no" on every row — including rows 1 to 9, where the count
        plainly is a digit — and `check` called the config valid. `<encode>` did stop the
        run, but with "expected a single-character string" and no file, no line and no
        code, on a config `check` had also called valid. Same cause, so one refusal.
        """
        for child in children:
            inner = _node(child)
            named = inner.attrs.get("name", "") if inner and inner.name == "field" else ""
            if named not in _NUMERIC_BUILTIN_FIELDS:
                continue
            hint = (
                'It would answer "no" on every row, including the rows where the '
                "count is a single digit. Compare the number itself with <equals> or "
                "<less_than>, or put the digit you mean into a <str>."
                if tag == "is_digit"
                else 'The run would stop with "expected a single-character string", naming '
                "no file and no line. Wrap it in <concat> to turn the number into its "
                "digits — <encode> still needs exactly one of them — or put the character "
                "you mean into a <str>."
            )
            self._report(
                inner,
                "TDC286",
                f'<{tag}> asks about one character of text, and <field name="{named}"> is a number',
                hint,
            )

    def _predicate(self, node: _Node, scope: _Scope) -> None:
        if node.name in ("equals", "greater_than", "less_than"):
            if _count_nodes(node) != 2:
                self._report(node, "TDC183", f"<{node.name}> requires exactly 2 children", None)
            self._comparison_literals(node)
            for child in node.children:
                self._expr(child, scope)
        elif node.name == "is_digit":
            # It reads its first child and nothing else: a second was never looked at, and none at
            # all stopped the run.
            count = _count_nodes(node)
            if count != 1:
                self._report(
                    node, "TDC183", f"<is_digit> requires exactly 1 child, found {count}", None
                )
            self._numeric_builtin_argument(node.children, "is_digit")
            for child in node.children:
                self._expr(child, scope)
        else:
            self._report(
                node,
                "TDC180",
                f"unknown predicate <{node.name}> (valid only inside <test>)",
                None,
            )

    def _report(self, node: _Node, code: str, message: str, hint: str | None) -> None:
        self.diagnostics.append(Diagnostic.error(code, message, hint or "", node.line, node.column))


def _node(element) -> _Node | None:
    open_el = element.openCloseElement()
    if open_el is not None:
        return _Node(
            open_el.name.text,
            _attributes(open_el.attr()),
            _children(open_el),
            open_el.start.line,
            open_el.start.column,
        )
    self_closing = element.selfClosingElement()
    if self_closing is not None:
        return _Node(
            self_closing.name.text,
            _attributes(self_closing.attr()),
            [],
            self_closing.start.line,
            self_closing.start.column,
        )
    return None  # a <data> body, which carries no compute node


def _children(element) -> list:
    content = element.content()
    return [] if content is None else list(content.element() or [])


def _written_under_another_name(node: _Node, attr: str) -> bool:
    """Whether ``node`` lacks ``attr`` because it was written under a name the tag does not read.

    The checks that complain about a MISSING value stand down for such a tag: the misspelling has
    been reported, on the tag it belongs to, and the missing value is only its echo.
    ``<int val="7"/>`` was refused as ``<int v="">`` -- a spelling nobody wrote.
    """
    if attr in node.attrs:
        return False
    known = _ATTRIBUTES.get(node.name, ())
    return any(a != _ANY_TAG_ATTRIBUTE and a not in known for a in node.attrs)


def _count_nodes(node: _Node) -> int:
    """How many of a node's children are elements — a text body is not an argument."""
    return sum(1 for child in node.children if _node(child) is not None)


def _attributes(attrs) -> dict[str, str]:
    out: dict[str, str] = {}
    for attr in attrs:
        raw = attr.attrValue.text
        out[attr.attrName.text] = raw[1:-1]
    return out
