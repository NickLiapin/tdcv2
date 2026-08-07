"""A config checked before it runs, and what is wrong reported by stable code.

This exists because "the same config produces the same data everywhere" is only half a promise if
one implementation accepts what another refuses. A config that runs in Python and fails in
TypeScript is a portability bug even when no value was ever wrong.

The grammar is deliberately permissive — it lets any element nest anywhere — so every rule about
WHERE a tag may live is owned here rather than by the parser. That keeps the grammar shared and
small while the rules stay readable.

Codes and their meanings come from the reference. Nothing is invented here: a rule that exists in
one implementation and not the other is exactly the divergence this file is meant to prevent.
"""

from __future__ import annotations

import math
import re
from pathlib import Path
from urllib.parse import urlparse

from ..date import calendar
from ..date import locales as date_locales
from ..date import formatter as date_formatter
from ..date import gen as date_gen
from ..date import parse as date_parse
from ..date.plain import Precision
from ..distribution import percent_mask
from ..errors import Diagnostic
from ..expr import parse as expr_parse
from ..expr.parse import (
    Array,
    Binary,
    Bool,
    Call,
    Computed,
    Conditional,
    Member,
    Name,
    Null,
    Num,
    Str,
    Unary,
)
from ..format import mask as mask_lib
from ..format import mask as mask_mod
from ..format import transforms
from ..generators import accumulate as accumulate_gen
from ..generators import file as file_gen
from ..generators import regex
from ..generators import stat as stat_gen
from ..lib import numbers
from ..output import column_type
from ..packs import DataPacks
from ..parser import paired_data
from ..stats import distribution as dist
from . import checks
from .compute_check import ComputeCheck

#: Operators whose right side may be a bare word rather than a name.
COMPARISON_OPERATORS = ("==", "!=", "===", "!==", "<", ">", "<=", ">=")

# What may sit directly inside <tdc>.
TDC_CHILDREN = frozenset({"env", "block"})

# What each closed tag reads. An attribute a tag does not read is a request the config made and
# silently did not get, which is indistinguishable from a typo — and the data comes out looking
# fine either way. `comment` is accepted everywhere: it is documented as a note that never
# renders, and refusing it on a tag that happens not to list it would be a pointless trap.
CLOSED_TAG_ATTRIBUTES = {
    "env": {"count", "seed", "local", "inject", "mode", "engine", "comment"},
    "sequence": {"name", "parent", "uniq", "comment"},
    "line": {"if", "each", "comment"},
    "tdc": {"version", "v", "regex_max_length", "comment"},
    "mix": {"name", "percent", "parent", "flag", "comment"},
    # `percent` is NOT here: a <switch> picks its case from `on=`, and <case> requires
    # `is=` (TDC137). The percentage short-form belongs to <mix>.
    "switch": {"name", "on", "comment"},
    "case": {"is", "if", "anomaly", "default", "comment"},
    "map": {"comment"},
    "default": {"comment"},
    "data": {"if", "pair", "name", "type", "comment"},
    "pool": {"name", "count", "comment"},
    # A group wrapper says what must hold BETWEEN the sequences inside it; it has no
    # settings of its own. uniq="true" is an attribute of <sequence>, not of <uniq> —
    # writing it on the wrapper is a common slip and now says so.
    "uniq": {"comment"},
    "distinct": {"comment"},
    # An assertion is its two attributes and nothing else.
    "assert": {"that", "says", "comment"},
}

# Where each construct belongs — the "put it in X" half of a placement complaint.
#: Constructs that live at env level; inside a <sequence> they are simply misplaced.
MISPLACED_IN_SEQUENCE = frozenset({"mix", "switch", "case", "default", "map"})

PLACEMENT_HINTS = {
    "gen": "A <gen> lives inside a <sequence> (or a <case> of a <mix>/<switch>).",
    "mix": (
        "A <mix> is a named env-level construct — declare it directly in <env> and use ${{Name}}."
    ),
    "switch": (
        "A <switch> is a named env-level construct — declare it directly in <env> and use "
        "${{Name}}."
    ),
    "case": "A <case> belongs inside a <mix> or a <switch>.",
    "map": "A <map> belongs inside a <switch>.",
    "default": "A <default> belongs inside a <switch>.",
    "line": "A <line> belongs inside a <block> (or a before/after fixture).",
    "sequence": "A <sequence> belongs directly inside <env>.",
}

# The binary operators the evaluator implements. Anything else is refused, not ignored.
SUPPORTED_BINARY = (
    "==",
    "!=",
    "===",
    "!==",
    "<",
    ">",
    "<=",
    ">=",
    "&&",
    "||",
    "+",
    "-",
    "*",
    "/",
    # Euclidean, matching <mod>: -3 % 2 is 1 here and -1 in JavaScript, Java, C# and Rust.
    "%",
    # Set membership: `Country in [US, CA, MX]`.
    "in",
)

# What an if= may call, and how many arguments each takes; None as the upper bound means
# variadic. Every one is EXACT — comparisons and the arithmetic IEEE-754 pins down — so the five
# implementations cannot disagree. Transcendental functions are absent for that reason alone.
EXPR_FUNCTIONS: dict[str, tuple[int, int | None]] = {
    "abs": (1, 1),
    "ceil": (1, 1),
    "acos": (1, 1),
    "acosh": (1, 1),
    "asin": (1, 1),
    "asinh": (1, 1),
    "atan": (1, 1),
    "at": (2, 2),
    "atan2": (2, 2),
    "atanh": (1, 1),
    "beta": (2, 2),
    "cbrt": (1, 1),
    "contains": (2, 2),
    "cos": (1, 1),
    "count": (1, 1),
    "degrees": (1, 1),
    "digamma": (1, 1),
    "cosh": (1, 1),
    "ends_with": (2, 2),
    "erf": (1, 1),
    "erfc": (1, 1),
    "exp": (1, 1),
    "expm1": (1, 1),
    "gamma": (1, 1),
    "hypot": (2, 2),
    "floor": (1, 1),
    "is_empty": (1, 1),
    "join": (2, 2),
    "len": (1, 1),
    "lgamma": (1, 1),
    "log": (1, 1),
    "log10": (1, 1),
    "log1p": (1, 1),
    "log2": (1, 1),
    "lower": (1, 1),
    "max": (1, None),
    "mean": (1, 1),
    "median": (1, 1),
    "min": (1, None),
    "pow": (2, 2),
    "radians": (1, 1),
    "round": (1, 1),
    "sign": (1, 1),
    "sin": (1, 1),
    "sinh": (1, 1),
    "split": (2, 2),
    "sqrt": (1, 1),
    "starts_with": (2, 2),
    "stddev": (1, 1),
    "sum": (1, 1),
    "tan": (1, 1),
    "tanh": (1, 1),
    "trunc": (1, 1),
    "upper": (1, 1),
    "zeta": (1, 1),
}
EXPR_FUNCTION_NAMES = tuple(sorted(EXPR_FUNCTIONS))

# Not available, and not typos either. Someone writing cos(_count) knows what they meant, and
# "did you mean abs?" is worse than saying nothing.
PLANNED_EXPR_FUNCTIONS = (
    "airy",
    "besselj",
    "bessely",
    "elliptic_e",
    "elliptic_k",
    "polygamma",
)


def _nearest(needle: str, candidates: tuple[str, ...]) -> str | None:
    """The closest candidate by edit distance, or None when nothing is close enough."""

    def distance(a: str, b: str) -> int:
        prev = list(range(len(b) + 1))
        for i, ca in enumerate(a, 1):
            cur = [i]
            for j, cb in enumerate(b, 1):
                cur.append(min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (ca != cb)))
            prev = cur
        return prev[-1]

    limit = min(3, max(1, len(needle) // 2 + 1))
    best = min(candidates, key=lambda c: distance(needle, c), default=None)
    return best if best is not None and distance(needle, best) <= limit else None


SUPPORTED_UNARY = ("!", "-", "+")

# What may sit directly inside <env>.
ENV_CHILDREN = frozenset(
    {
        "sequence", "mix", "switch", "pool", "uniq", "distinct", "assert", "before", "after",
        "before_block",
        "after_block", "delimiter_block", "before_line", "after_line", "delimiter_line",
    }
)  # fmt: skip

# What may sit directly inside <sequence>: the generator(s), literal text between them, a
# <distinct> wrapper grouping fields, or a <compute> that derives the value.
SEQUENCE_CHILDREN = frozenset({"gen", "data", "distinct", "compute"})

# <distinct>/<uniq> mean two different things by position, and so hold two different sets.
# Inside a <sequence> they group the FIELDS of one record; at <env> level, whole COLUMNS.
# One list for both refuses working configs.
DISTINCT_CHILDREN = frozenset({"gen"})
ENV_GROUP_CHILDREN = frozenset({"sequence", "mix", "switch", "member"})

# Deliberately generous: too SHORT a list refuses configs that work, while too long a one
# merely leaves a little of the old silence in place.
POOL_CHILDREN = frozenset({"sequence", "mix", "switch", "uniq", "distinct", "member", "data"})

# A fixture holds literal text and <line>s.
#: A fixture body is made of ``<line>``s and nothing else.
#:
#: ``data`` used to be on this list, and every renderer only ever walks ``<line>`` — so
#: ``<before><data>x</data></before>`` validated and emitted nothing at all. The list is what the
#: "Allowed inside" note prints, so it has to say what the renderer actually does.
FIXTURE_CHILDREN = frozenset({"line"})

# What may sit directly inside <switch>.
SWITCH_CHILDREN = frozenset({"map", "case", "default"})

# What may sit directly inside <block> and <line>.
BLOCK_CHILDREN = frozenset({"line", "data"})
LINE_CHILDREN = frozenset({"data", "gen", "mix", "switch"})

FIXTURE_TAGS = frozenset(
    {
        "before", "after", "before_block", "after_block", "delimiter_block",
        "before_line", "after_line", "delimiter_line",
    }
)  # fmt: skip

# Tags refused inside <pool>, with the reason each one is refused.
FORBIDDEN_IN_POOL = {
    "block": "a pool has no output of its own — it is a table other columns read",
    "before": "fixtures describe a file, and a pool is not written to one",
    "after": "fixtures describe a file, and a pool is not written to one",
    "before_block": "fixtures describe a file, and a pool is not written to one",
    "after_block": "fixtures describe a file, and a pool is not written to one",
    "delimiter_block": "fixtures describe a file, and a pool is not written to one",
    "before_line": "fixtures describe a file, and a pool is not written to one",
    "after_line": "fixtures describe a file, and a pool is not written to one",
    "delimiter_line": "fixtures describe a file, and a pool is not written to one",
    "pool": "a pool stays a flat table — point one pool at another instead of nesting them",
}

# Measured on the reference: ~320 bytes a member with four fields.
POOL_WARN_MEMBERS = 100_000
POOL_MAX_MEMBERS = 1_000_000

# Everything a <gen> may carry, whatever its type.
# These eight are NOT here, and their absence is deliberate: seed, engine,
# version, inject belong to <env> or <tdc>; uniq to <sequence>; is to <case>;
# on to <switch>; v to <tdc>. The list was one flat union of every attribute
# name in the language, so writing any of them on a <gen> passed in silence
# while the reference refused it — a config that ran differently depending on
# which implementation you happened to use.
#: `parent=` selects which rows a whole <sequence> or <mix> builds on; a <gen> inside one is
#: already filtered by it, so on the <gen> itself nothing reads it.
_MISPLACED_GEN_PARENT = (
    "parent= selects which rows a whole <sequence> or <mix> builds on; move it there. "
    "A <gen> inside one is already filtered by it."
)

#: Attributes a <gen> may carry that are NOT pack parameters, so a pack-parameter check must not
#: mistake them for typos. They are each reported by their own rule instead — `parent=` belongs on
#: the <sequence>, and `count=`/`flag=` belong to other tags entirely.
_NOT_A_PACK_PARAM = frozenset({"parent", "count", "flag"})

GEN_ATTRS = frozenset(
    {
        "type", "value", "name", "if", "comment", "case", "mask", "order", "cycle", "repeat",
        "separator", "accumulate", "of", "plus", "reset", "op", "missing", "missing_as", "anomaly",
        "anomaly_factor",
        "anomaly_flag",
        "local", "weight", "percent", "first_zero", "include", "exclude",
        "length", "decimals", "distribution", "regex_max_length", "alphabet", "format", "from",
        "to", "oldest", "youngest", "precision", "range", "step", "weekdays", "src",
        "column", "header",
        "delimiter", "row", "base", "trend", "period", "amplitude", "noise", "points", "upper",
        "lower", "y_range", "interp", "spread", "ink_threshold", "mode", "in", "on_error",
        "timeout", "mean", "sd", "meanlog", "sdlog", "rate", "alpha", "xmin", "shape", "scale",
        "lambda", "n", "s", "beta", "min", "max", "filter", "peak_at",
    }
)  # fmt: skip

#: Which generator types actually read a given attribute. An attribute in `GEN_ATTRS` is spelled
#: correctly for SOME generator; this says whether it means anything for THIS one. Without it a
#: `min=`/`max=` on a number and a `range=` on anything but a date pass silently and are dropped.
ATTRIBUTE_OWNERS: dict[str, frozenset[str]] = {
    # A list to walk — or, on a date, a range walked instead of drawn.
    "order": frozenset({"text", "file", "date"}),
    "cycle": frozenset({"text", "file", "date"}),
    # How far each row moves. A counter's stride and a walked date range mean the same thing in
    # their own units, which is why they borrow one word.
    "step": frozenset({"date", "increment", "decrement"}),
    # The seasonal wave's highest row.
    "peak_at": frozenset({"timeseries"}),
    "weekdays": frozenset({"date"}),
    # Where the characters come from.
    "alphabet": frozenset({"symbol"}),
    # The external source and how to read it. `pattern` is here because a drawn curve is loaded
    # the same way — src="curve.svg", src="curve.png".
    "src": frozenset({"file", "http", "pattern"}),
    "column": frozenset({"file"}),
    "header": frozenset({"file"}),
    "delimiter": frozenset({"file"}),
    "row": frozenset({"file"}),
    # The network generator's own knobs.
    "in": frozenset({"http"}),
    "on_error": frozenset({"http"}),
    "timeout": frozenset({"http"}),
    # The drawn curve.
    "points": frozenset({"pattern"}),
    "upper": frozenset({"pattern"}),
    "lower": frozenset({"pattern"}),
    "y_range": frozenset({"pattern"}),
    "interp": frozenset({"pattern"}),
    "spread": frozenset({"pattern"}),
    "ink_threshold": frozenset({"pattern"}),
    # The column a whole-column construct reads, and what it does with it. On a date, `of=`
    # measures from a sibling instead of drawing, and `plus=` is the distance.
    "of": frozenset({"running", "stat", "date"}),
    "reset": frozenset({"running"}),
    "op": frozenset({"stat"}),
    "plus": frozenset({"date"}),
    # The synthetic series.
    "base": frozenset({"timeseries", "running"}),
    "trend": frozenset({"timeseries"}),
    "period": frozenset({"timeseries"}),
    "amplitude": frozenset({"timeseries"}),
    "noise": frozenset({"timeseries"}),
    # Zero-padding a numeric range.
    "first_zero": frozenset({"number"}),
    # The legacy two-date span, read by the date generator and by the `date.range` builtin
    # template. On a number it is the wrong word for value="10..99" — and silently gave single
    # digits.
    "range": frozenset({"date", "template"}),
}

#: Parameters of the named distributions. They shape the DRAW, so they mean nothing unless
#: ``distribution=`` asked for one — ``min="10" max="20"`` on a plain number is the trap this
#: catches. Gated on the attribute rather than on the type, because that is how the engine reads
#: them.
DISTRIBUTION_PARAMS = frozenset(
    {
        "mean", "sd", "meanlog", "sdlog", "rate", "alpha", "xmin", "shape", "scale",
        "min", "max", "lambda", "beta", "s", "n",
    }
)  # fmt: skip

#: The two template paths no pack backs, and the parameters each reads. A pack declares its own
#: parameters and is judged against the registry; these two would otherwise be checked by nobody,
#: and `oldst="30"` for `oldest` is the same silent failure `persent` used to be.
BUILTIN_TEMPLATE_PARAMS: dict[str, frozenset[str]] = {
    "person.b_day": frozenset({"oldest", "youngest", "format", "precision"}),
    "date.range": frozenset({"range", "format", "precision"}),
}

GEN_TYPES = frozenset(
    {
        "text", "file", "template", "number", "regex", "advanced_regex", "symbol", "date",
        "increment", "decrement", "timeseries", "pattern", "http", "pool", "running", "stat",
    }
)  # fmt: skip

# Template paths that are generators rather than pack files. No pack is named after them, so
# looking them up on disk would report a missing address for the two paths that always work.
BUILTIN_TEMPLATE_PATHS = frozenset({"person.b_day", "date.range"})

# The document versions this runtime understands.
SUPPORTED_VERSION = "0.1.0"

_INTERPOLATION = re.compile(r"\$\{\{([^}]+)}}")
_VERSION = re.compile(r"^\d+(?:\.\d+)*$")


def _gen_element(child):
    """A ``<gen>``, self-closing or open/close alike."""
    el = child.selfClosingElement() or child.openCloseElement()
    return el if el is not None and el.name.text == "gen" else None


def validate(document, base_dir: Path | None = None, packs: DataPacks | None = None):
    """Every diagnostic the config earns, in the order they were found.

    ``base_dir`` is where a relative ``src=`` resolves from — the config file's own folder.
    """
    v = _Validator(base_dir, packs)
    v.run(document)
    found = list(v.diagnostics)
    # A pack file the address scan read and could not place — TDC171. Reported after the walk
    # because the scan is what the walk's own lookups trigger: asking before it has run would
    # always find nothing.
    if packs is not None:
        found.extend(packs.header_warnings())
    return found


# The XML entities somebody writes in an expression, and what they meant. The
# config LOOKS like XML, so `filter="price &lt;= Budget"` is what a careful person
# writes. TDC does not expand entities, so the parser sees nine characters where a
# `<` was meant and reports the character it tripped over, which tells the reader
# nothing about what to change.
_XML_ENTITIES = (("&lt;", "<"), ("&gt;", ">"), ("&amp;", "&"), ("&quot;", '"'), ("&apos;", "'"))


def _xml_entity(expression: str):
    for found, means in _XML_ENTITIES:
        if found in expression:
            return found, means
    return None


# `uniq` over many rows holds the whole column in memory — say so before the run.
# A <pool> has warned since TDC234; uniq does the same thing and said nothing.
# 250 bytes a value is MEASURED (peak RSS against row count, slope over an
# eight-fold range) — see typescript/src/validator/uniq-memory.ts for the table.
_UNIQ_BYTES_PER_VALUE = 250
_UNIQ_WARN_ROWS = 100_000


def _megabytes(byte_count: int) -> str:
    mb = byte_count / 1024 / 1024
    return f"{mb / 1024:.1f} GB" if mb >= 1024 else f"{round(mb):,} MB"



# The functions that hand back a list. `at` reads one, and nothing else does today; when a
# second joins, it goes here and the check above stays put.
LIST_RETURNING_FUNCTIONS = ("split",)


def _provably_not_a_list(node) -> bool:
    """Whether a subexpression can be shown, from the text alone, never to be a list."""
    if isinstance(node, (Name, Member, Num, Str, Bool, Null)):
        return True
    if isinstance(node, Call):
        return node.name not in LIST_RETURNING_FUNCTIONS
    return False


def _bad_index_literal(node) -> str | None:
    """A written-out index that is not one, as it should read back in the message."""
    if isinstance(node, Str):
        return f'"{node.value}"'
    if isinstance(node, Num):
        value = node.value
        whole = value == int(value) if isinstance(value, float) else True
        if whole and value >= 0:
            return None
        return numbers.to_text(float(value)) if isinstance(value, float) else str(value)
    # A parser that does not fold a sign into the literal leaves a minus in front of it.
    if isinstance(node, Unary) and node.op == "-" and isinstance(node.operand, Num):
        inner = node.operand.value
        return "-" + (numbers.to_text(float(inner)) if isinstance(inner, float) else str(inner))
    return None

class _Validator:
    __slots__ = (
        "base_dir",
        "declared_names",
        "declared_order",
        "diagnostics",
        "document_regex_max_length",
        "env_count",
        "env_names",
        "finite_values",
        "locale",
        "packs",
        "pending_expressions",
        "pending_pool_filters",
        "pool_field_values",
        "pool_fields",
        "pool_member_nodes",
        "pool_references",
        "pools_read",
        "repeating_names",
        "valueless_names",
    )

    def __init__(self, base_dir: Path | None, packs: DataPacks | None) -> None:
        self.diagnostics: list[Diagnostic] = []
        self.base_dir = base_dir
        self.packs = packs
        self.document_regex_max_length = regex.DEFAULT_MAX_LENGTH
        self.locale = "en"
        # The run length from <env count="…">. Needed by checks whose answer
        # depends on SIZE rather than shape — what a uniq column costs is
        # nothing at a hundred rows and gigabytes at ten million.
        self.env_count = 0
        # Every sequence name the config declares — what an interpolation may refer to.
        self.declared_names: set[str] = set()
        self.declared_order: list[str] = []
        # Field names per <pool>, and the sequences that draw a whole member from one.
        self.pool_fields: dict[str, list[str]] = {}
        # Of those fields, the ones whose value list the config writes down, and which pools any
        # reference names at all — TDC225 and TDC231.
        self.pool_field_values: dict[str, dict[str, list[str]]] = {}
        self.pools_read: set[str] = set()
        self.pool_references: set[str] = set()
        # Names declared at the TOP level, which is what a filter= may compare against. A pool's
        # members are its own columns and share no namespace with the run's, so a pool holding an
        # `id` must not collide with the run's `id` — nor look like an ambiguity when it is none.
        self.env_names: set[str] = set()
        self.pool_member_nodes: set[int] = set()
        # Those of them that produce a list, which is what each= may walk.
        self.repeating_names: set[str] = set()
        # The compounds: every <gen> named, so the sequence is a group of fields
        # and produces no value of its own — which is what parent= filters on.
        self.valueless_names: set[str] = set()
        # Sequences whose produced values are plainly the list in their value=. Which is what lets
        # if="Gender.Mail" be caught: the dot on a plain sequence asks about a VALUE, and here the
        # values are known. Only recorded where nothing rewrites them — see _finite_text_values.
        self.finite_values: dict[str, list[str]] = {}
        # Every if= seen, where its complaint belongs in the report, and whether the builtins of
        # an each= line are in scope. The names cannot be checked as the walk passes: an
        # expression may name a sequence declared BELOW it, and the run resolves that happily.
        self.pending_expressions: list[tuple[int, str, int, int, bool]] = []
        # Every filter= seen, held back for the same reason: the column it compares against may
        # be declared BELOW the reference, and the run resolves that happily.
        # (at, expression, pool, field, other, line, column)
        self.pending_pool_filters: list[tuple[int, str, str, str, str, int, int]] = []

    def _roots(self) -> list[Path]:
        """The folders a file source may name. Absent packs mean none were configured."""
        return [] if self.packs is None else self.packs.data_roots

    def run(self, document) -> None:
        tdc = _find(document, "tdc")
        if tdc is None:
            self._error(
                "TDC001",
                "document has no <tdc> root element",
                "Wrap your configuration in a single <tdc>…</tdc> root tag.",
                1,
                0,
            )
            return

        self._check_version(tdc)
        self._check_regex_max_length(tdc)
        try:
            self.document_regex_max_length = regex.parse_max_length(
                _attrs(tdc.attr()).get("regex_max_length")
            )
        except ValueError:
            self.document_regex_max_length = regex.DEFAULT_MAX_LENGTH

        env = _find(tdc.content(), "env")
        block = _find(tdc.content(), "block")
        if block is None:
            self._error(
                "TDC002",
                "<tdc> has no <block> child — nothing to render",
                "<block> describes the layout of each generated card. Add a <block>…</block> "
                "inside <tdc>.",
                _line(tdc),
                _column(tdc),
            )

        self._check_tdc_children(tdc)
        if env is not None:
            self._check_env(env)
        if block is not None:
            self._check_block(block)

        # Two second passes, pools before expressions. Both splice their complaints back at the
        # position the attribute was found, so the report still reads top to bottom; running the
        # pool pass first is what makes the two independent — an expression's recorded position
        # is relative to the walk, and re-splicing it after another pass has inserted would need
        # that pass's shifts as well.
        self._run_pending_pool_filters()

        # Now that every name is known, the expressions can be checked — and each complaint goes
        # back where its attribute was, so the report stays in source order.
        pending, self.pending_expressions = self.pending_expressions, []
        shift = 0
        for at_index, condition, line, column, each in pending:
            before = len(self.diagnostics)
            self._check_expression_names(condition, line, column, each)
            found = self.diagnostics[before:]
            del self.diagnostics[before:]
            for offset, diagnostic in enumerate(found):
                self.diagnostics.insert(at_index + shift + offset, diagnostic)
            shift += len(found)

    # ── document ────────────────────────────────────────────────────────────────────────────

    def _check_tdc_children(self, tdc) -> None:
        """``<tdc>`` holds ``<env>`` and ``<block>``, and a self-closing spelling of either is
        refused rather than honoured in part.

        ``<env count="3" seed="demo"/>`` parses, and then every attribute on it is discarded: the
        run silently falls back to a default count on a random seed. Half-honouring it is worse
        than refusing it.
        """
        # Both containers are read by taking the FIRST of their kind, so a second one is
        # dropped whole — every sequence it declares, every line it lays out — and the run
        # finishes looking healthy while half the config produced nothing. The same silent
        # discard TDC014 refuses for the self-closing spelling, one level up. Reported on the
        # SECOND one: the first is what runs, so the second is the surprise.
        seen: dict[str, int] = {}
        for child in _elements(tdc):
            open_here = child.openCloseElement()
            name_here = open_here.name.text if open_here is not None else None
            if name_here in ("env", "block"):
                seen[name_here] = seen.get(name_here, 0) + 1
                if seen[name_here] > 1:
                    self._error(
                        "TDC270",
                        f"<tdc> holds more than one <{name_here}> — only the first is read, and "
                        "this one is discarded whole",
                        "Every sequence declared here would be missing at render time. Move "
                        "them into the first <env>."
                        if name_here == "env"
                        else "Every line laid out here would be missing from the output. Move "
                        'them into the first <block>, or use <line if="\u2026"> to switch '
                        "layouts per row.",
                        _line(open_here),
                        _column(open_here),
                    )

            self_closing = child.selfClosingElement()
            if self_closing is not None:
                name = self_closing.name.text
                if name in ("env", "block"):
                    self._error(
                        "TDC014",
                        f"<{name}/> cannot be self-closing — its attributes and children would "
                        "be ignored",
                        f"Write <{name}> … </{name}>.",
                        _line(self_closing),
                        _column(self_closing),
                    )
                    continue
                self._error(
                    "TDC010",
                    f'unknown child of <tdc>: "<{name}>"',
                    "Allowed children: env, block.",
                    _line(self_closing),
                    _column(self_closing),
                )
                continue
            open_el = child.openCloseElement()
            if open_el is not None and open_el.name.text not in TDC_CHILDREN:
                self._error(
                    "TDC010",
                    f'unknown child of <tdc>: "<{open_el.name.text}>"',
                    "Allowed children: env, block.",
                    _line(open_el),
                    _column(open_el),
                )

    def _check_version(self, tdc) -> None:
        self._check_closed_tag_attrs("tdc", tdc.attr(), _line(tdc), _column(tdc))
        attrs = _attrs(tdc.attr())
        version_attr = attrs.get("version")
        short_attr = attrs.get("v")

        if version_attr is not None and short_attr is not None:
            self._error(
                "TDC003",
                'both "version" and "v" are present on <tdc>',
                "Use one of them. They mean the same thing.",
                _line(tdc),
                _column(tdc),
            )
            return
        raw = version_attr if version_attr is not None else short_attr
        if raw is None:
            return

        key = "version" if version_attr is not None else "v"
        # Any dot-separated numeric version: "0.1", "0.1.0", "1.2.3". Insisting on exactly two
        # parts would reject the version this runtime itself declares.
        if not _VERSION.match(raw.strip()):
            line, column = _at(tdc, key)
            self._error(
                "TDC004",
                f'invalid TDC document version "{raw}"',
                'Use dot-separated numeric versions, e.g. "0.1", "0.1.0", or "1.2.3".',
                line,
                column,
            )
            return
        # A document from the future may use tags this runtime has never heard of, and rendering
        # it as best we can would produce data that is quietly missing whatever it did not
        # understand.
        if _compare_versions(raw, SUPPORTED_VERSION) > 0:
            line, column = _at(tdc, key)
            self._error(
                "TDC005",
                f'document version "{raw}" is newer than this runtime supports '
                f"({SUPPORTED_VERSION})",
                "Update the library, or lower the version attribute.",
                line,
                column,
            )

    def _check_regex_max_length(self, tdc) -> None:
        raw = _attrs(tdc.attr()).get("regex_max_length")
        if raw is None:
            return
        try:
            if int(raw.strip()) <= 0:
                raise ValueError
        except ValueError:
            line, column = _at(tdc, "regex_max_length")
            self._error(
                "TDC096",
                f'regex_max_length must be a positive integer, got "{raw}"',
                "It caps how long a generated regex value may be.",
                line,
                column,
            )

    # ── env ─────────────────────────────────────────────────────────────────────────────────

    # ── a share below one whole row ─────────────────────────────────────────────────────────

    def _check_small_shares(self, env) -> None:
        """``percent`` is an exact quota over the rows that reach it, not a chance per row.

        Ten percent of a five-row subset asks for HALF a record, and half a record cannot be
        emitted — so the branch produces one or none and the seed alone decides which. The engine
        rounds and says nothing, which is how a column that came out empty reads as a config that
        was never written rather than one that rounded away.

        The denominator is knowable for the shapes people write: ``count`` at the top of ``<env>``,
        ``count`` x a parent's share, or ``count`` x the share a ``<switch>`` branch matches. Where
        the subject writes no shares of its own this stays SILENT — a check that guessed would fire
        on working configs and be turned off.
        """
        if self.env_count <= 0:
            return
        shares: dict[str, dict[str, float]] = {}

        for child in _elements(env):
            inner = child.openCloseElement()
            if inner is None:
                continue
            name = inner.name.text
            if name == "sequence":
                self._read_sequence_shares(inner, shares)
            elif name == "mix":
                rows = self._rows_of(_attrs(inner.attr()).get("parent"), shares)
                self._report_thin(inner, self._branch_count(inner), rows)
            elif name == "switch":
                self._read_switch_shares(inner, shares)

    def _read_sequence_shares(self, seq, shares: dict[str, dict[str, float]]) -> None:
        """Record what a sequence's values are worth, and check its own share."""
        seq_attrs = _attrs(seq.attr())
        rows = self._rows_of(seq_attrs.get("parent"), shares)

        gens = [g for g in _child_elements(seq) if g is not None and _element_name(g) == "gen"]
        if len(gens) != 1:
            return
        gen = gens[0]
        attrs = _attrs(gen.attr())
        if attrs.get("type") != "text":
            return

        values = [v.strip() for v in (attrs.get("value") or "").split(",") if v.strip()]
        mask = attrs.get("percent")
        if not values or mask is None:
            return
        percents = self._safe_expand(mask, len(values))
        if percents is None:
            return

        name = seq_attrs.get("name")
        if name and rows is not None:
            shares[name] = {
                value: percent / 100 for value, percent in zip(values, percents, strict=False)
            }

        self._report_thin(gen, len(values), rows)

    def _read_switch_shares(self, switch, shares: dict[str, dict[str, float]]) -> None:
        """Each ``<case is="X">``, with the rows that value takes."""
        subject = _attrs(switch.attr()).get("on")
        table = shares.get(subject) if subject is not None else None
        if not table:
            return

        for case in _child_elements(switch):
            if _element_name(case) != "case":
                continue
            is_value = _attrs(case.attr()).get("is")
            if is_value is None:
                continue
            # `is="US|CA"` matches either, so the branch takes both their shares.
            fraction = 0.0
            for key in (k.strip() for k in is_value.split("|")):
                if key not in table:
                    break
                fraction += table[key]
            else:
                for inner in _child_elements(case):
                    if _element_name(inner) == "mix":
                        self._report_thin(
                            inner, self._branch_count(inner), self.env_count * fraction
                        )

    @staticmethod
    def _branch_count(mix) -> int:
        return sum(1 for el in _child_elements(mix) if _element_name(el) == "case")

    def _rows_of(self, parent: str | None, shares: dict[str, dict[str, float]]) -> float | None:
        """Rows reaching something with this ``parent``, or None when it cannot be resolved."""
        if parent is None or not parent.strip():
            return float(self.env_count)
        at = parent.find(".")
        if at < 0:
            return None
        share = shares.get(parent[:at], {}).get(parent[at + 1 :])
        return None if share is None else self.env_count * share

    @staticmethod
    def _safe_expand(mask: str, values: int) -> list[float] | None:
        """The mask, or None when it does not parse — somebody else's diagnostic."""
        try:
            return percent_mask.expand(mask, values)
        except Exception:  # any parse failure means "not ours to report"
            return None

    def _report_thin(self, el, branches: int, rows: float | None) -> None:
        """Report the smallest share that asks for less than a row, once per element."""
        if rows is None or rows <= 0 or branches <= 0:
            return
        own = _attrs(el.attr())
        mask = own.get("percent")
        if mask is None:
            return
        # `repeat=` plans the quota over ELEMENTS, not rows: three per row over four rows is
        # twelve draws, and `repeat="1..3"` does not even fix how many. Rows is the wrong
        # denominator here, so say nothing.
        if (own.get("repeat") or "").strip():
            return
        percents = self._safe_expand(mask, branches)
        if percents is None:
            return

        worst: float | None = None
        for percent in percents:
            if percent <= 0:  # a zero share asks for nothing on purpose
                continue
            if percent / 100 * rows >= 1:
                continue
            if worst is None or percent < worst:
                worst = percent
        if worst is None:
            return

        line, column = _line(el), _column(el)
        self._warn(
            "TDC251",
            f'percent="{_two_places(worst)}" over {_two_places(rows)} rows asks for '
            f"{_two_places(worst / 100 * rows)} records — the result is 0 or 1, and the seed "
            "decides which",
            "A share below one whole row cannot be emitted, so the branch fires once or not at "
            "all. Raise the share, or raise count= until the share covers a whole row.",
            line,
            column,
        )

    def _check_env(self, env) -> None:
        env_attrs = _attrs(env.attr())
        self.locale = env_attrs.get("local", "en")

        count = env_attrs.get("count")
        if count is not None:
            try:
                if int(count.strip()) < 0:
                    raise ValueError
                self.env_count = int(count.strip())
            except ValueError:
                line, column = _at(env, "count")
                self._error(
                    "TDC020",
                    f'invalid count "{count}" — expected a non-negative integer',
                    "count is how many records to generate.",
                    line,
                    column,
                )

        inject = env_attrs.get("inject")
        if inject is not None and "%" not in inject:
            line, column = _at(env, "inject")
            self._error(
                "TDC021",
                f'inject pattern "{inject}" has no "%" placeholder — interpolation will never '
                "match",
                'Use a single "%" where the sequence name should go, e.g. inject="${{%}}".',
                line,
                column,
            )

        # A share below one whole row: its own pass, because the denominator of a <mix> in a
        # switch branch belongs to the switch and not to the walk that follows.
        self._check_small_shares(env)

        self._check_children(env.content(), "env", ENV_CHILDREN)
        self._check_asserts(env)
        # A fixture holds text and <line>s. Anything else was ignored in silence unless
        # it happened to be a generator inside a <line>.
        for child in _elements(env):
            inner = child.openCloseElement()
            if inner is not None and inner.name.text in FIXTURE_TAGS:
                self._check_children(inner.content(), inner.name.text, FIXTURE_CHILDREN, "TDC131")
        self._check_closed_tag_attrs("env", env.attr(), _line(env), _column(env))

        names: set[str] = set()
        declared: list[str] = []
        # The same list object, reachable from the per-gen checks: `of=` on a running total
        # takes the declaration-order rule, and the gen check is too deep to be handed it.
        self.declared_order = declared

        for open_el in self._declarations(env):
            tag = open_el.name.text
            self._check_closed_tag_attrs(tag, open_el.attr(), _line(open_el), _column(open_el))
            attrs = _attrs(open_el.attr())
            name = attrs.get("name")
            if name is None or not name.strip():
                self._error(
                    "TDC030",
                    f'<{tag}> is missing a required "name" attribute',
                    "A sequence is referenced by name, so it needs one.",
                    _line(open_el),
                    _column(open_el),
                )
            elif checks.is_builtin(name):
                line, column = _at(open_el, "name")
                self._error(
                    "TDC033",
                    f'sequence name "{name}" collides with a builtin',
                    f"Builtins: {', '.join(sorted(checks.BUILTINS))}.",
                    line,
                    column,
                )
            elif name.startswith("_"):
                # The leading underscore is the engine's namespace. Letting a config into it means
                # a future builtin would silently shadow somebody's column.
                line, column = _at(open_el, "name")
                self._error(
                    "TDC031",
                    f'sequence name "{name}" starts with "_" — reserved for builtins',
                    "User sequences should avoid the leading underscore.",
                    line,
                    column,
                )
            elif name in names and not (
                id(open_el) in self.pool_member_nodes or name not in self.env_names
            ):
                line, column = _at(open_el, "name")
                self._error(
                    "TDC032",
                    f'duplicate sequence name "{name}"',
                    "Two sequences cannot share a name — the second would shadow the first.",
                    line,
                    column,
                )
            else:
                names.add(name)

            # Declaration order decides who can filter whom: a parent must already exist, because
            # the rows it selects are what the child is built over.
            parent = attrs.get("parent")
            if parent is not None and parent.strip():
                parent_name = parent.split(".", 1)[0] if "." in parent else parent
                line, column = _at(open_el, "parent")
                if not parent_name:
                    self._error(
                        "TDC034",
                        f'invalid parent reference "{parent}"',
                        'Syntax: parent="ParentName" or parent="ParentName.Value".',
                        line,
                        column,
                    )
                elif parent_name not in declared:
                    self._error(
                        "TDC035",
                        f'parent sequence "{parent_name}" is not declared before this sequence',
                        "Move the parent above it. A child is built over the rows its parent "
                        "selected.",
                        line,
                        column,
                    )
                elif parent_name in self.valueless_names:
                    # A parent selects rows by the VALUE it produced. A compound is a group of
                    # fields and produces none, so no row can ever match — the run used to
                    # discover that and report the parent as unknown, sending the reader after a
                    # name that is declared right above.
                    self._error(
                        "TDC214",
                        f'compound sequence "{parent_name}" has no value of its own to filter on',
                        'A parent is chosen by the value it produced, e.g. parent="Gender.Male". '
                        f'"{parent_name}" is a group of fields and produces none — name one of '
                        "its fields, or a sequence that has a single value.",
                        line,
                        column,
                    )

            if tag == "switch":
                self._check_switch(open_el, declared)
            elif tag == "mix":
                self._check_mix(open_el, True)
            elif tag == "sequence":
                self._check_uniq_memory(open_el, name)
                self._check_sequence_body(open_el, name)
                self._check_sequence_data_attrs(open_el)
                self._check_compute_body(open_el)
            for inner in _elements(open_el):
                self._check_gens_in(inner)

            if name is not None and name.strip():
                declared.append(name)
                self.declared_names.add(name)
                if id(open_el) not in self.pool_member_nodes:
                    self.env_names.add(name)
                # A reference to a <pool> publishes the pool's fields under its own name, so
                # `${{Doctor.lastName}}` is a field of the sequence `Doctor` exactly as it would
                # be for a compound. That one registration is what lets every later name check
                # work on a pool while knowing nothing about pools.
                self._register_pool_reference(open_el, name)
                # A compound's fields are referenced as Name.Field, and a flag column is a name
                # too. Fields inside a <distinct> wrapper are ordinary fields, so they count.
                self._collect_field_names(open_el, name)
                for key in ("flag", "anomaly_flag"):
                    value = attrs.get(key)
                    if value is not None and value.strip():
                        self.declared_names.add(value)

    def _register_pool_reference(self, sequence, name: str) -> None:
        """Publish ``Ref.field`` for a ``<gen type="pool">``, and check what it names."""
        for child in _elements(sequence):
            gen = child.selfClosingElement() or child.openCloseElement()
            if gen is None or gen.name.text != "gen":
                continue
            attrs = _attrs(gen.attr())
            if attrs.get("type") != "pool":
                continue
            pool_name = (attrs.get("value") or "").strip()
            if pool_name not in self.pool_fields:
                declared = ", ".join(sorted(self.pool_fields))
                self._error(
                    "TDC224",
                    f'<gen type="pool"> draws from "{pool_name}", which is not a declared pool',
                    'Declare it first: <pool name="…" count="…"> inside the same <env>.'
                    if not self.pool_fields
                    else f"Declared pools: {declared}.",
                    _line(gen),
                    _column(gen),
                )
                continue
            fields = self.pool_fields[pool_name]
            self._check_pool_filter(gen, pool_name, fields, attrs)
            for field_name in fields:
                self.declared_names.add(f"{name}.{field_name}")
            # The reference itself is a record, not a value: it has nothing to print.
            self.valueless_names.add(name)
            self.pool_references.add(name)

    def _check_pool_filter(self, gen, pool_name: str, fields: list[str], attrs) -> None:
        """What ``filter=`` may name.

        A qualified ``Pool.field`` says exactly what it means, so a field the pool has not got is
        a certain mistake. An UNQUALIFIED unknown name is deliberately left alone: the expression
        language reads a bare word as a string literal, which is how ``filter="c == North"`` says
        "northern only". Reporting those would put an error on a working config.
        """
        expression = attrs.get("filter")
        if expression is None or not expression.strip():
            return
        for match in re.finditer(r"([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)", expression):
            if match.group(1) != pool_name or match.group(2) in fields:
                continue
            listed = ", ".join(fields)
            self._error(
                "TDC226",
                f'filter= reads "{match.group(0)}", but pool "{pool_name}" has no field '
                f'"{match.group(2)}"',
                f'Pool "{pool_name}" declares no fields.'
                if not fields
                else f'Fields of "{pool_name}": {listed}.',
                _line(gen),
                _column(gen),
            )
        seen: set[str] = set()
        for match in re.finditer(r"[A-Za-z_][A-Za-z0-9_]*", expression):
            word = match.group(0)
            if word in seen:
                continue
            seen.add(word)
            if word not in fields or word not in self.env_names:
                continue
            self._error(
                "TDC232",
                f'"{word}" in filter= is both a field of pool "{pool_name}" and a sequence — '
                "which one is meant is not decidable",
                f'Rename one of them. Qualifying one side ("{pool_name}.{word}") does not help: '
                f'the other "{word}" still reads as the member\'s field, so the test would '
                "compare a value with itself.",
                _line(gen),
                _column(gen),
            )

        # `field == Something` — the one filter shape a check can decide, recognised the same way
        # the engine's fast path recognises it, by looking at the text rather than a parsed tree,
        # so what the reader sees and what is checked are the same thing.
        parts = expression.split("==")
        if len(parts) != 2:
            return
        left, right = parts[0].strip(), parts[1].strip()
        if not _PLAIN_NAME.fullmatch(left) or not _PLAIN_NAME.fullmatch(right):
            return
        left_is_field, right_is_field = left in fields, right in fields
        # Both sides a field compares the candidate with itself, which is a different mistake.
        if left_is_field == right_is_field:
            return
        field, other = (left, right) if left_is_field else (right, left)
        self.pending_pool_filters.append(
            (
                len(self.diagnostics),
                expression.strip(),
                pool_name,
                field,
                other,
                _line(gen),
                _column(gen),
            )
        )

    def _run_pending_pool_filters(self) -> None:
        """The put-aside filters, decided now that every column is known.

        What can be said before a single value exists: the member's field and the other side of
        the ``==`` each draw from a set the config writes down, and when those two sets do not
        overlap the filter can never match — not on some row, on every row. The run already
        refuses that, on row one, after building the pool; saying it at check time costs nothing
        and names both lists.

        Only DISJOINT sets are reported. A value that is merely rare is a refusal waiting for the
        row that draws it, and reporting it here would also refuse ``percent="100,0"``, which
        never draws that value at all. The run-time message names the value that matched nobody,
        which is the honest place to say it.
        """
        pending, self.pending_pool_filters = self.pending_pool_filters, []
        shift = 0
        for at_index, expression, pool_name, field, other, line, column in pending:
            field_values = self.pool_field_values.get(pool_name, {}).get(field)
            if not field_values:
                continue
            # A name no sequence has is a bare word, and the expression language reads a bare word
            # as its own text — that is how filter="clinic == North" says "northern only". So it
            # is a set of exactly one value.
            is_column = other in self.declared_names
            other_values = self.finite_values.get(other) if is_column else [other]
            if not other_values:
                continue
            if any(value in field_values for value in other_values):
                continue
            listed = ", ".join(field_values)
            produced = f'"{other}" produces: {", ".join(other_values)}. ' if is_column else ""
            diagnostic = Diagnostic.error(
                "TDC225",
                (
                    f'filter="{expression}" can never match — no value "{other}" produces is a '
                    f'"{field}" any member of pool "{pool_name}" could hold'
                    if is_column
                    else f'filter="{expression}" can never match — no member of pool '
                    f'"{pool_name}" holds "{field}" = "{other}"'
                ),
                f'"{field}" is drawn from: {listed}. {produced}A filter narrows the members '
                "a row may draw from, and every row would be left with none.",
                line,
                column,
            )
            self.diagnostics.insert(at_index + shift, diagnostic)
            shift += 1

    def _collect_pool_fields(self, env) -> None:
        """Field names per pool, gathered before the members are walked.

        A pre-pass rather than a running tally, so a reference is understood wherever it stands.
        A validator that only reported "unknown field" for a pool written at the bottom of the
        file would be reporting a problem the author does not have.
        """
        self.pool_fields = {}
        for child in _elements(env):
            open_el = child.openCloseElement()
            if open_el is None or open_el.name.text != "pool":
                continue
            name = _attrs(open_el.attr()).get("name")
            if not name:
                continue
            fields: list[str] = []
            for member in _elements(open_el):
                inner = member.openCloseElement()
                if inner is None:
                    continue
                tag = inner.name.text
                if tag in ("sequence", "mix", "switch"):
                    self._add_member_fields(fields, inner)
                elif tag in ("uniq", "distinct"):
                    for wrapped_el in _elements(inner):
                        wrapped = wrapped_el.openCloseElement()
                        if wrapped is None:
                            continue
                        self._add_member_fields(fields, wrapped)
            self.pool_fields[name] = fields

    def _collect_pool_field_values(self, env) -> None:
        """The values each pool field can hold, where the config says them outright.

        A member whose body is one unnamed ``<gen type="text" value="A,B">`` produces nothing but
        ``A`` and ``B``, so the set recorded here is a SUPERSET of what the built pool will hold —
        a pool of two members drawn from three values holds at most two of them. That direction is
        what TDC225 needs: a value outside the superset can match no member, whatever the draw.
        """
        self.pool_field_values = {}
        for child in _elements(env):
            open_el = child.openCloseElement()
            if open_el is None or open_el.name.text != "pool":
                continue
            name = _attrs(open_el.attr()).get("name")
            if not name:
                continue
            fields: dict[str, list[str]] = {}
            for member in _pool_member_nodes(open_el):
                field = _attrs(member.attr()).get("name")
                if not field:
                    continue
                values = _literal_text_values(member)
                if values is not None:
                    fields[field] = values
            self.pool_field_values[name] = fields

    def _collect_pool_references(self, env) -> None:
        """Every pool named by a ``<gen type="pool" value="…">``, anywhere under ``<env>``.

        Collected in one descent rather than tallied during the walk, because a reference may
        stand above the pool it names and TDC231 has to know about it by the time that pool is
        reached.
        """
        self.pools_read = set()

        def descend(node) -> None:
            for child in _elements(node):
                gen = child.selfClosingElement() or child.openCloseElement()
                if gen is None:
                    continue
                if gen.name.text == "gen":
                    attrs = _attrs(gen.attr())
                    if attrs.get("type") == "pool":
                        self.pools_read.add((attrs.get("value") or "").strip())
                    continue
                if child.openCloseElement() is not None:
                    descend(gen)

        descend(env)

    def _check_pool_is_read(self, pool) -> None:
        """A pool nobody draws from.

        A warning rather than an error, on the same reasoning as TDC234: the config runs, and
        every row is exactly what it would have been. What it costs is the build — a pool is
        computed in full before the first row and held in memory for the whole run — so an unread
        ``count="50000"`` is paid for and thrown away. It is also the shape a rename leaves
        behind, where the reference points at a new pool and the old one sits there looking
        deliberate.
        """
        name = _attrs(pool.attr()).get("name")
        if name is None or not name.strip() or name in self.pools_read:
            return
        self._warn(
            "TDC231",
            f'pool "{name}" is never drawn from',
            "A pool is built in full before the first row and kept in memory for the whole run, "
            "so an unread one costs its members for nothing. Read it with "
            f'<gen type="pool" value="{name}"/>, or remove it.',
            _line(pool),
            _column(pool),
        )

    def _add_member_fields(self, fields: list[str], node) -> None:
        """What one member contributes to its pool's field list.

        Usually its own name. A member that is itself a reference to another pool contributes
        that pool's fields under its name instead — ``at`` pointing at ``Clinics`` gives
        ``at.city`` and no bare ``at``, because a record has no value to print. Only pools
        declared ABOVE are visible, which is exactly what the engine can compute.
        """
        name = _attrs(node.attr()).get("name")
        if not name:
            return
        target = _member_pool_ref(node)
        nested = None if target is None else self.pool_fields.get(target)
        if nested is None:
            fields.append(name)
            return
        for field in nested:
            fields.append(f"{name}.{field}")

    def _check_pool_member_refs(self, pool, above: list[str]) -> None:
        """A member that draws from another pool may only name a pool declared ABOVE.

        The engine builds pools in declaration order, so this is not a style rule: a pool named
        below has no table yet, and a pool naming itself never would. Both used to validate and
        produce a member with no fields, which surfaced far away as "not a field of R" — blaming
        the line that reads for a mistake in the declaration. Declaration order is also the
        entire cycle check: a cycle cannot be written down.
        """
        pool_name = _attrs(pool.attr()).get("name") or ""
        for member in _pool_member_nodes(pool):
            target = _member_pool_ref(member)
            if target is None or target in above:
                continue
            itself = target == pool_name
            if itself:
                message = f'pool "{pool_name}" draws from itself'
                hint = "A pool is built before its own members exist, so there is nothing to draw. "
            else:
                message = (
                    f'pool "{pool_name}" draws from "{target}", which is not declared above it'
                )
                hint = (
                    "Pools are built in declaration order, so a pool can only read the pools "
                    f'above it. Move "{target}" above "{pool_name}". '
                )
            self._error(
                "TDC236",
                message,
                hint + "That order is also why a cycle between pools cannot be written down.",
                _line(member),
                _column(member),
            )

    def _check_pool(self, node) -> None:
        """A ``<pool>``'s own attributes and the tags it may hold.

        What is inside a legal child is NOT checked here — the caller walks the body with the same
        checks it uses on ``<env>``, which is the whole point of the construct.
        """
        attrs = _attrs(node.attr())
        line, column = _line(node), _column(node)
        name = attrs.get("name")
        if name is None or not name.strip():
            self._error(
                "TDC222",
                "<pool> has no name",
                'A pool is read by name: <pool name="Doctors" count="30">, then '
                '<gen type="pool" value="Doctors"/>.',
                line,
                column,
            )
        raw = attrs.get("count")
        if raw is None or not raw.strip():
            shown = f' name="{name}"' if name else ""
            self._error(
                "TDC222",
                f"<pool{shown}> has no count",
                "count is how many members the table holds — thirty doctors for two thousand "
                'patients: count="30".',
                line,
                column,
            )
        else:
            try:
                count = int(raw.strip())
                ok = count >= 1
            except ValueError:
                count, ok = 0, False
            if not ok:
                self._error(
                    "TDC223",
                    f'<pool> count "{raw}" is not a whole number of members',
                    "Use a whole number of at least 1 — a pool of nothing has no member to hand "
                    "out.",
                    line,
                    column,
                )
            elif count > POOL_MAX_MEMBERS:
                self._error(
                    "TDC235",
                    f"<pool> holds {count:,} members — more than the {POOL_MAX_MEMBERS:,} a pool "
                    "may hold",
                    "A pool is kept in memory for the whole run (measured: ~320 bytes a member "
                    "with four fields), so this would cost hundreds of megabytes before the first "
                    "row. If you meant the number of ROWS, that is count on <env>.",
                    line,
                    column,
                )
            elif count > POOL_WARN_MEMBERS:
                self._warn(
                    "TDC234",
                    f"<pool> holds {count:,} members and stays in memory for the whole run",
                    "Measured at ~320 bytes a member with four fields — 100,000 members cost "
                    "about 29 MB. It works; it is worth being deliberate about. If you meant the "
                    "number of ROWS, that is count on <env>.",
                    line,
                    column,
                )

        # Neither branch below said anything about a name it did not know, and the
        # open/close-only test meant a self-closing invention was not even looked at.
        # Tags with a reason of their own keep TDC230, which says far more.
        self._check_children(
            node.content(),
            "pool",
            POOL_CHILDREN | frozenset(FORBIDDEN_IN_POOL),
            shown=POOL_CHILDREN,
        )
        for child in _elements(node):
            inner = child.openCloseElement()
            if inner is None:
                continue
            reason = FORBIDDEN_IN_POOL.get(inner.name.text)
            if reason is None:
                continue
            self._error(
                "TDC230",
                f"<{inner.name.text}> cannot live inside a <pool>",
                f"{reason}.",
                _line(inner),
                _column(inner),
            )

    def _declarations(self, env) -> list:
        """Every sequence-like declaration in ``<env>``, in the order they appear.

        A ``<uniq>`` or ``<distinct>`` wrapper is not a declaration of its own — it says what must
        hold BETWEEN the sequences inside it. So its children are flattened into the same list, and
        each is checked, named and ordered exactly as if it had been written directly under
        ``<env>``. Anything else would make wrapping a sequence change what the sequence is.
        """
        out = []
        self._collect_pool_fields(env)
        self._collect_pool_field_values(env)
        self._collect_pool_references(env)
        pools_above: list[str] = []
        for child in _elements(env):
            open_el = child.openCloseElement()
            if open_el is None:
                continue
            tag = open_el.name.text
            if tag in ("sequence", "mix", "switch"):
                out.append(open_el)
            elif tag == "pool":
                # The pool node itself is not a declaration, so the env walk never reached its
                # attributes — every one of them, including a typo, used to pass in silence.
                self._check_closed_tag_attrs(
                    "pool", open_el.attr(), _line(open_el), _column(open_el)
                )
                self._check_pool(open_el)
                # Only the pools ALREADY seen: a member may draw from one of those and from
                # nothing else, which is what makes a cycle unwritable.
                self._check_pool_member_refs(open_el, pools_above)
                declared_pool = _attrs(open_el.attr()).get("name")
                if declared_pool and declared_pool in pools_above:
                    # Two pools under one name: the second quietly replaced the first, and
                    # the only sign was a TDC193 in the block about a field that "does not
                    # exist".
                    self._error(
                        "TDC241",
                        f'duplicate pool name "{declared_pool}"',
                        "A pool is reached by name, so two of them cannot share one. "
                        "Rename or remove the second.",
                        _line(open_el),
                        _column(open_el),
                    )
                elif declared_pool:
                    pools_above.append(declared_pool)
                self._check_pool_is_read(open_el)
                # A pool's members are ITS columns, not the run's: they must see each other while
                # the pool is walked and be gone afterwards, or a pool holding an `id` collides
                # with the run's own `id` over a clash that does not exist.
                outer = set(self.declared_names)
                for member_el in _elements(open_el):
                    member = member_el.openCloseElement()
                    if member is None:
                        continue
                    if member.name.text in ("sequence", "mix", "switch"):
                        self.pool_member_nodes.add(id(member))
                        out.append(member)
                    elif member.name.text in ("uniq", "distinct"):
                        wrapped_count = 0
                        for wrapped_el in _elements(member):
                            wrapped = wrapped_el.openCloseElement()
                            if wrapped is None:
                                continue
                            if wrapped.name.text in ("sequence", "mix", "switch"):
                                wrapped_count += 1
                                self.pool_member_nodes.add(id(wrapped))
                                out.append(wrapped)
                        self._check_group_size(member, member.name.text, wrapped_count)
                del outer
            elif tag in ("uniq", "distinct"):
                self._check_closed_tag_attrs(tag, open_el.attr(), _line(open_el), _column(open_el))
                members = 0
                for inner in _elements(open_el):
                    wrapped = inner.openCloseElement()
                    if wrapped is None:
                        continue
                    inner_tag = wrapped.name.text
                    # A <mix> or <switch> inside the group is a member and a declaration both:
                    # checked and named exactly as at the top level, or the name never exists and
                    # every reference to it reads as undeclared.
                    if inner_tag in ("mix", "switch"):
                        members += 1
                        out.append(wrapped)
                    elif inner_tag == "sequence":
                        members += 1
                        self._check_env_group_member(wrapped, tag)
                        out.append(wrapped)
                self._check_group_size(open_el, tag, members)
        return out

    def _check_group_size(self, wrapper, tag: str, members: int) -> None:
        """A group of fewer than two sequences constrains nothing.

        It used to be dropped in silence: ``check`` called the config valid and the run drew
        repeats anyway. A warning rather than an error — the config still runs, it just does not do
        what it was written for.
        """
        if members >= 2:
            return
        if tag == "uniq":
            hint = (
                "Put at least two <sequence> members in it, or drop the wrapper and write "
                'uniq="true" on the one sequence — that draws without replacement.'
            )
        else:
            hint = (
                "Put at least two <sequence> members in it, or drop the wrapper: there is nothing "
                "for a single value to differ from."
            )
        counted = "no sequences" if members == 0 else "one sequence"
        self._warn(
            "TDC221",
            f"<{tag}> wraps {counted} — a group constrains its members against each other, so it "
            "does nothing here",
            hint,
            _line(wrapper),
            _column(wrapper),
        )

    def _check_asserts(self, env) -> None:
        """``<assert that="…" says="…"/>`` — the two attributes it cannot do without.

        An assertion is the one construct whose whole worth is that it FAILS, so a half-written
        one is worse than none: the config carries a check, the reader believes the run was
        verified, and nothing was ever compared.

        The expression is not re-checked here. ``that=`` is the ``if=`` language, so it takes the
        same syntax pass now and the same put-aside name pass once every sequence is known — a
        typo in a column name is reported exactly as it is in ``if=``, because it IS that mistake.
        """
        for child in _elements(env):
            self_closing = child.selfClosingElement()
            if self_closing is None or self_closing.name.text != "assert":
                continue
            # A self-closing tag is not reached by the walk that checks closed-tag
            # attributes, so an unknown one on <assert> would pass in silence.
            self._check_closed_tag_attrs(
                "assert", self_closing.attr(), _line(self_closing), _column(self_closing)
            )
            attrs = _attrs(self_closing.attr())
            that = (attrs.get("that") or "").strip()
            says = (attrs.get("says") or "").strip()
            if not that:
                line, column = _at_attrs(
                    self_closing.attr(), "that", _line(self_closing), _column(self_closing)
                )
                self._error(
                    "TDC265",
                    "<assert> has no condition — that= is required",
                    "Write the property the run must have, in the if= language, over whole-run "
                    'columns: <assert that="Rows == 700" says="…"/>. The numbers come from '
                    "<gen type=\"stat\">.",
                    line,
                    column,
                )
                continue
            if not says:
                line, column = _at_attrs(
                    self_closing.attr(), "says", _line(self_closing), _column(self_closing)
                )
                self._error(
                    "TDC266",
                    f'<assert that="{that}"> has no message — says= is required',
                    "When this fails, says= is what the reader is told. An expression alone "
                    "leaves them to work out what it was for, months later, in a CI log.",
                    line,
                    column,
                )
            where = _at_attrs(
                self_closing.attr(), "that", _line(self_closing), _column(self_closing)
            )
            self._check_if_expression(that, where[0], where[1])
            self.pending_expressions.append(
                (len(self.diagnostics), that, where[0], where[1], False)
            )

    def _check_env_group_member(self, sequence, tag: str) -> None:
        """A member of an env-level group has to produce one value per row.

        The constraint is stated BETWEEN sequences, so a compound has no single value to compare
        or to make unique. Refusing is the only honest answer: silently using its first field would
        enforce something the config did not ask for.
        """
        named = 0
        total = 0
        for child in _elements(sequence):
            self_closing = child.selfClosingElement()
            if self_closing is not None and self_closing.name.text == "gen":
                total += 1
                if _attrs(self_closing.attr()).get("name") is not None:
                    named += 1
        if named > 0 or total > 1:
            name = _attrs(sequence.attr()).get("name") or "?"
            self._error(
                "TDC129",
                f'<sequence name="{name}"> inside a config-level <{tag}> must produce a single '
                "value",
                f"A <{tag}> around sequences uses one value per sequence. Use a simple <gen> or a "
                "<switch> sequence, not a compound (multi-field) one.",
                _line(sequence),
                _column(sequence),
            )

    def _check_compute_body(self, sequence) -> None:
        """A ``<compute>`` sequence's tree, checked against everything declared so far.

        Its ``<field>`` references can only name a sequence that already exists — the value is
        derived from the row, and a row is built in declaration order.
        """
        for child in _elements(sequence):
            open_el = child.openCloseElement()
            if open_el is None or open_el.name.text != "compute":
                continue
            known = set(self.declared_names) | set(checks.BUILTINS)
            ComputeCheck(self.diagnostics).check(open_el, known)

    def _collect_field_names(self, element, name: str) -> None:
        """``Name.Field`` registered for every field, wherever in the sequence body it sits."""
        for child in _elements(element):
            # A named <data> is a constant field and a real column, so a reference to it must not
            # read as a typo for a sequence nobody declared.
            data = child.dataElement()
            if data is not None:
                if hasattr(data, "attr"):
                    constant = _attrs(data.attr()).get("name")
                    if constant and constant.strip():
                        self.declared_names.add(f"{name}.{constant}")
                continue
            self_closing = child.selfClosingElement()
            if self_closing is not None and self_closing.name.text == "gen":
                gen_attrs = _attrs(self_closing.attr())
                field = gen_attrs.get("name")
                if field is not None and field.strip():
                    self.declared_names.add(f"{name}.{field}")
                # anomaly_flag= sits on the <gen>, not on the <sequence>, and names a real column
                # — referencing it must not read as a typo for a sequence nobody declared.
                gen_flag = gen_attrs.get("anomaly_flag")
                if gen_flag is not None and gen_flag.strip():
                    self.declared_names.add(gen_flag)
                try:
                    if checks.has_repeat(gen_attrs):
                        self.repeating_names.add(name)
                except ValueError:
                    pass  # A malformed repeat is _check_repeat's business, not this pass's.
                continue
            inner = child.openCloseElement()
            if inner is not None and inner.name.text == "distinct":
                self._collect_field_names(inner, name)

    def _check_uniq_memory(self, open_el, name: str | None) -> None:
        """Size, not shape: what a uniq column will COST at this run length."""
        if _attrs(open_el.attr()).get("uniq", "").strip().lower() != "true":
            return
        if self.env_count < _UNIQ_WARN_ROWS:
            return
        self._warn(
            "TDC236",
            f'uniq on "{name or "?"}" holds all {self.env_count:,} values in memory '
            f"for the whole run — about {_megabytes(self.env_count * _UNIQ_BYTES_PER_VALUE)}",
            "Drawing without replacement means remembering what has been drawn, so this "
            "cannot stream: the config runs on the in-memory engine whatever mode= asks "
            "for. Measured at about 250 bytes a value. It works — it is worth being "
            "deliberate about at this size.",
            _line(open_el),
            _column(open_el),
        )

    def _check_sequence_body(self, open_el, name: str | None) -> None:
        # An invented tag here used to pass in SILENCE: the config validated, exit 0,
        # and the run went ahead as if the tag had done something. <env> has always
        # answered this; <sequence> was the last container with no list of its own.
        # MISPLACED_IN_SEQUENCE is handled by the dedicated loop below, which also
        # counts them so TDC036 stays quiet. Reporting them here as well printed the
        # same TDC013 twice — invisible in the full report, obvious the moment the
        # brief output put the two lines together.
        self._check_children(
            open_el.content(),
            "sequence",
            SEQUENCE_CHILDREN | MISPLACED_IN_SEQUENCE,
            shown=SEQUENCE_CHILDREN,
        )
        """A sequence must actually produce something, and a compound must name its fields."""
        gens: list[dict[str, str]] = []
        gen_nodes = []
        has_compute = False
        compute_el = None
        for child in _elements(open_el):
            # A <gen> is a <gen> however it was punctuated. Looking only at the
            # self-closing form left `<gen …></gen>` unseen, and the sequence was
            # blamed for having no generator while one stood in plain sight.
            self_closing = _gen_element(child)
            if self_closing is not None:
                gens.append(_attrs(self_closing.attr()))
                gen_nodes.append(self_closing)
                continue
            inner = child.openCloseElement()
            if inner is None:
                continue
            if inner.name.text == "compute":
                has_compute = True
                compute_el = inner
            elif inner.name.text == "distinct":
                # The wrapper is allowed here, but its own body was never looked at:
                # the gens inside were collected and everything else dropped.
                self._check_children(inner.content(), "distinct", DISTINCT_CHILDREN)
                for g in _elements(inner):
                    gen = _gen_element(g)
                    if gen is not None:
                        gens.append(_attrs(gen.attr()))
                        gen_nodes.append(gen)

        # A <sequence> holds only <gen> (optionally wrapped in <distinct>). A construct that
        # belongs at env level is a placement mistake — saying so beats letting it fall through
        # to a confusing "no <gen>", which names a symptom rather than the cause.
        misplaced = 0
        for child in _elements(open_el):
            tag = None
            if child.mapElement() is not None:
                tag = "map"
            elif child.openCloseElement() is not None:
                tag = child.openCloseElement().name.text
            elif child.selfClosingElement() is not None:
                tag = child.selfClosingElement().name.text
            if tag in MISPLACED_IN_SEQUENCE:
                node = child.openCloseElement() or child.selfClosingElement()
                self._error(
                    "TDC013",
                    f"<{tag}> is not allowed directly inside <sequence>",
                    f"{PLACEMENT_HINTS[tag]} Allowed inside <sequence>: "
                    f"{', '.join(sorted(SEQUENCE_CHILDREN))}.",
                    _line(node) if node is not None else _line(open_el),
                    _column(node) if node is not None else _column(open_el),
                )
                misplaced += 1

        label = name if name is not None else "?"
        if has_compute and gens:
            # One <sequence>, two producers. The engine cannot honour both, and the five
            # implementations did not even agree on which one to drop — same config,
            # different data. Refuse instead.
            self._error(
                "TDC219",
                f'<compute> cannot sit beside a <gen> in <sequence name="{label}"> '
                "\u2014 one of the two would be dropped",
                "A sequence either DERIVES its value with <compute> or DRAWS it with "
                "<gen>. Move the <compute> into its own <sequence> and read the drawn "
                'one from it with <field name="\u2026"/>.',
                _line(compute_el) if compute_el is not None else _line(open_el),
                _column(compute_el) if compute_el is not None else _column(open_el),
            )
        if has_compute and not gens:
            self._uniq_unsupported(
                open_el,
                label,
                "<compute> processes the values it reads rather than drawing any of its "
                "own, so it cannot promise uniqueness",
            )
        if not gens and not has_compute and misplaced == 0:
            self._error(
                "TDC036",
                f'<sequence name="{label}"> has no <gen> child',
                'A sequence needs at least one <gen type="…"/> describing how values are made.',
                _line(open_el),
                _column(open_el),
            )
            return

        # Conditional first, exactly as the reference orders it: gens carrying `if` are branches,
        # and a branch has no need of a name.
        if any("if" in g for g in gens):
            self._uniq_unsupported(
                open_el,
                label,
                'its value is picked per row from <gen if="…"> branches rather than drawn '
                "as one pool, so it cannot promise uniqueness",
            )
            return

        self._uniq_on_composed(open_el, label, gens, gen_nodes)
        self._uniq_drops_gen_attrs(open_el, label, gens, gen_nodes)

        # Three readings, and the body says which: every gen named is a compound (several
        # columns, no value of its own), one unnamed gen alone is a simple sequence, and anything
        # else COMPOSES — the unnamed gens and the literals concatenate into the sequence's own
        # value while the named ones stay fields beside it. None of the three is an error, so the
        # only thing left to check is that two fields do not share a name.
        field_names: set[str] = set()
        for gen, node in zip(gens, gen_nodes, strict=True):
            field_name = gen.get("name")
            if field_name is None or not field_name.strip():
                continue
            if field_name in field_names:
                line, column = _at(node, "name")
                self._error(
                    "TDC111",
                    f'duplicate field name "{field_name}" inside compound '
                    f'<sequence name="{label}">',
                    'Each <gen name="…"> within a compound sequence must have a unique name.',
                    line,
                    column,
                )
            else:
                field_names.add(field_name)

        # Compound: every gen named, and no literal to compose with. Recorded so a later parent=
        # naming this sequence can be refused before the run rather than during it.
        composes = False
        for child in _elements(open_el):
            data = child.dataElement()
            if data is not None and _has_body(data) and _data_text(data).strip():
                composes = True
                break
        if gens and len(field_names) == len(gens) and not composes and name is not None:
            self.valueless_names.add(name)

        # A simple body — one unnamed gen and nothing else — may say outright what it produces.
        if len(gens) == 1 and not field_names and not composes and name is not None:
            values = _finite_text_values(gens[0])
            if values is not None:
                self.finite_values[name] = values

    def _check_sequence_data_attrs(self, open_el) -> None:
        """A ``<data>`` inside a ``<sequence>`` reads ``name`` and nothing else.

        It is a literal, or — with a name — a constant field. An output type belongs on the
        ``<data>`` in the ``<line>``, where the column is actually emitted; dropping one here is
        the silent loss this whole reading was introduced to end.
        """
        for child in _elements(open_el):
            data = child.dataElement()
            if data is None or not hasattr(data, "attr"):
                continue
            for attr in data.attr():
                attr_name = attr.attrName.text
                if attr_name in ("name", "comment"):
                    continue
                line, column = _at_attrs(data.attr(), attr_name, _line(open_el), _column(open_el))
                self._error(
                    "TDC015",
                    f'<data> inside <sequence> does not read "{attr_name}" — it is ignored',
                    'Inside a <sequence> a <data> is a literal or, with name="…", a constant '
                    "field. Output types belong on the <data> in the <line>.",
                    line,
                    column,
                )

    #: Attributes that reach the value AFTER it is drawn, and so cannot survive a draw without
    #: replacement. Each can make two distinct draws print the same text — a mask hides the
    #: digits that told them apart, ``case`` folds ``ab`` and ``AB`` together, ``missing``
    #: writes the same blank on many rows, ``repeat`` turns the cell into a list.
    _DROPPED_BY_UNIQ = (
        "mask",
        "case",
        "missing",
        "missing_as",
        "repeat",
        "separator",
        "anomaly",
        "anomaly_flag",
    )

    def _uniq_drops_gen_attrs(self, open_el, label: str, gens, gen_nodes) -> None:
        """``uniq="true"`` on a simple sequence whose ``<gen>`` also asks for formatting.

        The uniq path produces the column directly and never reaches the pipeline that applies
        these attributes, so today they vanish in silence. Applying them instead would break the
        promise the other way: a mask maps two distinct draws onto the same characters. Neither
        is acceptable without a word, so the combination is refused and the attribute is named.

        ``increment`` and ``decrement`` are exempt — unique by construction, they keep their
        ordinary build and their formatting runs as it does anywhere else.
        """
        attrs = _attrs(open_el.attr())
        if (attrs.get("uniq") or "").strip().lower() != "true":
            return
        if len(gens) != 1 or "name" in gens[0]:
            return
        gen = gens[0]
        if gen.get("type") in ("increment", "decrement"):
            return
        asked = [a for a in self._DROPPED_BY_UNIQ if a in gen]
        if not asked:
            return
        listed = ", ".join(f"{a}=" for a in asked)
        line, column = _at(open_el, "uniq")
        self._error(
            "TDC267",
            f'uniq="true" on <sequence name="{label}"> cannot be combined with {listed} on its '
            "<gen>: a draw without replacement produces the values directly, so nothing that "
            "rewrites them afterwards runs",
            "Two ways out. Drop the attribute if the uniqueness is what you wanted \u2014 or drop "
            "uniq= and keep the formatting, since a masked, blanked or repeated column cannot be "
            "unique as text anyway: a mask maps different values onto the same characters.",
            line,
            column,
        )

    def _uniq_on_composed(self, open_el, label: str, gens, gen_nodes) -> None:
        """`uniq="true"` on a composed value that joins two or more DRAWN parts.

        One drawn part plus constants is fine and honoured: appending a constant cannot make
        two different draws collide. Two drawn parts have no fixed widths, so a unique set of
        parts is not a unique join — ``9`` + ``15`` and ``91`` + ``5`` are the same three
        characters.
        """
        attrs = _attrs(open_el.attr())
        if (attrs.get("uniq") or "").strip().lower() != "true":
            return
        drawn = sum(1 for g in gens if "name" not in g)
        if drawn < 2:
            return
        line, column = _at(open_el, "uniq")
        self._error(
            "TDC220",
            f'uniq="true" cannot be honoured on <sequence name="{label}">: its value joins '
            f"{drawn} drawn parts, and a unique set of parts is not a unique join when the parts "
            "have no fixed width",
            "Give each part its own <sequence> and wrap them in <uniq>\u2026</uniq>, with a "
            'fixed width per part (length= plus first_zero="true" on a number). Then the join '
            "can be split back one way only, so a unique combination is a unique result.",
            line,
            column,
        )

    def _uniq_unsupported(self, open_el, label: str, why: str) -> None:
        """`uniq="true"` where the value is not DRAWN, so there is no pool to take from.

        Uniqueness is a property of a draw — without replacement on a simple sequence,
        a rearrangement of the columns on a compound one. A computed result and a
        conditional pick are neither, so the attribute could only be ignored, and it
        used to be in silence: the config claimed the column was unique and the data
        disagreed without a word.
        """
        attrs = _attrs(open_el.attr())
        if (attrs.get("uniq") or "").strip().lower() != "true":
            return
        line, column = _at(open_el, "uniq")
        self._error(
            "TDC218",
            f'uniq="true" is not allowed on <sequence name="{label}">: {why}',
            "Put uniq= on the sequences this one reads, or wrap them in <uniq>…</uniq> so "
            "their combination is unique across records. When the parts have fixed widths, "
            "a unique combination means a unique result.",
            line,
            column,
        )

    def _check_mix(self, open_el, named: bool) -> None:
        """A mix needs branches, and only branches.

        ``named`` is whether this mix sits at env level and can therefore own a flag column. A
        nested one contributes a value to somebody else's column and has nowhere to put a flag.
        """
        cases = 0
        anomalous = False
        first_anomalous = None
        for child in _elements(open_el):
            inner = child.openCloseElement()
            self_closing = child.selfClosingElement()
            tag = (
                inner.name.text
                if inner is not None
                else (self_closing.name.text if self_closing is not None else None)
            )
            if tag is None:
                continue
            if tag == "case":
                cases += 1
                if inner is not None:
                    if _attrs(inner.attr()).get("anomaly") == "true":
                        anomalous = True
                        if first_anomalous is None:
                            first_anomalous = inner
                    self._check_closed_tag_attrs("case", inner.attr(), _line(inner), _column(inner))
                    self._check_case_body(inner)
                continue
            node = inner if inner is not None else self_closing
            self._error(
                "TDC124",
                f'unknown child of <mix>: "<{tag}>"',
                "Allowed children: case.",
                _line(node),
                _column(node),
            )

        attrs = _attrs(open_el.attr())
        if cases > 0:
            line, column = _at(open_el, "percent")
            self._check_percent_mask(
                attrs.get("percent"), cases, ("TDC121", "TDC122", "TDC123"), line, column
            )
        else:
            self._error(
                "TDC120",
                "<mix> has no <case> children",
                "Add at least one <case>...</case> inside <mix>.",
                _line(open_el),
                _column(open_el),
            )

        flag = attrs.get("flag")
        if flag is not None and not named:
            line, column = _at(open_el, "flag")
            self._error(
                "TDC203",
                '"flag" on a nested <mix> is not supported — only a named env-level <mix> can '
                "declare one",
                'A flag becomes its own sequence, so it needs a <mix name="…"> at env level.',
                line,
                column,
            )
            # One complaint per mix: whether its branches are marked is beside the point once the
            # flag itself cannot exist.
            return
        if flag is None and first_anomalous is not None:
            # A branch marked as the outlier, and nothing recording which rows took it. The label
            # is the only reason to mark it, so the complaint points at the branch.
            line, column = _at(first_anomalous, "anomaly")
            self._error(
                "TDC203",
                'anomaly="true" on <case> does nothing — the enclosing <mix> declares no flag="…"',
                'Name the ground-truth column: <mix name="…" flag="IsAnomaly">.',
                line,
                column,
            )
        for listy in ("repeat", "separator"):
            if attrs.get(listy) is not None:
                line, column = _at(open_el, listy)
                self._error(
                    "TDC196",
                    f'"{listy}" is not supported on <mix> — it picks one branch, it does not '
                    "produce a list",
                    "Put repeat= on the <gen> inside a <case>, or on a plain <sequence>.",
                    line,
                    column,
                )
        if flag is not None and flag.strip() and cases > 0 and not anomalous:
            # A label that is false on every row is not a label. It reads as ground truth and
            # teaches whatever consumes it that nothing is ever anomalous.
            line, column = _at(open_el, "flag")
            self._error(
                "TDC202",
                'flag="…" but no <case> is marked anomaly="true" — the column would be all "false"',
                'Mark the outlier branch: <case anomaly="true">…</case>.',
                line,
                column,
            )

    def _check_switch(self, open_el, declared: list[str], named: bool = True) -> None:
        """``named`` is false for the form written inside a ``<case>``.

        That one contributes a value to the branch around it rather than a column of its own,
        so it has no name to declare and nothing can interpolate it. Every other rule — the
        subject, the entries, the fallback — is the same, from this one function.
        """
        attrs = _attrs(open_el.attr())
        if not named and attrs.get("name") is not None:
            line, column = _at(open_el, "name")
            self._error(
                "TDC245",
                '"name" on a nested <switch> is not supported — only an env-level <switch> '
                "becomes a column",
                "A nested <switch> contributes its value to the <case> around it. Nothing can "
                "interpolate it, so a name would name nothing. Move it to <env> if you want "
                "${{Name}}.",
                line,
                column,
            )
        # The entries walk below only ever looked at open/close children, so an invented
        # tag written self-closing passed while <bogus></bogus> was caught — the same
        # invention accepted or refused depending on how it was punctuated.
        self._check_children(open_el.content(), "switch", SWITCH_CHILDREN, "TDC124")
        on = attrs.get("on")
        if on is None or not on.strip():
            self._error(
                "TDC133",
                '<switch> is missing a required "on" attribute',
                'A switch looks a value up; "on" names the sequence it looks up.',
                _line(open_el),
                _column(open_el),
            )
        elif on not in declared:
            line, column = _at(open_el, "on")
            self._error(
                "TDC134",
                f'<switch on="{on}"> refers to an unknown sequence',
                "Declare the subject sequence above the switch.",
                line,
                column,
            )

        entries = 0
        for child in _elements(open_el):
            if child.mapElement() is not None:
                entries += 1
                self._check_map_rows(child.mapElement())
                continue
            inner = child.openCloseElement()
            if inner is None:
                continue
            if inner.name.text == "case":
                entries += 1
                is_value = _attrs(inner.attr()).get("is")
                if is_value is None or not is_value.strip():
                    self._error(
                        "TDC137",
                        '<case> inside <switch> is missing a required "is" attribute',
                        'A switch case matches a value; "is" is the value it matches.',
                        _line(inner),
                        _column(inner),
                    )
                self._check_case_body(inner)
            elif inner.name.text == "default":
                entries += 1
                self._check_case_body(inner)
        if entries == 0:
            self._error(
                "TDC135",
                "<switch> has no entries",
                'Add a <map>, a <case is="…">, or a <default>.',
                _line(open_el),
                _column(open_el),
            )

    def _check_gens_in(self, element) -> None:
        """Into a sequence body, so a ``<gen>`` inside a ``<distinct>`` is checked too."""
        self_closing = element.selfClosingElement()
        if self_closing is not None and self_closing.name.text == "gen":
            self._check_gen(self_closing)
            return
        open_el = element.openCloseElement()
        if open_el is not None:
            for inner in _elements(open_el):
                self._check_gens_in(inner)

    # ── gen ─────────────────────────────────────────────────────────────────────────────────

    def _check_gen(self, gen) -> None:
        attrs = _attrs(gen.attr())
        type_ = attrs.get("type")

        # A conditional gen carries `if` as its branch condition, and a plain one may have one
        # too. An expression here is an expression like any other: left unchecked, a branch that
        # can never be taken looks exactly like a branch nobody happened to hit.
        condition = attrs.get("if")
        if condition is not None:
            where = _at_attrs(gen.attr(), "if", *_at(gen, "if"))
            self._check_if_expression(condition, where[0], where[1])
            self.pending_expressions.append(
                (len(self.diagnostics), condition, where[0], where[1], False)
            )
            # A pool reference publishes a whole MEMBER, and a `<gen>` carrying `if` becomes a
            # conditional branch the pool resolver does not recognise — so no `Ref.field` column
            # was registered and `${{Ref.name}}` reached the output as its own literal text, on
            # every row including the ones the condition selected.
            if type_ == "pool":
                self._error(
                    "TDC268",
                    'if= is not supported on <gen type="pool">: the reference publishes a whole '
                    "MEMBER, and a conditional one would register no fields at all",
                    'To leave some rows without a member, use parent="\u2026" \u2014 it masks the '
                    "reference the same way it masks any other sequence, and the fields come out "
                    "empty on the rows it excludes.",
                    where[0],
                    where[1],
                )

        if type_ is None or not type_.strip():
            line, column = _at(gen, "name")
            self._error(
                "TDC040",
                '<gen> is missing a required "type" attribute',
                "Every generator names what it generates.",
                line,
                column,
            )
        elif type_ not in GEN_TYPES:
            line, column = _at(gen, "type")
            self._error(
                "TDC041",
                f'unknown gen type "{type_}"',
                f"Known types: {', '.join(sorted(GEN_TYPES))}.",
                line,
                column,
            )

        # Before the per-type checks, and INSTEAD of them when it fires: a value holding ${{…}}
        # is not the value its generator will try to parse, so letting the generator also
        # complain would put a wrong explanation beside the right one.
        if self._check_attr_interpolation(gen, attrs, type_):
            return

        self._check_required_value(gen, attrs, type_)
        self._check_number(gen, attrs, type_)
        self._check_regexes(gen, attrs, type_)
        self._check_symbol(gen, attrs, type_)
        self._check_date(gen, attrs, type_)
        self._check_timeseries(gen, attrs, type_)
        self._check_sequential_repeat(gen, attrs)
        self._check_repeat(gen, attrs, type_)

        self._check_gen_attributes(gen, attrs, type_)

        self._check_weight(gen, attrs, type_)
        self._check_source(gen, attrs, type_)
        self._check_http(gen, attrs, type_)
        self._check_running(gen, attrs, type_)
        self._check_stat(gen, attrs, type_)
        self._check_mask(gen, attrs)
        self._check_counter(gen, attrs, type_)
        self._check_date_templates(gen, attrs, type_)
        self._check_case_and_order(gen, attrs)
        self._check_imperfections(gen, attrs, type_)

        # `order="sequential"` gives row r element `r mod N` — a rule about POSITION, which
        # leaves no room for a rule about SHARE. The engine ignores the percent outright, and
        # nothing told the user: percent="98,1,1" over a hundred rows came out 34/33/33 from a
        # config `check` had called valid.
        if (
            type_ in ("text", "file")
            and (attrs.get("order") or "").strip() == "sequential"
            and attrs.get("percent") is not None
        ):
            line, column = _at(gen, "percent")
            self._error(
                "TDC271",
                f'percent="{attrs["percent"]}" is not read beside order="sequential": walking '
                "the list in order fixes which value each row gets, so there is no share left "
                "to apportion",
                'Drop order="sequential" to have the shares apportioned exactly, or drop '
                "percent= and take the values in the order they are written \u2014 each one as "
                "often as the others.",
                line,
                column,
            )

        if type_ == "text" and attrs.get("percent") is not None:
            line, column = _at(gen, "percent")
            self._check_percent_mask(
                attrs["percent"],
                _split_count(attrs.get("value", "")),
                ("TDC051", "TDC052", "TDC053"),
                line,
                column,
            )
        if type_ == "number" and attrs.get("percent") is not None and attrs.get("length"):
            line, column = _at(gen, "percent")
            self._check_percent_mask(
                attrs["percent"],
                _split_count(attrs["length"]),
                ("TDC084", "TDC085", "TDC086"),
                line,
                column,
            )

    def _check_attr_interpolation(self, gen, attrs: dict[str, str], type_: str | None) -> bool:
        """``${{Name}}`` written into an attribute that does not read it.

        Interpolation reaches exactly two places: the TEXT inside ``<data>``, and
        ``<gen type="template" value=>``, where a path may be finished by another column.
        Everywhere else the braces are eight literal characters — and the generator that
        receives them complains about whatever it happens to be parsing, which is true and tells
        the reader nothing: an invalid number range, an invalid date, a bad quantifier, an unknown
        alphabet — and ``type="text"`` said nothing at all and emitted the braces. Five messages
        and one silence for one mistake, and none of them naming it.

        The check is deliberately blind to WHICH attribute: a list of "attributes that do not
        interpolate" would be every attribute but one, and would have to be kept in step with
        every generator added later.
        """
        found = False
        for name, raw in attrs.items():
            if "${{" not in (raw or ""):
                continue
            # The one place it works: a pack path finished by another column, which is the
            # documented idiom for linked pairs.
            if name == "value" and type_ == "template":
                continue
            line, column = _at(gen, name)
            self._error(
                "TDC263",
                f"${{{{…}}}} in {name}= is not expanded — the braces are literal text here",
                "Interpolation reaches the text inside <data> and <gen type=\"template\" "
                "value=>, and nowhere else. To make one column depend on another, read it in an "
                "if= condition, or build the value in a <compute> sequence.",
                line,
                column,
            )
            found = True
        return found

    def _check_http(self, gen, attrs: dict[str, str], type_: str | None) -> None:
        """The ``http`` generator: everything knowable before the run.

        A missing endpoint, an address that is not a URL, an ``in=`` naming nothing. The transport
        failures — the service down, slow or wrong — cannot be known until the run and are reported
        then; these can, and a run that calls a service is the most expensive kind to discover a
        typo in.
        """
        if type_ != "http":
            return
        src = attrs.get("src")
        line, column = _at(gen, "src")
        if src is None or not src.strip():
            self._error(
                "TDC065",
                '<gen type="http"> requires a "src" attribute',
                'Point it at the service, e.g. src="http://127.0.0.1:5566/gen".',
                line,
                column,
            )
        elif not _is_http_url(src.strip()):
            self._error(
                "TDC066",
                f'invalid http src "{src.strip()}" — must be an http:// or https:// URL',
                'e.g. src="http://127.0.0.1:5566/gen" or src="https://svc.example.com/gen".',
                line,
                column,
            )

        in_name = attrs.get("in")
        if in_name is not None and in_name.strip() not in self.declared_names:
            line, column = _at(gen, "in")
            self._error(
                "TDC067",
                f'in="{in_name.strip()}" does not name a sequence declared before this one',
                "The value sent per row comes from an earlier <sequence>; declare it above.",
                line,
                column,
            )

        on_error = attrs.get("on_error")
        if on_error is not None and on_error not in ("fail", "empty"):
            line, column = _at(gen, "on_error")
            self._error(
                "TDC068",
                f'invalid on_error "{on_error}" — expected "fail" or "empty"',
                "fail (default) stops the run; empty blanks the cell and continues.",
                line,
                column,
            )

    def _check_mask(self, gen, attrs: dict[str, str]) -> None:
        """A ``mask=`` that does not parse. Caught here rather than on the first row."""
        mask = attrs.get("mask")
        if mask is None:
            return
        try:
            mask_lib.parse(mask)
        except ValueError as e:
            line, column = _at(gen, "mask")
            self._error(
                "TDC199",
                str(e),
                'Indices are 0-based; ranges use "..", e.g. mask="x[0..3]" or mask="w[-1], w[0]".',
                line,
                column,
            )

    def _check_source(self, gen, attrs: dict[str, str], type_: str | None) -> None:
        """A ``src=`` that names a file nobody can read.

        Checked before the run rather than during it: a missing file discovered on row one of a
        million-row job has already cost whatever the job cost.
        """
        if type_ not in ("file", "pattern"):
            return
        # `src=` is one of three ways to hand a drawing a shape, so its absence is only a mistake
        # when the other two are absent too — the drawing equivalent of a regex with no pattern,
        # which TDC095 and TDC128 have always caught before the run.
        if type_ == "pattern" and not any(
            (attrs.get(key) or "").strip() for key in ("points", "src", "upper")
        ):
            self._error(
                "TDC244",
                '<gen type="pattern"> has nothing to draw from',
                'Give it a shape: points="0,0 1,5 2,3", src="curve.svg" (or a PNG), or '
                'upper="…" with an optional lower="…" for a band.',
                _line(gen),
                _column(gen),
            )
            return
        src = attrs.get("src")
        if src is None or not src.strip():
            return
        line, column = _at(gen, "src")
        try:
            path = file_gen.resolve(src.strip(), self.base_dir, self._roots())
        except ValueError as e:
            # A source that cannot even be resolved — an "@data/" with no data folder configured —
            # is reported here rather than raised, so the run collects every problem at once.
            self._error(
                "TDC061",
                str(e),
                "Paths are relative to the config file's own folder.",
                line,
                column,
            )
            return
        if not path.is_file():
            self._error(
                "TDC061",
                f'cannot read file "{src}"',
                "Paths are relative to the config file's own folder.",
                line,
                column,
            )
            return
        if attrs.get("column") is None:
            return
        # A column that names nothing in the file: caught by loading it, which is the only way to
        # know, and cheap next to discovering it a million rows in.
        try:
            file_gen.load(attrs, self.base_dir, self._roots())
        except (ValueError, OSError) as e:
            line, column = _at(gen, "column")
            self._error(
                "TDC062",
                str(e),
                'For CSV files, use a header name like column="email" or a 1-based index like '
                'column="2".',
                line,
                column,
            )

    def _check_gen_attributes(self, gen, attrs: dict[str, str], type_: str | None) -> None:
        """Every attribute is spelled right AND read by this generator.

        An ignored attribute is a request the config made and silently did not get, which is
        indistinguishable from a typo — and the data comes out looking fine either way, which is
        what makes it worth stopping for. All errors, matching the reference.
        """
        if type_ == "template":
            self._check_builtin_template_attrs(gen, attrs)
            # A pack's parameters are open-ended, so the "is this a known name" half cannot run
            # here — but which type reads `order=` does not depend on the pack, and that half is
            # why `order=` and `parent=` sat on a template generator doing nothing.
            for name in attrs:
                owners = ATTRIBUTE_OWNERS.get(name)
                if owners is not None and "template" not in owners:
                    belongs = ", ".join(f'type="{t}"' for t in sorted(owners))
                    self._ignored(
                        gen,
                        name,
                        f'"{name}" belongs to {belongs} — a type="template" generator ignores it.',
                    )
                elif name == "parent":
                    self._ignored(gen, name, _MISPLACED_GEN_PARENT)
            return

        has_distribution = bool((attrs.get("distribution") or "").strip())
        order = (attrs.get("order") or "").strip()
        for name in attrs:
            if name not in GEN_ATTRS:
                self._ignored(gen, name, "Check the spelling against the generator's attributes.")
                continue
            # A distribution parameter with no distribution asked for shapes nothing.
            if name in DISTRIBUTION_PARAMS and not has_distribution:
                self._ignored(
                    gen,
                    name,
                    f'"{name}" is a parameter of a named distribution — add distribution="…" '
                    "for it to mean anything. To bound a plain number, put the range in "
                    'value="10..20".',
                )
                continue
            # `cycle` says what happens when a WALK runs out. Without a walk there is nothing
            # to run out of: the generator draws, and a draw never ends.
            if name == "cycle" and order != "sequential":
                self._ignored(
                    gen,
                    name,
                    'cycle= says what happens when order="sequential" reaches the end of its '
                    'source. Without order="sequential" the generator draws, and a draw never '
                    "runs out.",
                )
                continue
            owners = ATTRIBUTE_OWNERS.get(name)
            if owners is not None and type_ is not None and type_ not in owners:
                belongs = ", ".join(f'type="{t}"' for t in sorted(owners))
                self._ignored(
                    gen,
                    name,
                    f'"{name}" belongs to {belongs} — a type="{type_}" generator ignores it.',
                )

    def _check_builtin_template_attrs(self, gen, attrs: dict[str, str]) -> None:
        """The two pack-less template paths, against their own closed parameter sets.

        A pack declares its own parameters and is judged with the registry in hand; these two are
        backed by no pack, so nothing else checks them.
        """
        path = (attrs.get("value") or "").strip()
        allowed = BUILTIN_TEMPLATE_PARAMS.get(path)
        if allowed is None:
            if self._check_pack_params(gen, attrs, path):
                return
            for name in attrs:
                if name not in GEN_ATTRS:
                    self._ignored(
                        gen, name, "Check the spelling against the generator's attributes."
                    )
            return

        for name in attrs:
            if name in ("type", "value", "name", "local", "count", "percent", "weight", "if"):
                continue
            if name not in allowed:
                belongs = ", ".join(sorted(allowed))
                self._ignored(gen, name, f'"{path}" reads only {belongs}.')

    def _check_pack_params(self, gen, attrs: dict[str, str], path: str) -> bool:
        """Attributes on a template `<gen>` that the target pack CAN act on.

        A pack whose body declares `<sequence name="domain">` accepts `domain="…"` from
        the caller, and the engine replaces that sequence with the constant. So the
        attribute is neither a typo nor ignored — refusing it, as this used to, made a
        config that runs in the reference fail here.

        Returns False — leaving the ordinary check to run — when nothing is known about
        the pack: an unresolvable address, or no registry at all. Guessing there would
        produce exactly the false errors this must not create.
        """
        if self.packs is None or not path:
            return False
        declared = self.packs.parameter_names(path, self.locale)
        if declared is None:
            return False

        for name, value in attrs.items():
            if name in GEN_ATTRS or name in declared or name in _NOT_A_PACK_PARAM:
                continue
            line, column = _at(gen, name)
            if declared:
                hint = "Parameters of this generator: " + ", ".join(sorted(declared)) + "."
            else:
                hint = (
                    "This generator takes no parameters — it produces a fixed shape. "
                    f'Value passed: "{value}".'
                )
            self._error(
                "TDC072",
                f'"{name}" is not a parameter of "{path}" — it would be ignored',
                hint,
                line,
                column,
            )
        return True

    def _ignored(self, gen, name: str, why: str) -> None:
        line, column = _at(gen, name)
        self._error("TDC015", f'<gen> does not read "{name}" — it is ignored', why, line, column)

    def _check_required_value(self, gen, attrs: dict[str, str], type_: str | None) -> None:
        """Every generator that cannot work without one particular attribute."""
        value = attrs.get("value")
        missing = value is None or not value.strip()

        if type_ == "text":
            if missing:
                self._error(
                    "TDC050",
                    '<gen type="text"> requires a "value" attribute',
                    "It is the comma-separated list to pick from.",
                    _line(gen),
                    _column(gen),
                )
        elif type_ == "file":
            src = attrs.get("src")
            if src is None or not src.strip():
                self._error(
                    "TDC060",
                    '<gen type="file"> requires a "src" attribute',
                    "Provide the path to a UTF-8 text file with one value per line.",
                    _line(gen),
                    _column(gen),
                )
            row = attrs.get("row")
            column_attr = attrs.get("column")
            if row is not None and row.strip() and (column_attr is None or not column_attr.strip()):
                line, column = _at(gen, "row")
                self._error(
                    "TDC064",
                    'row-linked file generators require a CSV "column" attribute',
                    'Use column="name" or column="2" together with row="sharedKey".',
                    line,
                    column,
                )
        elif type_ == "template":
            if missing:
                self._error(
                    "TDC070",
                    '<gen type="template"> requires a "value" attribute',
                    "Use a known template path, e.g. person.male.firstName.",
                    _line(gen),
                    _column(gen),
                )
                return
            if "${{" in value:
                # An address that names a field is not known until the row is, so there is nothing
                # to look up here. The engine resolves it per row and reports what it cannot find.
                return
            address = value.strip()
            if address in BUILTIN_TEMPLATE_PATHS or self.packs is None:
                return
            line, column = _at(gen, "value")
            if self.packs.exists(address, self.locale):
                # The address resolves; whether the file behind it is usable is a separate
                # question, and one worth answering now. A pack a user wrote themselves is exactly
                # the kind that is malformed, and finding out on the first row wastes the run.
                try:
                    self.packs.load(address, self.locale)
                except (ValueError, OSError) as e:
                    self._error("TDC170", str(e), f'Data pack file for "{address}".', line, column)
            elif self.locale != "en" and self.packs.exists(address, "en"):
                # The path is real — the DATA for this locale is missing. Said as
                # its own code because "unknown template path" reads as a typo and
                # sends the reader hunting for one that is not there.
                self._error(
                    "TDC217",
                    f'template path "{value}" has no data for locale "{self.locale}"',
                    'The "en" pack ships it. Set local="…" on this <gen> or on <env>, '
                    "or choose a path your locale ships.",
                    line,
                    column,
                )
            else:
                self._error(
                    "TDC071",
                    f'unknown template path "{value}"',
                    "Check the address against the packs you have.",
                    line,
                    column,
                )
        elif type_ == "regex":
            if missing:
                self._error(
                    "TDC095",
                    '<gen type="regex"> requires a "value" attribute',
                    'Provide a finite regex pattern, e.g. value="[A-Z]{2}[0-9]{6}".',
                    _line(gen),
                    _column(gen),
                )
        elif type_ == "advanced_regex" and missing:
            self._error(
                "TDC128",
                '<gen type="advanced_regex"> requires a "value" attribute',
                "Provide a finite pattern, optionally with a weighted choice.",
                _line(gen),
                _column(gen),
            )

    def _check_number(self, gen, attrs: dict[str, str], type_: str | None) -> None:
        """The number generator's own parsers decide what is valid.

        A validator with its own idea of a valid range drifts from the generator that reads it, and
        then a config passes the check and fails at run time — the worst of both.
        """
        if type_ != "number":
            return
        distribution = attrs.get("distribution")
        if distribution is not None and distribution.strip():
            for key in checks.DISTRIBUTION_CONFLICTS:
                if attrs.get(key) is not None:
                    line, column = _at(gen, key)
                    self._error(
                        "TDC088",
                        f'<gen type="number" distribution="..."> cannot be combined with "{key}"',
                        f'A distribution replaces the range/percent. Remove "{key}", or drop '
                        '"distribution" to use a range.',
                        line,
                        column,
                    )
            # The distribution's own parameters: a shape nobody can draw from is an error before
            # the run, not a surprise on the first row.
            try:
                dist.parse(attrs)
            except ValueError as e:
                line, column = _at(gen, "distribution")
                self._error(
                    "TDC089",
                    str(e),
                    "Distributions: normal (mean, sd), lognormal (meanlog, sdlog), exponential "
                    "(rate), pareto (alpha, xmin). Optional: decimals, min, max.",
                    line,
                    column,
                )
            return

        value = attrs.get("value")
        if value is not None and value.strip() and checks.number_range_problem(value) is not None:
            line, column = _at(gen, "value")
            self._error(
                "TDC081",
                f'invalid number range "{value}"',
                'Expected "bit", "MIN..MAX", or a list like "[0..9],[20..29]".',
                line,
                column,
            )

        first_zero = attrs.get("first_zero")
        if first_zero is not None and not checks.is_boolean_text(first_zero):
            line, column = _at(gen, "first_zero")
            self._error(
                "TDC082",
                f'invalid first_zero "{first_zero}" — expected "true" or "false"',
                "It decides whether a generated digit string may start with a zero.",
                line,
                column,
            )

        length = attrs.get("length")
        if length is not None and not checks.is_valid_length(length):
            line, column = _at(gen, "length")
            self._error(
                "TDC083",
                f'invalid length "{length}" — expected a positive integer, range, or '
                "comma-separated list",
                'Examples: length="10", length="2-10", length="2,10-12".',
                line,
                column,
            )

        has_include = bool((attrs.get("include") or "").strip())
        has_exclude = bool((attrs.get("exclude") or "").strip())
        has_modifier = has_include or has_exclude
        # `include`/`exclude` turn the draw into a pick from an explicit set of WHOLE numbers, so
        # a fractional value can never be in it: `decimals` described a draw that is no longer
        # happening. The engine dropped it and emitted integers, and the config that asked for
        # 7.71 got 8 without a word.
        decimals = (attrs.get("decimals") or "").strip()
        if has_modifier and decimals not in ("", "0"):
            which = (
                "include/exclude"
                if has_include and has_exclude
                else "include"
                if has_include
                else "exclude"
            )
            line, column = _at(gen, "decimals")
            self._error(
                "TDC255",
                f'decimals="{decimals}" cannot be combined with {which}',
                "include= and exclude= build a set of whole numbers and pick one uniformly, so "
                "there are no fractional values to round. Drop decimals=, or bound the range "
                "with value= instead of a set.",
                line,
                column,
            )
        if has_modifier and (value is None or not value.strip()):
            self._error(
                "TDC087",
                '<gen type="number"> include/exclude require a numeric range in "value"',
                'Add a range first, e.g. value="0..9" exclude="3".',
                _line(gen),
                _column(gen),
            )

    def _check_regexes(self, gen, attrs: dict[str, str], type_: str | None) -> None:
        value = attrs.get("value")
        if value is None or not value.strip():
            return
        limit = (
            self._safe_max_length(attrs["regex_max_length"])
            if attrs.get("regex_max_length") is not None
            else self.document_regex_max_length
        )

        if type_ == "regex":
            problem = checks.regex_problem(value, limit)
            if problem is not None:
                line, column = _at(gen, "value")
                self._error(
                    "TDC097",
                    f"invalid regex generator pattern: {problem}",
                    "The subset is finite: no * or +, and every pattern has a longest output.",
                    line,
                    column,
                )
        elif type_ == "advanced_regex":
            problem = checks.advanced_regex_problem(value, limit)
            if problem is not None:
                line, column = _at(gen, "value")
                self._error(
                    "TDC130",
                    f"invalid advanced_regex generator pattern: {problem}",
                    "Weighted branches must sum to 100.",
                    line,
                    column,
                )

    def _check_symbol(self, gen, attrs: dict[str, str], type_: str | None) -> None:
        if type_ != "symbol":
            return
        value = attrs.get("value")
        alphabet = attrs.get("alphabet")

        if value and alphabet:
            line, column = _at(gen, "value")
            self._error(
                "TDC098",
                '<gen type="symbol"> accepts either "value" or "alphabet", not both',
                'Use value="[a-z]" for an inline set, or alphabet="cyrillic.ru.letters" for a '
                "named one.",
                line,
                column,
            )
            return
        if not value and not alphabet:
            # Neither an inline set nor a named one: there is nothing to draw a character from,
            # and the generator would produce empty strings for the whole run.
            self._error(
                "TDC098",
                '<gen type="symbol"> requires a "value" (inline set) or "alphabet" (named)',
                'Use value="[a-z]" for an inline set, or alphabet="cyrillic.ru.letters" for a '
                "named one.",
                _line(gen),
                _column(gen),
            )
            return
        if alphabet and not checks.is_known_alphabet(alphabet):
            line, column = _at(gen, "alphabet")
            self._error(
                "TDC099",
                f'unknown alphabet "{alphabet}"',
                f"Known alphabets: {', '.join(checks.alphabet_names())}.",
                line,
                column,
            )

    def _check_sequential_repeat(self, gen, attrs: dict[str, str]) -> None:
        """``repeat=`` together with ``order="sequential"``.

        Each attribute is well defined alone and undefined together, and the engines proved it
        by disagreeing: engine 1 gave the row several elements that were all the SAME value and
        never advanced, engines 2 and 3 dropped the repeat list and emitted one walking value.
        ``check`` called that valid, so the author got data that looks plausible, is wrong, and
        is wrong differently depending on which engine answered.

        Refusing costs no working feature — there was none. Making the combination mean the
        obvious thing (the row's elements walk the list) means threading an element index
        through the length-quota layout in three engines, which is a feature with its own
        design, not a patch.
        """
        if (attrs.get("order") or "").strip() != "sequential":
            return
        repeat = (attrs.get("repeat") or "").strip()
        if not repeat:
            return
        # Point at `repeat=`: a walked column is what the author asked for and can keep.
        line, column = _at(gen, "repeat")
        self._error(
            "TDC254",
            f'repeat="{repeat}" cannot be combined with order="sequential"',
            "A walked list and a repeating list are two different columns, and together they "
            "have no one answer — the engines disagree about what they produce. Keep "
            'order="sequential" for a column that walks its source one value per row, or keep '
            "repeat= for several drawn values per row.",
            line,
            column,
        )

    def _check_timeseries(self, gen, attrs: dict[str, str], type_: str | None) -> None:
        """``peak_at=`` — which row the seasonal wave is highest on.

        A wave is ``amplitude·cos(2π·(i − peak)/period)``, so ``peak_at`` names the row it
        peaks on. Without it the peak sits a quarter period in, which is where a plain sine
        already peaked — and for a year of daily rows that is early April, the one season
        nobody means by "warmer in summer".

        It is a ROW, not a shift, because the row is what the author knows: 182 of 365 is the
        first of July. Same unit as ``period``, which is also counted in rows.
        """
        if type_ != "timeseries" or attrs.get("peak_at") is None:
            return
        raw = (attrs.get("peak_at") or "").strip()
        line, column = _at(gen, "peak_at")

        try:
            float(raw)
        except ValueError:
            self._error(
                "TDC252",
                f'peak_at="{raw}" is not a number',
                "peak_at is the row the seasonal wave peaks on, counted like period= — "
                'peak_at="182" over period="365" puts the peak at the first of July.',
                line,
                column,
            )
            return

        # A wave needs a length before it can have a highest point. Without `period` there is
        # no wave at all, so `peak_at` would be read by nobody.
        period_raw = (attrs.get("period") or "").strip()
        try:
            period = float(period_raw) if period_raw else 0.0
        except ValueError:
            period = 0.0
        if period <= 0:
            self._error(
                "TDC253",
                f'peak_at="{raw}" has no period= on the same <gen> — there is no wave to '
                "place a peak on",
                "Add period= (the length of one season, in rows), or remove peak_at=.",
                line,
                column,
            )

    def _check_date(self, gen, attrs: dict[str, str], type_: str | None) -> None:
        if type_ != "date":
            return
        # `of=` makes this an OFFSET rather than a draw: a different set of attributes configures
        # it, and a different set of mistakes is possible. Its own checks REPLACE the ones below
        # rather than joining them — everything here is about how a draw is bounded, so it would
        # be a second complaint about the same attribute, naming a rule that no longer applies.
        if (attrs.get("of") or "").strip():
            self._check_date_offset(gen, attrs)
            return
        # `from=` alone is an OPEN axis when the range is WALKED: the end of such an axis is
        # start + count x step, a consequence rather than an input. On a DRAWN date one end
        # genuinely means nothing, and that is what this refuses.
        walked = (attrs.get("order") or "").strip() == "sequential"
        open_axis = walked and attrs.get("from") is not None and attrs.get("to") is None
        if not open_axis and (attrs.get("from") is not None) != (attrs.get("to") is not None):
            self._error(
                "TDC150",
                '<gen type="date"> requires both "from" and "to" when either is used',
                'Use from="2020-01-01" to="2025-12-31", or value="2020-01-01..2025-12-31".',
                _line(gen),
                _column(gen),
            )
        local = attrs.get("local")
        if local is not None and local.strip() and not checks.is_known_date_locale(local):
            line, column = _at(gen, "local")
            self._error(
                "TDC153",
                f'unknown date locale "{local}"',
                "A date locale has to be translated deliberately — month names inflect.",
                line,
                column,
            )
        self._check_env_locale_has_dates(gen, attrs)
        self._check_date_step(gen, attrs)
        self._check_date_weekdays(gen, attrs)
        self._check_date_common(gen, attrs)
        self._check_date_values(gen, attrs)

    #: Tokens whose OUTPUT is words rather than digits, plus the ``L`` family, whose layout is
    #: itself a per-locale fact (``M/D/YYYY`` against ``D.M.YYYY``).
    _LOCALE_TOKENS = re.compile(r"MMMM|MMM|dddd|ddd|L")

    def _check_env_locale_has_dates(self, gen, attrs: dict[str, str]) -> None:
        """``<env local="af">`` with a date the run will render in ENGLISH.

        The same value is refused outright on ``<gen type="date" local="af">`` (TDC153) and was
        silently downgraded here. Refusing it on ``<env local=>`` would be wrong — a locale can
        be a perfectly good source of NAMES and still ship no month names, and refusing would
        forbid the Afrikaans name pack because Afrikaans dates are missing.

        So this warns, and only when the format actually reads the locale. ``YYYY-MM-DD`` is the
        same in every language and says nothing; a missing ``format=`` does, because the default
        ``L`` is a layout the locale chooses. Bracketed text is stripped first: ``[LL]`` is a
        literal, not a token.
        """
        if not self.locale or checks.is_known_date_locale(self.locale):
            return
        if attrs.get("local") is not None:
            return  # its own local= is TDC153's business
        fmt = attrs.get("format")
        if fmt is not None and fmt.strip():
            outside = re.sub(r"\[[^\]]*\]", "", fmt)
            if not self._LOCALE_TOKENS.search(outside):
                return
        self._warn(
            "TDC272",
            f'<env local="{self.locale}"> ships no date translations, so this date renders in '
            "English",
            f"Date locales: {', '.join(date_locales.NAMES)}. Use format=\"YYYY-MM-DD\" "
            "\u2014 or any format without month or weekday names \u2014 to get the same text in "
            "every language, or accept the English month names.",
            _line(gen),
            _column(gen),
        )

    def _check_date_step(self, gen, attrs: dict[str, str]) -> None:
        """``step=`` on a walked date axis: what it may say, and that anything reads it."""
        if attrs.get("step") is None:
            return
        raw = (attrs.get("step") or "").strip()
        line, column = _at(gen, "step")

        parsed = calendar.parse_step(raw)
        if not parsed.ok:
            # The two failures read differently because they ARE different: one is a spelling
            # nobody meant, the other a step whose meaning would depend on which half was applied
            # first.
            mixed = parsed.reason == "mixed"
            self._error(
                "TDC247",
                (
                    f'step="{raw}" mixes a calendar unit with a fixed one'
                    if mixed
                    else f'step="{raw}" is not a step this engine can walk'
                ),
                (
                    'A month is 28 to 31 days, so "one month and fifteen days" depends on '
                    "which is applied first. Write one or the other: 45d, or 1mo."
                    if mixed
                    else f'Write {calendar.STEP_SYNTAX}. A bare number means days, so step="2" is '
                    "every other day."
                ),
                line,
                column,
            )
            return

        if (attrs.get("order") or "").strip() != "sequential":
            self._error(
                "TDC248",
                f'step="{raw}" has no order="sequential" on the same <gen> — nothing walks the '
                "range",
                'Add order="sequential" to walk the range one step at a time, or remove step= and '
                "let the dates be drawn at random.",
                line,
                column,
            )

    def _check_date_weekdays(self, gen, attrs: dict[str, str]) -> None:
        """``weekdays="mon..fri"`` — which weekdays a walked axis keeps.

        A FILTER, not a step: the spacing stops being even, since Friday to Monday is a three-day
        jump. That is why it is a separate attribute — one word for both operations would stop
        them being combinable, and "every 15 minutes, but only on working days" is exactly what
        gets asked for.
        """
        if attrs.get("weekdays") is None:
            return
        raw = (attrs.get("weekdays") or "").strip()
        line, column = _at(gen, "weekdays")

        if calendar.parse_weekdays(raw) is None:
            self._error(
                "TDC249",
                f'unknown weekday in weekdays="{raw}"',
                f'Names are {", ".join(calendar.WEEKDAY_NAMES)} — a span like "mon..fri" or a '
                'list like "sun,wed".',
                line,
                column,
            )
            return

        if (attrs.get("order") or "").strip() != "sequential":
            self._error(
                "TDC248",
                f'weekdays="{raw}" has no order="sequential" on the same <gen> — nothing walks '
                "the range",
                'Add order="sequential" to walk the range and keep only these days, or remove '
                "weekdays= and let the dates be drawn at random.",
                line,
                column,
            )
            return

        step = calendar.parse_step(attrs.get("step"))
        if step.step is not None and calendar.fixes_weekday(step.step):
            # Two different reasons wear one code, and they must not wear one sentence.
            #
            # A whole number of weeks really does land on the same weekday every time, so the
            # filter matches every row or none. Measured on the STEP rather than on its spelling,
            # so `14d` is caught as surely as `2w`.
            #
            # A CALENDAR step does not: 15 January 2026 is a Thursday, 15 February a Sunday,
            # 15 March a Sunday, 15 April a Wednesday. The combination is still refused — a month
            # holds a different number of days each time — but for its own reason.
            written = (attrs.get("step") or "").strip()
            whole_weeks = step.step.months == 0
            self._error(
                "TDC250",
                (
                    f'weekdays="{raw}" cannot narrow step="{written}" — that step already fixes '
                    "the weekday"
                    if whole_weeks
                    else f'weekdays="{raw}" cannot narrow step="{written}" — a calendar step is '
                    "not measured in days"
                ),
                (
                    "A whole number of weeks lands on the same weekday every time, so this would "
                    "match every row or none. Use a step that is not a multiple of a week, or "
                    "drop weekdays=."
                    if whole_weeks
                    else "A month and a year hold a different number of days each time, so which "
                    "rows survive the filter follows the calendar rather than anything written "
                    "here. Use a step measured in days or hours, or drop weekdays=."
                ),
                line,
                column,
            )

    def _check_date_values(self, gen, attrs: dict[str, str]) -> None:
        """The dates themselves parse.

        Without this a ``from="notadate"`` reached the generator and failed there, which is a
        crash at render time instead of a diagnostic at validation time — and the reference
        reports it here.
        """
        try:
            if attrs.get("from") is not None and attrs.get("to") is not None:
                date_parse.date_time(attrs["from"])
                date_parse.date_time(attrs["to"])
            if attrs.get("range") is not None:
                date_parse.value_range(attrs["range"])
            value = (attrs.get("value") or "").strip()
            if value:
                self._check_date_value(value)
            if value == "birth":
                date_gen.build_plan({**attrs, "value": "birth"}, self.locale, 0)
        except (ValueError, OSError) as e:
            # Whichever attribute the reader would look at first — the complaint is about the
            # span, and pointing at one of its two ends names only half of it.
            line, column = _at(gen, _primary_date_attr(attrs))
            self._error(
                "TDC151",
                str(e),
                'Examples: value="2020-01-01..2025-12-31", value="birth", value="today", '
                'or value="now".',
                line,
                column,
            )

    @staticmethod
    def _check_date_value(value: str) -> None:
        """A ``value=`` that is a date, a range, or one of the words the generator knows."""
        if value in ("birth", "today", "now"):
            return
        if ".." in value:
            date_parse.value_range(value)
            return
        date_parse.date_time(value)

    def _check_date_common(self, gen, attrs: dict[str, str]) -> None:
        """The attributes every date-shaped generator shares: its format and its precision.

        Also reached from the pack templates ``date.range`` and ``person.b_day``, which are dates
        wearing a different address and would otherwise skip these checks entirely.
        """
        fmt = attrs.get("format")
        if fmt is not None:
            try:
                date_formatter.check_format(fmt)
            except ValueError as e:
                line, column = _at(gen, "format")
                self._error(
                    "TDC152",
                    str(e),
                    "Use Moment-like tokens such as YYYY-MM-DD, DD.MM.YYYY, L, LL, or bracket "
                    "literals [text].",
                    line,
                    column,
                )
        if attrs.get("precision") is not None:
            try:
                date_gen.parse_precision(attrs["precision"], Precision.DAY)
            except ValueError as e:
                line, column = _at(gen, "precision")
                self._error("TDC154", str(e), "Supported: day, second, millisecond.", line, column)

    def _check_birth_ages(self, gen, attrs: dict[str, str]) -> None:
        """``oldest``/``youngest`` on a birth date: whole ages, and in that order."""
        try:
            date_gen.build_plan({**attrs, "value": "birth"}, self.locale, 0)
        except ValueError as e:
            # Whichever attribute the reader would look at first — the complaint is about the
            # span, and pointing at one of its two ends names only half of it.
            line, column = _at(gen, _primary_date_attr(attrs))
            self._error("TDC151", str(e), "", line, column)

    def _check_date_templates(self, gen, attrs: dict[str, str], type_: str | None) -> None:
        """``date.range`` and ``person.b_day``: pack addresses that are date generators.

        They take the same attributes and can be wrong in the same ways, so they are checked the
        same way rather than passing through as ordinary template lookups.
        """
        if type_ != "template":
            return
        path = attrs.get("value", "").strip()
        if path == "date.range":
            range_attr = attrs.get("range")
            if range_attr is None:
                self._error(
                    "TDC072",
                    '<gen value="date.range"> requires a "range" attribute',
                    'Syntax: range="YYYY.MM.DD - YYYY.MM.DD".',
                    _line(gen),
                    _column(gen),
                )
                return
            try:
                date_parse.legacy_range(range_attr)
                self._check_date_common(gen, attrs)
            except ValueError as e:
                line, column = _at(gen, "range")
                self._error(
                    "TDC073",
                    str(e),
                    'Expected two valid dates in "YYYY.MM.DD - YYYY.MM.DD" form.',
                    line,
                    column,
                )
            return
        if path == "person.b_day":
            self._check_date_common(gen, attrs)
            self._check_birth_ages(gen, attrs)

    def _check_counter(self, gen, attrs: dict[str, str], type_: str | None) -> None:
        """``value=`` and ``step=`` on a counter have to be numbers."""
        if type_ not in ("increment", "decrement"):
            return
        for name in ("value", "step"):
            raw = attrs.get(name)
            if raw is None:
                continue
            try:
                v = float(raw.strip())
                if v != v or v in (float("inf"), float("-inf")):
                    raise ValueError
            except ValueError:
                line, column = _at(gen, name)
                self._error(
                    "TDC090", f'invalid {name} "{raw}" — expected a number', "", line, column
                )

    def _check_accumulate(self, gen, attrs: dict[str, str], repeats: bool) -> None:
        """``accumulate=`` needs a list, and its op is one of a short closed set."""
        if attrs.get("accumulate") is None:
            return
        line, column = _at(gen, "accumulate")
        try:
            accumulate_gen.parse(attrs)
        except accumulate_gen.AccumulateError as e:
            self._error(
                "TDC238",
                str(e),
                "accumulate= keeps a running total across a repeat list. One of: "
                + ", ".join(accumulate_gen.OPS)
                + ".",
                line,
                column,
            )
        # `type="running"` accumulates down a COLUMN, so it carries the same word with no
        # list in sight. Only the list flavour needs `repeat`.
        if not repeats and attrs.get("type") != "running":
            self._error(
                "TDC237",
                '"accumulate" has no effect without "repeat"',
                "accumulate= turns the values of a repeat list into a running total, so there "
                'has to be a list. Add repeat="N", or drop accumulate=.',
                line,
                column,
            )

    def _check_repeat(self, gen, attrs: dict[str, str], type_: str | None) -> None:
        try:
            repeats = checks.has_repeat(attrs)
        except ValueError as e:
            line, column = _at(gen, "repeat")
            self._error(
                "TDC195",
                str(e),
                'Use repeat="3" for a fixed count or repeat="1..5" for a range (0 to 64).',
                line,
                column,
            )
            self._check_accumulate(gen, attrs, True)
            return

        self._check_accumulate(gen, attrs, repeats)

        if repeats:
            reason = checks.repeat_unsupported_reason(type_)
            if reason is not None:
                line, column = _at(gen, "repeat")
                self._error(
                    "TDC204",
                    f'"repeat" is not supported on <gen type="{type_}"> — {reason}',
                    "Its value comes from the row index, which a variable-length list makes "
                    "unknowable.",
                    line,
                    column,
                )
        elif attrs.get("separator") is not None:
            # A separator with nothing to separate is a request that silently does nothing.
            line, column = _at(gen, "separator")
            self._error(
                "TDC198",
                '"separator" has no effect without "repeat"',
                'separator joins the values a repeating gen produces. Add repeat="N", or drop it.',
                line,
                column,
            )

    def _check_running(self, gen, attrs: dict[str, str], type_: str | None) -> None:
        """Everything a running total cannot do without.

        Two things have to hold before the engine sees it, and neither is discoverable from
        the row it stands on: it has to say WHAT to accumulate and HOW, and the column it
        reads has to be declared ABOVE it — the same rule ``parent=`` follows.
        """
        if type_ != "running":
            return
        line, column = _line(gen), _column(gen)
        if not (attrs.get("of") or "").strip():
            self._error(
                "TDC239",
                '<gen type="running"> does not say what to accumulate',
                'Name the column it adds up: of="Delta". A running total reads another '
                "sequence — it draws nothing of its own.",
                line,
                column,
            )
        if not (attrs.get("accumulate") or "").strip():
            self._error(
                "TDC239",
                '<gen type="running"> does not say how to accumulate',
                'Add accumulate="…" — one of: ' + ", ".join(accumulate_gen.OPS) + ".",
                line,
                column,
            )
        # `of=` and `reset=` both read a column, so both take the declaration-order rule.
        # Reported separately: naming the wrong one would send the reader to the wrong
        # attribute.
        for name in ("of", "reset"):
            value = (attrs.get(name) or "").strip()
            if not value or value in self.declared_order:
                continue
            at_line, at_column = _at(gen, name)
            self._error(
                "TDC240",
                f'{name}="{value}" is not a sequence declared above this one',
                "A running total is built from a column that already exists, so the column "
                "it reads has to come first."
                if not self.declared_order
                else "Declared above: " + ", ".join(self.declared_order) + ".",
                at_line,
                at_column,
            )

    def _check_stat(self, gen, attrs: dict[str, str], type_: str | None) -> None:
        """Everything a statistic cannot do without.

        The same two things a running total needs, for the same two reasons: it has to say WHAT
        to summarise and WHICH statistic, and the column it reads has to be declared ABOVE it.
        The declaration-order complaint is TDC240, shared with ``running`` on purpose — the same
        rule with the same fix.
        """
        if type_ != "stat":
            return
        line, column = _line(gen), _column(gen)
        of = (attrs.get("of") or "").strip()
        if not of:
            self._error(
                "TDC262",
                '<gen type="stat"> does not say what to summarise',
                'Name the column it reads: of="Price". A statistic reads another sequence — it '
                "draws nothing of its own.",
                line,
                column,
            )
        raw_op = (attrs.get("op") or "").strip()
        if not raw_op:
            self._error(
                "TDC262",
                '<gen type="stat"> does not say which statistic',
                'Add op="…" — one of: ' + ", ".join(stat_gen.OPS) + ".",
                line,
                column,
            )
        else:
            try:
                stat_gen.parse_op(attrs)
            except stat_gen.StatError as err:
                at_line, at_column = _at(gen, "op")
                # This Diagnostic carries no suggestion field, so the near name goes in the
                # hint — the fixtures pin severity, code and position, never wording.
                near = _nearest(raw_op, stat_gen.OPS)
                hint = "One of: " + ", ".join(stat_gen.OPS) + "."
                if near:
                    hint = f'Did you mean "{near}"? ' + hint
                self._error("TDC262", str(err), hint, at_line, at_column)
        try:
            stat_gen.parse_decimals(attrs)
        except stat_gen.StatError as err:
            at_line, at_column = _at(gen, "decimals")
            self._error(
                "TDC262",
                str(err),
                "decimals= rounds the answer. A mean, a median and a standard deviation are "
                "ratios and print in full without it; sum, min and max keep the exact scale of "
                "the column.",
                at_line,
                at_column,
            )
        if of and of not in self.declared_order:
            at_line, at_column = _at(gen, "of")
            self._error(
                "TDC240",
                f'of="{of}" is not a sequence declared above this one',
                "A statistic is built from a column that already exists, so the column it reads "
                "has to come first."
                if not self.declared_order
                else "Declared above: " + ", ".join(self.declared_order) + ".",
                at_line,
                at_column,
            )

    #: Attributes that place a date generator's OWN draw, and so say nothing once `of=` has
    #: placed it relative to another column. Listed by name because ignoring them is exactly the
    #: failure this exists to prevent — a config that says from="2026-06-01" and gets January
    #: dates is right about what it asked for and wrong about what it got.
    _DRAW_ATTRS = ("value", "from", "to", "range", "oldest", "youngest", "order", "step")

    def _check_date_offset(self, gen, attrs: dict[str, str]) -> None:
        """Everything a date offset needs said, and nothing that contradicts it.

        The declaration-order complaint is TDC240, shared with ``running`` and ``stat`` — the
        same rule, the same fix, and the offset is built in declaration order for the same
        reason they are: it reads a column that has to exist already.
        """
        of = (attrs.get("of") or "").strip()
        plus = (attrs.get("plus") or "").strip()
        if not plus:
            self._error(
                "TDC264",
                f'<gen type="date" of="{of}"> does not say how far from it',
                f'Add plus="…" — {calendar.OFFSET_SYNTAX}. A range is drawn per row, so '
                'plus="3..10d" is the length of the stay; a single value is the same distance '
                "on every row.",
                _line(gen),
                _column(gen),
            )
        else:
            parsed = calendar.parse_offset(plus)
            if not parsed.ok:
                at_line, at_column = _at(gen, "plus")
                if parsed.reason == "order":
                    message = (
                        f'plus="{plus}" counts down, not up — the low bound is above the high one'
                    )
                    hint = (
                        "Write the smaller number first. To measure BACKWARDS, make both "
                        'negative: plus="-10..-3d".'
                    )
                else:
                    message = f'plus="{plus}" is not an offset'
                    hint = f"One of: {calendar.OFFSET_SYNTAX}. A bare number means days."
                self._error("TDC264", message, hint, at_line, at_column)

        for name in self._DRAW_ATTRS:
            if attrs.get(name) is None:
                continue
            at_line, at_column = _at(gen, name)
            self._error(
                "TDC264",
                f'{name}= is not read when the date is measured from of="{of}"',
                f"An offset lands wherever {of} plus the offset lands — {name}= would have to "
                f"contradict that to mean anything. Drop it, or drop of= and bound the draw "
                f"itself.",
                at_line,
                at_column,
            )

        if of and of not in self.declared_order:
            at_line, at_column = _at(gen, "of")
            near = _nearest(of, self.declared_order)
            hint = (
                "A date is measured from a column that already exists, so the column it reads "
                "has to come first."
                if not self.declared_order
                else "Declared above: " + ", ".join(self.declared_order) + "."
            )
            if near:
                hint = f'Did you mean "{near}"? ' + hint
            self._error(
                "TDC240",
                f'of="{of}" is not a sequence declared above this one',
                hint,
                at_line,
                at_column,
            )

    def _check_weight(self, gen, attrs: dict[str, str], type_: str | None) -> None:
        weight = attrs.get("weight")
        if weight is None or not weight.strip():
            return
        line, column = _at(gen, "weight")
        if type_ != "file":
            self._error(
                "TDC211",
                f'"weight" applies to <gen type="file">, not type="{type_ or ""}"',
                "For inline values, percent= states the shares.",
                line,
                column,
            )
            return
        if not (attrs.get("column") or "").strip():
            self._error(
                "TDC212",
                '"weight" needs "column" — the weights live in a second CSV column',
                "Name the value column too.",
                line,
                column,
            )
        if attrs.get("order") is not None:
            self._error(
                "TDC213",
                '"weight" cannot be combined with "order" — that walks rows by position, not by '
                "share",
                "Drop one of them.",
                line,
                column,
            )

    def _check_imperfections(self, gen, attrs: dict[str, str], type_: str | None) -> None:
        """``missing="p"`` and ``anomaly="p"``: a probability, and something to spend it on.

        Both were parsed only where they are used, deep in the sequence builder, so ``check``
        called a config valid and the run then stopped on ``anomaly="10x"``. A check that passes
        what the very next command refuses is worse than no check. The generator keeps its own
        parse as a backstop, for callers who build a gen through the library without validating.

        The second half is a request that would be honoured and still do nothing. An anomaly
        multiplies the selected value by ``anomaly_factor``, so a ``value=`` list with no number
        anywhere in it has nothing to perturb and ten rows come back ordinary with no sign that
        30% of them were meant to be outliers. Only a ``type="text"`` list is judged: it is the
        only source whose whole candidate set is written in the config.
        """
        for key in ("anomaly", "missing"):
            raw = attrs.get(key)
            if raw is None or not raw.strip() or _is_probability(raw):
                continue
            line, column = _at(gen, key)
            self._error(
                "TDC242",
                f'{key}="{raw}" is not a probability — it must be a number in [0, 1]',
                'It is the share of values turned into outliers: anomaly="0.05" spikes one '
                "value in twenty."
                if key == "anomaly"
                else 'It is the share of values blanked: missing="0.1" empties one value in ten.',
                line,
                column,
            )

        raw = attrs.get("anomaly")
        if raw is None or not _is_probability(raw) or float(raw) == 0.0:
            return
        if type_ != "text":
            return
        listed = attrs.get("value")
        if listed is None or not listed.strip():
            return
        if any(_is_number(v.strip()) for v in listed.split(",")):
            return
        line, column = _at(gen, "anomaly")
        self._error(
            "TDC243",
            f'anomaly="{raw}" has nothing to perturb — no value in "{listed}" is a number',
            "An anomaly multiplies a numeric value by anomaly_factor, so a list of words comes "
            "back unchanged. Put the anomaly on a numeric generator, or drop it.",
            line,
            column,
        )

    def _check_case_and_order(self, gen, attrs: dict[str, str]) -> None:
        """``case=`` and ``order=`` take one of a short list, and nothing else."""
        transform = attrs.get("case")
        if transform is not None and not transforms.is_case_transform(transform):
            line, column = _at(gen, "case")
            self._error(
                "TDC190",
                f'unknown case "{transform}"',
                f"Supported: {', '.join(transforms.CASE_TRANSFORMS)}.",
                line,
                column,
            )
        order = attrs.get("order")
        if order is not None and order not in ("random", "sequential"):
            line, column = _at(gen, "order")
            self._error(
                "TDC191",
                f'unknown order "{order}"',
                "Supported: random (the default), sequential.",
                line,
                column,
            )

    # ── shared shapes ───────────────────────────────────────────────────────────────────────

    def _check_closed_tag_attrs(self, tag: str, attrs, line: int, column: int) -> None:
        """Every attribute on a closed tag, checked against what that tag actually reads."""
        known = CLOSED_TAG_ATTRIBUTES.get(tag)
        if known is None:
            return
        for key in _attrs(attrs):
            if key not in known:
                where = _at_attrs(attrs, key, line, column)
                self._error(
                    "TDC015",
                    f'<{tag}> does not read "{key}" — it is ignored',
                    f"Attributes of <{tag}>: {', '.join(sorted(known))}.",
                    where[0],
                    where[1],
                )

    def _check_case_gen_if(self, gen_el) -> None:
        """``if=`` on a ``<gen>`` inside a ``<case>`` — accepted by the grammar, read by nothing.

        A case body is several parts JOINED into one value, so a condition on one part has no
        answer to give: if it were false, the part would have to become something, and there is
        no honest candidate. The branch already carries its own condition. It used to be
        accepted and ignored, so the value appeared on EVERY row — including the ones the
        condition excluded — from a config ``check`` had called valid.
        """
        if _attrs(gen_el.attr()).get("if") is None:
            return
        line, column = _at(gen_el, "if")
        self._error(
            "TDC269",
            "if= is not read on a <gen> inside a <case>: a case body is several parts joined, "
            "so a condition on one part has no value to fall back to",
            'Put the condition on the branch \u2014 <case if="\u2026"> \u2014 or move the <gen> '
            "into a <sequence> of its own, where a false condition falls through to the next "
            "<gen>.",
            line,
            column,
        )

    def _check_case_gen_flag(self, gen_el) -> None:
        """A ``<gen>`` written inside a ``<case>``.

        ``anomaly_flag="NAME"`` mints a ground-truth column beside a sequence's value. A case
        body is a CONCATENATION of parts, so a flag written on one part describes that part
        rather than the row, and there is no honest column to mint. ``<mix flag="NAME">`` asks
        the same question where it has an answer. Until this check the attribute was accepted
        here and did nothing, and the only sign was ``${{NAME}}`` reaching the data as literal
        characters.
        """
        flag = _attrs(gen_el.attr()).get("anomaly_flag")
        if flag is None:
            return
        line, column = _at(gen_el, "anomaly_flag")
        self._error(
            "TDC246",
            f'anomaly_flag="{flag.strip()}" is not read on a <gen> inside a <case>',
            "A case body is several parts joined, so a flag on one part does not describe the "
            'row. Put flag="NAME" on the <mix> instead, or move the <gen> into a <sequence> of '
            "its own.",
            line,
            column,
        )

    def _check_case_body(self, case_el) -> None:
        """What may sit inside a ``<case>``: literal text, one generator, or a nested mix.

        A nested mix is checked as a nested one — it contributes a value to the column around it
        and has nowhere of its own to put a flag.
        """
        for child in _elements(case_el):
            if child.dataElement() is not None:
                continue
            self_closing = child.selfClosingElement()
            if self_closing is not None and self_closing.name.text == "gen":
                self._check_case_gen_flag(self_closing)
                self._check_case_gen_if(self_closing)
                continue
            open_el = child.openCloseElement()
            if open_el is None:
                continue
            if open_el.name.text == "mix":
                self._check_mix(open_el, False)
                continue
            if open_el.name.text == "switch":
                # A `<switch>` inside a `<case>` looks its subject up over the rows of that
                # branch. Held to every rule the env-level form is, except that it has no name.
                self._check_switch(open_el, self.declared_order, named=False)
                continue
            if open_el.name.text == "gen":
                self._check_case_gen_flag(open_el)
                self._check_case_gen_if(open_el)
                continue
            self._error(
                "TDC125",
                f'unknown child of <case>: "<{open_el.name.text}>"',
                "Allowed children: data, gen, mix, switch.",
                _line(open_el),
                _column(open_el),
            )

    def _check_percent_mask(
        self,
        mask: str | None,
        value_count: int,
        codes: tuple[str, str, str],
        line: int,
        column: int,
    ) -> None:
        """A percent mask, checked against how many things it is dividing.

        Three different mistakes get three different codes, because they call for three different
        fixes: the wrong number of entries, an entry that is not a share, and shares that do not
        add up. ``codes`` is the trio for length, number and sum, in that order — ``<gen>``,
        ``<mix>`` and ``<switch>`` each have their own.
        """
        if mask is None:
            return
        try:
            percent_mask.expand(mask, value_count)
        except percent_mask.MaskError as e:
            code = {
                percent_mask.Kind.LENGTH: codes[0],
                percent_mask.Kind.NUMBER: codes[1],
                percent_mask.Kind.SUM: codes[2],
            }[e.kind]
            hint = (
                "Percent masks may be shorter than value only when missing positions can be "
                "inferred. They may never be longer than value."
                if e.kind is percent_mask.Kind.LENGTH
                else "Filled positions must be non-negative numbers. Empty positions split the "
                "remaining percent equally."
            )
            self._error(code, str(e), hint, line, column)
        except ValueError as e:
            self._error(codes[2], str(e), "", line, column)

    def _check_map_rows(self, element) -> None:
        """A ``<map>`` body: one ``KEY:VALUE`` per row.

        Entries are separated by commas, and a row with no colon is not a mapping — it would
        otherwise become a key with no value, silently absent from the table the switch reads. A
        warning rather than an error: the rest of the table still works, and the run is worth
        finishing.
        """
        content = getattr(element, "mapContent", None)
        if content is None or not callable(content) or content() is None:
            return
        line = element.start.line
        column = element.start.column
        for row in content().getText().split(","):
            trimmed = row.strip()
            if not trimmed:
                continue
            if ":" not in trimmed:
                self._warn(
                    "TDC136",
                    f'malformed <map> row "{trimmed}" — expected KEY:VALUE',
                    'Each entry is KEY:VALUE, entries separated by commas, multi-key via "|" '
                    "(US|CA:USD).",
                    line,
                    column,
                )

    def _check_data_type(self, body, line: int, column: int) -> None:
        """``type=`` on a ``<data>``: parsable, and on a piece that is actually a column.

        A type on an unnamed ``<data>`` is a request that does nothing — only a named one becomes
        a column, so the declaration would be quietly dropped.
        """
        attrs = _attrs(body.attr())
        raw_type = attrs.get("type")
        if raw_type is None:
            return
        where = _at_attrs(body.attr(), "type", line, column)
        name = attrs.get("name")
        if name is None or not name.strip():
            self._error(
                "TDC194",
                f'type="{raw_type}" has no name — only a named <data> becomes a column',
                'Add name="…" to export this as a typed column, or drop type=.',
                where[0],
                where[1],
            )
            return
        try:
            column_type.parse_output(raw_type)
        except ValueError as e:
            self._error(
                "TDC194",
                str(e),
                "Types: bool, int32, int64, uint8/16/32/64, float, float16, double, string, enum, "
                "date, timestamp, decimal(p,s), uuid, json; []T for a list; |null to allow NULL.",
                where[0],
                where[1],
            )

    def _safe_max_length(self, raw: str) -> int:
        try:
            return regex.parse_max_length(raw)
        except ValueError:
            return self.document_regex_max_length

    # ── block ───────────────────────────────────────────────────────────────────────────────

    def _check_block(self, block) -> None:
        # These two were missed when the other containers were closed: an invented
        # tag in either passed in silence while the same tag one level up did not.
        self._check_children(block.content(), "block", BLOCK_CHILDREN, "TDC013")
        for child in _elements(block):
            open_el = child.openCloseElement()
            if open_el is not None and open_el.name.text == "line":
                self._check_children(open_el.content(), "line", LINE_CHILDREN, "TDC013")
                self._check_line(open_el)

    def _check_line(self, line_el) -> None:
        """A ``<line>`` holds text, and only text.

        The block describes the shape of the output, not where values come from. A generator placed
        here would produce a value nothing else could reference, and a construct like a switch
        would be building a column in the middle of a layout.
        """
        self._check_closed_tag_attrs("line", line_el.attr(), _line(line_el), _column(line_el))
        # `if=` sits on the <line> as well as on each <data> inside it, and an unparsable one has
        # to be caught in both places or a whole line silently never renders.
        # `_item` and `_item_id` exist only while a line walks a list, and both the line's own
        # condition and every <data> inside it may name them.
        walks_a_list = _attrs(line_el.attr()).get("each") is not None
        line_condition = _attrs(line_el.attr()).get("if")
        if line_condition is not None:
            where = _at_attrs(line_el.attr(), "if", _line(line_el), _column(line_el))
            self._check_if_expression(line_condition, where[0], where[1])
            self.pending_expressions.append(
                (len(self.diagnostics), line_condition, where[0], where[1], walks_a_list)
            )
        each = _attrs(line_el.attr()).get("each")
        if each is not None:
            line, column = _at(line_el, "each")
            if not each.strip():
                self._error(
                    "TDC206",
                    'each="" names no sequence',
                    "Give it the name of a repeating sequence, or drop the attribute.",
                    line,
                    column,
                )
            elif each in self.declared_names and each not in self.repeating_names:
                # Walking a scalar would emit one line and look like it worked, which is the kind
                # of near-miss that survives review.
                self._error(
                    "TDC207",
                    f'each="{each}" — that sequence holds one value, not a list',
                    'Add repeat= to its <gen>, e.g. repeat="1..5", or drop each=.',
                    line,
                    column,
                )
            # A typed column is collected once per record, and an each= line emits several. The two
            # cannot both be true, so the column would silently take whichever element came last.
            for child in _elements(line_el):
                data = child.dataElement()
                if data is None or not _has_body(data):
                    continue
                column_name = _attrs(data.attr()).get("name")
                if column_name is not None and column_name.strip():
                    self._error(
                        "TDC209",
                        f'a named <data name="{column_name}"> cannot sit inside an each= line',
                        "Typed columns are collected once per card. For columnar output keep the "
                        'list as a list column (type="[]…"); each= is for text and SQL.',
                        line,
                        column,
                    )

        for child in _elements(line_el):
            self_closing = child.selfClosingElement()
            if self_closing is not None and self_closing.name.text == "gen":
                self._error(
                    "TDC131",
                    "a <gen> is not allowed inside <line> — the output block is for formatting "
                    "only",
                    "Declare it as a <sequence> in <env> and reference it with ${{Name}}.",
                    _line(self_closing),
                    _column(self_closing),
                )
                continue
            data = child.dataElement()
            if data is not None and _has_body(data):
                self._check_closed_tag_attrs("data", data.attr(), _line(line_el), _column(line_el))
                self._check_data_type(data, _line(line_el), _column(line_el))
                # The <data> element, not the <line> around it: several <data> pieces can share a
                # line, and pointing at the line would name the wrong one whenever they do.
                self._check_interpolation(_data_text(data), data.start.line, data.start.column)
                condition = _attrs(data.attr()).get("if")
                if condition is not None:
                    where = _at_attrs(data.attr(), "if", _line(line_el), _column(line_el))
                    self._check_if_expression(condition, where[0], where[1])
                    self.pending_expressions.append(
                        (len(self.diagnostics), condition, where[0], where[1], walks_a_list)
                    )
                continue
            open_el = child.openCloseElement()
            if open_el is not None and open_el.name.text != "data":
                self._error(
                    "TDC132",
                    f"a <{open_el.name.text}> is not allowed inside <line> — the output block is "
                    "for formatting only",
                    "Move it into <env>.",
                    _line(open_el),
                    _column(open_el),
                )

    def _check_interpolation(self, text: str, line: int, column: int) -> None:
        """Every ``${{…}}`` in a line: the name has to exist, and each filter has to be one.

        A name nobody declared is printed literally, so a typo reaches the output looking like
        data. An unknown filter is simply ignored, so the value comes out unformatted and correct
        enough to pass a glance.
        """
        for m in _INTERPOLATION.finditer(text):
            parts = m.group(1).split("|")
            name = parts[0].strip()
            if name in self.pool_references:
                # A reference draws a whole MEMBER, so it has no single value to print. Without
                # this it reached the output as literal text: a name that exists, resolves to
                # nothing, and says nothing.
                fields = sorted(
                    n[len(name) + 1 :] for n in self.declared_names if n.startswith(f"{name}.")
                )
                shown = ", ".join(f"${{{{{name}.{f}}}}}" for f in fields)
                self._error(
                    "TDC229",
                    f'"{name}" draws a whole member from a pool — it has no value of its own to '
                    "print",
                    f"Read one of its fields: ${{{{{name}.field}}}}."
                    if not fields
                    else f"Read a field: {shown}.",
                    line,
                    column,
                )
                continue
            if name and name not in self.declared_names and not checks.is_builtin(name):
                self._error(
                    "TDC193",
                    f'"{name}" is not a declared sequence — it would be printed literally',
                    "Declare it in <env>, or change the inject= pattern if the text is meant to "
                    "be literal.",
                    line,
                    column,
                )
            for filter_text in parts[1:]:
                colon = filter_text.find(":")
                kind = (filter_text if colon < 0 else filter_text[:colon]).strip()
                arg = None if colon < 0 else filter_text[colon + 1 :]
                # A mask with no pattern has nothing to keep, and the engine answered that
                # literally: it returned the empty string and the column came out blank. Every
                # other bare filter is a whole transform on its own — `upper`, `trim`, `csv` —
                # so this one reads like them and is not.
                if kind == "mask" and (arg is None or not arg.strip()):
                    self._error(
                        "TDC256",
                        'the "mask" filter needs a pattern — ${{X|mask}} empties the column',
                        "Write the pattern after a colon: ${{X|mask:xxx-xx}}. `x` keeps a "
                        "character, `w` keeps a whole word, `*` hides one — see the masks guide.",
                        line,
                        column,
                    )
                    continue
                # The same parse the `mask=` attribute gets. Written as a filter it was reaching
                # the renderer unchecked, which is how a bad index aborted a run with no position.
                if kind == "mask" and arg is not None:
                    try:
                        mask_mod.apply_mask(arg, "")
                    except ValueError as err:
                        self._error(
                            "TDC199",
                            str(err),
                            'Indices are 0-based; ranges use "..", e.g. mask:x[0..3] or '
                            "mask:w[-1], w[0].",
                            line,
                            column,
                        )
                    continue
                if kind and not checks.is_known_filter(kind):
                    self._error(
                        "TDC192",
                        f'unknown interpolation filter "{kind}"',
                        f"Supported: {', '.join(transforms.FILTER_NAMES)}.",
                        line,
                        column,
                    )

    def _check_expression_names(self, expression: str, line: int, column: int, each: bool) -> None:
        """The names an ``if=`` expression uses, checked against what exists.

        An identifier that names no sequence is not an error by itself — it is how a bare word
        works: ``if="Gender == Male"`` compares against the literal ``Male``, and the documentation
        is written that way throughout. What decides is WHERE the identifier sits:

        * the whole condition (``if="Ready"``, ``if="!Ready"``) — a name. An unknown one is its own
          name as a string, which is never empty, so the branch fires on every row.
        * the left of a comparison, and anything arithmetic — a name. An unknown one equals
          nothing, so the branch fires on no row.
        * the right of a comparison — left alone. ``A == B`` is a value comparison when B is
          declared and a bare word when it is not, and both are meant.

        A dot is read the same two ways the engine reads it: ``Person.FirstName`` is a field of a
        compound, ``Gender.Male`` asks whether Gender came out ``Male``. So the root must always
        exist, and the tail is checked only where the root is a compound.
        """
        try:
            parsed = expr_parse(expression)
        except ValueError:
            return  # Already reported as TDC100; there is no tree to walk.
        self._walk_expression_names(parsed, line, column, each, as_name=True)

    def _walk_expression_names(
        self, node, line: int, column: int, each: bool, *, as_name: bool
    ) -> None:
        if isinstance(node, Name):
            if as_name:
                self._check_expression_name(node.value, line, column, each)
            return
        if isinstance(node, Member):
            if as_name:
                self._check_expression_name(node.dotted, line, column, each)
            return
        if isinstance(node, Unary):
            self._walk_expression_names(node.operand, line, column, each, as_name=as_name)
            return
        if isinstance(node, Binary):
            # Each side of && or || is a condition in its own right; arithmetic on a bare word is
            # meaningless, so both sides are names there; on a comparison the right side may be
            # the word to match.
            logical = node.op in ("&&", "||")
            comparison = node.op in COMPARISON_OPERATORS
            self._walk_expression_names(node.left, line, column, each, as_name=True)
            self._walk_expression_names(
                node.right, line, column, each, as_name=logical or not comparison
            )

    def _check_expression_name(self, path: str, line: int, column: int, each: bool) -> None:
        root, _, tail = path.partition(".")
        known = (
            root in self.declared_names
            or root in checks.BUILTINS
            or (each and root in ("_item", "_item_id"))
        )
        if not known:
            hint = (
                "A condition that is a bare word is always true. Name a sequence declared in "
                "<env>, or compare against the word: Gender == Male."
                if not tail
                else "Name a sequence declared in <env>. A word on the RIGHT of a comparison is "
                "a literal and needs no declaration."
            )
            self._error(
                "TDC215",
                f'"{path}" is not a declared sequence — the condition reads it as the literal '
                f'text "{path}"',
                hint,
                line,
                column,
            )
            return

        if not tail:
            return

        # On a plain sequence the tail is a VALUE — Gender.Male asks whether Gender came out Male
        # — and where the config says outright what it produces, a value that is not among them
        # makes a branch nothing can take.
        if root not in self.valueless_names:
            values = self.finite_values.get(root)
            if values is None or tail in values:
                return
            self._warn(
                "TDC216",
                f'"{path}" — "{root}" never produces "{tail}", so this branch can never be taken',
                f'"{root}" produces: {", ".join(values)}.',
                line,
                column,
            )
            return
        field = tail.split(".")[0]
        if f"{root}.{field}" in self.declared_names:
            return
        fields = sorted(n[len(root) + 1 :] for n in self.declared_names if n.startswith(f"{root}."))
        self._error(
            "TDC215",
            f'"{path}" is not a field of "{root}" — the condition can never be true',
            f'Fields of "{root}": {", ".join(fields)}.' if fields else f'"{root}" has no fields.',
            line,
            column,
        )

    def _check_if_expression(self, expression: str, line: int, column: int) -> None:
        try:
            parsed = expr_parse(expression)
        except ValueError as e:
            entity = _xml_entity(expression)
            if entity is None:
                message = f'invalid if expression "{_clip(expression)}": {e}'
                hint = "Supported: comparison, && || !, and arithmetic."
            else:
                found, means = entity
                message = (
                    f'invalid if expression "{_clip(expression)}": TDC does not expand '
                    f'XML entities, so "{found}" is {len(found)} literal characters, '
                    f'not "{means}"'
                )
                hint = (
                    f"write {means} directly — the config is XML-shaped but it is not "
                    "XML, and the raw character is what the expression parser reads"
                )
            self._error("TDC100", message, hint, line, column)
            return
        self._check_expr_node(parsed, line, column)

    def _check_expr_node(self, node, line: int, column: int) -> None:
        """Every operator in a parsed condition, checked against the ones the engine implements.

        A parser that is more permissive than the evaluator is a trap: the config is accepted, and
        the operator it asked for is quietly not the operator it gets.
        """
        if isinstance(node, Array):
            # Reached only when nothing marked it as an `in` right-hand side: the
            # Binary branch below checks its own right operand before recursing.
            self._error(
                "TDC259",
                'a [list] is only allowed on the right of "in"',
                "Write Country in [US, CA, MX]. A list has no meaning on its own.",
                line,
                column,
            )
            for item in node.items:
                self._check_expr_node(item, line, column)
            return
        if isinstance(node, Conditional):
            self._check_expr_node(node.test, line, column)
            self._check_expr_node(node.consequent, line, column)
            self._check_expr_node(node.alternate, line, column)
            return
        if isinstance(node, Binary):
            if node.op == "in" and isinstance(node.right, Array):
                # The one place a list belongs; check its items, not the list itself.
                self._check_expr_node(node.left, line, column)
                for item in node.right.items:
                    self._check_expr_node(item, line, column)
                return
            if node.op not in SUPPORTED_BINARY:
                self._error(
                    "TDC101",
                    f'unsupported operator "{node.op}" in if expression',
                    f"Supported binary operators: {' '.join(SUPPORTED_BINARY)}. "
                    f"Functions: {', '.join(EXPR_FUNCTION_NAMES)}. "
                    "Anything an expression cannot say, a <compute> sequence can — it has "
                    "integer division, remainders, string surgery and checksums — and the "
                    "sequence it produces is what if= then compares.",
                    line,
                    column,
                )
            self._check_expr_node(node.left, line, column)
            self._check_expr_node(node.right, line, column)
            return
        if isinstance(node, Call):
            spec = EXPR_FUNCTIONS.get(node.name)
            if spec is None:
                planned = node.name in PLANNED_EXPR_FUNCTIONS
                near = None if planned else _nearest(node.name, EXPR_FUNCTION_NAMES)
                self._error(
                    "TDC257",
                    (
                        f"{node.name}() is not available yet in an if expression"
                        if planned
                        else f'unknown function "{node.name}" in if expression'
                    ),
                    (
                        "TDC computes its own mathematics rather than calling each language's, "
                        "because the libms disagree in the last bit and a comparison turns that "
                        f"bit into a different row. So {node.name} arrives once it has been built "
                        "and pinned to its bits in all five implementations, not before. "
                        f"Available today: {', '.join(EXPR_FUNCTION_NAMES)}."
                        if planned
                        else (f'Did you mean "{near}"? ' if near else "")
                        + f"Available: {', '.join(EXPR_FUNCTION_NAMES)}."
                    ),
                    line,
                    column,
                )
                return
            low, high = spec
            n = len(node.args)
            if n < low or (high is not None and n > high):
                wants = (
                    f"at least {low}"
                    if high is None
                    else (f"exactly {low}" if low == high else f"{low} to {high}")
                )
                self._error(
                    "TDC258",
                    f"{node.name}() takes {wants} argument{'' if high == 1 else 's'}, got {n}",
                    "",
                    line,
                    column,
                )
            if node.name == "at":
                self._check_at_call(node, line, column)
            for arg in node.args:
                self._check_expr_node(arg, line, column)
            return
        if isinstance(node, Computed):
            self._error(
                "TDC103",
                "computed member access is not supported in if expression",
                "Use plain dotted access like Gender.Male or Person.FirstName.",
                line,
                column,
            )
            self._check_expr_node(node.obj, line, column)
            return
        if isinstance(node, Unary):
            if node.op not in SUPPORTED_UNARY:
                self._error(
                    "TDC102",
                    f'unsupported unary operator "{node.op}" in if expression',
                    f"Supported unary operators: {' '.join(SUPPORTED_UNARY)}.",
                    line,
                    column,
                )
            self._check_expr_node(node.operand, line, column)

    def _check_at_call(self, node, line: int, column: int) -> None:
        """``at(subject, index)``, checked before the run rather than during it.

        Both halves are provable from the text alone. A name always resolves to a STRING — a
        ``repeat`` list arrives joined, never as a list — so ``at(Items, 1)`` can only ever answer
        with nothing, and that nothing is indistinguishable from a legitimately short row. An index
        written out as ``-1``, ``1.5`` or ``"one"`` is the same kind of mistake one level down.

        The engine refuses both at run time as well; this is the earlier, better-placed half of the
        same rule, because ``check`` can point at the character.
        """
        subject = node.args[0] if node.args else None
        if subject is not None and _provably_not_a_list(subject):
            self._error(
                "TDC260",
                "at() needs a list, and this argument is a single value",
                "A repeat list reaches an expression as its joined text, so cut it first: "
                'at(split(Items, ","), 1).',
                line,
                column,
            )
        index = node.args[1] if len(node.args) > 1 else None
        bad = _bad_index_literal(index) if index is not None else None
        if bad is not None:
            self._error(
                "TDC261",
                f"at() index must be a whole number of zero or more, not {bad}",
                "Elements count from zero: at(list, 0) is the first. Past the end is empty text "
                "— ask count(list) first.",
                line,
                column,
            )

    # ── placement ───────────────────────────────────────────────────────────────────────────

    def _check_children(
        self,
        content,
        parent: str,
        allowed: frozenset[str],
        code: str = "TDC010",
        shown: frozenset[str] | None = None,
    ) -> None:
        """``allowed`` is what passes; ``shown`` is what the note lists.

        They differ for ``<pool>``, where several tags are refused by a diagnostic of
        their own (TDC230) and so must not be reported here — but must not be offered
        as allowed either.
        """
        listed = ", ".join(sorted(shown if shown is not None else allowed))
        if content is None:
            return
        for child in content.element() or []:
            open_el = child.openCloseElement()
            self_closing = child.selfClosingElement()
            if open_el is not None:
                name, line, column = open_el.name.text, _line(open_el), _column(open_el)
            elif self_closing is not None:
                name, line, column = (
                    self_closing.name.text,
                    _line(self_closing),
                    _column(self_closing),
                )
            elif child.mapElement() is not None:
                name, line, column = "map", 1, 0
            elif child.dataElement() is not None:
                # `<data>` is its own node in the grammar, so this walk used to step over it in
                # silence — which is how `<before><data>x</data></before>` came to validate and
                # render nothing at all. Parents that take a `<data>` have it on `allowed` and
                # pass the check below; the fixtures do not, and now say so.
                data_el = child.dataElement()
                name, line, column = "data", _line(data_el), _column(data_el)
            else:
                continue
            if name in allowed:
                continue
            # Two different mistakes, and two different fixes. A construct this language knows is
            # in the wrong place and needs moving; a tag nobody has heard of is a typo and needs
            # correcting. One code for both would tell the author neither.
            hint = PLACEMENT_HINTS.get(name)
            if hint is not None:
                self._error(
                    "TDC013",
                    f"<{name}> is not allowed directly inside <{parent}>",
                    f"{hint} Allowed inside <{parent}>: {listed}.",
                    line,
                    column,
                )
            elif code == "TDC013":
                # TDC013 means "a tag this language knows, in the wrong place" and
                # TDC010 "a tag nobody has heard of", so the sentence follows the
                # code rather than the call site.
                self._error(
                    "TDC013",
                    f"<{name}> is not allowed directly inside <{parent}>",
                    f"Allowed inside <{parent}>: {listed}.",
                    line,
                    column,
                )
            else:
                self._error(
                    code,
                    f'unknown child of <{parent}>: "<{name}>"',
                    # The note is what a reader acts on, so every container says it the
                    # same way. Containers used to differ twice over: some stayed silent,
                    # and the ones that spoke used three wordings for one mistake.
                    f"Allowed inside <{parent}>: {listed}.",
                    line,
                    column,
                )

    # ── reporting ───────────────────────────────────────────────────────────────────────────

    def _error(self, code: str, message: str, hint: str, line: int, column: int) -> None:
        self.diagnostics.append(Diagnostic.error(code, message, hint, line, column))

    def _warn(self, code: str, message: str, hint: str, line: int, column: int) -> None:
        """Worth saying, not worth stopping for: the run still produces usable data."""
        self.diagnostics.append(Diagnostic.warning(code, message, hint, line, column))


# ── plumbing ────────────────────────────────────────────────────────────────────────────────


def _compare_versions(a: str, b: str) -> int:
    x = a.split(".")
    y = b.split(".")
    for i in range(max(len(x), len(y))):
        xi = int(x[i]) if i < len(x) else 0
        yi = int(y[i]) if i < len(y) else 0
        if xi != yi:
            return -1 if xi < yi else 1
    return 0


def _is_http_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
    except ValueError:
        return False
    return parsed.scheme in ("http", "https") and bool(parsed.hostname)


def _primary_date_attr(attrs: dict[str, str]) -> str:
    """The attribute a date complaint points at, in the order the reference tries them."""
    for name in ("value", "range", "from", "to", "oldest", "youngest"):
        if attrs.get(name) is not None:
            return name
    return "value"


def _split_count(value: str) -> int:
    """How many entries a comma-separated attribute holds."""
    return len(value.split(","))


def _at_attrs(attrs, name: str, line: int, column: int) -> tuple[int, int]:
    """Where an attribute's value sits, for a complaint that is about that value.

    An editor underlines what a diagnostic points at, and a whole tag is not what is wrong when one
    attribute is. The position is the first character INSIDE the quotes, which is where the value
    the message quotes actually begins.

    Falls back to the element when the attribute is absent — a complaint about a missing attribute
    has nowhere better to point.
    """
    for attr in attrs:
        if attr.attrName is not None and attr.attrName.text == name and attr.attrValue is not None:
            text = attr.attrValue.text
            quoted = len(text) >= 2 and text.startswith('"') and text.endswith('"')
            return attr.attrValue.line, attr.attrValue.column + (1 if quoted else 0)
    return line, column


def _at(element, name: str) -> tuple[int, int]:
    return _at_attrs(element.attr(), name, _line(element), _column(element))


def _attrs(attrs) -> dict[str, str]:
    out: dict[str, str] = {}
    for attr in attrs:
        raw = attr.attrValue.text
        out[attr.attrName.text] = raw[1:-1]
    return out


def _child_elements(element) -> list:
    """Every child that is a tag — open-close or self-closing — with `<data>` left out."""
    out: list = []
    for child in _elements(element):
        node = child.openCloseElement() or child.selfClosingElement()
        if node is not None:
            out.append(node)
    return out


def _element_name(node) -> str:
    return node.name.text


def _two_places(value: float) -> str:
    """Two decimals at most, and no trailing zeros — `0.5`, not `0.50`."""
    rounded = round(value, 2)
    return str(int(rounded)) if rounded == int(rounded) else str(rounded)


def _elements(element) -> list:
    content = element.content()
    return [] if content is None else list(content.element() or [])


def _pool_member_nodes(pool) -> list:
    """Every declaration inside a pool, flattened out of any group wrapper."""
    out: list = []
    for member_el in _elements(pool):
        member = member_el.openCloseElement()
        if member is None:
            continue
        tag = member.name.text
        if tag in ("sequence", "mix", "switch"):
            out.append(member)
        elif tag in ("uniq", "distinct"):
            for wrapped_el in _elements(member):
                wrapped = wrapped_el.openCloseElement()
                if wrapped is not None:
                    out.append(wrapped)
    return out


def _member_pool_ref(node) -> str | None:
    """The pool a member draws from, when the member is a ``<gen type="pool">``."""
    for child in _elements(node):
        gen = child.openCloseElement() or child.selfClosingElement()
        if gen is None or gen.name.text != "gen":
            continue
        attrs = _attrs(gen.attr())
        if attrs.get("type") != "pool":
            continue
        return (attrs.get("value") or "").strip()
    return None


def _has_body(data) -> bool:
    content = getattr(data, "dataContent", None)
    return callable(content) and content() is not None


def _data_text(data) -> str:
    """A ``<data>`` body as the user wrote it — the paired-tag pre-pass left a sentinel in it."""
    return paired_data.restore(data.dataContent().getText())


def _line(element) -> int:
    return element.start.line


def _column(element) -> int:
    return element.start.column


def _find(parent, name: str):
    """The first child element with this tag name, at one level down."""
    if parent is None:
        return None
    for child in parent.element() if hasattr(parent, "element") else []:
        open_el = child.openCloseElement()
        if open_el is not None and open_el.name.text == name:
            return open_el
    return None


_PLAIN_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")


def _literal_text_values(member) -> list[str] | None:
    """The literal ``value=`` list of a member whose body is a single plain text gen."""
    gens = []
    for child in _elements(member):
        gen = child.selfClosingElement() or child.openCloseElement()
        if gen is not None and gen.name.text == "gen":
            gens.append(gen)
    if len(gens) != 1:
        return None
    attrs = _attrs(gens[0].attr())
    if "name" in attrs:
        return None
    return _finite_text_values(attrs)


def _is_number(raw: str) -> bool:
    """True when the text is a finite number — the same test the generators apply."""
    try:
        return math.isfinite(float(raw))
    except ValueError:
        return False


def _is_probability(raw: str) -> bool:
    """True when the text is a probability the generators will accept."""
    return _is_number(raw) and 0.0 <= float(raw) <= 1.0


def _finite_text_values(attrs: dict[str, str]) -> list[str] | None:
    """The values a sequence will actually produce, when the config says so outright.

    Only one unnamed ``<gen type="text" value="a,b,c">`` qualifies — a text generator's list is
    always literal, never a file or a pack, so what is written is what comes out.

    Unless something rewrites it. ``case="upper"`` turns ``Male`` into ``MALE`` and
    ``mask="xxxx"`` turns ``Female`` into ``Fema``, so a comparison against the written word would
    then be wrong in both directions — flagging a config that works and accepting one that never
    matches. ``repeat=`` makes the value a list rather than a word. Any of the three, and the
    values stop being knowable from here.
    """
    if attrs.get("type") != "text":
        return None
    if any(key in attrs for key in ("case", "mask", "repeat")):
        return None
    raw = attrs.get("value")
    if raw is None or not raw.strip():
        return None
    return [v.strip() for v in raw.split(",")]


# The most of an attribute value a message will quote. The full text is in the
# config the position already points at; a message quoting 100 KB of it buries
# every other diagnostic in the report. The same limit lives in the other four
# implementations; change them together.
_MESSAGE_ECHO_LIMIT = 120


def _clip(value: str) -> str:
    """An attribute value, cut to fit inside a one-line message."""
    if len(value) <= _MESSAGE_ECHO_LIMIT:
        return value
    hidden = len(value) - _MESSAGE_ECHO_LIMIT
    return f"{value[:_MESSAGE_ECHO_LIMIT]}\u2026 ({hidden} more chars)"
