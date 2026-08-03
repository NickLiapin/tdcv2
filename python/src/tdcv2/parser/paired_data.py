"""Paired raw text, rewritten before the lexer ever sees it.

``<data pair="X">…</data pair="X">`` lets a body carry a literal ``</data>`` — a snippet of TDC
syntax inside generated documentation, say. The grammar keeps one static ``</data>`` close token
because a lexer that had to know which closer belongs to which opener would need the pair value
inside a token rule, so the pairing is resolved here instead: the paired closer becomes a plain
``</data>`` and every literal ``</data>`` in the body becomes a sentinel the lexer reads as
ordinary text. :func:`restore` puts the sentinel back when a body is read.

The rewrite is length-preserving on purpose. Everything the lexer, the parser and the validator
report afterwards carries a line and a column, and those have to point into the file the user
wrote rather than into the one this pass produced — which is why the closing tag's leftover
characters become spaces instead of disappearing.

Ported from ``typescript/src/parser/paired-data.ts``. The five implementations have to agree
character for character, malformed input included, so this follows the reference's decisions even
where a fresh design would choose otherwise.
"""

from __future__ import annotations

#: What a literal ``</data>`` inside a paired body becomes for the duration of lexing. Exactly as
#: long as the text it stands in for, which is what keeps every later position honest.
SENTINEL = "\u0000/data\u0000"

_OPEN = "<data"
_CLOSE = "</data>"
_CLOSE_PREFIX = "</data"

#: The reference tests whitespace with JavaScript's ``\s``. Spelling the set out is what stops
#: five languages disagreeing over an exotic space character, since none of their built-in
#: whitespace predicates covers exactly this set.
_SPACE = frozenset("\t\n\v\f\r \u00a0\u1680\u2028\u2029\u202f\u205f\u3000\ufeff") | {
    chr(code) for code in range(0x2000, 0x200B)
}

_WORD = frozenset("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_")


def preprocess(source: str) -> tuple[str, list[tuple[int, int, str]]]:
    """The source to lex, plus ``(line, column, message)`` for every paired tag that is wrong."""
    out: list[str] = []
    cursor = 0
    problems: list[tuple[int, int, str]] = []
    seen: dict[str, tuple[int, int]] = {}

    while cursor < len(source):
        open_start = source.find(_OPEN, cursor)
        if open_start < 0:
            out.append(source[cursor:])
            break

        if not _is_data_open_at(source, open_start):
            # `<database>` and friends: emit the false start and keep looking past it.
            out.append(source[cursor : open_start + len(_OPEN)])
            cursor = open_start + len(_OPEN)
            continue

        open_end = _find_tag_end(source, open_start)
        if open_end < 0:
            out.append(source[cursor:])
            break

        open_text = source[open_start : open_end + 1]
        pair = _pair_value(open_text)
        if pair is None or _is_self_closing(open_text):
            out.append(source[cursor : open_end + 1])
            cursor = open_end + 1
            continue

        pair_position = _position(source, open_start + open_text.index(pair))
        previous = seen.get(pair)
        if previous is not None:
            problems.append(
                (
                    pair_position[0],
                    pair_position[1],
                    f'duplicate <data pair="{pair}"> value. '
                    f"First use was at line {previous[0]}, column {previous[1]}.",
                )
            )
        else:
            seen[pair] = pair_position

        body_start = open_end + 1
        match, mismatch = _matching_close(source, body_start, pair)
        if match is None:
            if mismatch is not None:
                line, column = _position(source, mismatch[0])
                message = f'expected </data pair="{pair}">, got </data pair="{mismatch[2]}">'
            else:
                line, column = _position(source, open_start)
                message = f'unclosed <data pair="{pair}">'
            problems.append((line, column, message))
            # Nothing after an unmatched opener can be rewritten with any confidence about where
            # the body was meant to end, so the rest of the file is handed over untouched.
            out.append(source[cursor:])
            break

        close_start, close_end = match
        out.append(source[cursor:body_start])
        out.append(source[body_start:close_start].replace(_CLOSE, SENTINEL))
        out.append(_CLOSE)
        out.append(_structural_whitespace(source[close_start + len(_CLOSE) : close_end + 1]))
        cursor = close_end + 1

    return "".join(out), problems


def restore(text: str) -> str:
    """A ``<data>`` body as the user wrote it, with the sentinel back to a literal ``</data>``."""
    return text.replace(SENTINEL, _CLOSE)


def _is_data_open_at(source: str, index: int) -> bool:
    after = index + len(_OPEN)
    if after >= len(source):
        return True
    return source[after] in ">/" or source[after] in _SPACE


def _is_self_closing(tag_text: str) -> bool:
    at = len(tag_text) - 2  # The tag always ends in '>'; look at what leads up to it.
    while at >= 0 and tag_text[at] in _SPACE:
        at -= 1
    return at >= 0 and tag_text[at] == "/"


def _matching_close(
    source: str, start: int, expected: str
) -> tuple[tuple[int, int] | None, tuple[int, int, str] | None]:
    """The close that pairs with ``expected``, else the first close that carries a different one."""
    search_at = start
    mismatch: tuple[int, int, str] | None = None

    while search_at < len(source):
        close_start = source.find(_CLOSE_PREFIX, search_at)
        if close_start < 0:
            break
        close_end = _find_tag_end(source, close_start)
        if close_end < 0:
            break

        close_pair = _pair_value(source[close_start : close_end + 1])
        if close_pair == expected:
            return (close_start, close_end), mismatch
        if close_pair is not None and mismatch is None:
            mismatch = (close_start, close_end, close_pair)
        search_at = close_start + len(_CLOSE_PREFIX)

    return None, mismatch


def _find_tag_end(source: str, start: int) -> int:
    """The '>' that ends a tag, ignoring any inside quotes so ``if="a>b"`` does not end it early."""
    quote: str | None = None
    for at in range(start, len(source)):
        char = source[at]
        if quote is not None:
            if char == quote:
                quote = None
            continue
        if char in "\"'":
            quote = char
            continue
        if char == ">":
            return at
    return -1


def _pair_value(tag_text: str) -> str | None:
    """The ``pair="…"`` value in a tag, as the reference's ``\\bpair\\s*=\\s*"([^"\\r\\n]*)"``."""
    length = len(tag_text)
    at = 0
    while True:
        found = tag_text.find("pair", at)
        if found < 0:
            return None
        # The word boundary: `superpair=` is not a pair attribute, `data-pair=` is.
        if found > 0 and tag_text[found - 1] in _WORD:
            at = found + 1
            continue

        scan = _skip_space(tag_text, found + 4)
        if scan >= length or tag_text[scan] != "=":
            at = found + 1
            continue
        scan = _skip_space(tag_text, scan + 1)
        if scan >= length or tag_text[scan] != '"':
            at = found + 1
            continue

        scan += 1
        value_start = scan
        while scan < length and tag_text[scan] not in '"\r\n':
            scan += 1
        if scan < length and tag_text[scan] == '"':
            return tag_text[value_start:scan]
        at = found + 1


def _skip_space(text: str, at: int) -> int:
    while at < len(text) and text[at] in _SPACE:
        at += 1
    return at


def _structural_whitespace(text: str) -> str:
    """Line breaks kept, everything else blanked — the closer's leftovers hold their place."""
    return "".join(char if char in "\n\r" else " " for char in text)


def _position(source: str, index: int) -> tuple[int, int]:
    line = 1
    column = 0
    for at in range(index):
        if source[at] == "\n":
            line += 1
            column = 0
        else:
            column += 1
    return line, column
