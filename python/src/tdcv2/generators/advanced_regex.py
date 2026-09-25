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

import re
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
    SPACE_CAP,
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
class ConditionalBranch:
    """One branch of ``(?if{…})``.

    ``test`` is ``None`` for the ``*`` branch, which always matches; otherwise it is the
    capture index to read and the text it must equal.
    """

    test: tuple[int, str] | None
    node: Node


@dataclass(frozen=True, slots=True)
class Conditional(Node):
    """``(?if{sex=male:MR;sex=female:MS})`` — pick a branch from what an EARLIER named group
    produced on this row.

    The one construct here that reads rather than draws. Everything else decides a row from
    randomness alone, which is why a pattern could describe an address or an identifier but
    never a title that agrees with a sex chosen two characters earlier.

    Branches are tried in the order written and the first match wins, so a ``*`` is an
    "otherwise" wherever it stands — and a row matching NO branch produces nothing at all,
    which is what ``*`` exists to prevent.
    """

    branches: list[ConditionalBranch]


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

    __slots__ = ("captures", "dealt", "out")

    def __init__(self, dealt: list[tuple[WeightedChoice, int]] | None = None) -> None:
        self.out = ""
        self.captures: dict[int, str] = {}
        #: Every weighted branch this row was dealt, in the order it met them — kept only when a
        #: unique column asks, so it can redraw the row along the SAME branches.
        self.dealt = dealt


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
    if isinstance(node, Conditional):
        _generate_conditional(node, rows, prng)
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
        if row.dealt is not None:
            row.dealt.append((node, index))
    for choice, bucket in zip(node.choices, buckets, strict=True):
        if bucket:
            _generate_into(choice.node, bucket, prng)


def _generate_conditional(node: Conditional, rows: list[_Row], prng: Sfc32) -> None:
    """Each row to the FIRST branch it passes, then the branches in the order written.

    Rows that pass no branch are left untouched — nothing is appended — which is the only
    honest answer when the pattern says nothing about the value the row actually holds.
    Writing a ``*`` branch is how a config says what to do instead.

    Branch by branch, not row by row, so the draws a branch makes depend on how many rows
    CHOSE it rather than on where those rows sit in the column.
    """
    buckets: list[list[_Row]] = [[] for _ in node.branches]
    for row in rows:
        for i, branch in enumerate(node.branches):
            if branch.test is None or row.captures.get(branch.test[0], "") == branch.test[1]:
                buckets[i].append(row)
                break
    for branch, bucket in zip(node.branches, buckets, strict=True):
        if bucket:
            _generate_into(branch.node, bucket, prng)


# ── uniq="true" over a pattern ──────────────────────────────────────────────────────────────


def space_size(pattern: str, regex_max_length: int) -> int:
    """The most different strings a pattern can make — counted as :func:`regex.space_size` counts,
    with a weighted choice adding its branches and a conditional adding its branches plus the empty
    string a row that matches none contributes (unless a ``*`` branch leaves no such row).
    """
    return _space(compile_pattern(pattern, regex_max_length).root, None)


class PlannedColumn:
    """A column dealt exactly as :func:`generate` deals it, able to redraw one row without moving
    a single exact share. See the TypeScript reference, ``PlannedAdvancedColumn``, for the why.

    Weighted choices are told apart by IDENTITY, never by equality: they are frozen dataclasses,
    so two written the same way compare equal, and a row dealt the first would be read as having
    been dealt the second.
    """

    def __init__(self, root: Node, rows: list[_Row]) -> None:
        self._root = root
        self._rows = rows
        self.values = [row.out for row in rows]
        self.total_space = _space(root, None)
        ids: dict[int, int] = {}
        _number_weighted(root, ids)
        self._spine = _on_spine(root, False)

        def key_of(dealt: list[tuple[WeightedChoice, int]]) -> str:
            if not self._spine:
                return ""
            return "/".join(f"{ids[id(node)]}.{branch}" for node, branch in dealt)

        self.path_keys = [key_of(row.dealt or []) for row in rows]
        self._first: dict[str, list[tuple[WeightedChoice, int]]] = {}
        for key, row in zip(self.path_keys, rows, strict=True):
            self._first.setdefault(key, row.dealt or [])
        self._spaces: dict[str, int] = {}

    def path_space(self, key: str) -> int | None:
        """The strings a path can make, or ``None`` when the shares cannot be counted apart."""
        if not self._spine:
            return None
        if key not in self._spaces:
            along = {id(node): branch for node, branch in self._first.get(key, [])}
            self._spaces[key] = _space(self._root, along)
        return self._spaces[key]

    def describe_path(self, key: str) -> str:
        """``70% (branch 1 of 2)``, joined by `` → ``, for a refusal.

        Empty where the shares are not counted apart: every row is then in one group, and naming
        the branches its first row happened to take would describe a share nobody is held to.
        """
        if not self._spine:
            return ""
        return " → ".join(
            f"{numbers.to_text(node.choices[branch].percent)}% "
            f"(branch {branch + 1} of {len(node.choices)})"
            for node, branch in self._first.get(key, [])
        )

    def redraw(self, row: int, prng: Sfc32) -> str | None:
        """One more value for ``row`` along its dealt branches, or ``None`` if the walk strayed."""
        dealt = self._rows[row].dealt or []
        fresh = _Row()
        cursor = [0]
        if not _draw_along(self._root, fresh, dealt, cursor, prng):
            return None
        return fresh.out if cursor[0] == len(dealt) else None


def plan_column(
    attrs: dict[str, str], count: int, document_max_length: int, prng: Sfc32
) -> PlannedColumn:
    """Deal a column exactly as :func:`generate` would, remembering each row's weighted branches."""
    limit = (
        parse_max_length(attrs["regex_max_length"])
        if attrs.get("regex_max_length") is not None
        else document_max_length
    )
    root = compile_pattern(attrs.get("value", ""), limit).root
    rows = [_Row([]) for _ in range(count)]
    _generate_into(root, rows, prng)
    return PlannedColumn(root, rows)


def _draw_along(
    node: Node,
    row: _Row,
    dealt: list[tuple[WeightedChoice, int]],
    cursor: list[int],
    prng: Sfc32,
) -> bool:
    """One row walked as :func:`_generate_into` walks a bucket of one — except that a weighted
    choice takes the branch the row was dealt. ``False`` as soon as it meets a weighted choice the
    row did not meet at this point the first time."""
    if isinstance(node, Empty):
        return True
    if isinstance(node, Literal):
        row.out += node.value
        return True
    if isinstance(node, Chars):
        row.out += rand.pick(prng, node.chars)
        return True
    if isinstance(node, Sequence):
        return all(_draw_along(part, row, dealt, cursor, prng) for part in node.parts)
    if isinstance(node, Alternation):
        choice = node.choices[rand.next_int(prng, 0, len(node.choices))]
        return _draw_along(choice, row, dealt, cursor, prng)
    if isinstance(node, Repeat):
        times = rand.next_int(prng, node.min, node.max + 1)
        return all(_draw_along(node.node, row, dealt, cursor, prng) for _ in range(times))
    if isinstance(node, Capture):
        start = len(row.out)
        if not _draw_along(node.node, row, dealt, cursor, prng):
            return False
        row.captures[node.index] = row.out[start:]
        return True
    if isinstance(node, Backref):
        row.out += row.captures.get(node.index, "")
        return True
    if isinstance(node, WeightedChoice):
        at = cursor[0]
        if at >= len(dealt) or dealt[at][0] is not node:
            return False
        cursor[0] = at + 1
        return _draw_along(node.choices[dealt[at][1]].node, row, dealt, cursor, prng)
    if isinstance(node, Conditional):
        for branch in node.branches:
            if branch.test is None or row.captures.get(branch.test[0], "") == branch.test[1]:
                return _draw_along(branch.node, row, dealt, cursor, prng)
        return True
    raise AssertionError(f"advanced_regex: unhandled node {node}")


def _number_weighted(node: Node, ids: dict[int, int]) -> None:
    if isinstance(node, Sequence):
        for part in node.parts:
            _number_weighted(part, ids)
    elif isinstance(node, Alternation):
        for choice in node.choices:
            _number_weighted(choice, ids)
    elif isinstance(node, (Repeat, Capture)):
        _number_weighted(node.node, ids)
    elif isinstance(node, WeightedChoice):
        ids[id(node)] = len(ids)
        for choice in node.choices:
            _number_weighted(choice.node, ids)
    elif isinstance(node, Conditional):
        for branch in node.branches:
            _number_weighted(branch.node, ids)


def _on_spine(node: Node, under_draw: bool) -> bool:
    """Every weighted choice passed exactly once by each row reaching its parent."""
    if isinstance(node, WeightedChoice):
        return not under_draw and all(_on_spine(c.node, False) for c in node.choices)
    if isinstance(node, Sequence):
        return all(_on_spine(part, under_draw) for part in node.parts)
    if isinstance(node, Capture):
        return _on_spine(node.node, under_draw)
    if isinstance(node, Alternation):
        return all(_on_spine(choice, True) for choice in node.choices)
    if isinstance(node, Repeat):
        return _on_spine(node.node, True)
    if isinstance(node, Conditional):
        return all(_on_spine(branch.node, True) for branch in node.branches)
    return True


def _space(node: Node, along: dict[int, int] | None) -> int:
    """Strings ``node`` can make — along ``along``'s branches where it names a weighted choice."""
    if isinstance(node, (Empty, Literal, Backref)):
        return 1
    if isinstance(node, Chars):
        return len(set(node.chars))
    if isinstance(node, Sequence):
        total = 1
        for part in node.parts:
            total = min(total * _space(part, along), SPACE_CAP)
        return total
    if isinstance(node, Alternation):
        total = 0
        for choice in node.choices:
            total = min(total + _space(choice, along), SPACE_CAP)
        return total
    if isinstance(node, Capture):
        return _space(node.node, along)
    if isinstance(node, Repeat):
        inner = _space(node.node, along)
        term = 1
        for _ in range(node.min):
            term = min(term * inner, SPACE_CAP)
        total = 0
        for _ in range(node.min, node.max + 1):
            total = min(total + term, SPACE_CAP)
            term = min(term * inner, SPACE_CAP)
        return total
    if isinstance(node, WeightedChoice):
        if along is not None and id(node) in along:
            return _space(node.choices[along[id(node)]].node, along)
        total = 0
        for choice in node.choices:
            total = min(total + _space(choice.node, along), SPACE_CAP)
        return total
    if isinstance(node, Conditional):
        total = 0
        for branch in node.branches:
            total = min(total + _space(branch.node, along), SPACE_CAP)
        # A row that matches no branch appends nothing: one more outcome, unless `*` catches it.
        if not any(branch.test is None for branch in node.branches):
            total = min(total + 1, SPACE_CAP)
        return total
    raise AssertionError(f"advanced_regex: unhandled node {node}")


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
    if isinstance(node, Conditional):
        # The longest branch: a row takes exactly one of them, so the widest the conditional
        # can be is the widest branch — never their sum.
        return max((_max_length(b.node, capture_max_lengths) for b in node.branches), default=0)
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
        # ``(?<name>…)`` → its capture index, filled as each named group CLOSES. Closing
        # rather than opening, so ``(?<a>(?if{a=x:y}))`` cannot read the group it is inside:
        # at that point the group has produced nothing and the condition would compare
        # against the empty string on every row.
        self.group_names: dict[str, int] = {}
        # Every name written down, closed or not. The map above only learns a name when its
        # group closes, so checking THAT for a repeat misses the nested spelling —
        # ``(?<a>(?<a>x))`` — where the inner group closes first and the outer then
        # overwrites it. Which of the two ``(?if{a=…})`` reads would be decided by parse
        # order, so both spellings are refused here instead.
        self.declared_names: set[str] = set()

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
        if self._peek() == "?" and self.pattern.startswith("?if{", self.pos):
            self.pos += 4
            node = self._conditional()
            self._expect(")")
            return node

        capturing = True
        name: str | None = None
        if self._peek() == "?":
            if self.pattern.startswith("?:", self.pos):
                self.pos += 2
                capturing = False
            elif self.pattern.startswith("?<", self.pos) and self._peek_at(2) not in ("=", "!"):
                # ``(?<=…)`` and ``(?<!…)`` are LOOKBEHIND, not a group called "=" or "!".
                self.pos += 2
                name = self._group_name()
            else:
                raise self._error(
                    "this group is not supported — advanced_regex has (?:…), (?<name>…), "
                    "(?%{…}) and (?if{…}). Lookaround and numbered conditionals decide what a "
                    "pattern MATCHES, and nothing here is matching anything"
                )

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
        if name is not None:
            self.group_names[name] = index
        return Capture(index, node, group_max)

    def _group_name(self) -> str:
        """The ``name`` of ``(?<name>…)``, up to the closing ``>``."""
        start = self.pos
        while not self._at_end() and self._peek() != ">":
            self.pos += 1
        name = self.pattern[start : self.pos]
        self._expect(">")
        if not name:
            raise self._error("a named group needs a name: (?<sex>…)")
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", name):
            raise self._error(
                f'group name "{name}" must start with a letter or "_" and hold only letters, '
                'digits and "_"'
            )
        # Two groups under one name would make ``(?if{name=…})`` a coin toss between them,
        # decided by whichever the parser happened to record last.
        if name in self.declared_names:
            raise self._error(f'group name "{name}" is already used')
        self.declared_names.add(name)
        return name

    def _conditional(self) -> Node:
        """``?if{sex=male:MR;sex=female:MS}`` — the ``(?if{`` is already consumed.

        Each branch is a full pattern, so weighted choices and further conditionals nest
        inside them exactly as they do inside a weighted branch.
        """
        branches: list[ConditionalBranch] = []
        while not self._at_end():
            self._skip_control_whitespace()
            if self._peek() == "}":
                raise self._error("conditional must contain at least one branch")
            test = self._conditional_test()
            node = self._alternation(_BRANCH_STOP)
            branches.append(ConditionalBranch(test, node))

            ch = self._peek()
            if ch == ";":
                self.pos += 1
                continue
            if ch == "}":
                self.pos += 1
                return Conditional(branches)
            raise self._error('expected ";" or "}" in conditional')
        raise self._error("unterminated conditional")

    def _conditional_test(self) -> tuple[int, str] | None:
        """``name=value`` before a branch's ``:``, or ``*`` for the branch that always matches."""
        start = self.pos
        while not self._at_end() and self._peek() not in (":", "}"):
            self.pos += 1
        raw = self.pattern[start : self.pos]
        self._expect(":")
        if raw == "*":
            return None
        split = raw.find("=")
        if split < 0:
            raise self._error(
                f'conditional branch "{raw}" must read a group: name=value, or "*" for every '
                "other row"
            )
        name = raw[:split].strip()
        capture = self.group_names.get(name)
        if capture is None:
            # Declared LATER is the same as not declared at all here: the pattern is generated
            # left to right, so a group further along has produced nothing to compare against
            # and the branch could never be taken.
            raise self._error(
                f'conditional reads "{name}", which no (?<{name}>…) group before it declares'
            )
        return (capture, raw[split + 1 :])

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
        if ch == "k":
            return self._named_backref()
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

    def _named_backref(self) -> Node:
        r"""``\k<area>`` — the ``\k`` is already consumed.

        Missing until now, and missing SILENTLY: ``\k`` fell to the final ``return Literal(ch)``,
        so ``(?<a>[A-Z]{2})-\k<a>`` produced ``RI-k<a>`` while ``type="regex"`` produced ``RI-RI``
        from the same pattern and seed. A value that looks plausible, passes every format check
        and reaches the file is the worst way for a generator to be wrong, and this was the only
        construct here that failed that way — a numbered ``\1`` already worked, and every other
        unsupported construct is refused by name.

        The final ``Literal`` is not at fault and is left alone: "an unknown escape is the
        character itself" is a deliberate rule shared with ``regex`` (``\q`` is ``q`` in both).
        ``\k`` simply inherited it instead of reaching a branch of its own.

        ``group_names`` is keyed on the group CLOSING, so it already carries the rule this needs:
        a name further along the pattern has produced nothing to repeat.
        """
        if self._peek() != "<":
            raise self._error('a named backreference is written "\\k<area>"')
        self.pos += 1
        start = self.pos
        while not self._at_end() and self._peek() != ">":
            self.pos += 1
        name = self.pattern[start : self.pos]
        self._expect(">")
        index = self.group_names.get(name)
        if index is None:
            raise self._error(
                f'named backreference "\\k<{name}>" points to a group that is not generated yet'
            )
        return Backref(index)

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

    def _peek_at(self, offset: int) -> str | None:
        at = self.pos + offset
        return None if at >= len(self.pattern) else self.pattern[at]

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
