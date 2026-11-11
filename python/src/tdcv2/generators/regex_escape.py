r"""What a backslash means once the classes (``\d``, ``\w``, ``\s``, …) are out of the way.

Shared by ``regex`` and ``advanced_regex`` — the port of the reference's ``regex-escape.ts``.
Until it, every other escape fell to one final arm that returned the escaped character, so
``\x41`` printed ``x41`` and ``\bINV-\d{6}\b`` printed ``bINV-123456b`` after a clean check.

  ``\xHH``, ``\uHHHH``      the character with that code
  ``\b \B \A \Z \z \G``     refused: a generated value has nothing around it to assert
  any other ASCII letter    refused: never the letter itself

Punctuation stays the character, as it always was.
"""

from __future__ import annotations

from collections.abc import Callable

_ZERO_WIDTH = frozenset("bBAZzG")
_HEX = frozenset("0123456789abcdefABCDEF")


def escaped_literal(ch: str, fail: Callable[[str], Exception]) -> str:
    """The literal an escape stands for, or a refusal naming why it cannot be one."""
    if ch in _ZERO_WIDTH:
        raise fail(
            f'"\\{ch}" is a zero-width assertion, and a generated value has nothing around it to '
            "assert — remove it"
        )
    if len(ch) == 1 and ch.isascii() and ch.isalpha():
        raise fail(
            f'unknown escape "\\{ch}" — write the letter without the backslash, or \\xHH or '
            "\\uHHHH for a character by its code"
        )
    return ch


def hex_escape(
    kind: str, next_char: Callable[[], str | None], fail: Callable[[str], Exception]
) -> str:
    r"""``\xHH`` or ``\uHHHH``, the ``x`` or ``u`` already read: exactly two or four hex digits."""
    digits = 2 if kind == "x" else 4
    hex_text = ""
    for _ in range(digits):
        c = next_char()
        if c is None or c not in _HEX:
            example = "\\x41" if kind == "x" else "\\u0410"
            raise fail(f'"\\{kind}" needs exactly {digits} hex digits, as in {example}')
        hex_text += c
    code = int(hex_text, 16)
    if 0xD800 <= code <= 0xDFFF:
        raise fail(f'"\\u{hex_text}" is half of a surrogate pair — write the character itself')
    return chr(code)
