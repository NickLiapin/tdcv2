r"""``<gen type="advanced_regex">`` — the same finite subset, plus what a matcher has no use for.

This lives beside the stable ``regex`` generator rather than inside it. A regular expression is a
matching language, and the two constructs added here would mean nothing to a matcher: exact
weighted choice, ``(?%{70:RU;20:US;10:DE})``, says how OFTEN a branch appears, which is a question
only a generator can be asked.

"Exact" is the whole point, and it costs something. Seventy percent is settled over the entire
column by the same apportionment the rest of the library uses, not by a coin flip per row — which
means a weighted choice cannot be answered for row nine million on its own, and a config that
contains one is routed to an engine that builds the column whole.

That is also why generation walks the tree once for ALL rows instead of once per row: at a
weighted choice the rows are split into branch buckets and each bucket continues together. The
draw order follows from that shape, so it is part of the contract, not an implementation detail.
"""

from __future__ import annotations

from dataclasses import dataclass

from ..distribution import hamilton
from ..lib import numbers
from ..prng import rand
from ..prng.prng import Sfc32
from ..unicode import alphabets
from .regex import (
    ALPHABET_NAME,
    DIGITS,
    PRINTABLE_ASCII,
    SPACES,
    WORD,
    Alternation,
    Backref,
    Capture,
    Chars,
    Empty,
    Literal,
    Node,
    Repeat,
    Sequence,
    inverse,
    is_digit,
    parse_max_length,
)

# Inside a weighted choice a branch ends at the separator or the closing brace, so alternation
# has to stop there instead of swallowing them as ordinary characters.
_BRANCH_STOP = frozenset({";", "}"})


@dataclass(frozen=True, slots=True)
class WeightedBranch:
    percent: float
    node: Node


@dataclass(frozen=True, slots=True)
class WeightedChoice(Node):
    """``(?%{70:A;30:B})`` — branches with exact shares over the whole column."""

    choices: list[WeightedBranch]


@dataclass(frozen=True, slots=True)
class Program:
    root: Node
    max_length: int
    capture_count: int
    weighted_choice_count: int


def generate(attrs: dict[str, str], count: int, document_max_length: int, prng: Sfc32) -> list[str]:
    limit = (
        parse_max_length(attrs["regex_max_length"])
        if attrs.get("regex_max_length") is not None
        else document_max_length
    )
    program = compile_pattern(attrs.get("value", ""), limit)
    return _generate_rows(program.root, count, prng)


def compile_pattern(pattern: str, regex_max_length: int) -> Program:
    parser = _Parser(pattern)
    root = parser.parse()
    longest = _max_length(root, parser.capture_max_lengths)
    if longest > regex_max_length:
        raise ValueError(
            f"advanced_regex can produce {longest} characters, which exceeds "
            f"regex_max_length={regex_max_length}"
        )
    return Program(root, longest, parser.capture_count, parser.weighted_choice_count)


def has_weighted_choice(pattern: str) -> bool:
    """Does this pattern need an engine that builds the whole column?

    A malformed pattern answers ``False`` rather than raising: this is asked while ROUTING, and
    the parse error belongs to the run, where it can be reported against the right position.
    """
    try:
        parser = _Parser(pattern)
        parser.parse()
    except ValueError:
        return False
    return parser.weighted_choice_count > 0


# ── generating ──────────────────────────────────────────────────────────────────────────────


class _Row:
    """One row under construction, with the captures it has closed so far."""

    __slots__ = ("captures", "out")

    def __init__(self) -> None:
        self.out = ""
        self.captures: dict[int, str] = {}


def _generate_rows(root: Node, count: int, prng: Sfc32) -> list[str]:
    rows = [_Row() for _ in range(count)]
    _generate_into(root, rows, prng)
    return [row.out for row in rows]


def _generate_into(node: Node, rows: list[_Row], prng: Sfc32) -> None:
    if not rows:
        return

    if isinstance(node, Empty):
        return
    if isinstance(node, Literal):
        for row in rows:
            row.out += node.value
        return
    if isinstance(node, Chars):
        for row in rows:
            row.out += rand.pick(prng, node.chars)
        return
    if isinstance(node, Sequence):
        for part in node.parts:
            _generate_into(part, rows, prng)
        return
    if isinstance(node, Alternation):
        _generate_alternation(node, rows, prng)
        return
    if isinstance(node, Repeat):
        _generate_repeat(node, rows, prng)
        return
    if isinstance(node, Capture):
        _generate_capture(node, rows, prng)
        return
    if isinstance(node, Backref):
        for row in rows:
            row.out += row.captures.get(node.index, "")
        return
    if isinstance(node, WeightedChoice):
        _generate_weighted(node, rows, prng)
        return
    raise AssertionError(f"advanced_regex: unhandled node {node}")


def _generate_alternation(node: Alternation, rows: list[_Row], prng: Sfc32) -> None:
    buckets: list[list[_Row]] = [[] for _ in node.choices]
    for row in rows:
        buckets[rand.next_int(prng, 0, len(node.choices))].append(row)
    for choice, bucket in zip(node.choices, buckets, strict=True):
        if bucket:
            _generate_into(choice, bucket, prng)


def _generate_repeat(node: Repeat, rows: list[_Row], prng: Sfc32) -> None:
    # Every row's count is drawn first, then one pass per step over the rows still repeating.
    counts = [rand.next_int(prng, node.min, node.max + 1) for _ in rows]
    for step in range(node.max):
        active = [row for row, times in zip(rows, counts, strict=True) if times > step]
        _generate_into(node.node, active, prng)


def _generate_capture(node: Capture, rows: list[_Row], prng: Sfc32) -> None:
    starts = [len(row.out) for row in rows]
    _generate_into(node.node, rows, prng)
    for row, start in zip(rows, starts, strict=True):
        row.captures[node.index] = row.out[start:]


def _generate_weighted(node: WeightedChoice, rows: list[_Row], prng: Sfc32) -> None:
    """The branches as an exact quota over these rows, then each bucket carries on together."""
    indexes = list(range(len(node.choices)))
    percents = [choice.percent for choice in node.choices]
    selected = hamilton.distribute(len(rows), indexes, percents, prng)

    buckets: list[list[_Row]] = [[] for _ in node.choices]
    for row, index in zip(rows, selected, strict=True):
        buckets[index].append(row)
    for choice, bucket in zip(node.choices, buckets, strict=True):
        if bucket:
            _generate_into(choice.node, bucket, prng)


def _max_length(node: Node, capture_max_lengths: dict[int, int]) -> int:
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
    if isinstance(node, WeightedChoice):
        return max((_max_length(c.node, capture_max_lengths) for c in node.choices), default=0)
    raise AssertionError(f"advanced_regex: unhandled node {node}")


def _guard(value: int) -> int:
    if value < 0 or value > 2147483647:
        raise ValueError("advanced_regex: maximum length is too large")
    return value


def _chars(values: list[str]) -> Chars:
    return Chars(list(dict.fromkeys(values)))


# ── parsing ─────────────────────────────────────────────────────────────────────────────────


@dataclass(frozen=True, slots=True)
class _ClassAtom:
    chars: list[str]
    single: str | None


class _Parser:
    """The regex parser again, with two differences, so it is written out rather than subclassed.

    Alternation carries a set of characters it must stop at — needed only inside a weighted
    branch — and ``(`` recognises one more group form. Everything else is deliberately identical
    to ``regex``: the two generators accept the same patterns, and a config can move from one to
    the other without its values changing shape.
    """

    def __init__(self, pattern: str) -> None:
        self.pattern = pattern
        self.pos = 0
        self.capture_count = 0
        self.closed_capture_count = 0
        self.weighted_choice_count = 0
        self.capture_max_lengths: dict[int, int] = {}

    def parse(self) -> Node:
        node = self._alternation(frozenset())
        if not self._at_end():
            raise self._error(f'unexpected "{self._peek()}"')
        return node

    def _alternation(self, stop: frozenset[str]) -> Node:
        choices = [self._sequence(stop)]
        while self._peek() == "|":
            self.pos += 1
            choices.append(self._sequence(stop))
        return choices[0] if len(choices) == 1 else Alternation(choices)

    def _sequence(self, stop: frozenset[str]) -> Node:
        parts: list[Node] = []
        while not self._at_end():
            ch = self._peek()
            if ch in (")", "|") or ch in stop:
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
            self.pos += 1
            return Empty()
        if ch in ("*", "+", "?", "{"):
            raise self._error(f'quantifier "{ch}" has no target')
        self.pos += 1
        return Literal(ch)

    def _group(self) -> Node:
        self._expect("(")
        if self._peek() == "?" and self.pattern.startswith("?%{", self.pos):
            self.pos += 3
            node = self._weighted_choice()
            self._expect(")")
            return node

        capturing = True
        if self._peek() == "?":
            if self.pattern.startswith("?:", self.pos):
                self.pos += 2
                capturing = False
            else:
                raise self._error("lookaround, named, and conditional groups are not supported yet")

        index = 0
        if capturing:
            self.capture_count += 1
            index = self.capture_count

        node = self._alternation(frozenset())
        self._expect(")")
        if not capturing:
            return node

        self.closed_capture_count = max(self.closed_capture_count, index)
        group_max = _max_length(node, self.capture_max_lengths)
        self.capture_max_lengths[index] = group_max
        return Capture(index, node, group_max)

    def _weighted_choice(self) -> Node:
        choices: list[WeightedBranch] = []
        while not self._at_end():
            self._skip_control_whitespace()
            if self._peek() == "}":
                raise self._error("weighted choice must contain at least one branch")
            percent = self._weight()
            self._skip_control_whitespace()
            self._expect(":")
            node = self._alternation(_BRANCH_STOP)
            choices.append(WeightedBranch(percent, node))

            ch = self._peek()
            if ch == ";":
                self.pos += 1
                continue
            if ch == "}":
                self.pos += 1
                self._validate_percents(choices)
                self.weighted_choice_count += 1
                return WeightedChoice(choices)
            raise self._error('expected ";" or "}" in weighted choice')
        raise self._error("unterminated weighted choice")

    def _weight(self) -> float:
        start = self.pos
        while not self._at_end():
            ch = self._peek()
            if not is_digit(ch) and ch != ".":
                break
            self.pos += 1
        raw = self.pattern[start : self.pos]
        try:
            value = float(raw)
        except ValueError:
            raise self._error(f'invalid weighted choice percent "{raw}"') from None
        if value != value or value in (float("inf"), float("-inf")) or value < 0:
            raise self._error(f'invalid weighted choice percent "{raw}"')
        return value

    def _validate_percents(self, choices: list[WeightedBranch]) -> None:
        total = sum(choice.percent for choice in choices)
        if abs(total - 100) > 0.0001:
            raise self._error(
                f"weighted choice percentages sum to {numbers.to_text(total)}, expected 100"
            )

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

    def _skip_control_whitespace(self) -> None:
        while self._peek() in (" ", "\t"):
            self.pos += 1

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
        return ValueError(f"advanced_regex: {message} at offset {self.pos}")
