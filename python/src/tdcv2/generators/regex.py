"""``<gen type="regex">`` — a pattern read forwards, as a generator rather than a matcher.

The syntax is borrowed because everyone already knows it, but the direction is reversed: a
regular expression usually asks "does this string fit", and here it says "make me a string that
fits". That difference is why the unbounded quantifiers are refused. ``a+`` matches any number of
letters, which as an instruction means "produce between one and infinity of them" — a question
with no answer. ``{1,10}`` says what was actually meant.

The longest possible output is computed before a single value is generated and checked against
``regex_max_length``. A pattern that could produce a megabyte is a mistake worth catching at
parse time, not on the row where memory ran out.

One escape has no equivalent in any regular-expression dialect: ``\\a{cyrillic.ru.letters}``
names an alphabet. Spelling that range by hand is how Ё gets lost.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from ..prng import rand
from ..prng.prng import Sfc32
from ..unicode import alphabets

DEFAULT_MAX_LENGTH = 32

DIGITS = alphabets.between(ord("0"), ord("9"))
LOWER = alphabets.between(ord("a"), ord("z"))
UPPER = alphabets.between(ord("A"), ord("Z"))
PRINTABLE_ASCII = alphabets.between(ord(" "), ord("~"))
WORD = [*UPPER, *LOWER, *DIGITS, "_"]
SPACES = [" ", "\t"]

ALPHABET_NAME = re.compile(r"^[A-Za-z0-9._-]+$")


# ── the tree ────────────────────────────────────────────────────────────────────────────────


class Node:
    """One piece of a compiled pattern."""

    __slots__ = ()


@dataclass(frozen=True, slots=True)
class Empty(Node):
    pass


@dataclass(frozen=True, slots=True)
class Literal(Node):
    value: str


@dataclass(frozen=True, slots=True)
class Chars(Node):
    chars: list[str]


@dataclass(frozen=True, slots=True)
class Sequence(Node):
    parts: list[Node]


@dataclass(frozen=True, slots=True)
class Alternation(Node):
    choices: list[Node]


@dataclass(frozen=True, slots=True)
class Repeat(Node):
    node: Node
    min: int
    max: int


@dataclass(frozen=True, slots=True)
class Capture(Node):
    index: int
    node: Node
    max_length: int


@dataclass(frozen=True, slots=True)
class Backref(Node):
    index: int


# ── generating ──────────────────────────────────────────────────────────────────────────────


def generate(attrs: dict[str, str], count: int, document_max_length: int, prng: Sfc32) -> list[str]:
    limit = (
        parse_max_length(attrs["regex_max_length"])
        if attrs.get("regex_max_length") is not None
        else document_max_length
    )
    root = compile_pattern(attrs.get("value", ""), limit)
    return [_render(root, {}, prng) for _ in range(count)]


def compile_pattern(pattern: str, regex_max_length: int) -> Node:
    parser = _Parser(pattern)
    root = parser.parse()
    longest = _max_length(root, parser.capture_max_lengths)
    if longest > regex_max_length:
        raise ValueError(
            f"regex can produce {longest} characters, which exceeds "
            f"regex_max_length={regex_max_length}"
        )
    return root


def parse_max_length(raw: str | None) -> int:
    if raw is None:
        return DEFAULT_MAX_LENGTH
    try:
        value = int(raw.strip())
    except ValueError:
        raise ValueError(f'regex_max_length must be a positive integer, got "{raw}"') from None
    if value <= 0:
        raise ValueError(f'regex_max_length must be a positive integer, got "{raw}"')
    return value


def _render(node: Node, captures: dict[int, str], prng: Sfc32) -> str:
    if isinstance(node, Empty):
        return ""
    if isinstance(node, Literal):
        return node.value
    if isinstance(node, Chars):
        return rand.pick(prng, node.chars)
    if isinstance(node, Sequence):
        return "".join(_render(part, captures, prng) for part in node.parts)
    if isinstance(node, Alternation):
        return _render(rand.pick(prng, node.choices), captures, prng)
    if isinstance(node, Repeat):
        times = rand.next_int(prng, node.min, node.max + 1)
        return "".join(_render(node.node, captures, prng) for _ in range(times))
    if isinstance(node, Capture):
        value = _render(node.node, captures, prng)
        captures[node.index] = value
        return value
    if isinstance(node, Backref):
        return captures.get(node.index, "")
    raise AssertionError(f"regex: unhandled node {node}")


def _max_length(node: Node, capture_max_lengths: dict[int, int]) -> int:
    """The longest string the pattern can produce — computed before generating, never after."""
    if isinstance(node, Empty):
        return 0
    if isinstance(node, (Literal, Chars)):
        return 1
    if isinstance(node, Sequence):
        total = 0
        for part in node.parts:
            total = _guard(total + _max_length(part, capture_max_lengths))
        return total
    if isinstance(node, Alternation):
        return max((_max_length(c, capture_max_lengths) for c in node.choices), default=0)
    if isinstance(node, Repeat):
        return _guard(_max_length(node.node, capture_max_lengths) * node.max)
    if isinstance(node, Capture):
        return node.max_length
    if isinstance(node, Backref):
        return capture_max_lengths.get(node.index, 0)
    raise AssertionError(f"regex: unhandled node {node}")


def _guard(value: int) -> int:
    if value < 0 or value > 2147483647:
        raise ValueError("regex: maximum length is too large")
    return value


def _chars(values: list[str]) -> Node:
    return Chars(list(dict.fromkeys(values)))


def inverse(excluded: list[str]) -> list[str]:
    exclude = set(excluded)
    return [ch for ch in PRINTABLE_ASCII if ch not in exclude]


def is_digit(ch: str | None) -> bool:
    return ch is not None and len(ch) == 1 and "0" <= ch <= "9"


# ── parsing ─────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class _ClassAtom:
    chars: list[str]
    single: str | None


class _Parser:
    def __init__(self, pattern: str) -> None:
        self.pattern = pattern
        self.pos = 0
        self.capture_count = 0
        self.closed_capture_count = 0
        self.capture_max_lengths: dict[int, int] = {}

    def parse(self) -> Node:
        node = self._alternation()
        if not self._at_end():
            raise self._error(f'unexpected "{self._peek()}"')
        return node

    def _alternation(self) -> Node:
        choices = [self._sequence()]
        while self._peek() == "|":
            self.pos += 1
            choices.append(self._sequence())
        return choices[0] if len(choices) == 1 else Alternation(choices)

    def _sequence(self) -> Node:
        parts: list[Node] = []
        while not self._at_end():
            ch = self._peek()
            if ch in (")", "|"):
                break
            parts.append(self._repeated_atom())
        if not parts:
            return Empty()
        return parts[0] if len(parts) == 1 else Sequence(parts)

    def _repeated_atom(self) -> Node:
        atom = self._atom()
        ch = self._peek()
        if ch is None:
            return atom
        if ch == "?":
            self.pos += 1
            return self._finish_repeat(atom, 0, 1)
        if ch == "*":
            raise self._error('unbounded "*" quantifier is not allowed; use "{0,n}"')
        if ch == "+":
            raise self._error('unbounded "+" quantifier is not allowed; use "{1,n}"')
        if ch == "{":
            return self._bounded_repeat(atom)
        return atom

    def _finish_repeat(self, node: Node, minimum: int, maximum: int) -> Node:
        if maximum < minimum:
            raise self._error(f"invalid quantifier bounds {{{minimum},{maximum}}}")
        following = self._peek()
        if following == "?":
            raise self._error("lazy quantifiers are not supported")
        if following in ("*", "+", "{"):
            raise self._error("stacked quantifiers are not supported")
        return Repeat(node, minimum, maximum)

    def _bounded_repeat(self, node: Node) -> Node:
        self._expect("{")
        min_text = self._digits()
        if not min_text:
            raise self._error("quantifier must start with a number")
        minimum = self._safe_int(min_text)
        if self._peek() == "}":
            self.pos += 1
            return self._finish_repeat(node, minimum, minimum)
        self._expect(",")
        max_text = self._digits()
        if not max_text:
            raise self._error('unbounded "{n,}" quantifier is not allowed; use "{n,m}"')
        maximum = self._safe_int(max_text)
        self._expect("}")
        return self._finish_repeat(node, minimum, maximum)

    def _atom(self) -> Node:
        ch = self._peek()
        if ch is None:
            return Empty()
        if ch == "(":
            return self._group()
        if ch == "[":
            return self._char_class()
        if ch == "\\":
            return self._escape()
        if ch == ".":
            self.pos += 1
            return _chars(PRINTABLE_ASCII)
        if ch in ("^", "$"):
            # Anchors say where a match sits, which means nothing when producing one.
            self.pos += 1
            return Empty()
        if ch in ("*", "+", "?", "{"):
            raise self._error(f'quantifier "{ch}" has no target')
        self.pos += 1
        return Literal(ch)

    def _group(self) -> Node:
        self._expect("(")
        capturing = True
        if self._peek() == "?":
            if self.pattern.startswith("?:", self.pos):
                self.pos += 2
                capturing = False
            else:
                raise self._error("lookaround, named, and conditional groups are not supported")
        index = 0
        if capturing:
            self.capture_count += 1
            index = self.capture_count
        node = self._alternation()
        self._expect(")")
        if not capturing:
            return node
        self.closed_capture_count = max(self.closed_capture_count, index)
        group_max = _max_length(node, self.capture_max_lengths)
        self.capture_max_lengths[index] = group_max
        return Capture(index, node, group_max)

    def _char_class(self) -> Node:
        self._expect("[")
        negated = self._peek() == "^"
        if negated:
            self.pos += 1

        collected: list[str] = []
        saw_atom = False
        while not self._at_end() and self._peek() != "]":
            saw_atom = True
            start = self._class_atom()
            if self._peek() == "-" and self._peek_next() is not None and self._peek_next() != "]":
                self.pos += 1
                end = self._class_atom()
                if start.single is None or end.single is None:
                    raise self._error("character class ranges must use single-character endpoints")
                lo, hi = ord(start.single), ord(end.single)
                if lo > hi:
                    raise self._error(f'invalid character range "{start.single}-{end.single}"')
                collected.extend(alphabets.between(lo, hi))
            else:
                collected.extend(start.chars)
        self._expect("]")
        if not saw_atom:
            raise self._error("empty character classes are not supported")

        unique = list(dict.fromkeys(collected))
        if negated:
            excluded = set(unique)
            final = [ch for ch in PRINTABLE_ASCII if ch not in excluded]
        else:
            final = unique
        if not final:
            raise self._error("character class has no available characters")
        return _chars(final)

    def _class_atom(self) -> _ClassAtom:
        ch = self._peek()
        if ch is None:
            raise self._error("unterminated character class")
        if ch == "\\":
            return self._class_escape()
        self.pos += 1
        return _ClassAtom([ch], ch)

    def _class_escape(self) -> _ClassAtom:
        self._expect("\\")
        ch = self._escaped_char()
        if ch == "d":
            return _ClassAtom(DIGITS, None)
        if ch == "D":
            return _ClassAtom(inverse(DIGITS), None)
        if ch == "w":
            return _ClassAtom(WORD, None)
        if ch == "W":
            return _ClassAtom(inverse(WORD), None)
        if ch == "s":
            return _ClassAtom(SPACES, None)
        if ch == "S":
            return _ClassAtom(inverse(SPACES), None)
        if ch == "a":
            if self._peek() != "{":
                return _ClassAtom([ch], ch)
            return _ClassAtom(self._named_alphabet(), None)
        if ch in ("n", "r"):
            raise self._error("multiline escapes are not supported")
        if ch == "t":
            return _ClassAtom(["\t"], "\t")
        if ch in ("p", "P"):
            raise self._error("Unicode property classes are not supported")
        return _ClassAtom([ch], ch)

    def _escape(self) -> Node:
        self._expect("\\")
        ch = self._escaped_char()
        if is_digit(ch):
            index_text = ch + self._digits()
            index = self._safe_int(index_text)
            if index <= 0 or index > self.closed_capture_count:
                raise self._error(
                    f'backreference "\\{index_text}" points to a group that is not generated yet'
                )
            return Backref(index)
        if ch == "d":
            return _chars(DIGITS)
        if ch == "D":
            return _chars(inverse(DIGITS))
        if ch == "w":
            return _chars(WORD)
        if ch == "W":
            return _chars(inverse(WORD))
        if ch == "s":
            return _chars(SPACES)
        if ch == "S":
            return _chars(inverse(SPACES))
        if ch == "a":
            if self._peek() != "{":
                return Literal(ch)
            return _chars(self._named_alphabet())
        if ch in ("n", "r"):
            raise self._error("multiline escapes are not supported")
        if ch == "t":
            return Literal("\t")
        if ch in ("p", "P"):
            raise self._error("Unicode property classes are not supported")
        return Literal(ch)

    def _named_alphabet(self) -> list[str]:
        r"""``\a{name}`` — a named alphabet, the escape that has no equivalent anywhere else."""
        self._expect("{")
        name = []
        while not self._at_end() and self._peek() != "}":
            name.append(self._peek())
            self.pos += 1
        self._expect("}")
        text = "".join(name)
        if not text:
            raise self._error('alphabet escape "\\a{...}" requires a non-empty name')
        if not ALPHABET_NAME.match(text):
            raise self._error(f'invalid alphabet name "{text}"')
        resolved = alphabets.chars(text)
        if resolved is None:
            raise self._error(f'unknown alphabet "{text}"')
        return resolved

    def _escaped_char(self) -> str:
        ch = self._peek()
        if ch is None:
            raise self._error("dangling escape at end of pattern")
        self.pos += 1
        return ch

    def _digits(self) -> str:
        out = []
        while not self._at_end() and is_digit(self._peek()):
            out.append(self._peek())
            self.pos += 1
        return "".join(out)

    def _expect(self, expected: str) -> None:
        actual = self._peek()
        if actual != expected:
            found = "end of pattern" if actual is None else actual
            raise self._error(f'expected "{expected}" but found "{found}"')
        self.pos += 1

    def _at_end(self) -> bool:
        return self.pos >= len(self.pattern)

    def _peek(self) -> str | None:
        return None if self._at_end() else self.pattern[self.pos]

    def _peek_next(self) -> str | None:
        return None if self.pos + 1 >= len(self.pattern) else self.pattern[self.pos + 1]

    def _safe_int(self, text: str) -> int:
        try:
            value = int(text)
        except ValueError:
            raise self._error(f'invalid quantifier number "{text}"') from None
        if value < 0:
            raise self._error(f'invalid quantifier number "{text}"')
        return value

    def _error(self, message: str) -> ValueError:
        return ValueError(f"regex: {message} at offset {self.pos}")
