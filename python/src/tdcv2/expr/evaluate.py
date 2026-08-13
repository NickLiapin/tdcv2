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


def as_value(source: str, has: Callable[[str], bool], value: Callable[[str], str]):
    """What ``source`` evaluates TO on this row, rather than whether it holds.

    The same evaluator as ``as_condition`` and deliberately so: a distribution parameter and a
    formula must not come to mean different things from the same words as a condition does.
    """
    ast = _CACHE.get(source)
    if ast is None:
        ast = parse(source)
        _CACHE[source] = ast
    return _eval(ast, has, value)


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


def _spread(args: list) -> list:
    """One list argument spread out, or the arguments themselves."""
    if len(args) == 1 and isinstance(args[0], list):
        return args[0]
    return args


def _list_of(args: list, index: int) -> list:
    """An argument as a list.

    A bare value counts as a list of one, so ``sum(Price)`` on a single number is an answer
    rather than an error — the alternative is a rule a caller has to remember before every call.
    """
    value = _at(args, index)
    if isinstance(value, list):
        return value
    return [] if value is None else [value]


def _list_value(args: list, index: int) -> list:
    """``at``'s subject, which has to be a real list.

    ``_list_of`` above reads a bare value as a list of one, which is right for ``sum(Price)``
    and wrong here: a ``repeat`` list arrives as the JOINED text, so ``at(Items, 1)`` — the shape
    everybody writes first — used to ask for the second element of a one-element list and get the
    same empty string a legitimately short row gives. Naming the mistake is the point.
    """
    value = _at(args, index)
    if isinstance(value, list):
        return value
    raise ValueError(
        f"at() needs a list, and {_show(value)} is a single value — "
        'split it first, as in at(split(Items, ","), 1)'
    )


def _index_value(args: list, index: int) -> int:
    """An index: a whole number, zero or more. Anything else is a mistake, not a shape."""
    raw = _at(args, index)
    n = as_number(raw)
    if not math.isfinite(n) or n != math.floor(n) or n < 0:
        raise ValueError(f"at() index must be a whole number of zero or more, not {_show(raw)}")
    return int(n)


def _show(v) -> str:
    """A value as it should read inside a message: text quoted, everything else plain."""
    if isinstance(v, str):
        return f'"{v}"'
    if isinstance(v, list):
        return "a list"
    if v is None:
        return "nothing"
    return _text(v)


def _split(args: list) -> list:
    """Text to a list. An empty subject gives an empty list, not a list of one blank."""
    subject = _arg_text(args, 0)
    separator = _arg_text(args, 1)
    if subject == "":
        return []
    if separator == "":
        # CODE POINTS, the same unit `len` counts, so split(s, "") and len(s) never
        # disagree about how many characters a string has.
        return list(subject)
    return subject.split(separator)


def _element_at(args: list):
    """The i-th element, counting from zero, or empty text past the end."""
    items = _list_value(args, 0)
    index = _index_value(args, 1)
    return items[index] if index < len(items) else ""


def _sum(args: list):
    """The total. Whole while every element is whole, so a column of ids stays exact."""
    items = _list_of(args, 0)
    whole = [_as_exact_int(v) for v in items]
    if items and all(v is not None for v in whole):
        return _checked_int(sum(whole))
    return sum(as_number(v) for v in items)


def _mean(args: list) -> float:
    """The average. Always a double: a mean is a ratio, and ratios are not whole."""
    items = _list_of(args, 0)
    if not items:
        return math.nan
    return sum(as_number(v) for v in items) / len(items)


def _median(args: list) -> float:
    """The middle value; with an even count, the average of the two middle ones."""
    items = sorted(as_number(v) for v in _list_of(args, 0))
    if not items:
        return math.nan
    half = len(items) // 2
    if len(items) % 2 == 1:
        return items[half]
    return (items[half - 1] + items[half]) / 2


def _stddev(args: list) -> float:
    """The POPULATION standard deviation — divided by n, not by n-1.

    A generated list is the whole of what it describes, not a sample drawn from something
    larger, so n is the honest divisor. Stated because the two differ and neither is obvious.
    """
    items = [as_number(v) for v in _list_of(args, 0)]
    if not items:
        return math.nan
    average = sum(items) / len(items)
    variance = sum((v - average) * (v - average) for v in items) / len(items)
    return tdc_math.sqrt(variance)


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
    # These six have an EXACT answer for a whole number, and taking it through a float
    # throws that answer away past 2**53. Rounding a whole number IS the number, whatever
    # its size; abs negates a negative one; min and max compare, and the comparison is
    # exact while every argument is whole. Arithmetic already stayed exact, so the value
    # arrived intact and was being destroyed on the way out.
    "abs": lambda a: _exact_or(a, lambda w: abs(w), lambda x: abs(x)),
    "ceil": lambda a: _exact_or(a, lambda w: w, lambda x: float(math.ceil(x))),
    "floor": lambda a: _exact_or(a, lambda w: w, lambda x: float(math.floor(x))),
    "max": lambda a: _extremum(a, True),
    "min": lambda a: _extremum(a, False),
    "round": lambda a: _exact_or(a, lambda w: w, _round_half_away_from_zero),
    "trunc": lambda a: _exact_or(a, lambda w: w, lambda x: float(math.trunc(x))),
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
    # Lists inside one row. A sequence with repeat= puts several values in one field, and an
    # expression sees the JOINED text because that is what the field holds — so `split` is the
    # bridge and everything else works on lists. No grammar changed for this: the list value
    # already existed, produced by an array literal and consumed by `in`.
    "split": _split,
    "join": lambda a: _arg_text(a, 1).join(_text(v) for v in _list_of(a, 0)),
    # How many. `len` is the STRING length and would answer about the separators.
    "count": lambda a: float(len(_list_of(a, 0))),
    # The i-th element, counting from zero. PAST THE END gives empty text rather than a refusal,
    # because a `repeat` range produces rows of DIFFERENT lengths on purpose; `count()` is there
    # to ask first. Every other way of getting nothing — a negative index, a fractional one, an
    # index that is not a number, a subject that is not a list — is a mistake in the config and
    # refuses, because each of them used to answer with that same empty string.
    "at": _element_at,
    "sum": _sum,
    "mean": _mean,
    "median": _median,
    "stddev": _stddev,
    "zeta": lambda a: tdc_math.zeta(_num(a, 0)),
    # Transcendentals, computed by TDC rather than by Python — see math/tdc_math.py.
    # Adding one here means adding it to TdcMath in all five, not calling math.something.
    "acos": lambda a: tdc_math.acos(_num(a, 0)),
    "acosh": lambda a: tdc_math.acosh(_num(a, 0)),
    "asin": lambda a: tdc_math.asin(_num(a, 0)),
    "asinh": lambda a: tdc_math.asinh(_num(a, 0)),
    "atan": lambda a: tdc_math.atan(_num(a, 0)),
    "atanh": lambda a: tdc_math.atanh(_num(a, 0)),
    "beta": lambda a: tdc_math.beta(_num(a, 0), _num(a, 1)),
    "atan2": lambda a: tdc_math.atan2(_num(a, 0), _num(a, 1)),
    "cbrt": lambda a: tdc_math.cbrt(_num(a, 0)),
    "cos": lambda a: tdc_math.cos(_num(a, 0)),
    "degrees": lambda a: tdc_math.degrees(_num(a, 0)),
    "digamma": lambda a: tdc_math.digamma(_num(a, 0)),
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
    "radians": lambda a: tdc_math.radians(_num(a, 0)),
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


# ── Whole numbers that stay whole ─────────────────────────────────────────────
#
# A double holds every integer up to 2^53 and then starts skipping. Past that
# point two DIFFERENT whole numbers become the same double, and an expression
# built on doubles alone answers accordingly:
#
#     9007199254740993 == 9007199254740992   ->  True
#     9007199254740993 -  9007199254740992   ->  0
#
# Both wrong, and wrong silently — the worst way for a data generator to be
# wrong, since the run finishes and the file looks fine. So an operand that IS a
# whole number is carried as one, and only becomes a double when asked.
#
# The domain is signed 64-bit, matching the compute layer. Python's own int is
# unbounded, which makes the bound something this file has to impose rather than
# receive: without it Python would quietly answer questions the other four
# implementations refuse.

_INT64_MIN = -9223372036854775808
_INT64_MAX = 9223372036854775807



def _exact_or(args: list, whole_answer, float_answer):
    """Answer exactly when the argument is a whole number, else in floating point."""
    whole = _as_exact_int(_at(args, 0))
    if whole is not None:
        return whole_answer(whole)
    return float_answer(_num(args, 0))


def _extremum(args: list, want_max: bool):
    """``min`` / ``max``, exact while every argument is a whole number.

    The winner is handed back as the value that was given rather than re-derived, so
    ``max(9007199254740993, 1)`` answers with the number somebody wrote. One float among
    them and the whole comparison falls to floating point, which is honest: there is no
    exact ordering between a big integer and a float that is not one.
    """
    values = _nonempty(_spread(args))
    whole = [_as_exact_int(v) for v in values]
    if whole and all(w is not None for w in whole):
        return max(whole) if want_max else min(whole)
    numbers = [as_number(v) for v in values]
    return max(numbers) if want_max else min(numbers)


def _as_exact_int(v):
    """A value seen as an exact whole number, or None if it is not one.

    ``bool`` is excluded first and deliberately: in Python it is a SUBCLASS of int, so
    ``isinstance(True, int)`` is true and True would otherwise arithmetic as 1 here while
    behaving as a truth value everywhere else.
    """
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return v if _INT64_MIN <= v <= _INT64_MAX else None
    if isinstance(v, str):
        body = v[1:] if v[:1] in "+-" else v
        if body.isdigit():
            parsed = int(v)
            if _INT64_MIN <= parsed <= _INT64_MAX:
                return parsed
    return None


def _both_whole(left, right):
    """Both operands as exact whole numbers, or None if either is not one."""
    a = _as_exact_int(left)
    if a is None:
        return None
    b = _as_exact_int(right)
    return None if b is None else (a, b)


def _checked_int(v: int) -> int:
    """The result of whole-number arithmetic, refused rather than rounded."""
    if not (_INT64_MIN <= v <= _INT64_MAX):
        raise ValueError(f"integer overflow: {v} is outside the signed 64-bit range")
    return v


def _binary(op: str, left, right):
    if op == "==":
        return _loose_equals(left, right)
    if op == "!=":
        return not _loose_equals(left, right)
    if op == "===":
        return _strict_equals(left, right)
    if op == "!==":
        return not _strict_equals(left, right)
    whole = _both_whole(left, right)
    if op == "<":
        return whole[0] < whole[1] if whole else _lt(as_number(left), as_number(right))
    if op == ">":
        return whole[0] > whole[1] if whole else _lt(as_number(right), as_number(left))
    if op == "<=":
        if whole:
            return whole[0] <= whole[1]
        return not _lt(as_number(right), as_number(left)) and not _nan(left, right)
    if op == ">=":
        if whole:
            return whole[0] >= whole[1]
        return not _lt(as_number(left), as_number(right)) and not _nan(left, right)
    if op == "&&":
        return to_boolean(left) and to_boolean(right)
    if op == "||":
        return to_boolean(left) or to_boolean(right)
    if op == "+":
        if whole:
            return _checked_int(whole[0] + whole[1])
        # Adds when either side is already a number, joins otherwise, as in JavaScript.
        if isinstance(left, float) or isinstance(right, float):
            return as_number(left) + as_number(right)
        return _text(left) + _text(right)
    if op == "-":
        if whole:
            return _checked_int(whole[0] - whole[1])
        return as_number(left) - as_number(right)
    if op == "*":
        if whole:
            return _checked_int(whole[0] * whole[1])
        return as_number(left) * as_number(right)
    if op == "/":
        # Division alone stays in floating point, always. It is not closed over the
        # whole numbers — 7/2 is not one — and a rule that came out exact only when
        # the division happened to be even would be a rule nobody could hold.
        return _divide(as_number(left), as_number(right))
    if op == "%":
        if whole and whole[1] != 0:
            # Euclidean, like the double path and like <mod> in compute.
            r = whole[0] % whole[1]
            return r + abs(whole[1]) if r < 0 else r
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
    # Two whole numbers compare as whole numbers, whichever shape they arrived
    # in — a generated id is a string, the literal beside it is not.
    whole = _both_whole(left, right)
    if whole:
        return whole[0] == whole[1]
    # A number the config WROTE, beside text that reads as one. Both shapes of number count,
    # and the whole-number half is the repair of a bug that had every money column silently
    # failing its own equality test: `Total == 100` was false while `Total > 99` was true,
    # because 100 is a whole number and "100.00" is not, so the two never met.
    if _is_written(left) and isinstance(right, str):
        b = numbers.parse(right)
        if not math.isnan(b):
            return as_number(left) == b
    if _is_written(right) and isinstance(left, str):
        a = numbers.parse(left)
        if not math.isnan(a):
            return a == as_number(right)
    if left is None or right is None:
        return left is None and right is None
    if isinstance(left, bool) or isinstance(right, bool):
        return as_number(left) == as_number(right)
    if isinstance(left, float) and isinstance(right, float):
        return left == right
    # Two texts stay text, whatever they look like: `Empty == Space` is false even though both
    # read as zero. Only a literal drags a column into numbers.
    return _text(left) == _text(right)


def _is_written(v) -> bool:
    """A number as the config wrote it, rather than as a column produced it."""
    return isinstance(v, (int, float)) and not isinstance(v, bool)


# ── The two equalities ────────────────────────────────────────────────────────────────────
#
# A TDC column is TEXT. Every generator produces text, every built-in is text, and the only
# things that are not text are the literals someone writes inside an expression. So "are these
# equal?" has two honest readings, and TDC gives each one its own operator — the shape Perl
# settled on for the same reason, where a scalar is likewise text that might be a number:
#
#     ==   the same NUMBER   "01" == 1     True
#     ===  the same TEXT     "01" === 1    False
#
# `===` used to be the host language's identity test — "same type AND same value". That is a
# fine question in a language with types and a meaningless one here, because there is only ever
# one type: `N === 1` was false for EVERY number on every row, silently, with check passing.


def _strict_equals(left, right) -> bool:
    """``===`` — do both sides print the same characters?

    A list never matches, itself included: ``in`` is the operator for lists, and TDC259 refuses
    one anywhere else before the run. Answering False keeps all five implementations saying the
    same thing rather than leaving each host's idea of list equality to decide it.
    """
    if isinstance(left, list) or isinstance(right, list):
        return False
    return _strict_text(left) == _strict_text(right)


def _strict_text(v) -> str:
    """The characters a value prints as.

    Nothing — an absent column, the ``null`` literal — is the EMPTY text, the same thing a
    column that produced no value holds. One rule instead of two: absent is empty, here and in
    ``to_boolean`` and in the output.
    """
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float):
        return numbers.to_text(v)
    return str(v)


def to_boolean(v) -> bool:
    """What counts as TRUE — for a bare ``if="X"``, and for ``!``, ``&&`` and ``||``.

    Two texts are false and every other text is true::

        ""       False    the column produced nothing
        "false"  False    a flag column saying no
        "0"      TRUE     zero is a value, not an absence

    That is Lua's and Ruby's rule — only "nothing" and "no" are false — carried into a language
    whose single carrier is text. ``_last``, ``_first`` and every ``anomaly_flag`` column hold
    literally "true" or "false", so without this ``if="!_last"`` would be true on every row
    including the last. ``"0"`` being true is deliberate: ask about the number with the operator
    that means the number, ``if="Count != 0"``.
    """
    if v is None:
        return False
    if isinstance(v, str):
        return v != "" and v != "false"
    if isinstance(v, bool):
        return v
    if isinstance(v, float):
        return v != 0 and not math.isnan(v)
    # A whole number is false only at zero, like the double beside it.
    if isinstance(v, int):
        return v != 0
    return True


def as_number(v) -> float:
    if isinstance(v, bool):
        return 1.0 if v else 0.0
    if isinstance(v, float):
        return v
    # A whole number handed to something that works in floating point — sqrt, log,
    # sin. Past 2^53 this loses digits, which is the honest answer: those functions
    # have no exact one to give.
    if isinstance(v, int):
        return float(v)
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
