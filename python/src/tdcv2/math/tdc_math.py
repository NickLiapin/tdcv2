"""TdcMath — the transcendental functions, computed by TDC rather than by Python.

IEEE-754 pins down ``+``, ``-``, ``*``, ``/`` and ``sqrt``: each has exactly one legal answer, so
every language agrees. It says nothing about ``sin``, ``cos``, ``exp``, ``log`` or ``pow`` — every
libm picks its own algorithm — and the difference is real. Measured on one machine::

    tan(1)      Node 3ff8eb245cbee3a6   Python 3ff8eb245cbee3a5
    cos(1000)   Node 3fe1ff026793f1bb   Python 3fe1ff026793f1bc

In ``timeseries`` that never shows, because every number is rounded to a decimal string before it
becomes output. An ``if=`` has no rounding step, so a comparison turns that bit into a different
row and a different file.

**Nothing here may call a transcendental of the host.** No ``math.sin``, no ``math.exp``, no
``**``. Only ``+ - * /``, ``math.sqrt`` (correctly rounded by the standard, verified equal across
the implementations), and the exact operations ``abs`` and ``trunc``.

Every line mirrors ``typescript/src/math/tdc-math.ts`` in the same ORDER of operations. That order
is the contract: float addition is not associative, so regrouping a sum would change the last bit
and break the shared case that compares them.
"""

from __future__ import annotations

import math

PI = 3.141592653589793
E = 2.718281828459045

# ln 2, split so `k * LN2_HI` keeps the low bits a single constant would drop.
_LN2_HI = 0.6931471803691238
_LN2_LO = 1.9082149292705877e-10
_LN2 = 0.6931471805599453

# pi/2 in three pieces, for the same reason: a single rounded pi/2 loses most of
# the significant digits of sin(1000) before the series starts.
_PIO2 = 1.5707963267948966
_PIO2_1 = 1.5707963267341256
_PIO2_2 = 6.077100506506192e-11
_PIO2_3 = 2.0222662487959506e-21

_SIN_COEFF = (
    -1 / 6,
    1 / 120,
    -1 / 5040,
    1 / 362880,
    -1 / 39916800,
    1 / 6227020800,
    -1 / 1307674368000,
)

_COS_COEFF = (
    -1 / 2,
    1 / 24,
    -1 / 720,
    1 / 40320,
    -1 / 3628800,
    1 / 479001600,
    -1 / 87178291200,
)

_EXP_OVERFLOW = 709.782712893384
_EXP_UNDERFLOW = -745.1332191019411


def sqrt(x: float) -> float:
    """Delegated: IEEE-754 requires square root to be correctly rounded, so there is one answer."""
    if x != x or x < 0:
        return math.nan
    return math.sqrt(x)


def _scale_by_power_of_two(value: float, n: int) -> float:
    """``value * 2**n`` by exact doubling — a power of two is exact in binary."""
    out = value
    k = n
    while k > 0:
        out *= 2
        k -= 1
    while k < 0:
        out /= 2
        k += 1
    return out


def exp(x: float) -> float:
    """``exp(x)`` — range-reduced to ``2^k * e^r`` with |r| <= ln2/2, then Taylor."""
    if x != x:
        return math.nan
    if x > _EXP_OVERFLOW:
        return math.inf
    if x < _EXP_UNDERFLOW:
        return 0.0
    k = math.trunc(x / _LN2 + (0.5 if x >= 0 else -0.5))
    r = x - k * _LN2_HI - k * _LN2_LO
    term = 1.0
    total = 1.0
    for i in range(1, 14):
        term = term * r / i
        total += term
    return _scale_by_power_of_two(total, k)


def log(x: float) -> float:
    """``log(x)`` — ``x = m * 2^e`` by exact halving, then ``2*atanh((m-1)/(m+1))``."""
    if x != x or x < 0:
        return math.nan
    if x == 0:
        return -math.inf
    if x == math.inf:
        return math.inf
    m = x
    e = 0
    while m >= 1.4142135623730951:
        m /= 2
        e += 1
    while m < 0.7071067811865476:
        m *= 2
        e -= 1
    s = (m - 1) / (m + 1)
    s2 = s * s
    total = 0.0
    for i in range(25, 0, -2):
        total = total * s2 + 1 / i
    return 2 * s * total + e * _LN2_HI + e * _LN2_LO


def log10(x: float) -> float:
    return log(x) / 2.302585092994046


def _reduce_by_quarter_turn(x: float) -> tuple[int, float]:
    """The quadrant (0-3) and the remainder in [-pi/4, pi/4]."""
    k = math.trunc(x / _PIO2 + (0.5 if x >= 0 else -0.5))
    remainder = x - k * _PIO2_1 - k * _PIO2_2 - k * _PIO2_3
    return ((k % 4) + 4) % 4, remainder


def _sin_core(r: float) -> float:
    z = r * r
    total = 0.0
    for i in range(len(_SIN_COEFF) - 1, -1, -1):
        total = total * z + _SIN_COEFF[i]
    return r + r * z * total


def _cos_core(r: float) -> float:
    z = r * r
    total = 0.0
    for i in range(len(_COS_COEFF) - 1, -1, -1):
        total = total * z + _COS_COEFF[i]
    return 1 + z * total


def sin(x: float) -> float:
    if x != x or math.isinf(x):
        return math.nan
    quadrant, remainder = _reduce_by_quarter_turn(x)
    if quadrant == 0:
        return _sin_core(remainder)
    if quadrant == 1:
        return _cos_core(remainder)
    if quadrant == 2:
        return -_sin_core(remainder)
    return -_cos_core(remainder)


def cos(x: float) -> float:
    if x != x or math.isinf(x):
        return math.nan
    quadrant, remainder = _reduce_by_quarter_turn(x)
    if quadrant == 0:
        return _cos_core(remainder)
    if quadrant == 1:
        return -_sin_core(remainder)
    if quadrant == 2:
        return -_cos_core(remainder)
    return _sin_core(remainder)


def tan(x: float) -> float:
    """One reduction shared by both halves, so the two can never come from different quadrants."""
    if x != x or math.isinf(x):
        return math.nan
    quadrant, remainder = _reduce_by_quarter_turn(x)
    s = _sin_core(remainder)
    c = _cos_core(remainder)
    return s / c if quadrant % 2 == 0 else -c / s


def pow(x: float, y: float) -> float:
    """An integer exponent goes through repeated squaring: ``pow(10, 3)`` is exactly 1000.

    The name shadows the builtin inside this module, deliberately: it is the name the expression
    language uses, and nothing here calls the builtin.
    """
    if y != y:
        return math.nan
    if y == 0:
        return 1.0
    if x != x:
        return math.nan
    if y == math.trunc(y) and not math.isinf(y) and abs(y) <= 1024:
        result = 1.0
        base = 1 / x if y < 0 else x
        n = int(abs(y))
        while n > 0:
            if n % 2 == 1:
                result *= base
            base *= base
            n = n // 2
        return result
    if x < 0:
        return math.nan
    if x == 0:
        return 0.0 if y > 0 else math.inf
    return exp(y * log(x))
