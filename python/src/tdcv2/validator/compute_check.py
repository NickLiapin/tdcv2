"""The ``<compute>`` tree, checked before it runs.

Compute is a small language of its own, and its mistakes are the quiet kind: a ``<var>`` nobody
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

_ENCODINGS = frozenset({"base36", "ascii", "unicode", "hex", "binary", "octal"})

_KNOWN_TAGS = frozenset(
    {
        # literals and references
        "int", "str", "list", "field", "var", "current", "current_index", "acc",
        # binding
        "let",
        # collections
        "each", "reduce", "join", "split", "at", "length",
        # arithmetic
        "add", "subtract", "multiply", "divide", "mod",
        # encoding and conversion
        "encode", "to_number", "pad", "concat", "upper", "lower", "capitalize", "title",
        "mask", "slice", "replace", "trim", "group",
        # conditionals and the role wrappers
        "choose", "when", "otherwise", "test", "then", "result", "over", "do", "init", "in",
        "index",
        # predicates
        "equals", "greater_than", "less_than", "is_digit",
    }
)  # fmt: skip

# Tags the compute spec describes but this version does not ship, so the diagnostic explains the
# gap instead of reading like a typo.
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

    def with_vars(self, names) -> _Scope:
        return _Scope(frozenset(names), self.in_iteration, self.in_reduce, self.known_fields)

    def iterating(self, reduce: bool) -> _Scope:
        return _Scope(self.variables, True, reduce or self.in_reduce, self.known_fields)


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

        self._slot(_children(compute_element), scope)

    def _slot(self, children: list, scope: _Scope) -> None:
        """``<let>`` prefixes bind for the siblings after them, and the last child is the value."""
        bound = set(scope.variables)
        for child in children:
            node = _node(child)
            if node is None:
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
                self._slot(node.children, scope.with_vars(bound))
                bound.add(name)
            else:
                self._expr(child, scope.with_vars(bound))

    def _wrapper(self, node: _Node, wrapper: str, scope: _Scope) -> None:
        """A construct needing one named wrapper child, like ``<each><over>…</over></each>``."""
        for child in node.children:
            inner = _node(child)
            if inner is not None and inner.name == wrapper:
                self._slot(inner.children, scope)
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
                f'<{name}> is a predicate, not a value — it is valid only inside <test>',
                "A predicate answers true or false, and this position wants something to "
                f"print. Wrap it: <choose><when><test><{name}>…</{name}></test></when>"
                "<then>…</then></choose>.",
            )
            return
        if name not in _KNOWN_TAGS:
            self._report(node, "TDC180", f"unknown compute tag <{name}>", _HINTS_BY_TAG.get(name))
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
        elif name == "var":
            key = node.attrs.get("name", "")
            if key not in scope.variables:
                self._report(
                    node, "TDC182", f'<var name="{key}"> is not bound by an enclosing <let>', None
                )
        elif name == "field":
            key = node.attrs.get("name", "")
            if scope.known_fields is not None and key not in scope.known_fields:
                self._report(
                    node,
                    "TDC182",
                    f'<field name="{key}"> refers to a value that is not in scope',
                    None,
                )
        elif name == "int":
            raw = node.attrs.get("v", "").strip()
            if not _INTEGER.match(raw):
                self._report(
                    node,
                    "TDC188",
                    f'<int v="{node.attrs.get("v", "")}"> is not an integer',
                    'Write a whole number, e.g. <int v="42"/>. For text use <str v="…"/>.',
                )
        elif name == "str":
            pass  # A literal string: nothing about it can be wrong here.
        elif name in ("list", "add", "multiply", "concat"):
            for child in node.children:
                self._expr(child, scope)
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
            self._wrapper(node, "over", scope)
            self._wrapper(node, "do", scope.iterating(False))
        elif name == "reduce":
            self._wrapper(node, "over", scope)
            self._wrapper(node, "init", scope)
            self._wrapper(node, "do", scope.iterating(True))
        elif name == "at":
            self._wrapper(node, "in", scope)
            self._wrapper(node, "index", scope)
        elif name == "encode":
            as_what = node.attrs.get("as", "")
            if as_what not in _ENCODINGS:
                self._report(node, "TDC186", f'<encode>: unknown encoding "{as_what}"', None)
            self._slot(node.children, scope)
        elif name == "mask":
            # The filter form of the same fault is TDC256 in validate.py. A mask with no pattern
            # has nothing to keep, and the engine answered that literally: it returned the empty
            # string, so the column came out blank.
            if not (node.attrs.get("pattern") or "").strip():
                self._report(
                    node,
                    "TDC256",
                    "<mask> needs a pattern= — without one it returns the empty string",
                    None,
                )
            self._slot(node.children, scope)
        elif name == "choose":
            self._choose(node, scope)
        elif name == "over":
            self._report(
                node,
                "TDC181",
                "<over> is only valid inside <each> or <reduce>",
                "It names the list being walked. Outside those tags there is nothing to walk.",
            )
        else:
            self._slot(node.children, scope)

    def _choose(self, node: _Node, scope: _Scope) -> None:
        has_otherwise = False
        for child in node.children:
            inner = _node(child)
            if inner is None:
                continue
            if inner.name == "when":
                self._when(inner, scope)
            elif inner.name == "otherwise":
                has_otherwise = True
                self._slot(inner.children, scope)
        if not has_otherwise:
            # Without it, a row matching no branch computes nothing at all — and an empty check
            # digit is indistinguishable from a value that happens to be blank.
            self._report(node, "TDC184", "<choose> requires an <otherwise> branch", None)

    def _when(self, node: _Node, scope: _Scope) -> None:
        test = None
        for child in node.children:
            inner = _node(child)
            if inner is not None and inner.name == "test":
                test = inner
                break
        if test is None:
            self._report(node, "TDC187", "<when> requires a <test> child", None)
        else:
            for child in test.children:
                predicate = _node(child)
                if predicate is not None:
                    self._predicate(predicate, scope)
                    break
        self._wrapper(node, "then", scope)

    def _predicate(self, node: _Node, scope: _Scope) -> None:
        if node.name in ("equals", "greater_than", "less_than"):
            if _count_nodes(node) != 2:
                self._report(node, "TDC183", f"<{node.name}> requires exactly 2 children", None)
            for child in node.children:
                self._expr(child, scope)
        elif node.name == "is_digit":
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


def _count_nodes(node: _Node) -> int:
    """How many of a node's children are elements — a text body is not an argument."""
    return sum(1 for child in node.children if _node(child) is not None)


def _attributes(attrs) -> dict[str, str]:
    out: dict[str, str] = {}
    for attr in attrs:
        raw = attr.attrValue.text
        out[attr.attrName.text] = raw[1:-1]
    return out
