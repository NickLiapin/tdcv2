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

import dataclasses
import math
import re
from pathlib import Path
from urllib.parse import urlparse

from ..date import calendar
from ..date import formatter as date_formatter
from ..date import gen as date_gen
from ..date import locales as date_locales
from ..date import parse as date_parse
from ..date.plain import Precision
from ..distribution import percent_mask
from ..engine.memory import RESERVED_TEMPLATE_ATTRS
from ..errors import Diagnostic
from ..errors.diagnostic import closest_match
from ..expr import parse as expr_parse
from ..expr.match_key import match_key
from ..expr.parse import (
    NOT_ONE_EXPRESSION,
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
from ..generators import number as number_gen
from ..generators import regex
from ..generators import repeat as repeat_gen
from ..generators import stat as stat_gen
from ..lib import numbers
from ..output import column_type
from ..packs import DataPacks
from ..parser import paired_data
from ..pattern import curve
from ..stats import dist_params
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
#: Attributes the closed-tag pass must stay quiet about, because a check of their own already
#: refuses them with a code that says more. Listed here rather than added to the tag's attribute
#: set: they are NOT attributes of the tag, they are attributes with a better complaint.
_HAS_ITS_OWN_REFUSAL = frozenset({"mix:repeat", "mix:separator"})


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
    # A <data> has no value of its own: it JOINS the value of the thing around it. Written
    # where there is nothing to join — straight into <tdc>, <env>, <block> or <pool> — it
    # rendered nothing and said nothing.
    "data": (
        "A <data> joins the value of the <line>, <sequence> or <case> it sits in — "
        "on its own there is nothing for it to join."
    ),
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
    "clamp": (3, 3),
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
    "gauss": (3, 3),
    "hash": (2, 2),
    "noise": (3, 3),
    "prev": (2, 2),
    "hypot": (2, 2),
    "floor": (1, 1),
    "is_empty": (1, 1),
    "join": (2, 2),
    "len": (1, 1),
    "lerp": (3, 3),
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
ENV_GROUP_CHILDREN = frozenset({"sequence", "mix", "switch"})

# Deliberately generous: too SHORT a list refuses configs that work, while too long a one
# merely leaves a little of the old silence in place.
# No "data". A pool publishes NAMED fields — ${{Ref.a}} — and a bare <data> has no name, so
# nothing can address it. The composed form works one level in, inside the member's <sequence>.
POOL_CHILDREN = frozenset({"sequence", "mix", "switch", "uniq", "distinct"})

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
BLOCK_CHILDREN = frozenset({"line"})
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
def _did_you_mean(name: str) -> str:
    """The `help:` line for a near name, or "" when nothing was near enough."""
    return f'did you mean "{name}"?' if name else ""


def _locales_having(packs, path: str) -> list[str]:
    """The locales that ship this path, sorted — what the refusal offers instead of guessing.

    "The `en` pack ships it" was true and narrow: a path may live in eighty-six locales, and
    naming one told a reader to write `local="en"` when the locale they wanted was there all
    along.
    """
    if packs is None:
        return []
    found = set()
    for address in packs.addresses():
        dot = address.find(".")
        if dot > 0 and address[dot + 1 :] == path:
            found.add(address[:dot])
    return sorted(found)


def _candidates(names, most: int = 6) -> str:
    """A list of allowed names, truncated the way the reference truncates every long one.

    Six then "… (N more)". Printed in full, a fifteen-name list buries the one the reader is
    scanning for, and each implementation cut it at a different place — or not at all.
    """
    names = list(names)
    if len(names) <= most:
        return ", ".join(names)
    return ", ".join(names[:most]) + f", … ({len(names) - most} more)"


#: Attributes whose refusal has a SENTENCE of its own, keyed `tag:attribute`.
#:
#: The generic complaint — check the spelling — is right about a typo and useless about a word
#: written in the wrong place, which is what these are. `count=` on a <gen> is not a misspelling
#: of anything; it is `<env count=>` or `repeat=`, and saying so is the difference between a
#: reader fixing it and a reader hunting for a spelling that was never wrong.
_MISPLACED = {
    "gen:parent": (
        "parent= selects which rows a whole <sequence> or <mix> builds on; move it there. "
        "A <gen> inside one is already filtered by it."
    ),
    # Not a misplacement but the same failure: a word readers reach for that the language
    # spells differently. The nearest accepted string to `phase` is `case`, which sends
    # someone shifting a seasonal wave off to look at branching.
    "gen:phase": (
        "A seasonal wave is shifted with peak_at=, which names the ROW the wave peaks on "
        'rather than an angle: peak_at="182" over period="365" puts the peak at the first '
        "of July."
    ),
    # `count` belongs to <env> (rows in the run) and to <pool> (members in the table). On a
    # <gen> nothing reads it, and it looks exactly like a way to ask for several values —
    # which is `repeat=`.
    "gen:count": (
        "count= is the size of the run on <env> and the size of the table on <pool>. "
        "For several values in ONE row use repeat=."
    ),
    # `flag` names the ground-truth column of a <mix>. The nearest thing on a <gen> is
    # anomaly_flag=, and someone reaching for `flag` there wants it.
    "gen:flag": (
        "flag= names the branch-recording column of a <mix>. The <gen> equivalent is "
        "anomaly_flag=, which records which rows were made outliers."
    ),
    "switch:percent": (
        "percent= splits rows between the branches of a <mix>. A <switch> chooses its case "
        "from the value of on=, so there is nothing here to split."
    ),
}

#: The generic complaint, for an attribute with no sentence of its own.
_UNKNOWN_GEN_ATTR = (
    "Check the spelling, or see the attributes reference for what a generator takes."
)

#: Attributes a <gen> may carry that are NOT pack parameters, so a pack-parameter check must not
#: mistake them for typos. They are each reported by their own rule instead — `parent=` belongs on
#: the <sequence>, and `count=`/`flag=` belong to other tags entirely.
_NOT_A_PACK_PARAM = frozenset({"parent", "count", "flag"})

#: What the ENGINE reads off a <gen type="template"> before the pack runs, plus the
#: wrappers it applies around the produced value. A pack may claim any OTHER name, so
#: this — not the union of every generator's attributes — is what the pack-parameter
#: check may skip. Using the union meant `points=` on a pack that does not declare it
#: was reported by nobody once the ownership check stopped guessing.
PACK_WRAPPER_ATTRS = frozenset(
    {
        "anomaly",
        "anomaly_factor",
        "anomaly_flag",
        "case",
        "comment",
        "count",
        "cycle",
        "flag",
        "if",
        "local",
        "mask",
        "missing",
        "missing_as",
        "missing_when",
        "name",
        "order",
        "parent",
        "repeat",
        "separator",
        "type",
        "value",
        "distinct",
    }
)

GEN_ATTRS = frozenset(
    {
        "type", "value", "name", "if", "comment", "case", "mask", "order", "cycle", "repeat",
        "separator", "accumulate", "distinct", "of", "plus", "reset", "op",
        "missing", "missing_as", "missing_when", "anomaly",
        "anomaly_factor",
        "anomaly_flag",
        "local", "weight", "percent", "first_zero", "include", "exclude",
        "length", "decimals", "distribution", "regex_max_length", "alphabet", "format", "from",
        "to", "oldest", "youngest", "precision", "range", "step", "weekdays", "src",
        "column", "header",
        "delimiter", "row", "base", "trend", "period", "amplitude", "noise", "points", "upper",
        "lower", "y_range", "fit", "interp", "spread", "ink_threshold", "mode", "in", "on_error",
        "timeout", "secret", "mean", "sd", "meanlog", "sdlog", "rate", "alpha", "xmin",
        "shape", "scale",
        "lambda", "n", "s", "beta", "min", "max", "filter", "peak_at", "noise_correlation",
        "expr", "lengths", "read", "sample",
    }
)  # fmt: skip

#: Which generator types actually read a given attribute. An attribute in `GEN_ATTRS` is spelled
#: correctly for SOME generator; this says whether it means anything for THIS one. Without it a
#: `min=`/`max=` on a number and a `range=` on anything but a date pass silently and are dropped.
#: The output wrappers a generator type does NOT put its value through.
#:
#: ``running`` and ``stat`` are resolved before the formatting layer runs — they read a column
#: that already exists and publish the number as it stands — so these sat on them doing nothing
#: while ``check`` called the config valid. Refused rather than implemented: the answer already
#: exists one step later and is better, because the interpolation filter runs where the value is
#: PRINTED, so ``${{Total|mask:x}}`` works today.
# The same, for a date measured from another column — keyed on ``of=``, not on a type.
#
# ``percent=`` is here and not in the map below because the other three are numbers and a
# quota over a derived number is a different argument; a date offset is a DATE, and a quota
# over "row N plus seven days" would have to invent which rows get the offset and which keep
# the original. Refused, like the rest.
OFFSET_WRAPPERS_NOT_READ: frozenset[str] = frozenset(
    {
        "mask",
        "case",
        "missing",
        "missing_as",
        "missing_when",
        "repeat",
        "anomaly",
        "anomaly_factor",
        "percent",
    }
)

WRAPPERS_NOT_READ: dict[str, frozenset[str]] = {
    "running": frozenset(
        {
            "mask",
            "case",
            "missing",
            "missing_as",
            "missing_when",
            "repeat",
            "anomaly",
            "anomaly_factor",
        }
    ),
    "stat": frozenset(
        {
            "mask",
            "case",
            "missing",
            "missing_as",
            "missing_when",
            "repeat",
            "anomaly",
            "anomaly_factor",
        }
    ),
    # A pool reference hands the row a whole MEMBER from a table built before the run. There is
    # no value of its own for the formatting layer to reach, so every one of these sat on it doing
    # nothing while `check` called the config valid — six rows over a four-member pool came out
    # byte-identical with and without each of them.
    "pool": frozenset(
        {
            "mask",
            "case",
            "missing",
            "missing_as",
            "missing_when",
            "repeat",
            "anomaly",
            "anomaly_factor",
            "percent",
        }
    ),
}

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
    # How a source file is READ: as a bag of values (the default) or as a sorted sample the run
    # interpolates between. Only `file` has a source to read.
    "read": frozenset({"file"}),
    # Whether that quantile read DRAWS from the distribution or sweeps it evenly.
    "sample": frozenset({"file"}),
    # The network generator's own knobs.
    "in": frozenset({"http"}),
    "on_error": frozenset({"http"}),
    "timeout": frozenset({"http"}),
    "secret": frozenset({"http"}),
    # The drawn curve.
    "points": frozenset({"pattern"}),
    "upper": frozenset({"pattern"}),
    "lower": frozenset({"pattern"}),
    "y_range": frozenset({"pattern"}),
    "fit": frozenset({"pattern"}),
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
    "noise_correlation": frozenset({"timeseries"}),
    # Zero-padding a numeric range.
    "first_zero": frozenset({"number"}),
    # ── The date's own vocabulary ─────────────────────────────────────────────────────────
    #
    # from=/to= are the trap that reopened this table. They are the natural words for a numeric
    # range, they are real attributes, and a number generator has never read them:
    #
    #     <gen type="number" from="1000" to="9999"/>   ->  3 4 4 6
    #
    # Four-digit ids asked for, single digits produced, check calling the config valid.
    "from": frozenset({"date"}),
    "to": frozenset({"date"}),
    "format": frozenset({"date"}),
    "precision": frozenset({"date"}),
    # The birth window, read only where a birthday is drawn.
    "oldest": frozenset({"date"}),
    "youngest": frozenset({"date"}),
    # ── The shape of a drawn value ────────────────────────────────────────────────────────
    #
    # length= on a text or a regex is the second-most natural thing to write and does nothing:
    # a text walks the list you gave it, and a regex is as long as its pattern says.
    "length": frozenset({"number", "symbol"}),
    "include": frozenset({"number", "symbol"}),
    "exclude": frozenset({"number", "symbol"}),
    # How many places the answer is printed to. Four generators produce a number they may have
    # to round; the rest produce text, which has no places.
    # `file` is on the list only because `read="quantile"` makes it produce a number — an
    # interpolated point between two observations, written to the source's precision by default.
    "decimals": frozenset({"number", "timeseries", "pattern", "stat", "formula", "file"}),
    "distribution": frozenset({"number"}),
    "expr": frozenset({"formula"}),
    "lengths": frozenset({"number", "text", "template", "file", "symbol", "regex"}),
    # The ceiling on what an unbounded pattern may expand to.
    "regex_max_length": frozenset({"regex", "advanced_regex"}),
    # How a drawing is read — as a curve or as a density.
    "mode": frozenset({"pattern"}),
    # percent= is deliberately ABSENT: only text and number read it as a share of their own
    # values, but the engine routes ANY generator carrying it through the share machinery.
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
        "formula",
    }
)  # fmt: skip

# Template paths that are generators rather than pack files. No pack is named after them, so
# looking them up on disk would report a missing address for the two paths that always work.
#: The nine builtin template paths, in the order the reference lists them.
#:
#: Named here rather than derived from the pack registry: this is the list a REFUSAL offers when
#: no path was given at all, and it has to be the same nine everywhere. Offering one example
#: where the reference offers three told a reader the language is narrower than it is.
KNOWN_TEMPLATE_PATHS = (
    "person.male.firstName",
    "person.female.firstName",
    "person.lastName",
    "person.male.diagnosis",
    "person.female.diagnosis",
    "person.gender",
    "person.b_day",
    "location.country",
    "date.range",
)

#: The generator types in the order the reference lists them — the common ones first.
#:
#: The order is the answer on a list the refusal CUTS: sorted, the six a reader is shown open with
#: `advanced_regex` where the reference opens with `text`. Declaration order — the common types
#: first — is what the reference prints.
GEN_TYPE_ORDER = (
    "text",
    "file",
    "template",
    "number",
    "regex",
    "advanced_regex",
    "symbol",
    "date",
    "increment",
    "decrement",
    "timeseries",
    "pattern",
    "http",
    "pool",
    "running",
    "stat",
    "formula",
)

BUILTIN_TEMPLATE_PATHS = frozenset({"person.b_day", "date.range"})

# The document versions this runtime understands.
SUPPORTED_VERSION = "0.1.0"

_INTERPOLATION = re.compile(r"\$\{\{([^}]+)}}")
_VERSION = re.compile(r"^\d+(?:\.\d+)*$")


def _gen_element(child):
    """A ``<gen>``, self-closing or open/close alike."""
    el = child.selfClosingElement() or child.openCloseElement()
    return el if el is not None and el.name.text == "gen" else None


def validate(
    document,
    base_dir: Path | None = None,
    packs: DataPacks | None = None,
    count: int | None = None,
):
    """Every diagnostic the config earns, in the order they were found.

    ``base_dir`` is where a relative ``src=`` resolves from — the config file's own folder.

    ``count`` is the row count the run will ACTUALLY use, when ``--count`` overrides the one
    in ``<env>``. Several warnings are arithmetic over the count, and one computed over the
    declared value while the run uses another is describing a run that is not happening.
    """
    v = _Validator(base_dir, packs, count)
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


#: The four types that are a WHOLE COLUMN read from other columns.
_DERIVED_TYPES = frozenset({"running", "stat", "formula"})


def _is_derived(type_: str | None, attrs: dict[str, str]) -> bool:
    """Is this `<gen>` a whole column read from other columns?"""
    if type_ is None:
        return False
    if type_ in _DERIVED_TYPES:
        return True
    return type_ == "date" and bool((attrs.get("of") or "").strip())


def _identifiers_of(node, bare_words_allowed: bool = False) -> set[str]:
    """Every COLUMN name an expression reads, root of a dotted path included.

    Most identifiers in a formula are columns: the whole expression is arithmetic whose answer
    is printed, so a name that is not a column is a typo rather than a word.

    Two places are the exception, and they are the same two ``if=`` has. The right-hand side of a
    COMPARISON may be a bare word — ``Gender == Male`` — and so may both branches of a TERNARY,
    which is how a formula writes a LABEL rather than a number:
    ``expr="BMI > 25 ? over : normal"``. Reading those as columns refused the formula page's own
    headline example with TDC240, on a config the reference runs.

    Walking the tree by guessed FIELD NAMES also missed whole node kinds, because this parser's
    nodes are not the reference's: a unary holds ``operand`` and not ``argument``, an array holds
    ``items`` and not ``elements``, and a dotted reference is a ``Member`` with no child node at
    all. So ``-Typo`` and ``Person.Age`` walked straight through a green ``check`` and died at run
    time with "the expression has no number as its answer" — a sentence that names neither the
    column nor the typo. Matched on node TYPE now, which cannot drift out of step with the parser
    the way a list of attribute names did.
    """
    found: set[str] = set()

    def walk(n, bare: bool) -> None:
        if isinstance(n, Name):
            if not bare:
                found.add(n.value.split(".")[0])
            return
        if isinstance(n, Member):
            # `Person.Age` — the ROOT is the column; the tail is its field, and a field cannot
            # be known from the config alone.
            if not bare:
                found.add(n.dotted.split(".")[0])
            return
        if isinstance(n, Binary):
            if n.op in ("&&", "||"):
                walk(n.left, bare)
                walk(n.right, bare)
                return
            # The right of a comparison may be a bare word, the same reading `if=` gives it.
            # Arithmetic has no such case: both sides are numbers.
            compare = n.op in ("==", "!=", "===", "!==", "<", ">", "<=", ">=")
            walk(n.left, False)
            walk(n.right, compare or bare)
            return
        if isinstance(n, Unary):
            walk(n.operand, bare)
            return
        if isinstance(n, Conditional):
            walk(n.test, False)
            # Both branches may be labels — see the note above.
            walk(n.consequent, True)
            walk(n.alternate, True)
            return
        if isinstance(n, Call):
            for arg in n.args:
                walk(arg, False)
            return
        if isinstance(n, Array):
            for item in n.items:
                walk(item, True)
            return

    walk(node, bare_words_allowed)
    return found


def _prev_targets(node) -> set[str]:
    """The column names appearing as the first argument of a ``prev()`` call.

    Read off the tree rather than the text, so ``prevention`` and a quoted "prev(" are
    not mistaken for the form.
    """
    found: set[str] = set()

    def walk(n) -> None:
        args = getattr(n, "args", None)
        if getattr(n, "name", None) == "prev" and args:
            first = args[0]
            if isinstance(first, Name):
                found.add(first.value.split(".")[0])
        for attr in ("left", "right", "argument", "test", "consequent", "alternate", "object"):
            child = getattr(n, attr, None)
            if child is not None:
                walk(child)
        for attr in ("arguments", "args", "elements"):
            children = getattr(n, attr, None)
            if children:
                for child in children:
                    walk(child)

    walk(node)
    return found


class _Validator:
    __slots__ = (
        "base_dir",
        "count_override",
        "current_sequence",
        "declared_fields",
        "declared_names",
        "declared_order",
        "diagnostics",
        "document_regex_max_length",
        "env_count",
        "env_names",
        "expr_scope",
        "finite_values",
        "locale",
        "packs",
        "pending_expressions",
        "pending_pool_filters",
        "pool_field_values",
        "pool_fields",
        "pool_member_nodes",
        "pool_member_scope",
        "pool_references",
        "pools_read",
        "repeating_names",
        "row_link_gens",
        "valueless_names",
    )

    def __init__(
        self,
        base_dir: Path | None,
        packs: DataPacks | None,
        count_override: int | None = None,
    ) -> None:
        self.diagnostics: list[Diagnostic] = []
        self.base_dir = base_dir
        self.packs = packs
        self.document_regex_max_length = regex.DEFAULT_MAX_LENGTH
        self.locale = "en"
        # The run length from <env count="…">. Needed by checks whose answer
        # depends on SIZE rather than shape — what a uniq column costs is
        # nothing at a hundred rows and gigabytes at ten million.
        self.env_count = 0
        # `--count` decides how many rows the run makes, so it decides what the
        # arithmetic warnings are about. A warning computed over the declared
        # count while the run uses another describes a run that is not happening.
        self.count_override = count_override
        # Every sequence name the config declares — what an interpolation may refer to.
        self.declared_names: set[str] = set()
        self.declared_order: list[str] = []
        #: Dotted field names in DECLARATION order — `P.zeta`, `P.alpha`, not sorted.
        #:
        #: `declared_names` is a set, and a set has no order to lend a message. The reference
        #: lists a compound's fields the way the config writes them, so a reader matching the
        #: note against the <sequence> above reads down the same list; sorted, `zeta, alpha`
        #: came back as `alpha, zeta` and stopped being that list.
        self.declared_fields: list[str] = []
        # The sequence being walked right now, if it has a name. `declared_order`
        # deliberately excludes it — that is what makes "declared above" mean what it
        # says — so a check needing to know whose column this is cannot read it there.
        # `prev()` needs exactly that: naming your own column is meaningless in an
        # ordinary formula and is the entire point inside `prev`.
        self.current_sequence: str | None = None
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
        #: Every ``<gen>`` carrying a ``row=``, wherever it sits. A link is checked once the
        #: whole ``<env>`` has been walked because its members are free to live in different
        #: sequences — which is exactly the case a per-sequence check misses.
        self.row_link_gens: list[tuple[dict[str, str], object]] = []
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
        self.pending_expressions: list[
            tuple[int, str, int, int, bool, frozenset[str] | None, frozenset[str]]
        ] = []
        # The names a deferred expression may see, where they are NOT the run's. A <pool> member
        # reads its own pool and nothing else: the table is built before any row exists, so a
        # condition naming an env column is constant-false on every member. None means the run's
        # own names, which is every expression outside a pool.
        self.expr_scope: frozenset[str] | None = None
        self.pool_member_scope: dict[int, frozenset[str]] = {}
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
        for at_index, condition, line, column, each, scope, extra in pending:
            before = len(self.diagnostics)
            outer = self.declared_names
            # `extra` carries the names the LANGUAGE provides for one expression — today just
            # `_value` inside `missing_when`. Added rather than substituted, so a condition can
            # still read the columns beside it.
            if scope is not None:
                self.declared_names = set(scope) | set(extra)
            elif extra:
                self.declared_names = set(outer) | set(extra)
            try:
                self._check_expression_names(condition, line, column, each)
            finally:
                self.declared_names = outer
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
                        f"Write <{name}> … </{name}>. A self-closing <{name}/> silently "
                        "discards count, seed and everything inside.",
                        _line(self_closing),
                        _column(self_closing),
                    )
                    continue
                self._misplaced_at_tdc(name, _line(self_closing), _column(self_closing))
                continue
            data_el = child.dataElement()
            if data_el is not None:
                # Its own node in the grammar, so this walk stepped over it in silence and the
                # text was dropped without a word.
                self._error(
                    "TDC013",
                    "<data> is not allowed directly inside <tdc>",
                    f"{PLACEMENT_HINTS['data']} Allowed inside <tdc>: "
                    f"{_candidates(sorted(TDC_CHILDREN))}.",
                    _line(data_el),
                    _column(data_el),
                )
                continue
            open_el = child.openCloseElement()
            if open_el is not None and open_el.name.text not in TDC_CHILDREN:
                self._misplaced_at_tdc(open_el.name.text, _line(open_el), _column(open_el))

    def _misplaced_at_tdc(self, name: str, line: int, column: int) -> None:
        """A stray tag at document level.

        Two different mistakes, two different fixes — the same split every other container
        makes. A construct this language KNOWS is in the wrong place and needs moving (TDC013,
        with where it belongs); a tag nobody has heard of is a typo (TDC010). This walk used to
        call both unknown, so a <sequence> written at document level was reported as a tag that
        does not exist.
        """
        takes = f"Allowed inside <tdc>: {_candidates(sorted(TDC_CHILDREN))}."
        hint = PLACEMENT_HINTS.get(name)
        if hint is not None:
            self._error(
                "TDC013",
                f"<{name}> is not allowed directly inside <tdc>",
                f"{hint} {takes}",
                line,
                column,
            )
        else:
            self._error("TDC010", f'unknown child of <tdc>: "<{name}>"', takes, line, column)

    def _check_version(self, tdc) -> None:
        self._check_closed_tag_attrs("tdc", tdc.attr(), _line(tdc), _column(tdc))
        attrs = _attrs(tdc.attr())
        version_attr = attrs.get("version")
        short_attr = attrs.get("v")

        if version_attr is not None and short_attr is not None:
            self._error(
                "TDC003",
                '<tdc> declares both "version" and "v"',
                'Use one root version attribute. Prefer the canonical form: <tdc version="0.1.0">.',
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
                f'TDC document version "{raw}" is newer than this runtime ({SUPPORTED_VERSION})',
                "Update TDC before processing this file; newer DSL features may not exist in "
                "this runtime.",
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
                'Use a positive integer, e.g. regex_max_length="64".',
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
                    "",
                    line,
                    column,
                )
        # Applied after the declared value is read, because the declared one still
        # has to parse — an override does not excuse `count="x"`.
        if self.count_override is not None:
            self.env_count = self.count_override

        # The renderer splits on `(.+)%(.+)`, so the pattern needs a `%` with something on
        # BOTH sides. Counting the `%` alone let "%%" and "%x" through: they have one, they
        # cannot be split, and the renderer quietly stopped interpolating.
        inject = env_attrs.get("inject")
        if inject is not None:
            # A `%` is a hole only where it has text on BOTH sides, which is what the renderer's
            # `(.+)%(.+)` asks for. None and the pattern can never split; several and only the
            # rightmost is the hole, so the others survive as a literal `%` in the wrapper and the
            # text would have to carry one to match — `inject="[%]-[%]"` with `<data>[Id]-[Id]`
            # came out as `[Id]-[Id]` in five implementations and was refused by none.
            holes = sum(1 for i in range(1, len(inject) - 1) if inject[i] == "%")
            line, column = _at(env, "inject")
            if holes == 0:
                self._error(
                    "TDC021",
                    (
                        f'inject pattern "{inject}" has nothing on both sides of its "%" — '
                        "interpolation will never match"
                        if "%" in inject
                        else f'inject pattern "{inject}" has no "%" placeholder — interpolation '
                        "will never match"
                    ),
                    "The `%` is where the sequence name goes, and it needs an opening and a "
                    'closing part around it: inject="${{%}}", inject="[%]", inject="%{%}%".',
                    line,
                    column,
                )
            elif holes > 1:
                self._error(
                    "TDC021",
                    f'inject pattern "{inject}" marks {holes} holes — one marker has room for one',
                    "A `%` is the hole where the sequence name goes, and there is one of them. "
                    "The engine reads the rightmost, so the others stay as a literal `%` in the "
                    "wrapper and your text would have to contain one to match. Write a single "
                    'hole — inject="[%]" — and repeat the name in the <data> instead: '
                    '<data>[Id]-[Id]</data>. inject="%{%}%" is fine, because only its middle `%` '
                    "has text on both sides.",
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
                # A `<data>` written straight into a fixture is not an unknown child — the
                # tag is known and the placement is what is wrong, and the renderer only ever
                # walks <line> children, so the text was dropped without a word. Named rather
                # than rendered: a bare <data> would have to invent whether it ends the line,
                # and <line><data> already says.
                self._check_fixture_data(inner)
                self._check_children(
                    inner.content(),
                    inner.name.text,
                    FIXTURE_CHILDREN | frozenset({"data"}),
                    "TDC131",
                    shown=FIXTURE_CHILDREN,
                )
        self._check_closed_tag_attrs("env", env.attr(), _line(env), _column(env))

        names: set[str] = set()
        declared: list[str] = []
        # The same list object, reachable from the per-gen checks: `of=` on a running total
        # takes the declaration-order rule, and the gen check is too deep to be handed it.
        self.declared_order = declared

        for open_el in self._declarations(env):
            tag = open_el.name.text
            # Every expression deferred while this declaration is walked is a pool member's or
            # the run's, and the two see different names.
            self.expr_scope = self.pool_member_scope.get(id(open_el))
            self._check_closed_tag_attrs(tag, open_el.attr(), _line(open_el), _column(open_el))
            attrs = _attrs(open_el.attr())
            name = attrs.get("name")
            self.current_sequence = name.strip() if name else None
            if name is None or not name.strip():
                self._error(
                    "TDC030",
                    f'<{tag}> is missing a required "name" attribute',
                    "Every sequence needs a unique name for interpolation, e.g. <sequence "
                    'name="Gender">.',
                    _line(open_el),
                    _column(open_el),
                )
            elif checks.is_builtin(name):
                line, column = _at(open_el, "name")
                self._error(
                    "TDC033",
                    f'sequence name "{name}" collides with a builtin',
                    f"Builtins: {', '.join(sorted(checks.BUILTINS))}. Pick a different name.",
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
                    "Builtin names: _count, _first, _item, _item_id, _last, _total. User sequences "
                    "should avoid the leading underscore.",
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
                    "Each <sequence>/<mix> must declare a unique name; rename or remove the "
                    "duplicate.",
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
                        "Parent sequences must be declared earlier in the same <env>. Forward "
                        "references and cycles are not supported.",
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
                # A pool reference draws no column of its own — it hands the row a whole member
                # from a table built before the run — so there is nothing to take without
                # replacement. `uniq="true"` sat on it doing nothing.
                if any(
                    (_attrs(g.attr()).get("type") or "") == "pool"
                    for g in _child_elements(open_el)
                    if _element_name(g) == "gen"
                ):
                    self._uniq_unsupported(
                        open_el,
                        name,
                        "it draws a whole member from a <pool> rather than a column of its own, "
                        "so there is nothing to draw without replacement \u2014 put uniq= on a "
                        "<sequence> inside the <pool> to make the members distinct",
                    )
                # A compound's fields are referenced as Name.Field, and a flag column is a name
                # too. Fields inside a <distinct> wrapper are ordinary fields, so they count.
                self._collect_field_names(open_el, name)
                for key in ("flag", "anomaly_flag"):
                    value = attrs.get(key)
                    if value is not None and value.strip():
                        self.declared_names.add(value)
        # Once, at the end: a row= link is free to span sequences, so its members are only all in
        # view now.
        self._row_link_source()
        self.expr_scope = None

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
                self.declared_fields.append(f"{name}.{field_name}")
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

        # The little language itself — its operators, its functions, its constructs. The name
        # checks below are about THIS pool's fields and say nothing about whether the expression
        # is runnable at all, so a misspelled function used to pass `check` and kill the run with
        # a bare `unknown function`.
        line, column = _at(gen, "filter")
        self._check_if_expression(expression, line, column, "filter= expression", "a")

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
            # Compared the way `==` compares two texts, so the check cannot refuse a config
            # the run would have answered. Raw text refused `code == Want` where the members
            # hold 01,02,03 and the column produces 1,2,3 — the same question written with
            # one extra term matched every row.
            field_keys = {match_key(v) for v in field_values}
            if any(match_key(value) in field_keys for value in other_values):
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
            # A COMPOUND member publishes ``Name.Field`` for each of its named gens, and the
            # pool exposes those under the same dotted name — the engine does it, so the CLI
            # must accept it. ``${{Seen.addr.city}}`` printed ``Paris`` on a run and was
            # TDC193 on a check.
            for gen in _child_elements(node):
                if _element_name(gen) != "gen":
                    continue
                field = (_attrs(gen.attr()).get("name") or "").strip()
                if field:
                    fields.append(f"{name}.{field}")
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
                # What a member of THIS pool may name in an `if=`: the pool's own fields, gathered
                # by the pre-pass. A condition naming an env column is not merely out of scope —
                # the pool is built before any row exists, so it is constant-false on every
                # member, and the column it guards came out empty on every row.
                pool_name = _attrs(open_el.attr()).get("name") or ""
                scope = frozenset(self.pool_fields.get(pool_name, []))
                for member_el in _elements(open_el):
                    member = member_el.openCloseElement()
                    if member is None:
                        continue
                    if member.name.text in ("sequence", "mix", "switch"):
                        self.pool_member_nodes.add(id(member))
                        self.pool_member_scope[id(member)] = scope
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
                                self.pool_member_scope[id(wrapped)] = scope
                                out.append(wrapped)
                        self._check_group_size(member, member.name.text, wrapped_count)
            elif tag in ("uniq", "distinct"):
                self._check_closed_tag_attrs(tag, open_el.attr(), _line(open_el), _column(open_el))
                # ENV_GROUP_CHILDREN was declared when the unknown-child holes were closed and
                # then never read here, so an invented tag inside an env-level group was accepted
                # in silence — the reference refused it and the four ports did not.
                self._check_children(open_el.content(), tag, ENV_GROUP_CHILDREN)
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
                        self._check_group_derived_member(wrapped, tag)
                        self._check_env_group_member(wrapped, tag)
                        out.append(wrapped)
                self._check_group_size(open_el, tag, members)
                self._check_group_pool_members(open_el, tag, env)
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
                    '<gen type="stat">.',
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
            self._defer_expression(that, where[0], where[1], False)

    def _check_group_derived_member(self, sequence, tag: str) -> None:
        """A DERIVED column inside a `<uniq>` or `<distinct>` group.

        A group is a rearrangement: it keeps every member's multiset of values and permutes the
        columns until each record is unique. Sound for drawn columns — a draw means the same
        wherever it lands — and destructive for a derived one, whose value is a statement ABOUT
        the row it was computed for. Measured on the reference, `<uniq>` over `A` (1..5) and
        `F = A * 10` gave `2|20  3|20  3|30  2|30  5|50`: two rows of five saying that ten times
        three is twenty, with `check` calling the config valid.

        A `<compute>` is the same case from the other side — `f(x)` is `f(x)`, so it has no pool
        to draw from and no column of its own to rearrange.
        """
        name = _attrs(sequence.attr()).get("name") or "?"
        for child in _elements(sequence):
            open_el = child.openCloseElement()
            if open_el is not None and open_el.name.text == "compute":
                line, column = _line(open_el), _column(open_el)
                self._error(
                    "TDC296",
                    f'<sequence name="{name}"> holds a <compute>, which cannot be a member of '
                    f"<{tag}>: it derives its value from other columns, so it has nothing of its "
                    "own to rearrange and cannot keep the group's promise",
                    f"Put the <{tag}> around the <gen> sequences the <compute> READS. Its value "
                    "follows them, so arranging the inputs arranges the result.",
                    line,
                    column,
                )
                return
            gen = child.selfClosingElement()
            if gen is None or gen.name.text != "gen":
                continue
            attrs = _attrs(gen.attr())
            type_ = attrs.get("type")
            if not _is_derived(type_, attrs):
                continue
            described = (
                "a date measured from another column (of=)"
                if type_ == "date"
                else f'a type="{type_}" column'
            )
            line, column = _line(gen), _column(gen)
            self._error(
                "TDC296",
                f'<sequence name="{name}"> holds {described}, which cannot be a member of '
                f"<{tag}>: the group rearranges finished columns, and a computed value moved to "
                "another row no longer describes that row",
                f"Put the {tag} group around the columns this one READS, and leave the computed "
                "column outside it. It follows whatever the group arranges, so it stays true row "
                "by row.",
                line,
                column,
            )
            return

    def _check_group_pool_members(self, wrapper, tag: str, env) -> None:
        """A group whose members draw from a ``<pool>``.

        The group's promise is kept by member IDENTITY here — no two of them hand one row the
        same member — because a record has no value of its own to compare. That works, and
        these are the three shapes it cannot mean:

        * a reference beside an ordinary sequence: one holds a record and the other a string,
          and there is no field the comparison would be about;
        * references to two DIFFERENT pools: a doctor is never the same record as a ward, so
          the group would be satisfied without doing anything;
        * more references than the pool has members: no arrangement exists.

        All three used to be accepted and then do nothing at all.
        """
        counts: dict[str, int] = {}
        for child in _elements(env):
            open_child = child.openCloseElement()
            if open_child is None or open_child.name.text != "pool":
                continue
            attrs = _attrs(open_child.attr())
            name = attrs.get("name")
            raw = attrs.get("count")
            if name is None or raw is None:
                continue
            try:
                n = int(str(raw).strip())
            except ValueError:
                continue
            if n > 0:
                counts[name] = n

        pooled: list[tuple[str, str]] = []
        plain: list[tuple[str, object]] = []
        for inner in _elements(wrapper):
            member = inner.openCloseElement()
            if member is None or member.name.text != "sequence":
                continue
            name = _attrs(member.attr()).get("name") or "?"
            gens = [
                g.selfClosingElement()
                for g in _elements(member)
                if g.selfClosingElement() is not None and g.selfClosingElement().name.text == "gen"
            ]
            pool = None
            if len(gens) == 1:
                gen_attrs = _attrs(gens[0].attr())
                if gen_attrs.get("type") == "pool":
                    pool = (gen_attrs.get("value") or "").strip()
            if pool is None:
                plain.append((name, member))
            else:
                pooled.append((name, pool))
        if not pooled:
            return

        if plain:
            plain_name, node = plain[0]
            ref_name, ref_pool = pooled[0]
            self._error(
                "TDC302",
                f'<{tag}> mixes <sequence name="{plain_name}">, which draws a value, with '
                f'<sequence name="{ref_name}">, which draws a whole member of pool '
                f'"{ref_pool}" — there is nothing the two can be compared on',
                f"A <{tag}> over pool references compares WHICH MEMBER each row took; over "
                "ordinary sequences it compares the value. One group does one of the two. To "
                'keep a value away from a member\'s field, filter instead: <gen type="pool" '
                'filter="field != Other"/>.',
                _line(node),
                _column(node),
            )
            return

        pools = list(dict.fromkeys(p for _, p in pooled))
        if len(pools) > 1:
            self._error(
                "TDC302",
                f"<{tag}> holds references to {len(pools)} different pools "
                f"({', '.join(pools)}) — a member of one is never a member of another, so the "
                "group would be satisfied without changing anything",
                "Group the references that draw from the SAME pool. Two pools cannot collide.",
                _line(wrapper),
                _column(wrapper),
            )
            return

        pool = pools[0]
        available = counts.get(pool)
        if available is not None and available < len(pooled):
            self._error(
                "TDC302",
                f'<{tag}> puts {len(pooled)} references on pool "{pool}", which has '
                f"{available} members — one row cannot give each of them a different one",
                f'Raise count= on <pool name="{pool}"> to at least {len(pooled)}, or take a '
                "reference out of the group.",
                _line(wrapper),
                _column(wrapper),
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
                        self.declared_fields.append(f"{name}.{constant}")
                continue
            self_closing = child.selfClosingElement()
            if self_closing is not None and self_closing.name.text == "gen":
                gen_attrs = _attrs(self_closing.attr())
                field = gen_attrs.get("name")
                if field is not None and field.strip():
                    self.declared_names.add(f"{name}.{field}")
                    self.declared_fields.append(f"{name}.{field}")
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
            "TDC299",
            f'uniq on "{name or "?"}" costs about '
            f"{_megabytes(self.env_count * _UNIQ_BYTES_PER_VALUE)} at {self.env_count:,} rows "
            f"— memory that follows the row count",
            "Keeping a promise about the finished column costs memory that follows count, on "
            "every engine — the cost belongs to the promise, not to one of them. About 250 "
            "bytes a value, measured; a compound uniq measures higher still. A single drawn "
            "column pays twice: drawing without replacement cannot be done a row at a time, so "
            "that shape also runs in memory whatever mode= asks for. It works — it is worth "
            "being deliberate about at this size.",
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

        for gen_attrs, gen_node in zip(gens, gen_nodes, strict=True):
            if (gen_attrs.get("row") or "").strip():
                self.row_link_gens.append((gen_attrs, gen_node))

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
                'A sequence needs at least one <gen type="…"/> describing how values are produced. '
                'For a percentage distribution use a standalone <mix name="…"> in <env>.',
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
        self._uniq_with_distinct(open_el, label)
        self._row_link_order(gens, gen_nodes)

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

        # The shape TDC246 refuses inside a <case>, one level out. A sequence mints the
        # ground-truth column only where the flagged gen IS its value: a name= turns the gen into
        # a FIELD and a second part makes it one piece of a joined string, and in both the engine
        # minted nothing while `check` called the config valid. The anomaly still fired — the
        # values came out perturbed — so the only thing missing was the record of WHICH rows, and
        # ${{NAME}} reached the output as its own literal text.
        if len(gens) > 1 or field_names or composes:
            for gen, node in zip(gens, gen_nodes, strict=True):
                flag = gen.get("anomaly_flag")
                if flag is None:
                    continue
                line, column = _at(node, "anomaly_flag")
                self._error(
                    "TDC283",
                    f'anomaly_flag="{flag.strip()}" is not read on a <gen> that is one part of '
                    "its <sequence>",
                    "The flag records which ROWS were made outliers, and a sequence built from "
                    "several parts has no row-level column to put it in. Move this <gen> into a "
                    "<sequence> of its own \u2014 that also gives you the value as its own "
                    "column.",
                    line,
                    column,
                )

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
        "distinct",
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
        # Every <gen> the uniq construction replaces: the ONE unnamed gen of a simple sequence,
        # or ALL the fields of a compound one. Looking only at the simple shape missed the case
        # that mattered — a compound with missing="0.4" produced ZERO blanks over twelve rows.
        simple = len(gens) == 1 and "name" not in gens[0]
        members = [gens[0]] if simple else [g for g in gens if "name" in g]
        if not members:
            return
        asked = []
        for gen in members:
            if gen.get("type") in ("increment", "decrement"):
                continue
            for a in self._DROPPED_BY_UNIQ:
                if a in gen and a not in asked:
                    asked.append(a)
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

    def _row_link_order(self, gens, gen_nodes) -> None:
        """``order="sequential"`` on SOME members of a ``row=`` link.

        ``row="k"`` exists to keep a record together: every generator carrying the key reads the
        SAME line of the CSV. ``order="sequential"`` picks a line too, by the row's position. Two
        rules choosing the same line, and only one can win. Measured on the files guide's own
        users.csv with one member sequential, John was paired with Johnson — John is Smith.

        Narrow on purpose: when EVERY member is sequential they agree (both pick by position) and
        the records hold. Only a MIXED link is proof of a contradiction.
        """
        links: dict[str, list[int]] = {}
        for index, gen in enumerate(gens):
            key = (gen.get("row") or "").strip()
            if key:
                links.setdefault(key, []).append(index)
        for key, indexes in links.items():
            if len(indexes) < 2:
                continue
            walking = [i for i in indexes if (gens[i].get("order") or "").strip() == "sequential"]
            if not walking or len(walking) == len(indexes):
                continue
            plain = len(indexes) - len(walking)
            line, column = _at(gen_nodes[walking[0]], "order")
            self._error(
                "TDC282",
                f'order="sequential" on part of the row="{key}" link: {len(walking)} of '
                f"{len(indexes)} members walk the file in order and {plain} pick a line per "
                "record, so they stop reading the same line",
                "row= exists to keep the fields of one record together. Either give every member "
                'of the link order="sequential", so they walk in step, or drop it from this one.',
                line,
                column,
            )

    def _row_link_source(self) -> None:
        """Members of one ``row=`` link that read DIFFERENT files.

        One line of one file is what a link is, so two files under one key is not a request the
        engine can grant — and the two engines did not agree on how to fail it. The in-memory
        engine threw ``row link "k" cannot mix different file sources``: no code, no line, no file.
        The streaming engine granted it, pairing the two files by proportion, which for a 3-row
        file and a 2-row file gave ann/10, ann/10, ann/10, cal/20 — a join nobody asked for,
        printed as data.

        One config, two answers, and the wrong one is the silent one. Only ``src`` is compared:
        two members legitimately read different columns of one file, and a link is exactly what
        makes that a record.
        """
        links: dict[str, list[tuple[dict[str, str], object]]] = {}
        for gen_attrs, gen_node in self.row_link_gens:
            key = (gen_attrs.get("row") or "").strip()
            links.setdefault(key, []).append((gen_attrs, gen_node))
        for key, members in links.items():
            if len(members) < 2:
                continue
            first_src = (members[0][0].get("src") or "").strip()
            for gen_attrs, gen_node in members[1:]:
                src = (gen_attrs.get("src") or "").strip()
                if src == first_src:
                    continue
                line, column = _at(gen_node, "src")
                self._error(
                    "TDC298",
                    f'row="{key}" links two different files: this one reads "{src}" and another '
                    f'member reads "{first_src}"',
                    "A link is one LINE of one file, so there is no line that belongs to both. "
                    "Point every member of the link at the same src=, or give this one its own "
                    "row= key.",
                    line,
                    column,
                )

    def _uniq_with_distinct(self, open_el, label: str) -> None:
        """``<distinct>`` inside a ``uniq="true"`` sequence.

        They are documented as independent and they are not. ``<distinct>`` repairs a row so its
        fields differ; ``uniq`` afterwards rearranges the whole columns and knows nothing about
        which pairings the repair ruled out. Measured on twelve rows over exactly twelve legal
        distinct pairs, the run still produced ``s,s`` and ``q,q``.
        """
        attrs = _attrs(open_el.attr())
        if (attrs.get("uniq") or "").strip().lower() != "true":
            return
        has_distinct = any(_element_name(child) == "distinct" for child in _child_elements(open_el))
        if not has_distinct:
            return
        line, column = _at(open_el, "uniq")
        self._error(
            "TDC267",
            f'uniq="true" on <sequence name="{label}"> cannot be combined with <distinct>: the '
            "uniq arrangement rearranges the finished columns and does not know which pairings "
            "<distinct> ruled out, so the repair is undone",
            "Keep one of the two. <distinct> is about a single record (its fields differ); uniq= "
            "is about the whole column (no record repeats). For both at once, give each field "
            "its own <sequence>, wrap them in <uniq>\u2026</uniq>, and put the <distinct> at env "
            "level.",
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
                "Allowed inside <mix>: case.",
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
                'Name the subject sequence to look up, e.g. <switch name="Currency" on="Country">.',
                _line(open_el),
                _column(open_el),
            )
        elif on not in declared:
            line, column = _at(open_el, "on")
            # A dot with a KNOWN root is a field mistake. Reported as an unknown sequence it sent
            # the reader off to check a name that is declared right above.
            dot = on.find(".")
            root = on if dot < 0 else on[:dot]
            field_mistake = dot >= 0 and (root in declared or checks.is_builtin(root))
            # Against `declared_names`, not the local scope: a compound's FIELDS are registered
            # there, and filtering by the switch's own scope threw them all away, so a real field
            # mistake was told the subject "has no fields".
            fields = [
                n[len(root) + 1 :]
                for n in self.declared_fields
                if n.startswith(f"{root}.") and n in self.declared_names
            ]
            if field_mistake:
                near = closest_match(on[dot + 1 :], fields)
                self._error(
                    "TDC134",
                    f'<switch on="{on}"> refers to "{on[dot + 1 :]}", which is not a field of '
                    f'"{root}"',
                    f'"{root}" has no fields — switch on it directly, or on a sequence that has '
                    "some."
                    if not fields
                    else f'Fields of "{root}": {", ".join(fields)}.',
                    line,
                    column,
                    _did_you_mean(f"{root}.{near}" if near else ""),
                )
            else:
                self._error(
                    "TDC134",
                    f'<switch on="{on}"> refers to an unknown sequence',
                    "The `on` subject must be a sequence declared earlier in the same <env>.",
                    line,
                    column,
                    _did_you_mean(closest_match(on, sorted(declared))),
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
                        'Give the match key(s): <case is="US"> or multi-key <case is="US|CA|MX">.',
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
                'Add a <map>KEY:VALUE, …</map> table and/or <case is="…">…</case> entries.',
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
            self._defer_expression(condition, where[0], where[1], False)
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

        self._check_missing_when(gen, attrs)
        if type_ is None or not type_.strip():
            line, column = _at(gen, "name")
            self._error(
                "TDC040",
                '<gen> is missing a required "type" attribute',
                "Allowed types: text, file, template, number, regex, advanced_regex, … (11 more).",
                line,
                column,
            )
        elif type_ not in GEN_TYPES:
            line, column = _at(gen, "type")
            self._error(
                "TDC041",
                f'unknown gen type "{type_}"',
                f"Allowed types: {_candidates(list(GEN_TYPE_ORDER))}.",
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
        # Before the source is read: how the file is READ is a question about the config, and a
        # reader whose `read=` is misspelled should be told that first, not sent to look at the
        # path. The reference reports them in this order and the fixtures pin it.
        self._check_quantile_read(gen, attrs, type_)
        self._check_source(gen, attrs, type_)
        self._check_http(gen, attrs, type_)
        self._check_running(gen, attrs, type_)
        self._check_stat(gen, attrs, type_)
        self._check_formula(gen, attrs, type_)
        self._check_derived_not_conditional(gen, attrs, type_)
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
            self._warn_inferred_zeros(attrs["percent"], attrs.get("value", ""), line, column)
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
                'Interpolation reaches the text inside <data> and <gen type="template" '
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

        timeout = attrs.get("timeout")
        if timeout is not None and not _positive_seconds(timeout):
            line, column = _at(gen, "timeout")
            self._error(
                "TDC069",
                f'invalid timeout "{timeout.strip()}" — expected a positive number of seconds',
                'timeout="30" waits thirty seconds for one answer. Omit it for the default of 30.',
                line,
                column,
            )

        # secret — the key a request is signed with. Three spellings, and only the literal is
        # worth saying anything about: a config travels into version control, and the secret would
        # travel with it. A warning rather than an error, because a service on 127.0.0.1 for an
        # afternoon is a real use and refusing it would only teach people to write it somewhere
        # worse.
        secret = attrs.get("secret")
        if secret is not None:
            raw = secret.strip()
            line, column = _at(gen, "secret")
            if not raw:
                self._error(
                    "TDC284",
                    'secret="" has no key to sign with',
                    'Name where the key lives: secret="env:TDC_HTTP_SECRET" or '
                    'secret="file:~/.tdc/service.key". Remove the attribute to send the request '
                    "unsigned.",
                    line,
                    column,
                )
            elif not raw.startswith("env:") and not raw.startswith("file:"):
                self._warn(
                    "TDC284",
                    "secret= is written into the config, so it travels wherever the config does",
                    "A config goes into version control and the key goes with it. "
                    'secret="env:TDC_HTTP_SECRET" reads it from the environment, '
                    'secret="file:~/.tdc/service.key" from a file the repository does not hold.',
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

    def _check_fit(self, gen, attrs: dict[str, str]) -> None:
        """``fit="low..high"`` — where a drawing read from a FILE lands on the value axis.

        A file carries a shape and nothing else, so its own lowest and highest point are the only
        two things that can be measured; ``fit=`` says what they become. Typed points already
        carry a board, so the two spellings cannot both be right about the same drawing.
        """
        raw = (attrs.get("fit") or "").strip()
        if not raw:
            return

        line, column = _at(gen, "fit")
        drawn = [name for name in ("points", "upper", "lower") if (attrs.get(name) or "").strip()]
        if drawn:
            listed = " and ".join(f"{name}=" for name in drawn)
            self._error(
                "TDC300",
                f"fit= is not read beside {listed} — those points already carry a board",
                "A typed point is a percentage of the 0..100 board, so 80 already means 80% of "
                "y_range and there is nothing left for fit= to place. fit= is for a drawing read "
                "from src=, whose numbers are in some other tool's units. Drop one of the two.",
                line,
                column,
            )
            return

        parts = raw.split("..")
        values = [numbers.parse(part) for part in parts] if len(parts) == 2 else []
        if len(parts) != 2 or any(v != v or v in (float("inf"), float("-inf")) for v in values):
            self._error(
                "TDC300",
                f'fit="{raw}" is not a band',
                'Write fit="low..high" with two numbers — the values the drawing\'s lowest and '
                "highest point become. Omit it entirely to have the drawing fill y_range.",
                line,
                column,
            )
            return
        if values[0] > values[1]:
            self._error(
                "TDC300",
                f'fit="{raw}" counts down — the low bound is above the high one',
                "Write the smaller number first. Turning the drawing upside down is a different "
                "request, and it is not what this attribute does.",
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

        if type_ == "pattern":
            self._check_fit(gen, attrs)

        # `y_range=` is the value axis a drawing is brought into, and a drawing has no scale of
        # its own. The generator refuses without it, but a refusal at run time is not enough: a
        # config that passes `check` and then dies is the exact defect this validator closes.
        if type_ == "pattern" and not (attrs.get("y_range") or "").strip():
            self._error(
                "TDC293",
                '<gen type="pattern"> needs y_range — a drawing has no scale of its own',
                'y_range="min..max" is the value axis the picture is brought into: its floor is '
                "the minimum, its top is the maximum, and nothing leaves the range. Without it "
                "the drawing would be measured against its own ink, so a flat line halfway up "
                'would come out at the floor. Write y_range="0..100" for a percentage canvas, '
                "or the units you actually mean.",
                _line(gen),
                _column(gen),
            )

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

        # `mode=`, `interp=`, `spread=` and `decimals=` — the four drawing attributes whose
        # value is a fixed word or a number. They used to be read only by the generator, so
        # `check` called mode="banana" valid and the run then refused it with a bare sentence
        # and no code. The GENERATOR's own parsers are called here rather than their rules
        # repeated: a second copy is a second thing to keep in step, and drifting apart is
        # exactly the failure being closed.
        if type_ == "pattern":
            for name, parse in (
                # The three that carry a DRAWING, read by the same code the run uses: a `;`
                # that becomes one curve instead of two, and points with no width, both used
                # to pass `check` and die in the run.
                (
                    "points",
                    lambda: curve.build(curve.parse_points(attrs.get("points") or ""), None, 0),
                ),
                (
                    "upper",
                    lambda: curve.build(curve.parse_points(attrs.get("upper") or ""), None, 0),
                ),
                (
                    "lower",
                    lambda: curve.build(curve.parse_points(attrs.get("lower") or ""), None, 0),
                ),
                ("mode", lambda: curve.parse_mode(attrs.get("mode"))),
                ("interp", lambda: curve.parse_interp(attrs.get("interp"))),
                ("spread", lambda: curve.parse_spread(attrs)),
                ("decimals", lambda: curve.parse_decimals(attrs)),
            ):
                if attrs.get(name) is None:
                    continue
                try:
                    parse()
                except ValueError as e:
                    line, column = _at(gen, name)
                    self._error(
                        "TDC285",
                        str(e),
                        "Every drawing attribute is checked before the run, so `check` and "
                        "the run agree.",
                        line,
                        column,
                    )

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
                file_gen.format_attempts(
                    file_gen.attempts(src.strip(), self.base_dir, self._roots())
                ),
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
                if f"gen:{name}" in _MISPLACED:
                    self._ignored(gen, name, _MISPLACED[f"gen:{name}"])
                    continue
                # A name the pack may claim is the pack's business, and the pack-parameter
                # check judges it with the registry in hand. The line is drawn by what the
                # ENGINE reads before the pack runs — everything else is handed to the pack as
                # an override. Getting this wrong refused `base=` on the 39 packs that declare
                # a `<sequence name="base">`, the whole check-digit family, on configs the
                # engine would have run correctly.
                if name not in RESERVED_TEMPLATE_ATTRS:
                    continue
                owners = ATTRIBUTE_OWNERS.get(name)
                if owners is not None and "template" not in owners:
                    belongs = ", ".join(f'type="{t}"' for t in sorted(owners))
                    self._ignored(
                        gen,
                        name,
                        f'"{name}" belongs to {belongs} — a type="template" generator ignores it.',
                    )
            return

        has_distribution = bool((attrs.get("distribution") or "").strip())
        order = (attrs.get("order") or "").strip()
        for name in attrs:
            if name not in GEN_ATTRS:
                self._ignored(gen, name, _MISPLACED.get(f"gen:{name}", _UNKNOWN_GEN_ATTR))
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
            # A date measured from another column is the fourth member of the derived
            # family, and it was the one nobody added. `running`, `stat` and `formula` are
            # keyed by TYPE below, which a date offset cannot be: it is `type="date"` plus
            # `of=`, and a plain `type="date"` reads every one of these correctly. So it is
            # keyed on `of=` instead.
            #
            # Measured over six rows, each byte-identical to the plain run: mask=, case=,
            # missing=, missing_as=, anomaly= with its factor, repeat= and percent= all did
            # nothing while `check` called the config valid.
            if (
                type_ == "date"
                and (attrs.get("of") or "").strip()
                and name in OFFSET_WRAPPERS_NOT_READ
            ):
                self._ignored(
                    gen,
                    name,
                    "a date measured from another column with of= is built in declaration "
                    "order, before the formatting layer runs — the same place a running "
                    "total is built. Apply it where the value is printed instead: "
                    "${{Later|mask:x}}, ${{Later|upper}}.",
                )
                continue
            # A wrapper the type never puts its value through. Separate from the ownership
            # table because the name IS a general wrapper — it works on almost every type,
            # and these two resolve before the layer that applies it.
            if type_ is not None and name in WRAPPERS_NOT_READ.get(type_, frozenset()):
                # A pool reference is the odd one here: it hands the row a whole MEMBER,
                # not a number. The note said "its number" because the sentence was written
                # for `running` and `stat` and then templated over the type name.
                held = "the member it drew" if type_ == "pool" else "its number"
                self._ignored(
                    gen,
                    name,
                    f'a type="{type_}" generator publishes {held} as it stands — the '
                    "formatting layer does not run for it. Apply it where the value is "
                    "printed instead: ${{Total|mask:x}}, ${{Total|upper}}.",
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
                    self._ignored(gen, name, _MISPLACED.get(f"gen:{name}", _UNKNOWN_GEN_ATTR))
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

        widths = self.packs.parameter_widths(path, self.locale)

        for name, value in attrs.items():
            if name in PACK_WRAPPER_ATTRS or name in _NOT_A_PACK_PARAM:
                continue
            if name in declared:
                # A parameter the pack DOES accept, pinned to a value of the wrong width.
                #
                # The packs that carry a check digit compute it over a fixed layout, so a
                # wrong-width value does not shift the layout — it breaks it. Measured on
                # ``usa.finance.aba_routing``, whose own ``prefix`` is 2 characters:
                # ``prefix="12345"`` aborted the run with ``<at>: index 8 is out of range``,
                # naming no file, line or code, and ``tail="678"`` said nothing at all and
                # wrote a six-digit number that is not a routing number. ``check`` passed on
                # both. Only reported where the width is a FACT read off the pack's own body.
                want = widths.get(name)
                if want is not None and len(value) != want:
                    line, column = _at(gen, name)
                    self._error(
                        "TDC276",
                        f'"{name}" is pinned to {len(value)} characters, and "{path}" builds '
                        f"its value around a {name}= of exactly {want}",
                        f"A pinned parameter replaces the pack's own value, and this pack has "
                        f"a fixed layout — a check digit is computed over the whole of it. Use "
                        f"a {name}= of {want} characters, or drop it and let the pack draw its "
                        "own.",
                        line,
                        column,
                    )
                continue
            line, column = _at(gen, name)
            if declared:
                hint = "Parameters of this generator: " + _candidates(list(declared)) + "."
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
        # No near name when the attribute has a sentence of its OWN: `count=` is not a
        # misspelling of anything, and offering `case` beside an explanation of where count=
        # belongs is two answers to one question.
        near = "" if f"gen:{name}" in _MISPLACED else closest_match(name, sorted(GEN_ATTRS))
        self._error(
            "TDC015",
            f'<gen> has no "{name}" attribute',
            why,
            line,
            column,
            _did_you_mean(near if near != name else ""),
        )

    def _check_fixture_data(self, fixture) -> None:
        """`<data>` with no `<line>` around it, inside a fixture body."""
        content = fixture.content()
        if content is None:
            return
        for child in content.element() or []:
            data_el = child.dataElement()
            if data_el is None:
                continue
            self._error(
                "TDC131",
                f"<data> directly inside <{fixture.name.text}> renders nothing",
                f"A fixture body is made of <line>s. Wrap it: <{fixture.name.text}><line>"
                f"<data>…</data></line></{fixture.name.text}>.",
                _line(data_el),
                _column(data_el),
            )

    def _check_required_value(self, gen, attrs: dict[str, str], type_: str | None) -> None:
        """Every generator that cannot work without one particular attribute."""
        value = attrs.get("value")
        missing = value is None or not value.strip()

        if type_ == "text":
            if missing:
                self._error(
                    "TDC050",
                    '<gen type="text"> requires a "value" attribute',
                    'Provide comma-separated values, e.g. value="Male,Female".',
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
                    f"Use a known template path, e.g. "
                    f"{_candidates(list(KNOWN_TEMPLATE_PATHS), 3)}.",
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
            # `local=` on the <gen> picks the pack, so it decides which locale this check asks
            # about. Reading only the env locale here validated a DIFFERENT config than the one
            # that would run: `local="zh"` on a path zh does not ship passed `check`, and the run
            # then died with a raw "unknown template path" from inside the pack reader.
            locale = (attrs.get("local") or "").strip() or self.locale
            if self.packs.exists(address, locale):
                # The address resolves; whether the file behind it is usable is a separate
                # question, and one worth answering now. A pack a user wrote themselves is exactly
                # the kind that is malformed, and finding out on the first row wastes the run.
                try:
                    self.packs.load(address, locale)
                except (ValueError, OSError) as e:
                    self._error("TDC170", str(e), f'Data pack file for "{address}".', line, column)
            elif locale != "en" and self.packs.exists(address, "en"):
                # The path is real — the DATA for this locale is missing. Said as
                # its own code because "unknown template path" reads as a typo and
                # sends the reader hunting for one that is not there.
                self._error(
                    "TDC217",
                    f'template path "{value}" has no data for locale "{locale}"',
                    f"It exists in: {_candidates(_locales_having(self.packs, address))}. "
                    'Set local="…" on this <gen> or on <env>, or choose a path your locale '
                    "ships.",
                    line,
                    column,
                )
            else:
                self._error(
                    "TDC071",
                    f'unknown template path "{value}"',
                    "Known paths: person.male.firstName, person.female.firstName, person.lastName, "
                    "person.male.diagnosis, person.female.diagnosis, person.gender, … (3 more).",
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
                'Provide a finite advanced regex pattern, e.g. value="(?%{70:RU;30:US})-[0-9]{6}".',
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
            #
            # A parameter written as an EXPRESSION has no value yet, so it is checked with `1`
            # standing in — every parameter of every distribution accepts it, and the rest of the
            # generator is still judged. A value the distribution rejects (a negative `sd`) is
            # caught by the run, where it finally exists, with the same message.
            dynamic = dist_params.expression_params(attrs)
            for name in dynamic:
                self._expression_names(gen, name, attrs.get(name, ""))
            for_check = dict(attrs)
            for name in dynamic:
                for_check[name] = "1"
            try:
                dist.parse(for_check)
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

        # A blank value= is a written attribute, not an absent one. Skipping it here let the
        # generator fall back to its default range and invent numbers for a config that had
        # named none: value="" produced 4 2 8 while the reference refused the same file.
        value = attrs.get("value")
        if value is not None and checks.number_range_problem(value) is not None:
            line, column = _at(gen, "value")
            self._error(
                "TDC081",
                f'invalid number range "{value}"',
                'Expected "bit", a single number like "50", a list like "10,20,35", '
                'a range "MIN..MAX", or a mix of those: "0,10..20,99".',
                line,
                column,
            )

        first_zero = attrs.get("first_zero")
        if first_zero is not None and not checks.is_boolean_text(first_zero):
            line, column = _at(gen, "first_zero")
            self._error(
                "TDC082",
                f'invalid first_zero "{first_zero}" — expected "true" or "false"',
                "",
                line,
                column,
            )

        length = attrs.get("length")
        if length is not None and not checks.is_valid_length(length):
            line, column = _at(gen, "length")
            self._error(
                "TDC083",
                f'invalid length "{length}" — expected a positive integer, range, or '
                "comma-separated length groups",
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

        self._check_decimals_reach_something(gen, attrs)
        self._check_first_zero_is_reachable(gen, attrs)

    def _check_decimals_reach_something(self, gen, attrs: dict[str, str]) -> None:
        """``decimals=`` only describes a draw that HAS a fractional part.

        Two shapes reached the generator and were dropped there::

            <gen type="number" length="4" decimals="2"/>               -> 4566
            <gen type="number" value="1..9" length="3" decimals="2"/>  -> 3.78

        The first has no range, so the generator produces a digit STRING — an identifier —
        and there is nothing to round. The second has one, so ``decimals`` wins and ``length``
        is discarded instead: a fractional value has no integer width to pad to.
        """
        decimals = (attrs.get("decimals") or "").strip()
        if not decimals or decimals == "0":
            return
        value = (attrs.get("value") or "").strip()
        if not value:
            line, column = _at(gen, "decimals")
            self._error(
                "TDC277",
                f'decimals="{decimals}" has nothing to round — without value= this generator '
                "produces a digit string",
                'Give it a range to draw from: value="0..100" decimals="2". A number with only '
                "length= is an identifier of that many digits, and an identifier has no decimal "
                "places.",
                line,
                column,
            )
            return
        length = (attrs.get("length") or "").strip()
        if length:
            line, column = _at(gen, "length")
            self._error(
                "TDC278",
                f'length="{length}" is not read beside decimals="{decimals}" — a fractional '
                "value has no integer width to pad",
                "Keep one of them: decimals= for a fractional value over the range, or length= "
                "for a whole number padded to a fixed width.",
                line,
                column,
            )

    def _check_first_zero_is_reachable(self, gen, attrs: dict[str, str]) -> None:
        """``first_zero="false"`` the range can never satisfy.

        A drawn value is padded to ``length`` with zeros, so it avoids a leading one only by
        being wide enough on its own. When the range's largest value has fewer digits than the
        width, EVERY draw needs padding — and the generator answered by redrawing a hundred
        times and emitting the forbidden shape anyway.
        """
        if (attrs.get("first_zero") or "") != "false":
            return
        value = (attrs.get("value") or "").strip()
        length = (attrs.get("length") or "").strip()
        if not value or not length:
            return
        try:
            widths = [
                w
                for choice in number_gen.parse_length_choices(length)
                for w in range(choice.min, choice.max + 1)
            ]
            biggest = max(r.max for r in number_gen.parse_ranges(value))
        except Exception:
            return  # a malformed range or length is already reported above
        unreachable = [w for w in widths if w > 1 and biggest < 10 ** (w - 1)]
        if not unreachable:
            return
        smallest = min(unreachable)
        digits = f"{unreachable[0]} digits" if len(unreachable) == 1 else f"{smallest} digits"
        line, column = _at(gen, "first_zero")
        self._error(
            "TDC279",
            f'first_zero="false" cannot be honoured — no value in "{value}" reaches {digits}, '
            "so every draw has to be padded",
            f"The widest value the range offers is {biggest}. Widen the range — "
            f'value="{10 ** (smallest - 1)}..{10**smallest - 1}" — or drop length=, or allow '
            "the zero.",
            line,
            column,
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
                    "Use finite regex: bounded quantifiers such as {n} or {n,m}; unbounded *, +, "
                    "and {n,} are rejected.",
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
                    "Use finite advanced regex. Weighted choice syntax is (?%{70:A;30:B}); branch "
                    "percentages must sum to 100.",
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
                # The SHORT sentence here: the reader has both spellings in front of them and
                # needs to drop one, not a list of the sixteen named sets.
                'Use `value="[a-z]"` for an inline set, or '
                '`alphabet="cyrillic.ru.letters"` for a named one.',
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
                'Inline: value="[a-z]" or value="कखगघ". Named, e.g. '
                'alphabet="cyrillic.ru.letters". Known: '
                f"{_candidates(checks.alphabet_names(), 8)}.",
                _line(gen),
                _column(gen),
            )
            return
        if alphabet and not checks.is_known_alphabet(alphabet):
            line, column = _at(gen, "alphabet")
            self._error(
                "TDC099",
                f'unknown alphabet "{alphabet}"',
                f"Known alphabets: {_candidates(checks.alphabet_names())}.",
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
        """The seasonal attributes on a ``<gen type="timeseries">``.

        A wave is ``amplitude·cos(2π·(i − peak)/period)``, and ``period``, ``amplitude`` and
        ``peak_at`` describe the SAME waves position by position: ``period="7,365"`` with
        ``amplitude="120,400"`` is a weekly wave 120 tall and a yearly one 400 tall. Lengths
        that disagree describe no wave anybody can draw, so they are refused rather than
        half-honoured.

        ``peak_at`` names the row the wave is highest on. Without it the peak sits a quarter
        period in, which is where a plain sine already peaked — and for a year of daily rows
        that is early April, the one season nobody means by "warmer in summer". It is a ROW,
        not a shift, because the row is what the author knows: 182 of 365 is the first of
        July. Same unit as ``period``, which is also counted in rows.
        """
        if type_ != "timeseries":
            return
        periods = _wave_entries(attrs.get("period"))
        amplitudes = _wave_entries(attrs.get("amplitude"))
        peaks = _wave_entries(attrs.get("peak_at"))

        self._check_noise_correlation(gen, attrs)
        self._check_wave_lists(gen, periods, amplitudes, peaks)

        if attrs.get("peak_at") is None:
            return
        raw = (attrs.get("peak_at") or "").strip()
        line, column = _at(gen, "peak_at")

        if not peaks or not _all_numbers(peaks):
            self._error(
                "TDC252",
                f'peak_at="{raw}" is not a number',
                "peak_at is the row the seasonal wave peaks on, counted like period= — "
                'peak_at="182" over period="365" puts the peak at the first of July. One '
                'entry per period=, so period="7,365" takes peak_at="5,182".',
                line,
                column,
            )
            return

        # A wave needs a length before it can have a highest point. Without `period` there is
        # no wave at all, so `peak_at` would be read by nobody.
        if not periods or not _all_numbers(periods) or any(float(p) <= 0 for p in periods):
            self._error(
                "TDC253",
                f'peak_at="{raw}" has no period= on the same <gen> — there is no wave to '
                "place a peak on",
                "Add period= (the length of one season, in rows), or remove peak_at=.",
                line,
                column,
            )

    def _check_wave_lists(
        self, gen, periods: list[str], amplitudes: list[str], peaks: list[str]
    ) -> None:
        """The three seasonal lists have to line up, and every period has to be a length.

        Both used to be accepted and then half-read: ``period="7,365" amplitude="120"`` gave the
        yearly wave an amplitude of zero — a config asking for two seasons and getting one, with
        nothing said. A ``0`` among several periods is the same shape: on its own ``period="0"``
        means "no wave", which is a sensible thing to write, but in a list it is a wave with no
        length beside waves that have one.
        """
        if not periods or not _all_numbers(periods):
            return

        if len(periods) > 1 and any(float(p) <= 0 for p in periods):
            line, column = _at(gen, "period")
            self._error(
                "TDC304",
                f'period="{",".join(periods)}" lists a season with no length — every period '
                "in a list must be above zero",
                'period="0" on its own means "no seasonal wave". Among several it is a wave '
                "nothing can be drawn from: drop the entry, and its amplitude= with it.",
                line,
                column,
            )

        # One amplitude for several periods is the shorthand for waves of equal height, and is
        # kept: it reads exactly as it looks. Any other mismatch does not.
        for name, entries in (("amplitude", amplitudes), ("peak_at", peaks)):
            if not entries:
                continue
            if name == "amplitude" and len(entries) == 1:
                continue
            if len(entries) == len(periods):
                continue
            line, column = _at(gen, name)
            hint = (
                'One amplitude per period — period="7,365" amplitude="120,400" — or a single '
                "amplitude for waves of equal height."
                if name == "amplitude"
                else 'One peak_at per period: period="7,365" peak_at="5,182".'
            )
            self._error(
                "TDC304",
                f'{name}="{",".join(entries)}" has {len(entries)} entries and period= has '
                f"{len(periods)} — they describe the same waves",
                hint,
                line,
                column,
            )

    def _check_noise_correlation(self, gen, attrs: dict[str, str]) -> None:
        """``noise_correlation=`` — how much of one row's noise carries into the next.

        At 1 the noise would stop being noise and become a random walk with no level to return
        to; at more than 1 it grows without bound. Both are refused rather than clamped, because
        a config asking for either meant something else.
        """
        if attrs.get("noise_correlation") is None:
            return
        raw = (attrs.get("noise_correlation") or "").strip()
        line, column = _at(gen, "noise_correlation")
        try:
            value = float(raw)
        except ValueError:
            value = float("nan")
        if value != value or abs(value) >= 1:
            self._error(
                "TDC305",
                f'noise_correlation="{raw}" must be a number between -1 and 1',
                "It is how much of one row\u2019s noise carries into the next: 0 is "
                "independent noise, 0.8 is strongly correlated. At 1 the series would wander "
                "off and never come back.",
                line,
                column,
            )
            return

        # Correlation of WHAT, when there is nothing to correlate. `noise="0"` and no `noise=`
        # at all both leave this attribute deciding nothing.
        noise = (attrs.get("noise") or "").strip()
        blank = not noise
        try:
            zero = not blank and float(noise) == 0
        except ValueError:
            zero = False
        if value != 0 and (blank or zero):
            self._error(
                "TDC305",
                "noise_correlation= without noise= — there is no noise to correlate",
                'Add noise="p" (the strength of the jitter), or remove noise_correlation=.',
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
                'Use from="2020-01-01" to="2025-12-31" or value="2020-01-01..2025-12-31".',
                _line(gen),
                _column(gen),
            )
        local = attrs.get("local")
        if local is not None and local.strip() and not checks.is_known_date_locale(local):
            line, column = _at(gen, "local")
            self._error(
                "TDC153",
                f'unknown date locale "{local}"',
                f"Known date locales: {_candidates(list(date_locales.NAMES))}.",
                line,
                column,
            )
        self._check_env_locale_has_dates(gen, attrs)
        self._check_date_plus_without_of(gen, attrs)
        self._check_date_step(gen, attrs)
        self._check_date_weekdays(gen, attrs)
        self._check_date_common(gen, attrs)
        self._check_date_values(gen, attrs)
        self._check_one_date_spelling(gen, attrs)
        self._check_date_range_not_reversed(gen, attrs)

    def _check_one_date_spelling(self, gen, attrs: dict[str, str]) -> None:
        """One spelling of the range, not two.

        ``value=``, the ``from``/``to`` pair and ``range=`` are three ways to say the same
        thing, and the generator reads them in that order and stops. Writing two put one of
        them in the file and did nothing with the other, without a word::

            value="2020-05-05" from="1990-01-01" to="1990-12-31"   ->  1990-05-11
            value="today" from="1990-01-01" to="1990-12-31"        ->  2026-08-08
        """
        spellings = []
        if (attrs.get("value") or "").strip():
            spellings.append("value=")
        if attrs.get("from") is not None or attrs.get("to") is not None:
            spellings.append("from=/to=")
        if attrs.get("range") is not None:
            spellings.append("range=")
        if len(spellings) < 2:
            return
        listed = ", ".join(spellings[:-1]) + " and " + spellings[-1]
        count = "two spellings" if len(spellings) == 2 else "three spellings"
        self._error(
            "TDC280",
            f'<gen type="date"> carries {listed} — they are {count} of the same range, and '
            "only the first is read",
            # Written once as source rather than as a sentence: a triple-quoted `""" +
            # repr(HINT_SPELL) + """` reached the user as those very characters, so the one
            # diagnostic about writing a range two ways gave no advice about either.
            'Keep one: value="2020-01-01..2025-12-31", or from="2020-01-01" to="2025-12-31", '
            'or range="2020-01-01..2025-12-31". `value="today"`, `"now"` and `"birth"` are '
            "spellings too, so they cannot carry a from/to either.",
            _line(gen),
            _column(gen),
        )

    def _check_date_range_not_reversed(self, gen, attrs: dict[str, str]) -> None:
        """A range whose end is before its start, refused rather than swapped.

        The draw took ``min`` and ``max`` of the two ends, so ``from="2020-01-01"
        to="2010-01-01"`` produced perfectly plausible dates from the range the author did NOT
        write. The date page already states the rule for ``plus=``: write the smaller bound
        first, and a typo is refused rather than quietly swapped.
        """
        pairs = [((attrs.get("from") or "").strip(), (attrs.get("to") or "").strip(), "to")]
        raw = (attrs.get("range") or attrs.get("value") or "").strip()
        dots = raw.find("..")
        if dots > 0:
            pairs.append(
                (
                    raw[:dots],
                    raw[dots + 2 :],
                    "range" if attrs.get("range") is not None else "value",
                )
            )
        for start_raw, end_raw, where in pairs:
            if not start_raw or not end_raw:
                continue
            try:
                start = dataclasses.astuple(date_parse.date_time(start_raw).value)
                end = dataclasses.astuple(date_parse.date_time(end_raw).value)
            except (ValueError, OSError):
                continue  # already reported by the value checks above
            if start <= end:
                continue
            line, column = _at(gen, where)
            self._error(
                "TDC281",
                f'the range ends before it starts — "{end_raw}" is earlier than "{start_raw}"',
                f'Write the smaller bound first: "{end_raw}".."{start_raw}". A reversed range '
                "used to be swapped silently, which meant drawing from a range nobody wrote.",
                line,
                column,
            )

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
            f'Date locales: {_candidates(list(date_locales.NAMES))}. Use format="YYYY-MM-DD" '
            "\u2014 or any format without month or weekday names \u2014 to get the same text in "
            "every language, or accept the English month names.",
            _line(gen),
            _column(gen),
        )

    def _check_date_plus_without_of(self, gen, attrs: dict[str, str]) -> None:
        """``plus=`` on a date that is not measured from anything.

        ``plus=`` belongs to the offset and nothing else reads it, so a lone ``plus="3d"`` was
        dropped in silence and the column came out as ordinary drawn dates. "Shift this column by
        three days" is the natural misreading of it — and this generator already refuses ``step=``
        and ``weekdays=`` on a drawn date for exactly that reason.
        """
        if attrs.get("plus") is None:
            return
        line, column = _at(gen, "plus")
        self._error(
            "TDC264",
            '<gen type="date" plus="…"> does not say what it is measured from',
            'Add of="Name" to measure from another date column — plus= is how far from it, and '
            "on its own there is nothing to be far from. To move every drawn date, move the "
            "range.",
            line,
            column,
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
                self._error("TDC154", str(e), "", line, column)

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
        self._check_distinct(gen, attrs, repeats, type_)

        if repeats:
            reason = checks.repeat_unsupported_reason(type_)
            if reason is not None:
                line, column = _at(gen, "repeat")
                self._error(
                    "TDC204",
                    f'"repeat" is not supported on <gen type="{type_}"> — {reason}',
                    "Only increment, decrement, timeseries and pattern refuse it, and all four "
                    "for the same reason: their value is decided by the row index, which a list "
                    "of unknown length leaves undecided. Every other generator repeats, text "
                    "included.",
                    line,
                    column,
                )
        elif attrs.get("separator") is not None:
            # A separator with nothing to separate is a request that silently does nothing.
            line, column = _at(gen, "separator")
            self._error(
                "TDC198",
                '"separator" has no effect without "repeat"',
                'separator joins the values a repeating gen produces. Add repeat="N" or '
                'repeat="A..B".',
                line,
                column,
            )

    def _check_distinct(self, gen, attrs: dict[str, str], repeats: bool, type_: str | None) -> None:
        """``distinct="true"`` — the row's values are drawn without replacement.

        Four refusals, and each one is a proof rather than a guess. They exist because the
        alternative in every case is a config that says something and silently gets
        something else.
        """
        raw = attrs.get("distinct")
        if raw is None:
            return
        line, column = _at(gen, "distinct")
        word = raw.strip()
        if word not in ("true", "false"):
            self._error(
                "TDC289",
                f'"distinct" takes true or false, not "{word}"',
                'distinct="true" draws a repeat list without replacement. Omit it, or write '
                'distinct="false".',
                line,
                column,
            )
            return
        if word == "false":
            return

        # One value cannot repeat itself, so the attribute would be read and then do
        # nothing — the accepted-and-ignored failure this project keeps closing.
        if not repeats:
            self._error(
                "TDC290",
                '"distinct" has no effect without "repeat"',
                "distinct= stops one cell holding the same value twice, so there has to be a "
                'list. Add repeat="N" or repeat="A..B", or drop distinct=.',
                line,
                column,
            )
            return

        # `percent` is an EXACT quota over the whole run; `distinct` is a guarantee inside
        # one row. Holding both would cost either streaming or the randomness of the
        # sample, so the pair is refused.
        if attrs.get("percent") is not None:
            p_line, p_column = _at(gen, "percent")
            self._error(
                "TDC291",
                '"percent" and "distinct" cannot both be on one <gen>',
                "percent= promises exact proportions across the whole run; distinct= trades "
                "that promise away for a guarantee inside each row, so the two cannot both "
                "hold. Drop one — or put the proportions on a <mix> or <switch> outside, "
                "with repeat= on the <gen> inside.",
                p_line,
                p_column,
            )

        # The pool is only knowable up front for the types that carry it in the config.
        # Where it is not — a pack file, a regex — the same refusal fires at run time.
        pool = checks.distinct_pool_size(type_, attrs)
        try:
            spec = repeat_gen.parse(attrs)
        except ValueError:
            return  # A malformed repeat= is already reported as TDC195.
        longest = spec.max if spec is not None else None
        if pool is not None and longest is not None and longest > pool:
            r_line, r_column = _at(gen, "repeat")
            self._error(
                "TDC292",
                f'"repeat" asks for up to {longest} different values, but the list holds '
                f"only {pool}",
                f'With distinct="true" a value cannot be used twice in one cell, so {longest} '
                "of them cannot be found. Lower repeat=, or widen value=.",
                r_line,
                r_column,
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
                _did_you_mean(closest_match(value, self.declared_order)),
            )

    def _expression_names(self, gen, attribute: str, source: str) -> None:
        """Every column an expression-valued parameter names must be declared ABOVE it.

        The same rule `formula` follows, and for a sharper reason than a typo: a FORWARD reference
        makes the two engines disagree — the streaming registry answers it and the in-memory one
        does not — so one config would mean two datasets. TDC240 is shared with `running` on
        purpose; it is the same complaint about the same thing.
        """
        # The little language itself — its operators, its functions, its constructs. The name
        # loop below is about which COLUMNS the expression reads and says nothing about whether
        # it is one the evaluator can run, so a misspelled function used to pass `check` and kill
        # the run with a bare `unknown function`.
        line, column = _at(gen, attribute)
        kind = "expression" if attribute == "expr" else "parameter"
        article = "an" if attribute[0].lower() in "aeiou" else "a"
        self._check_if_expression(source, line, column, f"{attribute}= {kind}", article)

        try:
            parsed = expr_parse(source)
        except ValueError:
            return  # Already reported; there is no tree to walk.
        # `prev(RR, 700)` may name THIS column, and only there. Referring to your own
        # column in an ordinary formula is meaningless — the value being computed is the
        # one you are asking for — which is what the rule below refuses. Reading your own
        # PREVIOUS row is the opposite: a random walk, a Markov chain, an autoregression,
        # and the whole reason `mode="sequential"` exists.
        own_prev = _prev_targets(parsed) & {self.current_sequence or ""}
        for name in sorted(_identifiers_of(parsed)):
            if checks.is_builtin(name) or name in self.declared_order or name in own_prev:
                continue
            line, column = _at(gen, attribute)
            # The sentence follows what this attribute IS. `expr=` is the formula itself, and
            # calling it "a parameter" described something else entirely — the note is the half
            # a reader acts on, so it has to be about the thing in front of them.
            nothing_above = (
                "A formula is computed from columns that already exist, so the columns it "
                "reads have to come first."
                if attribute == "expr"
                else "A parameter reads a column that already exists, so the column it reads "
                "has to come first."
            )
            self._error(
                "TDC240",
                f'"{name}" in {attribute}= is not a sequence declared above this one',
                nothing_above
                if not self.declared_order
                else "Declared above: " + ", ".join(self.declared_order) + ".",
                line,
                column,
                _did_you_mean(closest_match(name, self.declared_order)),
            )

    def _check_formula(self, gen, attrs: dict[str, str], type_: str | None) -> None:
        """`expr=` is what a formula IS, and every name in it must be a column declared above."""
        if type_ != "formula":
            return
        source = (attrs.get("expr") or "").strip()
        if not source:
            # The fault is an ABSENT attribute, so there is no value to underline —
            # the tag itself is the target, as it is for every other missing-attribute
            # refusal. The reference does this; pointing at type= put the caret on the
            # one thing that was written correctly.
            line, column = _line(gen), _column(gen)
            self._error(
                "TDC294",
                '<gen type="formula"> does not say what to compute',
                'Add expr="…" — the arithmetic this column is, written the way an if= condition is '
                'written: expr="0.75 * Height - 58".',
                line,
                column,
            )
            return
        self._expression_names(gen, "expr", source)

    def _check_derived_not_conditional(self, gen, attrs: dict[str, str], type_: str | None) -> None:
        """A derived column cannot be ONE BRANCH of a per-row choice.

        `running`, `stat`, a date offset and `formula` are built once, for the whole column, in
        declaration order. An `if=` asks for something else entirely: a value chosen row by row.
        The two cannot both be true, and the run used to die with a message that read like an
        unfinished engine rather than a config that cannot mean anything.
        """
        if not _is_derived(type_, attrs):
            return
        if not (attrs.get("if") or "").strip():
            return
        line, column = _at(gen, "if")
        self._error(
            "TDC295",
            f'a type="{type_}" column is built for the whole run, so it cannot carry if=',
            "It reads other columns in declaration order and produces one column, not a value "
            'chosen per row. Put the condition where the value is USED — `<data if="…">` — or '
            "compute the column unconditionally and branch on it afterwards.",
            line,
            column,
        )

    def _check_quantile_read(self, gen, attrs: dict[str, str], type_: str | None) -> None:
        """`read="quantile"` — the file as a sorted sample rather than a bag of values.

        Everything refused here asks for TWO readings of one file at once. `weight=` says the
        shares live in a second column; `read="quantile"` says the values ARE the distribution.
        `row=` links several columns to one LINE, and a quantile answer is a point between two of
        them. `order="sequential"` walks the list in order, which a distribution has no notion of.
        """
        if type_ != "file":
            return
        read = (attrs.get("read") or "").strip()
        sample = (attrs.get("sample") or "").strip()

        if "read" in attrs and read != "quantile":
            line, column = _at(gen, "read")
            self._error(
                "TDC297",
                f'read="{read}" is not a way of reading a file — the only one is "quantile"',
                "Leave read= off to pick one of the file's values at random, or write "
                'read="quantile" to read the file as a sorted sample and land anywhere on it.',
                line,
                column,
            )
            return

        if "sample" in attrs and sample != "exact":
            line, column = _at(gen, "sample")
            self._error(
                "TDC297",
                f'sample="{sample}" is not a sampling mode — the only one is "exact"',
                "Leave sample= off to draw from the distribution row by row, or write "
                'sample="exact" to sweep it evenly so the run reproduces the sample with no '
                "sampling noise.",
                line,
                column,
            )

        if "sample" in attrs and read != "quantile":
            line, column = _at(gen, "sample")
            self._error(
                "TDC297",
                'sample= only means something beside read="quantile"',
                "It chooses between drawing from the distribution and sweeping it evenly, and a "
                "file read as a plain list of values has no distribution to sweep.",
                line,
                column,
            )

        if read != "quantile":
            return

        for name, why in (
            (
                "weight",
                'weight= puts the shares in a COLUMN beside the values, and read="quantile" '
                "says the values are the distribution themselves — how often one appears in the "
                "file IS its share",
            ),
            (
                "row",
                "row= links several columns to one LINE of the file, and a quantile answer is not "
                "a line: it is a point between two of them",
            ),
        ):
            if not (attrs.get(name) or "").strip():
                continue
            line, column = _at(gen, name)
            self._error(
                "TDC297",
                f'{name}= cannot be combined with read="quantile": {why}',
                "Keep one of the two readings. A countable value — a city, a status, a number of "
                "orders — wants weight= and its exact quota; a measured one wants the quantile "
                "read, which also fills in the values "
                "between the observations."
                if name == "weight"
                else "To keep a record together, read the file as lines with row= and leave "
                "read= off.",
                line,
                column,
            )

        if (attrs.get("order") or "").strip() == "sequential":
            line, column = _at(gen, "order")
            self._error(
                "TDC297",
                'order="sequential" cannot be combined with read="quantile"',
                "Walking a list in order and sampling a distribution are different jobs: one "
                "hands out the file's lines one after another, the other says where on the "
                "sorted sample a row lands.",
                line,
                column,
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
                hint = "One of: " + ", ".join(stat_gen.OPS) + "."
                self._error(
                    "TDC262",
                    str(err),
                    hint,
                    at_line,
                    at_column,
                    _did_you_mean(closest_match(raw_op, list(stat_gen.OPS))),
                )
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
                _did_you_mean(closest_match(of, self.declared_order)),
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

        # A ``repeat=`` source is a LIST in one cell, and an offset measures from a DATE. The run
        # said so in the worst possible words — it quoted the joined text and blamed the format,
        # sending the reader to look for a ``format=`` mistake that was never there. The cause is
        # the repetition, so name it.
        if of and of in self.repeating_names:
            at_line, at_column = _at(gen, "of")
            self._error(
                "TDC240",
                f'of="{of}" repeats, so each cell holds a LIST of dates rather than one date',
                "An offset measures from a single date. Drop repeat= on that column, or measure "
                "from one that does not repeat.",
                at_line,
                at_column,
            )

        if of and of not in self.declared_order:
            at_line, at_column = _at(gen, "of")
            # The near name goes on its OWN line — `help:` above the `note:` — rather than being
            # folded into the front of the hint, where it read as part of the explanation.
            hint = (
                "A date is measured from a column that already exists, so the column it reads "
                "has to come first."
                if not self.declared_order
                else "Declared above: " + ", ".join(self.declared_order) + "."
            )
            self._error(
                "TDC240",
                f'of="{of}" is not a sequence declared above this one',
                hint,
                at_line,
                at_column,
                _did_you_mean(closest_match(of, self.declared_order)),
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
                "For inline values the equivalent is percent=. weight= reads the shares from a CSV "
                "column.",
                line,
                column,
            )
            return
        if not (attrs.get("column") or "").strip():
            self._error(
                "TDC212",
                '"weight" needs "column" — the weights live in a second CSV column',
                'Name both: column="name" weight="count".',
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
                "Supported: random (default), sequential.",
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
                # An attribute with a check of its OWN is not also an unknown one. `repeat=` on
                # a <mix> has TDC196, which says the useful thing -- a mix picks one BRANCH, so
                # there is no list for repeat= to make -- and this pass reported TDC015 ahead of
                # it. Both were emitted; only the first is read, and the first says "typo",
                # sending someone to look for the correct spelling of an attribute a <mix> is
                # never going to have.
                if f"{tag}:{key}" in _HAS_ITS_OWN_REFUSAL:
                    continue
                # An attribute written on the wrong TAG has a sentence of its own too, not only one
                # written on a <gen>: `percent=` on a <switch> is not a misspelling, and "Attributes
                # of <switch>: comment, name, on" leaves the reader to work out for themselves that
                # shares belong to a <mix>.
                self._error(
                    "TDC015",
                    f'<{tag}> has no "{key}" attribute',
                    _MISPLACED.get(
                        f"{tag}:{key}",
                        f"Attributes of <{tag}>: {', '.join(sorted(known))}.",
                    ),
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
                "Allowed inside <case>: data, gen, mix, switch.",
                _line(open_el),
                _column(open_el),
            )

    def _warn_inferred_zeros(self, mask: str, value: str, line: int, column: int) -> None:
        """A value that is declared and can never be drawn.

        A warning rather than a refusal: the run is well defined and somebody may want exactly
        this. What is not acceptable is saying it in silence.
        """
        values = [s.strip() for s in value.split(",")]
        try:
            zeros = percent_mask.inferred_zeros(mask, len(values))
        except percent_mask.MaskError:
            return  # already reported by the check above
        if not zeros:
            return
        named = ", ".join(f'"{values[i]}"' for i in zeros)
        plural = "a value that is" if len(zeros) == 1 else "values that are"
        self._warn(
            "TDC301",
            f"percent leaves {named} at 0% — {plural} declared and never drawn",
            "A percent shorter than the list is fine: what is left over goes to the positions "
            "you did not write. Here the ones you did write already total 100, so there is "
            "nothing left. Give it the share you meant, drop it from value=, or write the 0 "
            "yourself to say you meant it.",
            line,
            column,
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
            # The sentence follows the CODE, not the kind of mask error: a `<mix>` percent mask is
            # checked against its <case> children and a number's against its value list, so "filled
            # positions split the remaining percent" is an answer to the second question only. One
            # sentence for both told a reader with too many mix percentages about positions that are
            # not there.
            hint = {
                "TDC121": "The mix percent mask must have no more entries than there are "
                "<case> children.",
                "TDC051": "Percent masks may be shorter than value only when missing positions "
                "can be inferred. They may never be longer than value.",
            }.get(
                code,
                "Filled positions must be non-negative numbers. Empty positions split the "
                "remaining percent equally.",
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
                "Supported: bool, int32, int64, double, string, date, timestamp, decimal(p,s), "
                "uuid, json — plus |null, and []T for a list (e.g. []int64, []string|null).",
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
        line_condition = _attrs(line_el.attr()).get("if")
        if line_condition is not None:
            where = _at_attrs(line_el.attr(), "if", _line(line_el), _column(line_el))
            self._check_if_expression(line_condition, where[0], where[1])
            self._defer_expression(line_condition, where[0], where[1], walks_a_list)
        each = _attrs(line_el.attr()).get("each")
        if each is not None:
            line, column = _at(line_el, "each")
            if not each.strip():
                self._error(
                    "TDC206",
                    'each="" names no sequence',
                    'Point it at a repeating sequence: <line each="Orders">.',
                    line,
                    column,
                )
            elif each in self.declared_names and each not in self.repeating_names:
                # Walking a scalar would emit one line and look like it worked, which is the kind
                # of near-miss that survives review.
                self._error(
                    "TDC207",
                    f'each="{each}" — that sequence holds one value, not a list',
                    'Add repeat= to its <gen>, e.g. <gen … repeat="1..5"/>, or drop each=.',
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
                    "Declare a named <sequence> in <env> and reference it here with ${{Name}}. "
                    "See https://nickliapin.github.io/tdcv2/docs/core-concepts/sequences",
                    _line(self_closing),
                    _column(self_closing),
                )
                continue
            data = child.dataElement()
            if data is not None and _has_body(data):
                # The same rule one level up: a conditional <line> that holds a typed column.
                # The column is collected once per card either way, so the condition is dropped.
                if line_condition is not None and (_attrs(data.attr()).get("name") or "").strip():
                    named = (_attrs(data.attr()).get("name") or "").strip()
                    self._error(
                        "TDC209",
                        f'<line if="\u2026"> holds the typed column <data name="{named}">, so '
                        "the condition cannot be honoured",
                        "A column has one cell per card, collected whether or not the line was "
                        "rendered \u2014 the condition would be dropped and the typed file would "
                        "disagree with the text one. Put the condition on the sequence instead "
                        "(<gen if=\u2026>) and declare the column nullable: an empty cell in a "
                        "nullable column is a NULL.",
                        _line(line_el),
                        _column(line_el),
                    )
                    line_condition = None  # one message per line, not one per column
                self._check_closed_tag_attrs("data", data.attr(), _line(line_el), _column(line_el))
                self._check_data_type(data, _line(line_el), _column(line_el))
                # The <data> element, not the <line> around it: several <data> pieces can share a
                # line, and pointing at the line would name the wrong one whenever they do.
                self._check_interpolation(_data_text(data), data.start.line, data.start.column)
                condition = _attrs(data.attr()).get("if")
                if condition is not None:
                    where = _at_attrs(data.attr(), "if", _line(line_el), _column(line_el))
                    # A named <data> declares a typed output COLUMN, and a column has one cell
                    # per card — the columnar writer collects it whether or not the line was
                    # rendered, so the condition was dropped and the typed file disagreed with
                    # the text rendering of the same config.
                    column_name = (_attrs(data.attr()).get("name") or "").strip()
                    if column_name:
                        self._error(
                            "TDC209",
                            f'<data name="{column_name}"> declares a typed column, so its if= '
                            "cannot be honoured",
                            "A column has one cell per card, collected whether or not the "
                            "line was rendered \u2014 the condition would be dropped and the "
                            "typed file would disagree with the text one. Put the condition on "
                            "the sequence instead (<gen if=\u2026>) and declare the column "
                            "nullable: an empty cell in a nullable column is a NULL.",
                            where[0],
                            where[1],
                        )
                    self._check_if_expression(condition, where[0], where[1])
                    self._defer_expression(condition, where[0], where[1], walks_a_list)
                continue
            open_el = child.openCloseElement()
            if open_el is not None and open_el.name.text != "data":
                self._error(
                    "TDC132",
                    f"a <{open_el.name.text}> is not allowed inside <line> — the output block is "
                    "for formatting only",
                    "Declare it in <env> and reference it here with ${{Name}}. See https://nickliapin.github.io/tdcv2/docs/constructs/mix",
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
                # A dot with a KNOWN root is a field mistake, and saying so beats repeating the
                # whole reference back: the reader already knows the sequence exists. Collapsed
                # into "is not a declared sequence", the message sent someone to <env> to declare
                # a `P` that is declared right there — the field name is the typo, and it is the
                # likelier of the two, because a sequence name is written once in <env> while
                # field names are invented as you go.
                dot = name.find(".")
                root = name if dot < 0 else name[:dot]
                if dot >= 0 and (root in self.declared_names or checks.is_builtin(root)):
                    # Declaration order, not set order: the reference lists a compound's fields
                    # the way the config writes them, and a reader matching the note against the
                    # <sequence> above reads down the same list.
                    fields = [
                        n[len(root) + 1 :]
                        for n in self.declared_fields
                        if n.startswith(f"{root}.") and n in self.declared_names
                    ]
                    self._error(
                        "TDC193",
                        f'"{name}" — "{root}" has no fields, so this would be printed literally'
                        if not fields
                        else f'"{name}" is not a field of "{root}" — it would be printed literally',
                        f"Reference it as ${{{{{root}}}}}. Only a compound or composed <sequence> "
                        "has fields to address after a dot — a <mix>, a <switch> and a built-in "
                        "have none."
                        if not fields
                        else f'Fields of "{root}": {", ".join(fields)}.',
                        line,
                        column,
                    )
                else:
                    self._error(
                        "TDC193",
                        f'"{name}" is not a declared sequence — it would be printed literally',
                        "Declare it in <env>, or set a different inject= pattern if you really "
                        "want the text ${{…}} in the output.",
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
                    continue
                # The name is known. Now the part after the colon, which reached the renderer
                # unread until TDC273/TDC274/TDC275.
                self._check_filter_arg(kind, arg, line, column)

    # Filters whose whole job is the transform; an argument reaches nothing.
    _NO_ARGUMENT_FILTERS = ("trim", "sql", "upper", "lower", "capitalize", "title")

    @staticmethod
    def _whole_number(text: str) -> int | None:
        """``-3``, ``0``, ``12`` — nothing else. ``int()`` alone accepts ``1_0`` and ``+5``."""
        stripped = text.strip()
        body = stripped[1:] if stripped.startswith("-") else stripped
        return int(stripped) if body.isdigit() and body.isascii() else None

    def _check_filter_arg(self, kind: str, arg: str | None, line: int, column: int) -> None:
        """The ARGUMENT of an interpolation filter — the part after the colon.

        The filter NAME has been checked since TDC192, and a mask pattern since TDC199/TDC256.
        The argument of every other filter reached the renderer unread, and the renderer is
        lenient by design: ``apply_group`` returns the value untouched when the size is not a
        usable number, ``apply_compact`` when the base is outside 2..36. That leniency is right
        at render time — one bad row must not abort a million-row run — but it means the config
        says one thing and the output does another, with nothing said anywhere.

        Not refused, deliberately: ``group`` and ``compact`` with no argument (both have a
        documented default), ``csv:;`` (the delimiter is accepted and ignored on purpose), and a
        negative ``slice`` index. Only a from/to pair of the SAME sign can be proven empty; with
        mixed signs the answer depends on the value's length, and a refusal has to be a proof.
        """
        if kind in self._NO_ARGUMENT_FILTERS and arg is not None:
            self._error(
                "TDC274",
                f'the "{kind}" filter takes no argument — ":{arg}" is read by nothing',
                f"Write ${{{{X|{kind}}}}}. Chain filters with more pipes instead: "
                f"${{{{X|trim|{kind}}}}}.",
                line,
                column,
            )
            return
        if kind == "replace" and (arg is None or arg == "" or arg.startswith(",")):
            self._error(
                "TDC275",
                'the "replace" filter needs something to look for — ${{X|replace}} changes nothing',
                "Write both parts: ${{X|replace:from,to}}. Leave the second empty to delete: "
                "${{X|replace:-,}}.",
                line,
                column,
            )
            return
        if kind == "slice":
            if arg is None or not arg.strip():
                self._error(
                    "TDC273",
                    'the "slice" filter needs a start index — ${{X|slice}} keeps the whole value',
                    "Write ${{X|slice:0,4}} for the first four characters, or ${{X|slice:-3}} "
                    "for the last three. Indices are 0-based and the end is exclusive.",
                    line,
                    column,
                )
                return
            parts = arg.split(",")
            start = self._whole_number(parts[0])
            raw_to = parts[1] if len(parts) > 1 else None
            end = None if raw_to is None or not raw_to.strip() else self._whole_number(raw_to)
            if start is None or (raw_to is not None and raw_to.strip() and end is None):
                self._error(
                    "TDC273",
                    f'"slice:{arg}" is not a pair of indices — the value comes out unsliced',
                    "Indices are whole numbers, 0-based, end exclusive: ${{X|slice:0,4}}. A "
                    "negative index counts from the end: ${{X|slice:-3}}.",
                    line,
                    column,
                )
                return
            # Same sign, so the ORDER is decidable without knowing the value's length.
            if end is not None and (start >= 0) == (end >= 0) and start > end:
                self._error(
                    "TDC273",
                    f'"slice:{arg}" ends before it starts — the column comes out empty',
                    f"Swap them: ${{{{X|slice:{end},{start}}}}}. The end is exclusive, so 0,4 is "
                    "four characters.",
                    line,
                    column,
                )
            return
        if kind == "group" and arg:
            size = self._whole_number(arg.split(",")[0])
            if size is None or size <= 0:
                self._error(
                    "TDC273",
                    f'"group:{arg}" is not a group size — the value comes out ungrouped',
                    "The size is a whole number above zero, counted from the RIGHT: "
                    "${{X|group:3}} \u2192 1 234 567. A separator follows it: ${{X|group:4,-}}.",
                    line,
                    column,
                )
            return
        if kind == "compact" and arg:
            base = self._whole_number(arg)
            if base is None or base < 2 or base > 36:
                self._error(
                    "TDC273",
                    f'"compact:{arg}" is not a base between 2 and 36 — the number comes out '
                    "unchanged",
                    "The base is a whole number from 2 to 36; 36 is the default and the "
                    "shortest. Base 1 has no digits to write with, and there are only 36 "
                    "letters and digits.",
                    line,
                    column,
                )

    def _check_missing_when(self, gen, attrs: dict[str, str]) -> None:
        """``missing_when="…"`` — the condition that turns MCAR into MAR or MNAR.

        Only the two STRUCTURAL mistakes are raised here. The expression itself takes the road
        every other condition takes: the syntax check, then the deferred name pass that reports
        a word which looks like a column and is not. Writing a second name rule here would have
        been the easy thing and the wrong one — ``if="Tier == hi"`` proves a bare word is a legal
        literal, and a rule invented here would refuse configs the language accepts elsewhere.
        """
        when = attrs.get("missing_when")
        if when is None:
            return
        where = _at_attrs(gen.attr(), "missing_when", *_at(gen, "missing_when"))
        if not when.strip():
            self._error(
                "TDC303",
                'missing_when="" is empty — it decides which rows may go missing',
                'Give it a condition (missing_when="Age < 30"), or drop it: without one every '
                "row is eligible, which is MCAR.",
                where[0],
                where[1],
            )
            return
        if not (attrs.get("missing") or "").strip():
            self._error(
                "TDC303",
                "missing_when= without missing= — nothing can go missing, so the condition "
                "decides nothing",
                'Add the rate the eligible rows go missing at: missing="0.4".',
                where[0],
                where[1],
            )
            return
        # A repeated cell holds SEVERAL values on one row, and the condition asks about one.
        # Both readings are defensible — test each element, or test the row — so the combination
        # is refused rather than guessed at. It used to be accepted and ignored.
        if (attrs.get("repeat") or "").strip():
            self._error(
                "TDC303",
                "missing_when= is not read on a <gen> with repeat= — a repeated cell holds "
                "several values, and the condition asks about one",
                'Drop repeat=, or drop missing_when= and use plain missing="p", which does '
                "apply to every element of the cell.",
                where[0],
                where[1],
            )
            return
        self._check_if_expression(when.strip(), where[0], where[1])
        # `_value` is the value being hidden — a name the language provides, like `_count`.
        self._defer_expression(when.strip(), where[0], where[1], False, extra={"_value"})

    def _defer_expression(
        self,
        expression: str,
        line: int,
        column: int,
        each: bool,
        extra: frozenset[str] | set[str] | None = None,
    ) -> None:
        """Put an expression aside, together with the names it will be checked against.

        The scope is taken HERE rather than at the end: by then a pool's members have left the
        walk, and checking one of their conditions against the run's names got it wrong in both
        directions — a sibling field read as undeclared, and an env column read as fine.
        """
        self.pending_expressions.append(
            (
                len(self.diagnostics),
                expression,
                line,
                column,
                each,
                self.expr_scope,
                frozenset(extra or ()),
            )
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
                _did_you_mean(closest_match(path, sorted(self.declared_names))),
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
            near = closest_match(tail, list(values))
            self._warn(
                "TDC216",
                f'"{path}" — "{root}" never produces "{tail}", so this branch can never be taken',
                f'"{root}" produces: {", ".join(values)}.',
                line,
                column,
                _did_you_mean(f"{root}.{near}" if near else ""),
            )
            return
        field = tail.split(".")[0]
        if f"{root}.{field}" in self.declared_names:
            return
        fields = sorted(n[len(root) + 1 :] for n in self.declared_names if n.startswith(f"{root}."))
        near = closest_match(field, fields)
        self._error(
            "TDC215",
            f'"{path}" is not a field of "{root}" — the condition can never be true',
            f'Fields of "{root}": {", ".join(fields)}.' if fields else f'"{root}" has no fields.',
            line,
            column,
            _did_you_mean(f"{root}.{near}" if near else ""),
        )

    def _check_if_expression(
        self,
        expression: str,
        line: int,
        column: int,
        label: str = "if expression",
        article: str = "an",
    ) -> None:
        """The little language, wherever it is written.

        ``if=`` is the oldest home and its wording is quoted in the docs, so it stays the
        default. ``expr=``, ``filter=`` and a distribution parameter reach the same evaluator
        and so have to be refused by the same list — until they were wired in here, a
        misspelled function passed ``check`` and killed the run with a bare
        ``unknown function``.
        """
        try:
            parsed = expr_parse(expression)
        except ValueError as e:
            entity = _xml_entity(expression)
            if entity is None:
                # The reference checks the NESTING before it parses, so the two have separate
                # notes: a condition nested past the ceiling is a generated one, and a condition
                # that will not parse wants the operator table. Here both arrive as one parser
                # error, so they are told apart by what the parser said — one hint for both meant
                # the reader of a malformed `if=` was told their parentheses look generated.
                message = f'invalid {label} "{_clip(expression)}": {e}'
                if str(e) == NOT_ONE_EXPRESSION:
                    # An expression that is complete and then continues. One sentence for the
                    # shape, in all five — see the constant beside the parser.
                    hint = (
                        'Write ONE condition. Two expressions side by side, or a stray ";" '
                        'or "," left after one, is not something TDC reads.'
                    )
                elif "nests deeper than" in str(e):
                    hint = "A real condition nests a handful of parentheses; this looks generated."
                else:
                    hint = (
                        "See the operator table: "
                        "https://nickliapin.github.io/tdcv2/docs/core-concepts/output-formatting"
                    )
            else:
                found, means = entity
                message = (
                    f'invalid {label} "{_clip(expression)}": nothing is expanded here, '
                    f'so "{found}" is {len(found)} literal characters, '
                    f'not "{means}"'
                )
                hint = (
                    f"write {means} directly — TDC reads the characters as typed, "
                    "and the raw character is what the expression parser reads"
                )
            self._error("TDC100", message, hint, line, column)
            return
        self._check_expr_node(parsed, line, column, label, article)

    def _check_expr_node(self, node, line: int, column: int, label: str, article: str) -> None:
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
                self._check_expr_node(item, line, column, label, article)
            return
        if isinstance(node, Conditional):
            self._check_expr_node(node.test, line, column, label, article)
            self._check_expr_node(node.consequent, line, column, label, article)
            self._check_expr_node(node.alternate, line, column, label, article)
            return
        if isinstance(node, Binary):
            if node.op == "in" and isinstance(node.right, Array):
                # The one place a list belongs; check its items, not the list itself.
                self._check_expr_node(node.left, line, column, label, article)
                for item in node.right.items:
                    self._check_expr_node(item, line, column, label, article)
                return
            if node.op not in SUPPORTED_BINARY:
                self._error(
                    "TDC101",
                    f'unsupported operator "{node.op}" in {article} {label}',
                    f"Supported binary operators: {' '.join(SUPPORTED_BINARY)}. "
                    f"Functions: {', '.join(EXPR_FUNCTION_NAMES)}. "
                    "Anything an expression cannot say, a <compute> sequence can — it has "
                    "integer division, remainders, string surgery and checksums — and the "
                    "sequence it produces is what if= then compares.",
                    line,
                    column,
                    _did_you_mean(closest_match(node.op, list(SUPPORTED_BINARY))),
                )
            self._check_expr_node(node.left, line, column, label, article)
            self._check_expr_node(node.right, line, column, label, article)
            return
        if isinstance(node, Call):
            spec = EXPR_FUNCTIONS.get(node.name)
            if spec is None:
                planned = node.name in PLANNED_EXPR_FUNCTIONS
                near = None if planned else _nearest(node.name, EXPR_FUNCTION_NAMES)
                self._error(
                    "TDC257",
                    (
                        f"{node.name}() is not available yet in {article} {label}"
                        if planned
                        else f'unknown function "{node.name}" in {article} {label}'
                    ),
                    (
                        "TDC computes its own mathematics rather than calling each language's, "
                        "because the libms disagree in the last bit and a comparison turns that "
                        f"bit into a different row. So {node.name} arrives once it has been built "
                        "and pinned to its bits in all five implementations, not before. "
                        f"Available today: {', '.join(EXPR_FUNCTION_NAMES)}."
                        if planned
                        else f"Available: {', '.join(EXPR_FUNCTION_NAMES)}."
                    ),
                    line,
                    column,
                    _did_you_mean(near or ""),
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
                self._check_expr_node(arg, line, column, label, article)
            return
        if isinstance(node, Computed):
            self._error(
                "TDC103",
                f"computed member access is not supported in {article} {label}",
                "Use plain dotted access like Gender.Male or Person.FirstName.",
                line,
                column,
            )
            self._check_expr_node(node.obj, line, column, label, article)
            return
        if isinstance(node, Unary):
            if node.op not in SUPPORTED_UNARY:
                self._error(
                    "TDC102",
                    f'unsupported unary operator "{node.op}" in {article} {label}',
                    f"Supported unary operators: {' '.join(SUPPORTED_UNARY)}.",
                    line,
                    column,
                )
            self._check_expr_node(node.operand, line, column, label, article)

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
        listed = _candidates(sorted(shown if shown is not None else allowed))
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

    def _error(
        self,
        code: str,
        message: str,
        hint: str,
        line: int,
        column: int,
        suggestion: str = "",
    ) -> None:
        self.diagnostics.append(Diagnostic.error(code, message, hint, line, column, suggestion))

    def _warn(
        self,
        code: str,
        message: str,
        hint: str,
        line: int,
        column: int,
        suggestion: str = "",
    ) -> None:
        """Worth saying, not worth stopping for: the run still produces usable data."""
        self.diagnostics.append(Diagnostic.warning(code, message, hint, line, column, suggestion))


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



def _wave_entries(raw: str | None) -> list[str]:
    """The entries of a comma-separated attribute, or [] when it is absent or blank."""
    text = (raw or "").strip()
    return [] if not text else [piece.strip() for piece in text.split(",")]


def _all_numbers(entries: list[str]) -> bool:
    for piece in entries:
        if not piece:
            return False
        try:
            value = float(piece)
        except ValueError:
            return False
        if value != value or value in (float("inf"), float("-inf")):
            return False
    return True

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


def _positive_seconds(raw: str) -> bool:
    """A timeout the engine can actually use: a positive number of seconds."""
    try:
        return float(raw.strip()) > 0
    except ValueError:
        return False
