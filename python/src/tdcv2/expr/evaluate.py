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
from ..math import tdc_math
from .parse import (
    Array,
    Binary,
    Bool,
    Call,
    Computed,
    Conditional,
    Member,
    Name,
    Node,
    Null,
    Num,
    Str,
    Unary,
    parse,
)

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
    if isinstance(node, Call):
        fn = _FUNCTIONS.get(node.name)
        if fn is None:
            raise ValueError(f'if expression: unknown function "{node.name}"')
        return fn([_eval(a, has, value) for a in node.args])
    if isinstance(node, Array):
        return [_eval(item, has, value) for item in node.items]
    if isinstance(node, Conditional):
        branch = node.consequent if to_boolean(_eval(node.test, has, value)) else node.alternate
        return _eval(branch, has, value)
    if isinstance(node, Computed):
        raise ValueError("computed member access is not supported in if expressions")
    raise ValueError(f"if expression: unhandled node {node}")


def _round_half_away_from_zero(x: float) -> float:
    """A half goes AWAY FROM ZERO: ``round(0.5)`` is 1 and ``round(-0.5)`` is -1.

    Python's own ``round`` sends a half to even (0.5 → 0, 2.5 → 2), JavaScript sends it toward
    +inf, Java rounds half up. None of the three is symmetric, so TDC states its own rule and
    every implementation writes it out rather than calling the host.
    """
    return -math.floor(-x + 0.5) if x < 0 else math.floor(x + 0.5)


def _nonempty(args: list) -> list:
    if not args:
        raise ValueError("if expression: a function needs at least one argument")
    return args


def _at(args: list, index: int):
    if index >= len(args):
        raise ValueError("if expression: a function was given too few arguments")
    return args[index]


def _num(args: list, index: int) -> float:
    return as_number(_at(args, index))


def _arg_text(args: list, index: int) -> str:
    """An argument as text. A list never reaches here — only ``in`` produces one."""
    value = _at(args, index)
    if value is None:
        return ""
    if isinstance(value, list):
        raise ValueError("if expression: a string function was given a list")
    return _text(value)


# Exact by construction: comparisons and the arithmetic IEEE-754 pins down, so the five
# implementations cannot disagree. Transcendental functions are absent for exactly that reason.
_FUNCTIONS: dict[str, Callable[[list], object]] = {
    # Numbers. Each coerces its own arguments rather than the registry doing it for
    # everyone, because the string family must NOT be coerced: len("10") is 2, and a
    # registry that pre-numbered every argument could not tell the two apart.
    "abs": lambda a: abs(_num(a, 0)),
    "ceil": lambda a: float(math.ceil(_num(a, 0))),
    "floor": lambda a: float(math.floor(_num(a, 0))),
    "max": lambda a: max(as_number(v) for v in _nonempty(a)),
    "min": lambda a: min(as_number(v) for v in _nonempty(a)),
    "round": lambda a: _round_half_away_from_zero(_num(a, 0)),
    "trunc": lambda a: float(math.trunc(_num(a, 0))),
    # Strings. None of these touches floating point, so all five agree for free.
    "contains": lambda a: _arg_text(a, 1) in _arg_text(a, 0),
    "ends_with": lambda a: _arg_text(a, 0).endswith(_arg_text(a, 1)),
    "is_empty": lambda a: len(_arg_text(a, 0)) == 0,
    # len counts CODE POINTS, which is what Python's len() over str already does and
    # what Rust's chars().count() gives; Java and C# reach it with codePointCount.
    "len": lambda a: float(len(_arg_text(a, 0))),
    "lower": lambda a: _arg_text(a, 0).lower(),
    "starts_with": lambda a: _arg_text(a, 0).startswith(_arg_text(a, 1)),
    "upper": lambda a: _arg_text(a, 0).upper(),
    # Transcendentals, computed by TDC rather than by Python — see math/tdc_math.py.
    # Adding one here means adding it to TdcMath in all five, not calling math.something.
    "acos": lambda a: tdc_math.acos(_num(a, 0)),
    "acosh": lambda a: tdc_math.acosh(_num(a, 0)),
    "asin": lambda a: tdc_math.asin(_num(a, 0)),
    "asinh": lambda a: tdc_math.asinh(_num(a, 0)),
    "atan": lambda a: tdc_math.atan(_num(a, 0)),
    "atanh": lambda a: tdc_math.atanh(_num(a, 0)),
    "atan2": lambda a: tdc_math.atan2(_num(a, 0), _num(a, 1)),
    "cbrt": lambda a: tdc_math.cbrt(_num(a, 0)),
    "cos": lambda a: tdc_math.cos(_num(a, 0)),
    "cosh": lambda a: tdc_math.cosh(_num(a, 0)),
    "erf": lambda a: tdc_math.erf(_num(a, 0)),
    "erfc": lambda a: tdc_math.erfc(_num(a, 0)),
    "exp": lambda a: tdc_math.exp(_num(a, 0)),
    "expm1": lambda a: tdc_math.expm1(_num(a, 0)),
    "gamma": lambda a: tdc_math.gamma(_num(a, 0)),
    "hypot": lambda a: tdc_math.hypot(_num(a, 0), _num(a, 1)),
    "lgamma": lambda a: tdc_math.lgamma(_num(a, 0)),
    "log": lambda a: tdc_math.log(_num(a, 0)),
    "log10": lambda a: tdc_math.log10(_num(a, 0)),
    "log1p": lambda a: tdc_math.log1p(_num(a, 0)),
    "log2": lambda a: tdc_math.log2(_num(a, 0)),
    "pow": lambda a: tdc_math.pow(_num(a, 0), _num(a, 1)),
    "sin": lambda a: tdc_math.sin(_num(a, 0)),
    "sign": lambda a: tdc_math.sign(_num(a, 0)),
    "sinh": lambda a: tdc_math.sinh(_num(a, 0)),
    "sqrt": lambda a: tdc_math.sqrt(_num(a, 0)),
    "tanh": lambda a: tdc_math.tanh(_num(a, 0)),
    "tan": lambda a: tdc_math.tan(_num(a, 0)),
}


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
    if op == "in":
        # As loose as `==`, deliberately: a text column against a list of numeric
        # words has to match, or `in` and `==` would disagree about the same pair.
        if isinstance(right, list):
            return any(_loose_equals(left, candidate) for candidate in right)
        return _loose_equals(left, right)
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
    """The EUCLIDEAN remainder, always in ``[0, |b|)``.

    Not JavaScript's rule and not Python's either. The compute layer's ``<mod>`` already answered
    this question — ``mod(-3, 2)`` is 1 — and one engine must not give two answers depending on
    which layer the author reached for. Same algorithm as ``euclidean_mod`` in ``compute/value``,
    written for floats.
    """
    if b == 0:
        raise ValueError("if expression: the right side of % must not be zero")
    if math.isnan(a) or math.isnan(b) or math.isinf(a):
        return math.nan
    if math.isinf(b):
        return a
    magnitude = abs(b)
    r = math.fmod(a, magnitude)
    return r + magnitude if r < 0 else r


def _text(v) -> str:
    """``String(x)``: a whole number prints without a decimal point, as in JavaScript."""
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        return numbers.to_text(v)
    return str(v)
