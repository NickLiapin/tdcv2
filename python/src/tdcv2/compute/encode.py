"""``<encode as="...">`` — one character turned into a number.

Every check-digit algorithm starts here: a passport number's letters become numbers under base36,
an IBAN's country code becomes two-digit values, a control character is a code point. Each
encoding takes ONE character and returns a STRING, so that the folds downstream consume digits
uniformly whichever encoding produced them.

For base36, ascii and unicode that string is the DECIMAL value of the character, so ``A`` under
base36 is ``"10"``. For hex, binary and octal it is the code point rendered in that base — which is
a different question, and the two are not interchangeable.
"""

from __future__ import annotations

from .value import ComputeError

ENCODINGS = ("base36", "ascii", "unicode", "hex", "binary", "octal")


def code_point_of(ch: str) -> int:
    """The single code point of ``ch``, or an error if it is not exactly one."""
    if len(ch) != 1:
        raise ComputeError(f'<encode>: expected a single character, got "{ch}"')
    return ord(ch)


def encode_char(ch: str, as_what: str) -> str:
    if as_what == "base36":
        return str(_base36_value(ch))
    if as_what == "ascii":
        cp = code_point_of(ch)
        if cp >= 128:
            raise ComputeError(
                f'<encode as="ascii">: "{ch}" is not an ASCII character (code >= 128)'
            )
        return str(cp)
    if as_what == "unicode":
        return str(code_point_of(ch))
    if as_what == "hex":
        return format(code_point_of(ch), "x")
    if as_what == "binary":
        return format(code_point_of(ch), "b")
    if as_what == "octal":
        return format(code_point_of(ch), "o")
    raise ComputeError(
        f'<encode>: unknown encoding "{as_what}" (expected one of {", ".join(ENCODINGS)})'
    )


def _base36_value(ch: str) -> int:
    """0-9 → 0..9, A-Z and a-z → 10..35."""
    cp = code_point_of(ch)
    if 48 <= cp <= 57:
        return cp - 48
    if 65 <= cp <= 90:
        return cp - 65 + 10
    if 97 <= cp <= 122:
        return cp - 97 + 10
    raise ComputeError(f'<encode as="base36">: "{ch}" is not a digit or letter')
