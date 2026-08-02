"""A parsed ``if`` expression evaluated against the row being rendered.

Values live in the same three-type world the reference works in: a number, a string, or a boolean.
The rules for moving between them are JavaScript's, with one deliberate change the reference also
makes — the string ``"false"`` counts as false. Without that, ``if="!_last"`` would be true on
every row, because the string "false" is a non-empty string.
"""

from __future__ import annotations

import math
from collections.abc import Callable

from ..lib import numbers
from .parse import Binary, Bool, Computed, Member, Name, Node, Null, Num, Str, Unary, parse

_CACHE: dict[str, Node] = {}


def as_condition(source: str, has: Callable[[str], bool], value: Callable[[str], str]) -> bool:
    """Whether ``source`` holds on this row.

    ``has`` and ``value`` are separate because an absent name is not an empty one: an unknown name
    is its own text, which is what lets ``Gender == Male`` go unquoted.
    """
    ast = _CACHE.get(source)
    if ast is None:
        ast = parse(source)
        _CACHE[source] = ast
    return to_boolean(_eval(ast, has, value))


def _eval(node: Node, has: Callable[[str], bool], value: Callable[[str], str]):
    if isinstance(node, Num):
        return node.value
    if isinstance(node, Str):
        return node.value
    if isinstance(node, Bool):
        return node.value
    if isinstance(node, Null):
        return None
    if isinstance(node, Name):
        return value(node.value) if has(node.value) else node.value
    if isinstance(node, Member):
        return _member(node.dotted, has, value)
    if isinstance(node, Unary):
        return _unary(node.op, _eval(node.operand, has, value))
    if isinstance(node, Binary):
        return _binary(node.op, _eval(node.left, has, value), _eval(node.right, has, value))
    if isinstance(node, Computed):
        raise ValueError("computed member access is not supported in if expressions")
    raise ValueError(f"if expression: unhandled node {node}")


def _member(dotted: str, has: Callable[[str], bool], value: Callable[[str], str]):
    """``A.B`` read three ways, in order.

    A compound field named "A.B"; else, when "A" is a sequence, the test "is A currently B?" — so
    ``if="Gender.Male"`` reads the way ``parent="Gender.Male"`` does; else the dotted text itself,
    so a typo shows up verbatim instead of silently becoming empty.
    """
    if has(dotted):
        return value(dotted)
    dot = dotted.find(".")
    if dot > 0 and has(dotted[:dot]):
        return value(dotted[:dot]) == dotted[dot + 1 :]
    return dotted


def _unary(op: str, arg):
    if op == "!":
        return not to_boolean(arg)
    if op == "-":
        return -as_number(arg)
    if op == "+":
        return as_number(arg)
    raise ValueError(f"if expression: unsupported operator {op}")


def _binary(op: str, left, right):
    if op == "==":
        return _loose_equals(left, right)
    if op == "!=":
        return not _loose_equals(left, right)
    if op == "===":
        return _strict_equals(left, right)
    if op == "!==":
        return not _strict_equals(left, right)
    if op == "<":
        return _lt(as_number(left), as_number(right))
    if op == ">":
        return _lt(as_number(right), as_number(left))
    if op == "<=":
        return not _lt(as_number(right), as_number(left)) and not _nan(left, right)
    if op == ">=":
        return not _lt(as_number(left), as_number(right)) and not _nan(left, right)
    if op == "&&":
        return to_boolean(left) and to_boolean(right)
    if op == "||":
        return to_boolean(left) or to_boolean(right)
    if op == "+":
        # Adds when either side is already a number, joins otherwise, as in JavaScript.
        if isinstance(left, float) or isinstance(right, float):
            return as_number(left) + as_number(right)
        return _text(left) + _text(right)
    if op == "-":
        return as_number(left) - as_number(right)
    if op == "*":
        return as_number(left) * as_number(right)
    if op == "/":
        return _divide(as_number(left), as_number(right))
    if op == "%":
        return _remainder(as_number(left), as_number(right))
    raise ValueError(f"if expression: unsupported operator {op}")


def _loose_equals(left, right) -> bool:
    """A number against a numeric-looking string compares as numbers.

    That is what makes ``_count == 5`` work even though ``_count`` arrives as text. Everything
    else compares as text.
    """
    if isinstance(left, float) and isinstance(right, str):
        b = numbers.parse(right)
        if not math.isnan(b):
            return left == b
    if isinstance(right, float) and isinstance(left, str):
        a = numbers.parse(left)
        if not math.isnan(a):
            return a == right
    if left is None or right is None:
        return left is None and right is None
    if isinstance(left, bool) or isinstance(right, bool):
        return as_number(left) == as_number(right)
    if isinstance(left, float) and isinstance(right, float):
        return left == right
    return _text(left) == _text(right)


def _strict_equals(left, right) -> bool:
    if left is None or right is None:
        return left is right
    return type(left) is type(right) and left == right


def to_boolean(v) -> bool:
    """The boolean projection ``if`` uses, and ``!``, ``&&`` and ``||`` with it."""
    if v is None:
        return False
    if isinstance(v, str):
        # "false" is falsy, unlike every other non-empty string. Without it `if="!_last"` would
        # be true on every row, because _last interpolates as the text "false".
        return v != "" and v != "false"
    if isinstance(v, bool):
        return v
    if isinstance(v, float):
        return v != 0 and not math.isnan(v)
    return True


def as_number(v) -> float:
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, float):
        return v
    if isinstance(v, str):
        return numbers.parse(v)
    return math.nan


def _lt(a: float, b: float) -> bool:
    return not math.isnan(a) and not math.isnan(b) and a < b


def _nan(left, right) -> bool:
    return math.isnan(as_number(left)) or math.isnan(as_number(right))


def _divide(a: float, b: float) -> float:
    """JavaScript divides by zero to infinity rather than raising."""
    if b == 0:
        if a == 0 or math.isnan(a):
            return math.nan
        return math.copysign(math.inf, a) * math.copysign(1.0, b)
    return a / b


def _remainder(a: float, b: float) -> float:
    """The remainder takes the sign of the DIVIDEND, which is JavaScript's rule, not Python's."""
    if b == 0 or math.isnan(a) or math.isnan(b) or math.isinf(a):
        return math.nan
    if math.isinf(b):
        return a
    return math.fmod(a, b)


def _text(v) -> str:
    """``String(x)``: a whole number prints without a decimal point, as in JavaScript."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        return numbers.to_text(v)
    return str(v)
