"""The per-generator rules, kept apart from the structural ones so neither file grows unreadable.

Most of these work by handing the attribute to the generator's own parser and reporting what it
says. That is deliberate: a validator with its own idea of what a valid range looks like drifts
from the generator that actually reads it, and then a config passes validation and fails at run
time — the worst of both.
"""

from __future__ import annotations

import re

from ..date import locales as date_locales
from ..format import transforms
from ..generators import advanced_regex, number, regex
from ..generators import repeat as repeat_gen
from ..unicode import alphabets

# Names the engine owns; a sequence may not claim one.
BUILTINS = frozenset({"_count", "_first", "_last", "_total", "_item", "_item_id"})

# Attributes a named distribution replaces, so carrying both is a contradiction.
DISTRIBUTION_CONFLICTS = ("value", "percent", "length", "include", "exclude")

_WHOLE = re.compile(r"^\d+$")
_RANGE = re.compile(r"^\d+\s*-\s*\d+$")


def is_builtin(name: str) -> bool:
    return name in BUILTINS


def regex_problem(pattern: str, max_length: int) -> str | None:
    """What is wrong with the pattern under the finite subset, or nothing."""
    try:
        regex.compile_pattern(pattern, max_length)
    except ValueError as e:
        return str(e)
    return None


def advanced_regex_problem(pattern: str, max_length: int) -> str | None:
    try:
        advanced_regex.compile_pattern(pattern, max_length)
    except ValueError as e:
        return str(e)
    return None


def number_range_problem(value: str) -> str | None:
    try:
        number.parse_ranges(value)
    except ValueError as e:
        return str(e)
    return None


def is_known_alphabet(name: str) -> bool:
    return alphabets.chars(name) is not None


def is_known_date_locale(name: str) -> bool:
    return date_locales.is_known(name)


def is_known_filter(name: str) -> bool:
    return transforms.is_filter_name(name)


def alphabet_names() -> list[str]:
    return alphabets.names()


def is_boolean_text(raw: str) -> bool:
    return raw in ("true", "false")


def is_valid_length(raw: str) -> bool:
    """A positive integer, a ``min-max`` range, or a comma-separated list of those."""
    for part in raw.split(","):
        p = part.strip()
        if not _WHOLE.match(p) and not _RANGE.match(p):
            return False
        for n in p.split("-"):
            try:
                if int(n.strip()) <= 0:
                    return False
            except ValueError:
                return False
    return True


def repeat_unsupported_reason(type_: str | None) -> str | None:
    """Why ``repeat=`` is refused on this generator type, or nothing when it is allowed."""
    if type_ in ("increment", "decrement", "timeseries", "pattern"):
        return "its value depends on the row index, which a variable-length list makes unknowable"
    return None


def has_repeat(attrs: dict[str, str]) -> bool:
    return repeat_gen.parse(attrs) is not None
