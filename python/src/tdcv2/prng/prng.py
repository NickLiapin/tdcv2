"""Seeded pseudo-random number generator: cyrb128 feeding sfc32.

This is the foundation of the cross-language guarantee. The same seed has to produce the same
sequence of doubles here, in the TypeScript reference and in the Java port. If this file drifts
by one bit, every generated dataset drifts with it.

The TypeScript original leans on ``Math.imul``, ``| 0`` and ``>>> 0`` to force 32-bit arithmetic
out of a language whose only number is a double. Java gets that for free — its ``int`` is 32-bit
and wraps. Python gets neither: its integers are unbounded, so every operation that would have
wrapped has to be masked back to 32 bits explicitly, and leaving the mask off anywhere produces
numbers that look plausible and are wrong.

That masking used to live in a one-line ``_u32`` helper, which read well and cost far too much:
profiling a million-row run showed 343 calls to it per row, roughly seventy million in all, each
one a Python frame built and torn down to evaluate a single ``&``. The masks are written inline
here instead. Where a mask is provably redundant — both operands of a ``^`` or ``|`` already fit
in 32 bits, so their result does too — it is left out, and the invariant that makes that safe is
noted where it applies.

The seed hash is also resumable. Every streaming draw is keyed by ``seed|stream|index`` where only
the index changes, so ``absorb`` folds the constant prefix once and callers keep that state; see
``seekable.py``. cyrb128 is a streaming hash, so resuming from a saved state is not an
approximation of hashing the whole string — it is the same arithmetic in the same order.

The one place a port can silently diverge is the seed string. JavaScript's ``charCodeAt`` returns
a UTF-16 code unit, and Java's ``charAt`` does too. Python iterates CODE POINTS, so a seed outside
the Basic Multilingual Plane would hash differently unless it is encoded to UTF-16 first — which
is why ``_code_units`` exists rather than a plain ``ord`` loop.

Verified against ``fixtures/cross-language/prng-vectors.json``.
"""

from __future__ import annotations

from collections.abc import Iterable

MASK = 0xFFFFFFFF

# The magic numbers are cyrb128's own, as unsigned 32-bit values.
_H1_INIT = 1779033703
_H2_INIT = 3144134277
_H3_INIT = 1013904242
_H4_INIT = 2773480762
_M1 = 597399067
_M2 = 2869860233
_M3 = 951274213
_M4 = 2716044179

State = tuple[int, int, int, int]

#: The four state words before any of the seed has been folded in.
INITIAL: State = (_H1_INIT, _H2_INIT, _H3_INIT, _H4_INIT)


def _code_units(text: str) -> Iterable[int]:
    """The seed as UTF-16 code units, matching what JavaScript and Java iterate.

    A character outside the Basic Multilingual Plane is one code point in Python and two code
    units elsewhere. Hashing code points would give a different seed for such a string — rare,
    but silently and permanently wrong when it happens.

    Seeds are ASCII in practice, and for ASCII a UTF-8 ``bytes`` already *is* the sequence of code
    units — iterating it yields the same integers without building a list. The general path stays
    for everything else.
    """
    if text.isascii():
        return text.encode()
    raw = text.encode("utf-16-be")
    return [(raw[i] << 8) | raw[i + 1] for i in range(0, len(raw), 2)]


def absorb(state: State, text: str) -> State:
    """Fold ``text`` into a running cyrb128 state.

    Splitting the hash here is what lets a caller pay for a constant seed prefix once instead of
    once per row. ``absorb(absorb(INITIAL, a), b)`` is ``absorb(INITIAL, a + b)``, exactly.
    """
    h1, h2, h3, h4 = state
    for k in _code_units(text):
        # One at a time, not as a tuple: the fourth line reads the h1 the first line just wrote.
        # Assigning them simultaneously is the obvious Python spelling and gives a different
        # generator — one that looks fine until its numbers are compared with another language's.
        # No outer mask on any of the four: both sides of each `^` are already 32-bit.
        h1 = h2 ^ ((h1 ^ k) * _M1 & MASK)
        h2 = h3 ^ ((h2 ^ k) * _M2 & MASK)
        h3 = h4 ^ ((h3 ^ k) * _M3 & MASK)
        h4 = h1 ^ ((h4 ^ k) * _M4 & MASK)
    return (h1, h2, h3, h4)


def finish(state: State) -> State:
    """The avalanche tail: a fully absorbed state into the four generator words."""
    h1, h2, h3, h4 = state
    h1 = (h3 ^ (h1 >> 18)) * _M1 & MASK
    h2 = (h4 ^ (h2 >> 22)) * _M2 & MASK
    h3 = (h1 ^ (h3 >> 17)) * _M3 & MASK
    h4 = (h2 ^ (h4 >> 19)) * _M4 & MASK
    return (h1 ^ h2 ^ h3 ^ h4, h2 ^ h1, h3 ^ h1, h4 ^ h1)


def cyrb128(seed: str) -> State:
    """Derive four 32-bit state words from a seed string."""
    return finish(absorb(INITIAL, seed))


class Sfc32:
    """An sfc32 generator over four state words. Each call returns a double in ``[0, 1)``.

    Stateful by nature, and deliberately not safe to share between threads: two threads drawing
    from one instance would interleave and destroy reproducibility, which is the whole point.
    """

    __slots__ = ("_a", "_b", "_c", "_d")

    def __init__(self, a: int, b: int, c: int, d: int) -> None:
        self._a = a & MASK
        self._b = b & MASK
        self._c = c & MASK
        self._d = d & MASK

    def next(self) -> float:
        """The next double in ``[0, 1)``."""
        # Read the state into locals first: every line below would otherwise re-resolve a slot
        # descriptor, and this is the hottest method in the library.
        a, b, c, d = self._a, self._b, self._c, self._d
        t = (a + b) & MASK
        self._a = b ^ (b >> 9)
        self._b = (c + ((c << 3) & MASK)) & MASK
        # Both halves of the `|` are 32-bit already, so no mask over the pair.
        c = ((c << 21) & MASK) | (c >> 11)
        d = (d + 1) & MASK
        self._d = d
        t = (t + d) & MASK
        self._c = (c + t) & MASK
        return t / 4294967296.0


def create(seed: str) -> Sfc32:
    """Build a generator from a seed string."""
    a, b, c, d = cyrb128(seed)
    return Sfc32(a, b, c, d)
