"""Case, slicing, grouping, escaping — the filters that shape a value on its way out.

Pure text in, text out, shared by three call sites that all mean the same thing: compute tags
(``<upper>``, ``<mask>``), the ``case=``/``mask=`` attributes of a ``<gen>``, and the
``${{Name|upper|mask:xxx}}`` filters inside a ``<data>``. One implementation, so a value formatted
in a template and the same value formatted by an attribute cannot drift apart.

The filters are lenient on purpose. An out-of-range slice yields less text, a ``compact`` of
something that is not a number passes it through — the validator is where a mistake gets named,
and aborting a million-row run over one short value is worse than a gap.
"""

from __future__ import annotations

import re
from collections.abc import Callable

from ..lib import numbers, text
from .mask import apply_mask

_WHOLE = re.compile(r"^-?\d+$")

CASE_TRANSFORMS = ("upper", "lower", "capitalize", "title")

FILTER_NAMES = (
    "upper",
    "lower",
    "capitalize",
    "title",
    "mask",
    "slice",
    "replace",
    "trim",
    "group",
    "compact",
    "csv",
    "sql",
)


def is_case_transform(name: str) -> bool:
    return name in CASE_TRANSFORMS


def is_filter_name(name: str) -> bool:
    return name in FILTER_NAMES


def gen_formatter(mask: str | None, case: str | None) -> Callable[[str], str] | None:
    """The per-value formatter for a gen's ``mask=``/``case=``, or ``None`` when neither applies.

    Mask first, then case: the mask decides which characters survive and in what order, and
    changing the case of characters that are about to be dropped is wasted work.
    """
    has_mask = mask is not None
    has_case = case is not None and is_case_transform(case)
    if not has_mask and not has_case:
        return None

    def format_one(value: str) -> str:
        out = value
        if has_mask:
            out = apply_mask(mask, out)  # type: ignore[arg-type]
        if has_case:
            out = apply_case(case, out)  # type: ignore[arg-type]
        return out

    return format_one


def apply_case(name: str, value: str) -> str:
    """``capitalize`` and ``title`` raise the first letter and leave the rest as written.

    Lowering the rest would turn ``McDonald`` into ``Mcdonald`` and ``IBM`` into ``Ibm``. A name
    is not a sentence, and the config already chose how the value was spelled.
    """
    if name == "upper":
        return value.upper()
    if name == "lower":
        return value.lower()
    if name == "capitalize":
        return _upper_first(value)
    if name == "title":
        return text.NOT_SPACE_RUN.sub(lambda m: _upper_first(m.group()), value)
    raise ValueError(f'unknown case transform "{name}"')


def apply_slice(value: str, start: float, end: float | None = None) -> str:
    """A substring by character index, ``[start, end)``; an absent end runs to the end."""
    chars = list(value)
    first = int(start) if _finite(start) else 0
    last = len(chars) if end is None or not _finite(end) else int(end)
    return "".join(chars[first:last])


def apply_replace(value: str, old: str, new: str) -> str:
    return value if old == "" else value.replace(old, new)


def apply_trim(value: str) -> str:
    return text.trim(value)


def apply_group(value: str, size: float, separator: str) -> str:
    """Characters grouped from the RIGHT into chunks of ``size``.

    From the right because that is where the significant end of a number is: grouping
    ``1234567`` from the left gives ``123 456 7``, which no one writes.
    """
    chars = list(value)
    if not _finite(size) or size <= 0 or not chars:
        return value
    step = int(size)
    out: list[str] = []
    end = len(chars)
    while end > 0:
        out.insert(0, "".join(chars[max(0, end - step) : end]))
        end -= step
    return separator.join(out)


def apply_compact(value: str, base: float) -> str:
    """A whole number rendered in a shorter alphabet — ``1000000`` becomes ``lfls``.

    The point is a unique suffix that stays readable at scale: a row id appended to a generated
    email keeps it unique, but ``john.smith2000000000@`` is nobody's address. In base 36 the same
    id is ``x2qxvk``, and six characters carry over two billion rows.

    LOWERCASE only, and deliberately so. Base 62 would be shorter still, but many systems fold the
    local part of an address to lower case — ``aB`` and ``Ab`` would merge and silently
    reintroduce exactly the duplicates the suffix exists to prevent.
    """
    body = value.strip()
    if not _WHOLE.match(body):
        return value
    if base != int(base) or base < 2 or base > 36:
        return value
    n = int(body)
    if abs(n) > 9007199254740991:
        return value
    return ("-" if n < 0 else "") + _to_base(abs(n), int(base))


def apply_csv(value: str, _delimiter: str) -> str:
    """A value quoted for CSV per RFC 4180: wrapped in quotes, with any inside doubled.

    ``<data>`` assembles TEXT and knows nothing about the file being written, so a value carrying
    the delimiter silently splits the row. Measured on a real catalogue: one product named
    ``Набор ножей, 3 шт`` turned 6172 of 50 000 rows into eight fields where the header declares
    seven — category landing in price, price in quantity — with no error and nothing visibly wrong.

    Quoting unconditionally rather than only when needed: a rule with no exceptions is one nobody
    has to remember, every CSV reader accepts redundant quotes, and "only when it contains a
    comma" is exactly the reasoning that loses to a newline or a quote later.
    """
    doubled = value.replace('"', '""')
    return f'"{doubled}"'


def apply_sql(value: str) -> str:
    """A value escaped for a single-quoted SQL literal, by doubling apostrophes.

    ``O'Brien`` closes the string early and the statement fails to parse — or, far worse in
    generated data, parses into something else. The BODY only, no surrounding quotes, so the
    caller keeps writing ``'${{Name|sql}}'`` and the shape of the statement stays visible in the
    config.
    """
    return value.replace("'", "''")


def apply_filter(kind: str, arg: str | None, value: str) -> str:
    """One filter applied to one value; an unknown name is a no-op the validator flags.

    Argument shapes: ``mask:PATTERN``, ``slice:from[,to]``, ``replace:from,to``, ``trim``,
    ``group:size[,sep]`` (a space by default), ``compact[:base]``, ``csv[:delimiter]``, ``sql``,
    and the four case transforms, which take none.
    """
    if kind == "mask":
        return apply_mask(arg or "", value)
    if kind == "slice":
        parts = (arg or "").split(",")
        start = numbers.parse(parts[0] if parts else "0")
        end = None if len(parts) < 2 or parts[1] == "" else numbers.parse(parts[1])
        return apply_slice(value, start, end)
    if kind == "replace":
        old, new = _split_first(arg or "", ",")
        return apply_replace(value, old, new or "")
    if kind == "trim":
        return apply_trim(value)
    if kind == "group":
        size, separator = _split_first(arg or "", ",")
        joiner = " " if separator is None else separator
        return apply_group(value, numbers.parse(size or "3"), joiner)
    if kind == "compact":
        return apply_compact(value, 36 if not arg else numbers.parse(arg))
    if kind == "csv":
        return apply_csv(value, arg if arg else ",")
    if kind == "sql":
        return apply_sql(value)
    if kind in CASE_TRANSFORMS:
        return apply_case(kind, value)
    return value


def _upper_first(word: str) -> str:
    return word[:1].upper() + word[1:] if word else word


def _split_first(value: str, separator: str) -> tuple[str, str | None]:
    i = value.find(separator)
    return (value, None) if i < 0 else (value[:i], value[i + 1 :])


def _finite(value: float) -> bool:
    return value == value and value not in (float("inf"), float("-inf"))


def _to_base(n: int, base: int) -> str:
    if n == 0:
        return "0"
    digits = "0123456789abcdefghijklmnopqrstuvwxyz"
    out: list[str] = []
    while n:
        n, rest = divmod(n, base)
        out.append(digits[rest])
    return "".join(reversed(out))
