"""The tiny expression language behind ``if="..."``.

Comparison (``== != < > <= >=``), logic (``&& || !``) and arithmetic (``+ - * /``) over sequence
values, numbers and quoted strings.

The reference parses these with jsep, a JavaScript expression parser, so the precedence table
below is jsep's rather than one chosen here. Reproducing it matters: ``a == b && c`` has to bind
the same way in every implementation, or two engines disagree about which rows appear — the kind of
difference no test of a single value would catch.

A bare word that names no sequence is its own value: ``Gender == Male`` works without quoting
"Male", which is how configs have always been written.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..lib import text

# jsep's binary precedence, verbatim. Higher binds tighter.
#
# The bitwise and shift operators are here even though the engine implements none of them, and
# that is the point: the reference parses whatever jsep parses and then refuses the operator BY
# NAME. A port whose table stopped at the supported set answered `x & 1` with a syntax error
# pointing at the ampersand, which tells the reader nothing about what to write instead.
PRECEDENCE = {
    "||": 1,
    "&&": 2,
    "|": 3,
    "^": 4,
    "&": 5,
    "==": 6,
    "!=": 6,
    "===": 6,
    "!==": 6,
    "<": 7,
    ">": 7,
    "<=": 7,
    ">=": 7,
    "<<": 8,
    ">>": 8,
    ">>>": 8,
    "+": 9,
    "-": 9,
    "*": 10,
    "/": 10,
    "%": 10,
    # A word operator rather than a symbol; the tokenizer keeps it from swallowing
    # a sequence called "index".
    "in": 7,
}

# Longest first, so `<=` is never read as `<` followed by a stray `=`, and `&&` never as two `&`.
_OPERATORS = (
    ">>>",
    "===",
    "!==",
    "==",
    "!=",
    "<=",
    ">=",
    "&&",
    "||",
    "<<",
    ">>",
    "<",
    ">",
    "+",
    "-",
    "*",
    "/",
    "%",
    "&",
    "|",
    "^",
)


class Node:
    __slots__ = ()


@dataclass(frozen=True, slots=True)
class Num(Node):
    value: float


@dataclass(frozen=True, slots=True)
class Str(Node):
    value: str


@dataclass(frozen=True, slots=True)
class Bool(Node):
    value: bool


@dataclass(frozen=True, slots=True)
class Null(Node):
    pass


@dataclass(frozen=True, slots=True)
class Name(Node):
    value: str


@dataclass(frozen=True, slots=True)
class Member(Node):
    """A dotted reference: a compound field, a value test, or a literal — resolved at evaluation."""

    dotted: str


@dataclass(frozen=True, slots=True)
class Binary(Node):
    op: str
    left: Node
    right: Node


@dataclass(frozen=True, slots=True)
class Unary(Node):
    op: str
    operand: Node


@dataclass(frozen=True, slots=True)
class Array(Node):
    """``[US, CA, MX]`` — only ever the right side of ``in``."""

    items: tuple[Node, ...]


@dataclass(frozen=True, slots=True)
class Conditional(Node):
    """``a ? b : c`` — picks a VALUE, which is then compared like any other."""

    test: Node
    consequent: Node
    alternate: Node


@dataclass(frozen=True, slots=True)
class Call(Node):
    """``abs(x)`` — a call on a bare name, with its arguments already parsed."""

    name: str
    args: tuple[Node, ...]


@dataclass(frozen=True, slots=True)
class Computed(Node):
    """``x[0]`` — subscripting, which the evaluator does not implement.

    Parsed rather than rejected so the complaint can name what is unsupported. A parser stricter
    than the reference's turns "computed member access is not supported" into "syntax error", and
    the second says nothing about what to write instead.
    """

    obj: Node


# A hard ceiling on parenthesis nesting. The parser recurses per "(", so a
# generated "((((...))))" is a stack overflow for the price of a text file.
# Real expressions nest a handful. The scan is linear and quote-aware; the
# same ceiling lives in every implementation.
_MAX_EXPR_NESTING = 32


def _paren_depth(source: str) -> int:
    depth = 0
    deepest = 0
    in_string: str | None = None
    escaped = False
    for ch in source:
        if escaped:
            escaped = False
            continue
        if in_string is not None:
            if ch == "\\":
                escaped = True
            elif ch == in_string:
                in_string = None
            continue
        if ch in ("'", '"'):
            in_string = ch
        elif ch in ("(", "["):
            depth += 1
            deepest = max(deepest, depth)
        elif ch in (")", "]"):
            depth = max(0, depth - 1)
    return deepest


def parse(source: str) -> Node:
    if _paren_depth(source) > _MAX_EXPR_NESTING:
        raise ValueError(f"nests deeper than {_MAX_EXPR_NESTING} levels")
    parser = _Parser(source)
    result = parser.ternary(0)
    parser.skip_space()
    if not parser.done():
        raise ValueError(f'if expression: unexpected "{parser.rest()}" in "{source}"')
    return result


class _Parser:
    """Precedence climbing over a hand-written tokenizer."""

    __slots__ = ("pos", "src")

    def __init__(self, src: str) -> None:
        self.src = src
        self.pos = 0

    def done(self) -> bool:
        return self.pos >= len(self.src)

    def rest(self) -> str:
        return self.src[self.pos :]

    def skip_space(self) -> None:
        while self.pos < len(self.src) and text.is_space(self.src[self.pos]):
            self.pos += 1

    def ternary(self, min_precedence: int) -> Node:
        """``a ? b : c``, which binds looser than every binary operator.

        Wrapping the binary loop rather than living inside it is what makes
        ``x > 1 ? a : b`` read as ``(x > 1) ? a : b`` and not ``x > (1 ? a : b)``.
        """
        test = self.expression(min_precedence)
        self.skip_space()
        if self.done() or self.src[self.pos] != "?":
            return test
        self.pos += 1
        consequent = self.ternary(0)
        self.skip_space()
        if self.done() or self.src[self.pos] != ":":
            raise ValueError(f'if expression: a ? without its : in "{self.src}"')
        self.pos += 1
        return Conditional(test, consequent, self.ternary(0))

    def expression(self, min_precedence: int) -> Node:
        left = self._unary()
        while True:
            self.skip_space()
            op = self._peek_operator()
            if op is None or PRECEDENCE[op] < min_precedence:
                return left
            self.pos += len(op)
            # Left-associative: the right operand stops at anything this loop can handle itself.
            right = self.expression(PRECEDENCE[op] + 1)
            left = Binary(op, left, right)

    def _unary(self) -> Node:
        self.skip_space()
        if self.pos < len(self.src):
            c = self.src[self.pos]
            if c == "!" and not self.src.startswith("!=", self.pos):
                self.pos += 1
                return Unary("!", self._unary())
            if c in ("-", "+") and not self._number_starts():
                self.pos += 1
                return Unary(c, self._unary())
            if c == "~":
                # Parsed, then refused by the evaluator. The reference's expression library
                # accepts it too, and both have to refuse the same configs for the same stated
                # reason — "unsupported operator" says more than "syntax error" does.
                self.pos += 1
                return Unary("~", self._unary())
        return self._primary()

    def _number_starts(self) -> bool:
        """A leading ``-`` belongs to the number when a digit follows it directly."""
        return self.pos + 1 < len(self.src) and self.src[self.pos + 1].isdigit()

    def _primary(self) -> Node:
        self.skip_space()
        if self.done():
            raise ValueError("if expression: ends where a value was expected")
        c = self.src[self.pos]

        if c == "(":
            self.pos += 1
            inner = self.ternary(0)
            self.skip_space()
            if self.done() or self.src[self.pos] != ")":
                raise ValueError(f'if expression: unbalanced parentheses in "{self.src}"')
            self.pos += 1
            return inner

        if c == "[":
            self.pos += 1
            items: list[Node] = []
            self.skip_space()
            if not self.done() and self.src[self.pos] == "]":
                self.pos += 1
                return Array(())
            while True:
                items.append(self.ternary(0))
                self.skip_space()
                if self.done():
                    raise ValueError(f'if expression: unbalanced brackets in "{self.src}"')
                if self.src[self.pos] == ",":
                    self.pos += 1
                    continue
                if self.src[self.pos] == "]":
                    self.pos += 1
                    break
                raise ValueError(f'if expression: unbalanced brackets in "{self.src}"')
            return Array(tuple(items))

        if c in ("'", '"'):
            return self._string(c)

        if c.isdigit() or (c == "-" and self._number_starts()):
            return self._number()

        if c.isalpha() or c in ("_", "$"):
            value = self._word()
            self.skip_space()
            # A call, but only on a bare name: ``abs(x)`` and never ``obj.method(x)``. The
            # reference restricts it the same way, and the validator says so with a position.
            if isinstance(value, Name) and not self.done() and self.src[self.pos] == "(":
                self.pos += 1
                args: list[Node] = []
                self.skip_space()
                if not self.done() and self.src[self.pos] == ")":
                    self.pos += 1
                else:
                    while True:
                        args.append(self.ternary(0))
                        self.skip_space()
                        if self.done():
                            raise ValueError(
                                f'if expression: unbalanced parentheses in "{self.src}"'
                            )
                        if self.src[self.pos] == ",":
                            self.pos += 1
                            continue
                        if self.src[self.pos] == ")":
                            self.pos += 1
                            break
                        raise ValueError(f'if expression: unbalanced parentheses in "{self.src}"')
                self.skip_space()
                return Call(value.value, tuple(args))
            while not self.done() and self.src[self.pos] == "[":
                self.pos += 1
                self.expression(0)
                self.skip_space()
                if self.done() or self.src[self.pos] != "]":
                    raise ValueError(f'if expression: unbalanced brackets in "{self.src}"')
                self.pos += 1
                self.skip_space()
                value = Computed(value)
            return value

        raise ValueError(f'if expression: cannot read "{self.rest()}" in "{self.src}"')

    def _string(self, quote: str) -> Node:
        self.pos += 1
        out: list[str] = []
        while self.pos < len(self.src) and self.src[self.pos] != quote:
            c = self.src[self.pos]
            if c == "\\" and self.pos + 1 < len(self.src):
                self.pos += 1
                c = self.src[self.pos]
            out.append(c)
            self.pos += 1
        if self.done():
            raise ValueError(f'if expression: unterminated string in "{self.src}"')
        self.pos += 1
        return Str("".join(out))

    def _number(self) -> Node:
        start = self.pos
        if self.src[self.pos] == "-":
            self.pos += 1
        while self.pos < len(self.src) and (
            self.src[self.pos].isdigit() or self.src[self.pos] == "."
        ):
            self.pos += 1
        return Num(float(self.src[start : self.pos]))

    def _word(self) -> Node:
        parts = [self._identifier()]
        while self.pos < len(self.src) and self.src[self.pos] == ".":
            self.pos += 1
            parts.append(self._identifier())
        if len(parts) == 1:
            name = parts[0]
            if name == "true":
                return Bool(True)
            if name == "false":
                return Bool(False)
            if name == "null":
                return Null()
            return Name(name)
        return Member(".".join(parts))

    def _identifier(self) -> str:
        start = self.pos
        while self.pos < len(self.src):
            c = self.src[self.pos]
            if c.isalnum() or c in ("_", "$"):
                self.pos += 1
            else:
                break
        if start == self.pos:
            raise ValueError(f'if expression: expected a name in "{self.src}"')
        return self.src[start : self.pos]

    def _peek_operator(self) -> str | None:
        # `in` is a WORD, so it only counts when what follows cannot continue an
        # identifier — otherwise a sequence called "index" would be read as the
        # operator followed by "dex".
        if self.src.startswith("in", self.pos):
            after = self.pos + 2
            if after >= len(self.src) or not (
                self.src[after].isalnum() or self.src[after] in ("_", "$")
            ):
                before = self.src[self.pos - 1] if self.pos > 0 else " "
                if not (before.isalnum() or before in ("_", "$")):
                    return "in"
        for op in _OPERATORS:
            if self.src.startswith(op, self.pos):
                return op
        return None
