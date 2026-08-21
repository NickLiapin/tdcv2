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


# The letters a TOKEN is spelled with, plus the two a reader arrives with from elsewhere.
# ``A``/``a`` is Moment's AM/PM and ``h`` its 12-hour clock; TDC has neither, and a format
# carrying them was written by somebody expecting them to work. Letters outside this set —
# the ``o`` and ``f`` of ``of``, the ``t`` and ``e`` of ``date:`` — are ordinary words, and
# a word beside a date is a reasonable thing to write unbracketed.
_TOKEN_LETTERS = frozenset("YMDdHhmsSZAaL")


def check_format(fmt: str) -> None:
    """Whether a format is well formed, without a date to apply it to.

    The same walk the formatter does, so what is refused here is exactly what would have
    been printed as literal text there. A near-miss token used to pass validation and then
    print itself: ``hh:mm A`` gave ``hh:00 A``, ``YYY`` gave ``24Y``, and the run said
    nothing.
    """
    i = 0
    while i < len(fmt):
        if fmt[i] == "[":
            end = fmt.find("]", i + 1)
            if end < 0:
                raise DateError(f'date format: unterminated literal "{fmt}"')
            i = end + 1
            continue
        named = next((n for n in NAMED_FORMATS if fmt.startswith(n, i)), None)
        if named is not None:
            i += len(named)
            continue
        token = next((tk for tk in TOKENS if fmt.startswith(tk, i)), None)
        if token is not None:
            i += len(token)
            continue
        if fmt[i] in _TOKEN_LETTERS:
            # The whole run, so the message names what the writer typed rather than one letter.
            end = i
            while end < len(fmt) and fmt[end] in _TOKEN_LETTERS:
                end += 1
            run = fmt[i:end]
            raise DateError(
                f'date format: "{run}" is not a token — '
                f"write it as [{run}] if it is meant to be literal text"
            )
        i += 1


# The named formats, longest first — the order they have to be tried in. `LLLL` before
# `LLL` before `LL` before `L`, and `ISO_TIME` before `ISO`, or a longer name is read as a
# shorter one followed by letters nobody asked for.
NAMED_FORMATS = ("LLLL", "LLL", "LL", "L", "ISO_TIME", "ISO")


def _named(name: str, locale: DateLocale) -> str:
    if name == "ISO":
        return "YYYY-MM-DD"
    if name == "ISO_TIME":
        return "YYYY-MM-DDTHH:mm:ss"
    return locale.formats[name]


def _expand(fmt: str, locale: DateLocale) -> str:
    """Replace every named format with the tokens it stands for, once.

    These are TOKENS, not whole formats: the reference table documents them beside ``YYYY``
    and ``MM``, and a reader who writes ``LL [at] HH:mm`` is owed the date the table
    promises. They used to be matched against the WHOLE format string, so ``LL`` alone
    worked and ``LL HH:mm`` printed the literal text ``LL 00:00`` — the config was
    accepted, the run succeeded, and the file was wrong.

    Bracketed text is skipped, so ``[LL]`` stays the letters. The result is not expanded
    again: a locale's own ``LL`` is written in plain tokens, and a second pass could only
    find a name a locale had put there, which would be a loop rather than a feature.
    """
    out: list[str] = []
    i = 0
    while i < len(fmt):
        if fmt[i] == "[":
            end = fmt.find("]", i + 1)
            if end < 0:
                # Left for the caller to report, so the message is the one it always was.
                out.append(fmt[i:])
                break
            out.append(fmt[i : end + 1])
            i = end + 1
            continue
        for name in NAMED_FORMATS:
            if fmt.startswith(name, i):
                out.append(_named(name, locale))
                i += len(name)
                break
        else:
            out.append(fmt[i])
            i += 1
    return "".join(out)


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
