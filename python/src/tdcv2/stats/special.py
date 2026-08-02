"""The special functions that make gamma and beta seekable.

Neither has a closed-form inverse CDF, and the textbook way to sample them is rejection sampling —
draw, test, draw again. That consumes a VARIABLE number of uniforms, which would break the one
property the whole library rests on: that row nine million can be computed without the rows before
it.

So their CDFs are computed instead — the regularized lower incomplete gamma and the regularized
incomplete beta — and inverted by bisection. That costs a hundred iterations per value and buys an
exact inverse-CDF sampler consuming exactly ONE uniform.

Standard series and continued-fraction forms, written out rather than taken from a library: a
dependency would have to be present in three languages and agree with itself to the last bit.
"""

from __future__ import annotations

import math

_LANCZOS_G = 7
_LANCZOS_C = (
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

_MAX_ITER = 300
_EPS = 1e-15
_FPMIN = 1e-300

# 2^-100 is far below what a double can tell apart, so the bracket has closed long before this.
_BISECTION_ITER = 100


def lgamma(z: float) -> float:
    """The natural log of the gamma function, by the Lanczos approximation."""
    if z < 0.5:
        # Reflection, for the left half-plane.
        return math.log(math.pi / math.sin(math.pi * z)) - lgamma(1 - z)
    zz = z - 1
    x = _LANCZOS_C[0]
    for i in range(1, _LANCZOS_G + 2):
        x += _LANCZOS_C[i] / (zz + i)
    t = zz + _LANCZOS_G + 0.5
    return 0.5 * math.log(2 * math.pi) + (zz + 0.5) * math.log(t) - t + math.log(x)


def gamma_p(a: float, x: float) -> float:
    """The regularized lower incomplete gamma ``P(a,x)`` — the CDF of gamma(a, 1) at x."""
    if x <= 0:
        return 0.0
    if x < a + 1:
        return _gamma_series(a, x)
    return 1 - _gamma_continued_fraction(a, x)


def beta_i(x: float, a: float, b: float) -> float:
    """The regularized incomplete beta ``I_x(a,b)`` — the CDF of beta(a,b) at x."""
    if x <= 0:
        return 0.0
    if x >= 1:
        return 1.0
    bt = math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * math.log(x) + b * math.log(1 - x))
    if x < (a + 1) / (a + b + 2):
        return bt * _beta_continued_fraction(a, b, x) / a
    return 1 - bt * _beta_continued_fraction(b, a, 1 - x) / b


def gamma_p_inv(a: float, u: float) -> float:
    """The inverse of ``gamma_p(a, ·)``: the x ≥ 0 where ``P(a,x) = u``, for u in (0,1)."""
    hi = 1.0
    while gamma_p(a, hi) < u and hi < 1e300:
        hi *= 2
    lo = 0.0
    for _ in range(_BISECTION_ITER):
        mid = (lo + hi) / 2
        if gamma_p(a, mid) < u:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def beta_i_inv(a: float, b: float, u: float) -> float:
    """The inverse of ``beta_i(·, a, b)``: the x in (0,1) where ``I_x(a,b) = u``."""
    lo = 0.0
    hi = 1.0
    for _ in range(_BISECTION_ITER):
        mid = (lo + hi) / 2
        if beta_i(mid, a, b) < u:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def _gamma_series(a: float, x: float) -> float:
    gln = lgamma(a)
    ap = a
    total = 1 / a
    delta = total
    for _ in range(_MAX_ITER):
        ap += 1
        delta *= x / ap
        total += delta
        if abs(delta) < abs(total) * _EPS:
            break
    return total * math.exp(-x + a * math.log(x) - gln)


def _gamma_continued_fraction(a: float, x: float) -> float:
    """``Q(a,x) = 1 - P(a,x)``, by its continued fraction."""
    gln = lgamma(a)
    b = x + 1 - a
    c = 1 / _FPMIN
    d = 1 / b
    h = d
    for i in range(1, _MAX_ITER):
        an = -i * (i - a)
        b += 2
        d = an * d + b
        if abs(d) < _FPMIN:
            d = _FPMIN
        c = b + an / c
        if abs(c) < _FPMIN:
            c = _FPMIN
        d = 1 / d
        delta = d * c
        h *= delta
        if abs(delta - 1) < _EPS:
            break
    return math.exp(-x + a * math.log(x) - gln) * h


def _beta_continued_fraction(a: float, b: float, x: float) -> float:
    qab = a + b
    qap = a + 1
    qam = a - 1
    c = 1.0
    d = 1 - qab * x / qap
    if abs(d) < _FPMIN:
        d = _FPMIN
    d = 1 / d
    h = d
    for m in range(1, _MAX_ITER):
        m2 = 2 * m
        aa = m * (b - m) * x / ((qam + m2) * (a + m2))
        d = 1 + aa * d
        if abs(d) < _FPMIN:
            d = _FPMIN
        c = 1 + aa / c
        if abs(c) < _FPMIN:
            c = _FPMIN
        d = 1 / d
        h *= d * c
        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
        d = 1 + aa * d
        if abs(d) < _FPMIN:
            d = _FPMIN
        c = 1 + aa / c
        if abs(c) < _FPMIN:
            c = _FPMIN
        d = 1 / d
        delta = d * c
        h *= delta
        if abs(delta - 1) < _EPS:
            break
    return h
