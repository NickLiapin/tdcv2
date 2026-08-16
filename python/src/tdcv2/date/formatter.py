"""``format="DD.MM.YYYY"`` — the Moment-style token subset.

Deliberately not ``strftime``. Its patterns differ from Moment's in ways that would show up as
wrong output rather than as an error — ``%d`` and ``DD`` agree but ``%y`` and ``YY`` do not always
— and configs are written by people who know the Moment spelling from every other tool.

An unrecognised character is emitted as itself, so ``DD/MM`` needs no escaping for the slash. A
bracketed run is a literal, which is how a format carries a word that happens to contain a token
letter: ``[Day] D`` rather than an argument about what ``D`` in "Day" means.
"""

from __future__ import annotations

from . import locales
from .locales import DateLocale
from .plain import DateError, PlainDateTime, weekday

# Longest first: MMMM has to be recognised before MMM and MM.
TOKENS = (
    "YYYY",
    "MMMM",
    "dddd",
    "MMM",
    "ddd",
    "SSS",
    "YY",
    "MM",
    "DD",
    "HH",
    "mm",
    "ss",
    "ZZ",
    "M",
    "D",
    "H",
    "m",
    "s",
    "Z",
)


def _compile(expanded: str) -> tuple[tuple[bool, str], ...]:
    """Split a format into ``(is_token, text)`` parts, once.

    Scanning is not free: at every position it asks each of the twenty tokens whether the string
    starts with it there. Doing that per row cost eleven million ``startswith`` calls on a
    two-hundred-thousand-row run, all of them re-deriving the same answer, because a run has one
    format string and reuses it for every date.
    """
    parts: list[tuple[bool, str]] = []
    literal: list[str] = []
    i = 0
    while i < len(expanded):
        if expanded[i] == "[":
            end = expanded.find("]", i + 1)
            if end < 0:
                raise DateError(f'date format: unterminated literal "{expanded}"')
            literal.append(expanded[i + 1 : end])
            i = end + 1
            continue

        token = next((t for t in TOKENS if expanded.startswith(t, i)), None)
        if token is None:
            literal.append(expanded[i])
            i += 1
            continue

        if literal:
            parts.append((False, "".join(literal)))
            literal.clear()
        parts.append((True, token))
        i += len(token)

    if literal:
        parts.append((False, "".join(literal)))
    return tuple(parts)


# One entry per distinct format string. A config has a handful; the cache never grows with rows.
_COMPILED: dict[str, tuple[tuple[bool, str], ...]] = {}


def format_date_time(value: PlainDateTime, fmt: str | None, locale_name: str | None = None) -> str:
    locale = locales.resolve(locale_name)
    expanded = _expand(fmt if fmt is not None else "L", locale)

    parts = _COMPILED.get(expanded)
    if parts is None:
        parts = _COMPILED[expanded] = _compile(expanded)

    # `after_day` — whether a day-of-month token has already been rendered. `MMMM` reads it to
    # pick between the month's two forms; see `_render`.
    out: list[str] = []
    after_day = False
    for is_token, text in parts:
        if not is_token:
            out.append(text)
            continue
        out.append(_render(text, value, locale, after_day))
        if text in ("D", "DD"):
            after_day = True
    return "".join(out)


def check_format(fmt: str) -> None:
    """Whether a format is well formed, without a date to apply it to.

    Only the bracket literals can be malformed. An unknown token is text by design, so it is not
    an error and there is nothing else to check.
    """
    i = 0
    while i < len(fmt):
        if fmt[i] == "[":
            end = fmt.find("]", i + 1)
            if end < 0:
                raise DateError(f'date format: unterminated literal "{fmt}"')
            i = end
        i += 1


def _expand(fmt: str, locale: DateLocale) -> str:
    if fmt == "ISO":
        return "YYYY-MM-DD"
    if fmt == "ISO_TIME":
        return "YYYY-MM-DDTHH:mm:ss"
    if fmt in ("L", "LL", "LLL", "LLLL"):
        return locale.formats[fmt]
    return fmt


def _render(token: str, v: PlainDateTime, locale: DateLocale, after_day: bool = False) -> str:
    """`after_day` — whether a day-of-month token has already been rendered.

    Half the world writes the month differently depending on whether a day number stands beside
    it. Russian says ``январь`` alone and ``15 января 2026`` in a date; Czech, Polish, Ukrainian,
    Greek and Finnish all shift too. English and Hungarian do not, and put the month first anyway.

    ``MMMM`` renders the in-date form when a day token came BEFORE it and the standalone form
    otherwise — the rule the reference applies, read off the format string alone so all five
    implementations agree without a host date library:

        D. MMMM YYYY      -> in-date     Czech, Finnish, Russian
        MMMM D, YYYY      -> standalone  English
        YYYY. MMMM D.     -> standalone  Hungarian, which wants the nominative
        dddd, D MMMM YYYY -> in-date     ``dddd`` is a weekday, not a day number
    """
    if token == "YYYY":
        return _pad(v.year, 4)
    if token == "YY":
        return _pad(v.year % 100, 2)
    if token == "MMMM":
        months = locale.months_in_date if after_day and locale.months_in_date else locale.months
        return months[v.month - 1]
    if token == "MMM":
        return locale.months_short[v.month - 1]
    if token == "MM":
        return _pad(v.month, 2)
    if token == "M":
        return str(v.month)
    if token == "DD":
        return _pad(v.day, 2)
    if token == "D":
        return str(v.day)
    if token == "dddd":
        return locale.weekdays[weekday(v)]
    if token == "ddd":
        return locale.weekdays_short[weekday(v)]
    if token == "HH":
        return _pad(v.hour, 2)
    if token == "H":
        return str(v.hour)
    if token == "mm":
        return _pad(v.minute, 2)
    if token == "m":
        return str(v.minute)
    if token == "ss":
        return _pad(v.second, 2)
    if token == "s":
        return str(v.second)
    if token == "SSS":
        return _pad(v.millisecond, 3)
    if token == "Z":
        return "+00:00"
    if token == "ZZ":
        return "+0000"
    return token


def _pad(value: int, length: int) -> str:
    return str(value).rjust(length, "0")
