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
# The constant carries 21 zero low bits, so any k this reduction produces
# multiplies without rounding.
_LN2_HI = 0.6931471803691238
_LN2_LO = 1.9082149292705877e-10
_LN2 = 0.6931471805599453

# pi/2 in three pieces, for the same reason: a single rounded pi/2 loses most of
# the significant digits of sin(1000) before the series starts.
_PIO2 = 1.5707963267948966
_PIO2_1 = 1.5707963267341256
_PIO2_2 = 6.077100506506192e-11
_PIO2_3 = 2.0222662487959506e-21

# pi/4 and 3pi/4 — the quadrant answers atan2 returns.
_PIO4 = 0.7853981633974483
_PI3O4 = 2.356194490192345

# Taylor coefficients for (sin(r) - r)/r^3 over r^2, ascending. The count is set
# by the WORST point of the reduced interval, |r| = pi/4, not by a typical one.
_SIN_COEFF = (
    -1 / 6,
    1 / 120,
    -1 / 5040,
    1 / 362880,
    -1 / 39916800,
    1 / 6227020800,
    -1 / 1307674368000,
    1 / 355687428096000,
)

# Taylor coefficients for (cos(r) - 1)/r^2 over r^2, ascending. The last two are
# not optional: stopping at 1/14! is 13 ulp out at |r| = pi/4, and sin and tan
# both inherit that, since half of all arguments route through this series.
_COS_COEFF = (
    -1 / 2,
    1 / 24,
    -1 / 720,
    1 / 40320,
    -1 / 3628800,
    1 / 479001600,
    -1 / 87178291200,
    1 / 20922789888000,
    -1 / 6402373705728000,
)

# Taylor coefficients for e^r over r, ascending: 1/n!. Horner rather than a
# forward recurrence, which rounds twice per term and carries the error forward:
# 4 ulp against 1 for the same number of terms.
_EXP_COEFF = (
    1,
    1,
    1 / 2,
    1 / 6,
    1 / 24,
    1 / 120,
    1 / 720,
    1 / 5040,
    1 / 40320,
    1 / 362880,
    1 / 3628800,
    1 / 39916800,
    1 / 479001600,
    1 / 6227020800,
    1 / 87178291200,
    1 / 1307674368000,
)

# Taylor coefficients for atan(t)/t over t^2, ascending. Twenty-four, because
# the reduction halves the argument ONCE and no more: one halving with this many
# terms measures 2 ulp, two halvings with sixteen measures 3, three with twelve
# measures 4. Series terms are cheaper than reduction steps here.
_ATAN_COEFF = (
    1,
    -1 / 3,
    1 / 5,
    -1 / 7,
    1 / 9,
    -1 / 11,
    1 / 13,
    -1 / 15,
    1 / 17,
    -1 / 19,
    1 / 21,
    -1 / 23,
    1 / 25,
    -1 / 27,
    1 / 29,
    -1 / 31,
    1 / 33,
    -1 / 35,
    1 / 37,
    -1 / 39,
    1 / 41,
    -1 / 43,
    1 / 45,
    -1 / 47,
)

# Taylor coefficients for sinh(x)/x over x^2, ascending: 1/(2n+1)!.
_SINH_COEFF = (
    1,
    1 / 6,
    1 / 120,
    1 / 5040,
    1 / 362880,
    1 / 39916800,
    1 / 6227020800,
    1 / 1307674368000,
)

# Taylor coefficients for cosh(x) over x^2, ascending: 1/(2n)!.
_COSH_COEFF = (
    1,
    1 / 2,
    1 / 24,
    1 / 720,
    1 / 40320,
    1 / 3628800,
    1 / 479001600,
    1 / 87178291200,
)

_EXP_OVERFLOW = 709.782712893384
_EXP_UNDERFLOW = -745.1332191019411

# The most halvings that keep a value near 1 inside the normal range.
_DEEPEST_NORMAL_HALVING = 1021


# Taylor coefficients for (e^x - 1)/x over x, ascending: 1/(n+1)!.
_EXPM1_COEFF = (
    1,
    1 / 2,
    1 / 6,
    1 / 24,
    1 / 120,
    1 / 720,
    1 / 5040,
    1 / 40320,
    1 / 362880,
    1 / 3628800,
    1 / 39916800,
    1 / 479001600,
    1 / 6227020800,
    1 / 87178291200,
    1 / 1307674368000,
    1 / 20922789888000,
)


def _horner(coeff: tuple[float, ...], z: float) -> float:
    """Horner over z, ascending coefficients — the shape every series here uses."""
    total = 0.0
    for i in range(len(coeff) - 1, -1, -1):
        total = total * z + coeff[i]
    return total


def sqrt(x: float) -> float:
    """Delegated: IEEE-754 requires square root to be correctly rounded, so there is one answer."""
    if x != x or x < 0:
        return math.nan
    return math.sqrt(x)


def _halve_times(value: float, count: int) -> float:
    """Halve ``value`` exactly ``count`` times. Exact while the result stays normal."""
    out = value
    for _ in range(count):
        out /= 2
    return out


def _scale_by_power_of_two(value: float, n: int) -> float:
    """``value * 2**n`` for ``value`` near 1.

    Stepping one power at a time is exact — while the numbers stay normal. Below 2^-1022 they are
    not: a subnormal has fewer bits than it started with, and every further halving rounds again.
    Halving all the way down that way threw away most of the answer: exp(-730) came back
    9.22631e-318 against a true 9.226315e-318, and exp(-745) came back 0 against 5e-324.

    So a deep scaling is split: down to the edge of the normal range in exact steps, then ONE
    multiplication by a small power of two — itself exact, being no smaller than 2^-54.
    """
    if n >= -_DEEPEST_NORMAL_HALVING:
        out = value
        k = n
        while k > 0:
            out *= 2
            k -= 1
        return _halve_times(out, -k)
    at_the_edge = _halve_times(value, _DEEPEST_NORMAL_HALVING)
    remainder = _halve_times(1.0, -(n + _DEEPEST_NORMAL_HALVING))
    return at_the_edge * remainder


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
    return _scale_by_power_of_two(_horner(_EXP_COEFF, r), k)


def _atanh_series(s2: float, highest_odd_power: int) -> float:
    """The series for ``atanh(s)/s`` over s^2, shared by ``log`` and ``log1p``.

    The two callers reduce to different intervals, so each names how far to go: ``log`` halves its
    argument until |s| <= 0.1716 and thirteen terms suffice, while ``log1p`` cannot halve — it must
    not form ``1 + x`` at all — and reaches |s| <= 1/3, where thirteen terms are 63 ulp out and
    twenty are 2.
    """
    total = 0.0
    for i in range(highest_odd_power, 0, -2):
        total = total * s2 + 1 / i
    return total


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
    return 2 * s * _atanh_series(s * s, 25) + e * _LN2_HI + e * _LN2_LO


def log10(x: float) -> float:
    return log(x) / 2.302585092994046


def _reduce_by_quarter_turn(x: float) -> tuple[int, float]:
    """The quadrant (0-3) and the remainder in [-pi/4, pi/4]."""
    k = math.trunc(x / _PIO2 + (0.5 if x >= 0 else -0.5))
    remainder = x - k * _PIO2_1 - k * _PIO2_2 - k * _PIO2_3
    return ((k % 4) + 4) % 4, remainder


def _sin_core(r: float) -> float:
    z = r * r
    return r + r * z * _horner(_SIN_COEFF, z)


def _cos_core(r: float) -> float:
    z = r * r
    return 1 + z * _horner(_COS_COEFF, z)


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


def _repeated_squaring(base: float, exponent: int) -> float:
    result = 1.0
    b = base
    n = exponent
    while n > 0:
        if n % 2 == 1:
            result *= b
        b *= b
        n = n // 2
    return result


def pow(x: float, y: float) -> float:
    """``pow(x, y)``.

    An integer exponent goes through repeated squaring: pow(10, 3) is exactly 1000. The name
    shadows the builtin inside this module, deliberately: it is the name the expression language
    uses, and nothing here calls the builtin.
    """
    if y != y:
        return math.nan
    if y == 0:
        return 1.0
    if x != x:
        return math.nan
    if y == math.trunc(y) and not math.isinf(y) and abs(y) <= 1024:
        return _repeated_squaring(1 / x if y < 0 else x, int(abs(y)))
    # A negative base with a fractional exponent has no real answer, and saying
    # so is better than returning whatever the general route would produce.
    if x < 0:
        return math.nan
    if x == 0:
        return 0.0 if y > 0 else math.inf
    # A half-integer exponent is the fractional one people actually write, and
    # x^(n/2) is (sqrt x)^n — both halves exact. Without this, pow(100, 0.5) came
    # back 9.999999999999998 and pow(9, 1.5) 26.99999999999999.
    half = 2 * y
    if half == math.trunc(half) and abs(half) <= 2048:
        root = math.sqrt(x)
        return _repeated_squaring(1 / root if half < 0 else root, int(abs(half)))
    return exp(y * log(x))


# ── The second wave: inverses and hyperbolics ─────────────────────────────────
#
# Same rule as everything above: + - * /, math.sqrt, and the functions this
# module already built. Nothing here calls a transcendental of the host.


def _atan_half(t: float) -> float:
    """Half-angle for the arctangent: ``atan(t) = 2*atan(h(t))``. Built from sqrt alone."""
    return t / (1 + math.sqrt(1 + t * t))


def _atan_core(t: float) -> float:
    """``atan`` on [0, 1], halved once so the series runs on |t| <= 0.4143."""
    h = _atan_half(t)
    return 2 * (h * _horner(_ATAN_COEFF, h * h))


def atan(x: float) -> float:
    """``atan(x)`` — the arctangent, in radians, over the whole real line."""
    if x != x:
        return math.nan
    if x == math.inf:
        return _PIO2
    if x == -math.inf:
        return -_PIO2
    sign = -1 if x < 0 else 1
    a = abs(x)
    r = _PIO2 - _atan_core(1 / a) if a > 1 else _atan_core(a)
    return sign * r


def atan2(y: float, x: float) -> float:
    """``atan2(y, x)`` — the angle of the point (x, y), in radians, over (-pi, pi].

    The quadrant cannot be recovered from ``y/x`` alone: the ratio is the same in opposite
    quadrants, which is the whole reason this function exists separately from ``atan``.
    """
    if y != y or x != x:
        return math.nan
    y_inf = math.isinf(y)
    x_inf = math.isinf(x)
    if y_inf and x_inf:
        magnitude = _PIO4 if x > 0 else _PI3O4
        return magnitude if y > 0 else -magnitude
    if y_inf:
        return _PIO2 if y > 0 else -_PIO2
    if x_inf:
        if x > 0:
            return 0.0
        return -PI if y < 0 else PI
    if x == 0 and y == 0:
        return 0.0
    if x == 0:
        return _PIO2 if y > 0 else -_PIO2
    if y == 0:
        return 0.0 if x > 0 else PI
    r = atan(y / x)
    if x > 0:
        return r
    return r + PI if y > 0 else r - PI


def _asin_small(a: float) -> float:
    """``asin`` on [0, 0.5], where ``1 - a*a`` keeps every bit it started with."""
    return atan(a / math.sqrt(1 - a * a))


def asin(x: float) -> float:
    """``asin(x)`` — the arcsine, in radians, over [-1, 1].

    Past a half the direct route would compute ``1 - a*a`` with a and 1 nearly equal, and lose most
    of its digits before sqrt ever saw them. The half-angle identity moves the subtraction to
    ``1 - a``, which is exact in that range, and lands back on the branch above.
    """
    if x != x:
        return math.nan
    sign = -1 if x < 0 else 1
    a = abs(x)
    if a > 1:
        return math.nan
    if a == 1:
        return sign * _PIO2
    if a <= 0.5:
        return sign * _asin_small(a)
    return sign * (_PIO2 - 2 * _asin_small(math.sqrt((1 - a) / 2)))


def acos(x: float) -> float:
    """``acos(x)`` — the arccosine, in radians, over [-1, 1].

    Not ``pi/2 - asin(x)`` everywhere: near x = 1 the answer approaches zero, and that subtraction
    would compute it as the difference of two numbers that are nearly pi/2, throwing away every
    digit that matters.
    """
    if x != x:
        return math.nan
    if x > 1 or x < -1:
        return math.nan
    if x == 1:
        return 0.0
    if x == -1:
        return PI
    if x >= 0.5:
        return 2 * _asin_small(math.sqrt((1 - x) / 2))
    if x <= -0.5:
        return PI - 2 * _asin_small(math.sqrt((1 + x) / 2))
    return _PIO2 - _asin_small(abs(x)) * (-1 if x < 0 else 1)


def sinh(x: float) -> float:
    """``sinh(x)`` — below a half the exponential route would cancel the answer away."""
    if x != x or math.isinf(x):
        return x
    a = abs(x)
    if a < 0.5:
        return x * _horner(_SINH_COEFF, x * x)
    sign = -1 if x < 0 else 1
    # Past this point e^x overflows but sinh(x) still fits, so the halving is
    # folded into the exponent rather than applied after it.
    if a > 709:
        return sign * exp(a - _LN2)
    t = exp(a)
    return sign * (t - 1 / t) / 2


def cosh(x: float) -> float:
    """``cosh(x)`` — a sum rather than a difference, so nothing cancels."""
    if x != x:
        return math.nan
    if math.isinf(x):
        return math.inf
    a = abs(x)
    if a < 0.5:
        return _horner(_COSH_COEFF, x * x)
    if a > 709:
        return exp(a - _LN2)
    t = exp(a)
    return (t + 1 / t) / 2


def tanh(x: float) -> float:
    """``tanh(x)`` — past 20 the true value is within 1e-17 of 1, closer than the next double."""
    if x != x:
        return math.nan
    sign = -1 if x < 0 else 1
    if math.isinf(x):
        return float(sign)
    a = abs(x)
    if a > 20:
        return float(sign)
    if a < 0.5:
        z = x * x
        return x * _horner(_SINH_COEFF, z) / _horner(_COSH_COEFF, z)
    u = exp(2 * a)
    return sign * (u - 1) / (u + 1)


def cbrt(x: float) -> float:
    """``cbrt(x)`` — the cube root, defined for negatives too.

    ``pow(x, 1/3)`` is not the same function: one third is not a double, and a negative base with a
    fractional exponent has no real answer at all. So this is its own function, reduced by powers
    of eight — exact, being powers of two — and then refined by Newton's method.
    """
    if x != x or math.isinf(x) or x == 0:
        return x
    sign = -1 if x < 0 else 1
    a = abs(x)
    e = 0
    while a >= 8:
        a /= 8
        e += 1
    while a < 1:
        a *= 8
        e -= 1
    # A straight line through the ends of [1, 8): within 11% everywhere, which
    # six Newton passes take past the last bit.
    y = 1 + (a - 1) / 7
    for _ in range(6):
        y = (2 * y + a / (y * y)) / 3
    return sign * _scale_by_power_of_two(y, e)


# ── The third wave: the shapes that exist to avoid cancellation ───────────────
#
# expm1 and log1p are not conveniences. Near zero, exp(x) - 1 and log(1 + x)
# each throw away most of their answer to a subtraction or to a rounding that
# happens before the function is even called — and these two are what the
# inverse hyperbolics are built from, which is why they come first.


def expm1(x: float) -> float:
    """``expm1(x)`` — e^x - 1, computed so that small x keeps its digits.

    ``exp(0.0000001) - 1`` in plain arithmetic is a subtraction of two numbers that agree to seven
    places, and most of the answer dies in it. The series has no subtraction to lose anything to.
    """
    if x != x:
        return math.nan
    if abs(x) < 0.5:
        return x * _horner(_EXPM1_COEFF, x)
    return exp(x) - 1


def log1p(x: float) -> float:
    """``log1p(x)`` — log(1 + x), computed so that small x keeps its digits.

    The loss here happens before the logarithm is reached: ``1 + 1e-20`` IS 1 as a double, so
    ``log(1 + x)`` returns zero for every x under 1e-16. Reducing instead to
    ``2*atanh(x/(2+x))`` never forms ``1 + x`` at all.
    """
    if x != x or x < -1:
        return math.nan
    if x == -1:
        return -math.inf
    if x == math.inf:
        return math.inf
    # Past a half, `1 + x` has nothing left to lose and the direct route is both
    # shorter and better conditioned.
    if abs(x) >= 0.5:
        return log(1 + x)
    s = x / (2 + x)
    return 2 * s * _atanh_series(s * s, 39)


def log2(x: float) -> float:
    """``log2(x)``.

    Not ``log(x) / ln2``: that would make ``log2(8)`` come out 2.9999999999999996, and a power of
    two is precisely the argument someone passes to ``log2``. The exponent is separated first.
    """
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
    if m == 1:
        return float(e)
    return e + log(m) / _LN2


def hypot(x: float, y: float) -> float:
    """``hypot(x, y)`` — the length of the vector, without an intermediate that overflows.

    ``sqrt(x*x + y*y)`` is the definition and the wrong implementation: for x = 1e200 the square
    overflows to infinity and the answer comes back infinite, though it is perfectly
    representable. Factoring the larger side out first keeps every intermediate near 1.
    """
    # An infinite side wins even against a NaN on the other, which is what
    # IEEE-754 recommends: the length is infinite whatever the other side is.
    if math.isinf(x) or math.isinf(y):
        return math.inf
    if x != x or y != y:
        return math.nan
    a = abs(x)
    b = abs(y)
    if a < b:
        a, b = b, a
    if a == 0:
        return 0.0
    ratio = b / a
    return a * math.sqrt(1 + ratio * ratio)


def sign(x: float) -> float:
    """``sign(x)`` — -1, 0 or 1. Exact: there is nothing here to round."""
    if x != x:
        return math.nan
    if x > 0:
        return 1.0
    if x < 0:
        return -1.0
    return 0.0


def asinh(x: float) -> float:
    """``asinh(x)`` — the inverse hyperbolic sine, over the whole real line.

    ``log(x + sqrt(x*x + 1))`` is the textbook form and cancels for small x. Rewriting the
    argument as ``x + x*x/(1 + sqrt(1 + x*x))`` leaves ``log1p`` a number near x rather than a
    number near 1, and nothing cancels.
    """
    if x != x or math.isinf(x):
        return x
    sign_ = -1 if x < 0 else 1
    a = abs(x)
    # Past this, a*a would overflow while asinh(a) is still a small number; up
    # there sqrt(1 + a*a) is a to every bit, so the answer is log(2a).
    if a > 1e150:
        return sign_ * (log(a) + _LN2)
    return sign_ * log1p(a + (a * a) / (1 + math.sqrt(1 + a * a)))


def acosh(x: float) -> float:
    """``acosh(x)`` — the inverse hyperbolic cosine, defined for x >= 1.

    Written around ``t = x - 1``, which is exact for the x near 1 where the answer approaches zero
    and the textbook form loses it.
    """
    if x != x:
        return math.nan
    if x < 1:
        return math.nan
    if x == 1:
        return 0.0
    if x == math.inf:
        return math.inf
    if x > 1e150:
        return log(x) + _LN2
    t = x - 1
    return log1p(t + math.sqrt(2 * t + t * t))


def atanh(x: float) -> float:
    """``atanh(x)`` — the inverse hyperbolic tangent, over (-1, 1).

    ``0.5*log((1+x)/(1-x))`` forms a ratio near 1 for small x and loses it. The same ratio written
    as ``1 + 2x/(1-x)`` hands ``log1p`` the small part directly.
    """
    if x != x:
        return math.nan
    if x > 1 or x < -1:
        return math.nan
    if x == 1:
        return math.inf
    if x == -1:
        return -math.inf
    # The identity is only well-conditioned on the positive side. Fed x = -0.999999
    # directly it hands log1p an argument of -0.9999995, which is the very
    # cancellation log1p exists to avoid — and the answer came back 37618 ulp
    # wrong. Folding to |x| first keeps that argument positive and large.
    sign_ = -1 if x < 0 else 1
    a = abs(x)
    return sign_ * 0.5 * log1p((2 * a) / (1 - a))


# ── The fourth wave: statistics ───────────────────────────────────────────────
#
# erf, erfc, gamma and lgamma. These are the first functions here whose accuracy
# is bounded by something other than the series that computes them, and each one
# says so where it lives.

_TWO_OVER_SQRT_PI = 1.1283791670955126
_ONE_OVER_SQRT_PI = 0.5641895835477563
_LOG_SQRT_2PI = 0.9189385332046728
_SQRT_2PI = 2.5066282746310002

# 2^27 + 1 — Dekker's splitting constant.
_SPLIT = 134217729

# Taylor coefficients for erf(x)*sqrt(pi)/2 over x^2, ascending: -+1/(n!(2n+1)).
_ERF_COEFF = (
    1,
    -1 / 3,
    1 / 10,
    -1 / 42,
    1 / 216,
    -1 / 1320,
    1 / 9360,
    -1 / 75600,
    1 / 685440,
    -1 / 6894720,
    1 / 76204800,
    -1 / 918086400,
    1 / 11975040000,
    -1 / 168129561600,
    1 / 2528170444800,
    -1 / 40537905525000,
    1 / 691118486016000,
    -1 / 12460033493760000,
)

# How deep the continued fraction for erfc runs.
_ERFC_DEPTH = 200

# Lanczos coefficients, g = 7, n = 9 — the classic set, good for ~15 digits.
_LANCZOS = (
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
)


def _exp_neg_square(x: float) -> float:
    """``e^(-x*x)``, computed so the rounding of x*x never reaches the exponent.

    This is the whole accuracy story for erfc. Squaring x rounds by about x^2 * 2^-53; exp then
    turns that ABSOLUTE error in its argument into a RELATIVE error in its answer, so at x = 23 the
    result drifts by about 6e-14 — four hundred ulp. Measured before this existed: 445 ulp. After:
    5. The high part keeps 26 significant bits, so its square needs 52 and is exact.
    """
    s = _SPLIT * x
    hi = s - (s - x)
    lo = x - hi
    return exp(-hi * hi) * (1 + expm1(-(2 * hi * lo + lo * lo)))


def _erf_small(x: float) -> float:
    """``erf`` on [0, 1] — no exponential involved, so nothing amplifies."""
    return _TWO_OVER_SQRT_PI * x * _horner(_ERF_COEFF, x * x)


def _erfc_large(x: float) -> float:
    """``erfc`` for x > 1, by continued fraction.

    Two hundred levels rather than a convergence test: a FIXED depth is one less thing for five
    implementations to agree about. The depth is set by the slowest point, just above x = 1, where
    100 levels leave 29645 ulp and 200 leave 5.
    """
    f = 0.0
    for k in range(_ERFC_DEPTH, 0, -1):
        f = k / 2 / (x + f)
    return _ONE_OVER_SQRT_PI * _exp_neg_square(x) / (x + f)


def erf(x: float) -> float:
    """``erf(x)`` — the error function.

    Below 1 the series is used directly; above it, ``1 - erfc(x)``, because there erfc is the small
    quantity and the subtraction costs nothing.
    """
    if x != x:
        return math.nan
    sign_ = -1 if x < 0 else 1
    a = abs(x)
    if math.isinf(a):
        return float(sign_)
    if a <= 1:
        return sign_ * _erf_small(a)
    return sign_ * (1 - _erfc_large(a))


def erfc(x: float) -> float:
    """``erfc(x)`` — the complement, 1 - erf(x), and not computed that way past 1.

    At x = 5 the true value is 1.5e-12, and ``1 - erf(x)`` keeps only six of its twelve digits; by
    x = 6 erf has rounded to 1 and the answer is gone entirely. That is why this exists separately.
    """
    if x != x:
        return math.nan
    if x == math.inf:
        return 0.0
    if x == -math.inf:
        return 2.0
    if x < 0:
        return 2 - erfc(-x)
    if x <= 1:
        return 1 - _erf_small(x)
    return _erfc_large(x)


def _sin_pi(x: float) -> float:
    """``sin(pi*x)``, taken from the distance to the nearest whole number.

    The reflection formula for gamma needs this near the integers, where sin(pi*x) approaches zero.
    Computing sin(PI * x) directly puts the rounding of PI * x — absolute, and growing with x —
    right next to a zero: at x = -4.00006 the answer came out 28582 ulp wrong.
    """
    n = math.floor(x + 0.5)
    r = x - n
    s = sin(PI * r)
    return s if n % 2 == 0 else -s


def _lanczos_sum(z: float) -> float:
    a = _LANCZOS[0]
    for i in range(1, 9):
        a += _LANCZOS[i] / (z + i)
    return a


def lgamma(x: float) -> float:
    """``lgamma(x)`` — the natural logarithm of |gamma(x)|.

    Away from x = 1 and x = 2 it is within 32 ulp. AT those two points lgamma is ZERO, and a
    relative bound there is not a statement about this code — no method that sums terms of size 1
    can be relatively accurate about their cancelling to nothing. What holds is the ABSOLUTE error,
    measured under 1e-13 on a bounded range, and both zeros come out exactly zero.
    """
    if x != x:
        return math.nan
    if x == math.inf:
        return math.inf
    # The poles: every whole number at or below zero.
    if x <= 0 and x == math.trunc(x):
        return math.inf
    if x < 0.5:
        return log(PI / abs(_sin_pi(x))) - lgamma(1 - x)
    z = x - 1
    t = z + 7.5
    return _LOG_SQRT_2PI + (z + 0.5) * log(t) - t + log(_lanczos_sum(z))


def gamma(x: float) -> float:
    """``gamma(x)`` — the factorial extended to the reals.

    Gamma of a whole number is a factorial, and multiplying it out is exact for the first
    twenty-three and within 7 ulp for all 171 that fit in a double. The general route cannot match
    that: it ends in an exponential, and exp turns the absolute error of its argument into a
    relative error of its answer, so the drift grows with log gamma(x) — about 2000 ulp near
    x = 146. The same amplification pow has, for the same reason.
    """
    if x != x:
        return math.nan
    if x == math.inf:
        return math.inf
    if x == -math.inf:
        return math.nan
    # Every whole number at or below zero is a pole, with no value to give.
    if x <= 0 and x == math.trunc(x):
        return math.nan
    if x == math.trunc(x) and 1 <= x <= 171:
        result = 1.0
        k = 2
        while k < x:
            result *= k
            k += 1
        return result
    if x < 0.5:
        return PI / (_sin_pi(x) * gamma(1 - x))
    z = x - 1
    t = z + 7.5
    # One exponential rather than t^(z+0.5) * e^(-t): that product overflows on
    # its first factor near x = 150, while gamma(x) is still finite to 171.
    return _SQRT_2PI * _lanczos_sum(z) * exp((z + 0.5) * log(t) - t)
