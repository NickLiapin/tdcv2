"""The evaluator for ``<compute>`` — a check digit written as a tag tree.

The tree IS the program. There is no separate expression language to parse, and no separate AST:
every implementation walks the same parse tree, so a checksum written once behaves identically in
all three. That is the whole reason this layer exists in tag form rather than as a little
expression syntax — an expression syntax would need three parsers that agree.

Pure: no random numbers, no clock, no files. The only inputs are the values a ``<field>`` can
reach, which is exactly what ``${{name}}`` can reach.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field

from ..format.mask import apply_mask
from ..format.transforms import apply_case, apply_group, apply_replace, apply_slice, apply_trim
from ..lib import numbers
from ..parser.config_builder import attributes
from .encode import encode_char
from .value import (
    ComputeError,
    Value,
    coerce_int,
    coerce_str,
    euclidean_mod,
    floor_div,
    int_value,
    list_value,
    parse_int_strict,
    str_value,
    to_output,
)

_WRAPPERS = ("result", "do", "over", "init", "in", "index", "then", "otherwise")
_CASES = ("upper", "lower", "capitalize", "title")


@dataclass(frozen=True, slots=True)
class Scope:
    """What a node can see.

    ``current``, ``current_index`` and ``acc`` are present only inside a ``<do>`` body, which is
    what makes ``<current/>`` outside an iteration an error rather than an empty string.
    """

    fields: Callable[[str], str | None]
    variables: dict[str, Value] = field(default_factory=dict)
    current: Value | None = None
    current_index: int | None = None
    acc: Value | None = None

    def with_var(self, name: str, value: Value) -> Scope:
        # The whole scope carries over: a <let> inside an iteration must not drop the contextual
        # current/current_index/acc.
        return Scope(
            self.fields,
            {**self.variables, name: value},
            self.current,
            self.current_index,
            self.acc,
        )

    def iterating(self, current: Value, index: int, acc: Value | None = None) -> Scope:
        return Scope(self.fields, self.variables, current, index, acc)


@dataclass(frozen=True, slots=True)
class Node:
    """One compute element: its tag, its attributes, and its child elements."""

    name: str
    attrs: dict[str, str]
    children: list


def evaluate(compute_element, fields: Callable[[str], str | None]) -> str:
    """A ``<compute>`` element evaluated to its output string."""
    return to_output(_slot(_children_of(compute_element), Scope(fields)))


def evaluate_predicate(valid_element, fields: Callable[[str], str | None]) -> bool:
    """A ``<valid>`` element's single predicate, for a pack generator's reject-and-retry."""
    children = _children_of(valid_element)
    if not children:
        raise ComputeError("<valid> requires a predicate child")
    return _predicate(children[0], Scope(fields))


# ── walking ─────────────────────────────────────────────────────────────────────────────────


def _node(element) -> Node:
    open_el = element.openCloseElement()
    if open_el is not None:
        return Node(open_el.name.text, attributes(open_el.attr()), _content(open_el.content()))
    self_closing = element.selfClosingElement()
    if self_closing is None:
        raise ComputeError("unexpected <data> or malformed element inside <compute>")
    return Node(self_closing.name.text, attributes(self_closing.attr()), [])


def _name_of(element) -> str:
    open_el = element.openCloseElement()
    if open_el is not None:
        return open_el.name.text
    self_closing = element.selfClosingElement()
    return self_closing.name.text if self_closing is not None else ""


def _content(content) -> list:
    return [] if content is None else list(content.element() or [])


def _children_of(element) -> list:
    return _content(element.content())


def _child(node: Node, name: str) -> Node:
    for child in node.children:
        if _name_of(child) == name:
            return _node(child)
    raise ComputeError(f"<{node.name}> requires a <{name}> child")


def _two(node: Node):
    if len(node.children) != 2:
        raise ComputeError(f"<{node.name}> requires exactly 2 children")
    return node.children[0], node.children[1]


def _slot(children: list, scope: Scope) -> Value:
    """Zero or more ``<let>`` prefixes, then exactly one value-producing expression.

    The bindings accumulate, so a later ``<let>`` and the final expression both see the earlier
    ones. That is what makes a long checksum readable: each step gets a name.
    """
    local = scope
    result: Value | None = None
    for child in children:
        if _name_of(child) == "let":
            binding = _node(child)
            local = local.with_var(binding.attrs.get("name", ""), _slot(binding.children, local))
        else:
            result = _element(child, local)
    if result is None:
        raise ComputeError("empty expression slot: no value produced")
    return result


def _wrapper(node: Node, name: str, scope: Scope) -> Value:
    return _slot(_child(node, name).children, scope)


def _iterable(value: Value) -> list[Value]:
    if value.kind == "str":
        return [str_value(ch) for ch in value.text]
    if value.kind == "list":
        return list(value.items)
    raise ComputeError("<over>: expected a string or list to iterate")


# The builtin row counters, which are numbers rather than text. _first and _last are
# deliberately absent: they are the strings "true" and "false".
_NUMERIC_BUILTIN_FIELDS = frozenset({"_count", "_total"})


def _element(element, scope: Scope) -> Value:
    n = _node(element)
    name = n.name

    # ── literals ──
    if name == "int":
        raw = n.attrs.get("v", "")
        try:
            return int_value(int(raw))
        except ValueError:
            raise ComputeError(f'<int>: "{raw}" is not an integer') from None
    if name == "str":
        return str_value(n.attrs.get("v", ""))
    if name == "list":
        raw = n.attrs.get("v")
        if raw is not None:
            items = []
            for part in (p.strip() for p in raw.split(",")):
                if not part:
                    continue
                try:
                    items.append(int_value(int(part)))
                except ValueError:
                    raise ComputeError(f'<list>: "{part}" is not an integer') from None
            return list_value(items)
        return list_value(_element(c, scope) for c in n.children)

    # ── references ──
    if name == "field":
        key = n.attrs.get("name", "")
        value = scope.fields(key)
        if value is None:
            raise ComputeError(f'<field>: "{key}" is not in scope')
        # A sequence's value is text, and coerce_int deliberately refuses a multi-digit string so
        # that "the third character" and "the number 375" stay different things. The row counters
        # are not text: _count and _total are numbers by nature. Without this they were strings,
        # so the single-digit escape hatch carried them to row 9 and the tenth row failed.
        # _first and _last stay out: they are the words "true" and "false".
        if key in _NUMERIC_BUILTIN_FIELDS:
            return int_value(int(value))
        return str_value(value)
    if name == "var":
        key = n.attrs.get("name", "")
        if key not in scope.variables:
            raise ComputeError(f'<var>: "{key}" is not bound')
        return scope.variables[key]
    if name == "current":
        if scope.current is None:
            raise ComputeError("<current/> used outside an iteration")
        return scope.current
    if name == "current_index":
        if scope.current_index is None:
            raise ComputeError("<current_index/> used outside an iteration")
        return int_value(scope.current_index)
    if name == "acc":
        if scope.acc is None:
            raise ComputeError("<acc/> used outside a <reduce>")
        return scope.acc
    if name == "let":
        raise ComputeError("<let> is a binding prefix, not a value expression")

    # ── collections ──
    if name == "each":
        items = _iterable(_wrapper(n, "over", scope))
        body = _child(n, "do")
        return list_value(
            _slot(body.children, scope.iterating(item, i)) for i, item in enumerate(items)
        )
    if name == "reduce":
        items = _iterable(_wrapper(n, "over", scope))
        body = _child(n, "do")
        acc = _wrapper(n, "init", scope)
        for i, item in enumerate(items):
            acc = _slot(body.children, scope.iterating(item, i, acc))
        return acc
    if name == "join":
        value = _slot(n.children, scope)
        if value.kind != "list":
            raise ComputeError("<join>: expected a list")
        return str_value(n.attrs.get("sep", "").join(coerce_str(v) for v in value.items))
    if name == "at":
        collection = _wrapper(n, "in", scope)
        if collection.kind != "list":
            raise ComputeError("<at>: <in> must be a list")
        index = coerce_int(_wrapper(n, "index", scope), "<at> index")
        if 0 <= index < len(collection.items):
            return collection.items[index]
        default = n.attrs.get("default")
        if default is not None:
            return int_value(parse_int_strict(default))
        raise ComputeError(f"<at>: index {index} is out of range and no default is set")
    if name == "length":
        value = _slot(n.children, scope)
        if value.kind == "str":
            return int_value(len(value.text))
        if value.kind == "list":
            return int_value(len(value.items))
        raise ComputeError("<length>: expected a string or list")

    # ── arithmetic ──
    if name == "add":
        return int_value(sum(coerce_int(_element(c, scope), "<add>") for c in n.children))
    if name == "multiply":
        product = 1
        for c in n.children:
            product *= coerce_int(_element(c, scope), "<multiply>")
        return int_value(product)
    if name == "subtract":
        if not n.children:
            raise ComputeError("<subtract> requires at least one child")
        head, *rest = n.children
        total = coerce_int(_element(head, scope), "<subtract>")
        for c in rest:
            total -= coerce_int(_element(c, scope), "<subtract>")
        return int_value(total)
    if name == "mod":
        a, b = _two(n)
        return int_value(
            euclidean_mod(coerce_int(_element(a, scope)), coerce_int(_element(b, scope)))
        )
    if name == "divide":
        a, b = _two(n)
        return int_value(floor_div(coerce_int(_element(a, scope)), coerce_int(_element(b, scope))))

    # ── encoding and conversion ──
    if name == "encode":
        value = _slot(n.children, scope)
        if value.kind != "str":
            raise ComputeError("<encode>: expected a single-character string")
        return str_value(encode_char(value.text, n.attrs.get("as", "")))
    if name == "to_number":
        return int_value(parse_int_strict(coerce_str(_slot(n.children, scope))))
    if name == "pad":
        width = int(numbers.parse(n.attrs.get("width", "0")))
        fill = n.attrs.get("fill", "0")
        return str_value(_pad_start(coerce_str(_slot(n.children, scope)), width, fill))
    if name == "concat":
        return str_value("".join(coerce_str(_element(c, scope)) for c in n.children))

    # ── text ──
    if name in _CASES:
        return str_value(apply_case(name, coerce_str(_slot(n.children, scope))))
    if name == "mask":
        pattern = n.attrs.get("pattern", "")
        return str_value(apply_mask(pattern, coerce_str(_slot(n.children, scope))))
    if name == "slice":
        to = n.attrs.get("to")
        return str_value(
            apply_slice(
                coerce_str(_slot(n.children, scope)),
                numbers.parse(n.attrs.get("from", "0")),
                None if to is None else numbers.parse(to),
            )
        )
    if name == "replace":
        return str_value(
            apply_replace(
                coerce_str(_slot(n.children, scope)),
                n.attrs.get("from", ""),
                n.attrs.get("to", ""),
            )
        )
    if name == "trim":
        return str_value(apply_trim(coerce_str(_slot(n.children, scope))))
    if name == "group":
        return str_value(
            apply_group(
                coerce_str(_slot(n.children, scope)),
                numbers.parse(n.attrs.get("size", "3")),
                n.attrs.get("sep", " "),
            )
        )

    # ── conditional ──
    if name == "choose":
        return _choose(n, scope)

    if name in _WRAPPERS:
        return _slot(n.children, scope)

    raise ComputeError(f"unknown compute tag <{name}>")


def _choose(node: Node, scope: Scope) -> Value:
    otherwise: Node | None = None
    for child in node.children:
        branch = _node(child)
        if branch.name == "when":
            if _test(_child(branch, "test"), scope):
                return _slot(_child(branch, "then").children, scope)
        elif branch.name == "otherwise":
            otherwise = branch
    if otherwise is not None:
        return _slot(otherwise.children, scope)
    raise ComputeError("<choose>: no <when> matched and no <otherwise> present")


def _test(test: Node, scope: Scope) -> bool:
    if not test.children:
        raise ComputeError("<test> requires a predicate child")
    return _predicate(test.children[0], scope)


def _predicate(element, scope: Scope) -> bool:
    n = _node(element)
    if n.name in ("equals", "greater_than", "less_than"):
        a, b = _two(n)
        x = coerce_int(_element(a, scope), f"<{n.name}>")
        y = coerce_int(_element(b, scope), f"<{n.name}>")
        if n.name == "equals":
            return x == y
        if n.name == "greater_than":
            return x > y
        return x < y
    if n.name == "is_digit":
        if not n.children:
            raise ComputeError("<is_digit> requires a child")
        value = _element(n.children[0], scope)
        return value.kind == "str" and len(value.text) == 1 and "0" <= value.text <= "9"
    raise ComputeError(f"unknown predicate <{n.name}> (valid only inside <test>)")


def _pad_start(value: str, width: int, fill: str) -> str:
    """``padStart`` as JavaScript performs it: the filler repeats and is cut, not aligned."""
    if not fill or len(value) >= width:
        return value
    needed = width - len(value)
    return (fill * (needed // len(fill) + 1))[:needed] + value
