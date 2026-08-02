"""Named character sets, and the ranges they are built from.

``alphabet="cyrillic.ru.letters"`` beats writing thirty-three characters out by hand, and it beats
a range: Ё sits outside the alphabetical block in Unicode but inside it in the alphabet, so a
naive ``а``–``я`` range silently omits a letter Russian actually uses.

Every entry is one CODE POINT, not one UTF-16 unit, so a character outside the basic plane stays
whole rather than being drawn as half a surrogate pair.
"""

from __future__ import annotations


def between(start: int, end: int) -> list[str]:
    """Every code point in an inclusive range."""
    if start > end:
        raise ValueError("invalid alphabet range")
    return [chr(cp) for cp in range(start, end + 1)]


def code_points(value: str) -> list[str]:
    """One entry per code point, so characters outside the basic plane stay whole."""
    return list(value)


_LATIN_LOWER = between(ord("a"), ord("z"))
_LATIN_UPPER = between(ord("A"), ord("Z"))
_DIGITS = between(ord("0"), ord("9"))
# Ё spliced into place rather than appended: it belongs between Е and Ж in the alphabet.
_CYR_LOWER = [*between(ord("а"), ord("е")), "ё", *between(ord("ж"), ord("я"))]
_CYR_UPPER = [*between(ord("А"), ord("Е")), "Ё", *between(ord("Ж"), ord("Я"))]

REGISTRY: dict[str, list[str]] = {
    "latin.lower": _LATIN_LOWER,
    "latin.upper": _LATIN_UPPER,
    "latin.letters": [*_LATIN_UPPER, *_LATIN_LOWER],
    "digits.ascii": _DIGITS,
    "digits.fullwidth": between(ord("０"), ord("９")),
    "cyrillic.ru.lower": _CYR_LOWER,
    "cyrillic.ru.upper": _CYR_UPPER,
    "cyrillic.ru.letters": [*_CYR_UPPER, *_CYR_LOWER],
    "greek.letters": code_points("ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩαβγδεζηθικλμνξοπρσςτυφχψω"),
    "hebrew.letters": between(ord("א"), ord("ת")),
    "arabic.letters": between(ord("ء"), ord("ي")),
    "kana.hiragana": between(ord("ぁ"), ord("ゖ")),
    "kana.katakana": between(ord("ァ"), ord("ヺ")),
    "cjk.unified.basic": between(ord("一"), ord("鿿")),
    "roman.upper": code_points("IVXLCDM"),
    "roman.lower": code_points("ivxlcdm"),
}


def chars(name: str) -> list[str] | None:
    """``None`` when the name is unknown; callers report it with the list of known names."""
    return REGISTRY.get(name)


def names() -> list[str]:
    return list(REGISTRY.keys())
