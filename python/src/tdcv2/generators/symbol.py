"""``<gen type="symbol">`` — characters drawn from a set.

The set can be written inline (``value="[a-z0-9]"``) or named (``alphabet="cyrillic.ru.letters"``),
and either can be adjusted with ``include``/``exclude``. Naming beats writing out: an alphabet has
edge cases — Ё between Е and Ж — that a hand-written range gets wrong.
"""

from __future__ import annotations

from ..prng import rand
from ..prng.prng import Sfc32
from ..unicode import alphabets, char_set

_DEFAULT_LENGTH = 1
_MAX_LENGTH = 1024


def generate(attrs: dict[str, str], count: int, prng: Sfc32) -> list[str]:
    chars = resolve_chars(attrs)
    length = parse_length(attrs.get("length"))
    return ["".join(rand.pick(prng, chars) for _ in range(length)) for _ in range(count)]


def parse_length(raw: str | None) -> int:
    if raw is None:
        return _DEFAULT_LENGTH
    try:
        value = int(raw.strip())
    except ValueError:
        raise ValueError(
            f'symbol length must be an integer from 1 to {_MAX_LENGTH}, got "{raw}"'
        ) from None
    if value <= 0 or value > _MAX_LENGTH:
        raise ValueError(f'symbol length must be an integer from 1 to {_MAX_LENGTH}, got "{raw}"')
    return value


def resolve_chars(attrs: dict[str, str]) -> list[str]:
    """The characters this generator may draw, after include/exclude."""
    value = attrs.get("value") or None
    alphabet = attrs.get("alphabet") or None

    if value is not None and alphabet is not None:
        raise ValueError(
            'symbol generator: use either "value" (inline set) or "alphabet" (named), not both'
        )

    if value is not None:
        base = char_set.parse(value)
        if not base:
            raise ValueError(f'symbol generator: value "{value}" produced an empty character set')
    elif alphabet is not None:
        base = alphabets.chars(alphabet)
        if base is None:
            raise ValueError(
                f'unknown alphabet "{alphabet}"; known alphabets: ' + ", ".join(alphabets.names())
            )
    else:
        raise ValueError(
            'symbol generator requires "value" (inline set like "abc" or "[a-z]") or '
            '"alphabet" (named); known alphabets: ' + ", ".join(alphabets.names())
        )

    return _apply_include_exclude(base, attrs.get("include"), attrs.get("exclude"))


def _apply_include_exclude(base: list[str], include: str | None, exclude: str | None) -> list[str]:
    if not include and not exclude:
        return base

    chars = dict.fromkeys(base)
    if include:
        for c in char_set.parse(include):
            chars[c] = None
    if exclude:
        for c in char_set.parse(exclude):
            chars.pop(c, None)
    if not chars:
        raise ValueError(
            "symbol generator: the character set is empty after applying include/exclude"
        )
    return list(chars)
