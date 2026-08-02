"""A shuffle that can be evaluated at one position.

Laying out an exact quota is easy — so many of this value, so many of that — but the result is
sorted, and a run whose first half is all one value is not data anyone can use. Shuffling it
needs the whole column in hand, which is exactly what the streaming engine does not have.

A format-preserving permutation solves it. Four Feistel rounds over a padded domain give a
bijection on ``[0, n)`` that can be computed for a single index, so row nine million learns which
slot it owns without anything knowing about the rows around it. Cycle-walking handles an ``n``
that is not a power of two: keep applying the round function until the result lands in range,
which it must, because the padded domain is a permutation too.
"""

from __future__ import annotations

import math
from functools import lru_cache

from .prng import MASK, cyrb128

_ROUNDS = 4

# `(round + 1) * 0x9E3779B1`, masked — four constants, not four multiplications per round.
_ROUND_KEYS = tuple(((r + 1) * 0x9E3779B1) & MASK for r in range(_ROUNDS))


def key(seed: str, stream_id: str) -> int:
    """A key private to one stream, so two columns shuffle independently."""
    return cyrb128(f"{seed}|perm|{stream_id}")[0]


def permute(index: int, n: int, key_value: int) -> int:
    """The slot row ``index`` owns, among ``n``."""
    if n <= 1:
        return 0
    half_size = _half_size_for(n)
    x = index
    while True:
        x = _forward(x, half_size, key_value)
        if x < n:
            return x


def unpermute(slot: int, n: int, key_value: int) -> int:
    """The inverse: which row owns ``slot``."""
    if n <= 1:
        return 0
    half_size = _half_size_for(n)
    x = slot
    while True:
        x = _inverse(x, half_size, key_value)
        if x < n:
            return x


@lru_cache(maxsize=1024)
def _half_size_for(n: int) -> int:
    """The padded domain: two equal halves whose product covers ``n``.

    Cached because a run asks for the same ``n`` on every row, and the answer costs two logarithms.
    """
    bits = max(2, math.ceil(math.log(n) / math.log(2)))
    return 1 << math.ceil(bits / 2)


def _round_fn(r: int, round_index: int, key_value: int) -> int:
    """The round function — a plain avalanche mix, masked to 32 bits at every step.

    Kept as the readable statement of what the rounds do. ``_forward`` and ``_inverse`` spell the
    same arithmetic out inline: at four rounds per call and a call per row, the frame cost was
    measurable on its own.
    """
    h = r ^ _ROUND_KEYS[round_index]
    h = (h ^ (h >> 16)) * 0x85EBCA6B & MASK
    h = (h ^ (h >> 13)) * 0xC2B2AE35 & MASK
    h = (h ^ key_value) * 0x27D4EB2F & MASK
    return h ^ (h >> 16)


def _forward(x: int, half_size: int, key_value: int) -> int:
    left, right = divmod(x, half_size)
    for round_key in _ROUND_KEYS:
        h = right ^ round_key
        h = (h ^ (h >> 16)) * 0x85EBCA6B & MASK
        h = (h ^ (h >> 13)) * 0xC2B2AE35 & MASK
        h = (h ^ key_value) * 0x27D4EB2F & MASK
        # Unsigned remainder: the round function's result is a 32-bit pattern, not a signed
        # number, and taking it as signed would fold the domain onto half of itself.
        left, right = right, left ^ ((h ^ (h >> 16)) % half_size)
    return left * half_size + right


def _inverse(y: int, half_size: int, key_value: int) -> int:
    left, right = divmod(y, half_size)
    for round_key in reversed(_ROUND_KEYS):
        previous_right = left
        h = previous_right ^ round_key
        h = (h ^ (h >> 16)) * 0x85EBCA6B & MASK
        h = (h ^ (h >> 13)) * 0xC2B2AE35 & MASK
        h = (h ^ key_value) * 0x27D4EB2F & MASK
        left, right = right ^ ((h ^ (h >> 16)) % half_size), previous_right
    return left * half_size + right
