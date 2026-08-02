"""``distribution="normal" mean="170" sd="10"`` — a column shaped like the thing it stands for.

Heights are not uniform between 150 and 200. Salaries are not either, and neither are inter-event
times or file sizes or the popularity of products. A uniform range is the wrong default for almost
every real quantity, and a test set built from one hides exactly the bugs that show up on the tail.

Two rules keep this working with the streaming engines. Each distribution consumes a FIXED number
of uniforms, so a row's value follows from its index alone — which rules out rejection sampling,
the usual way to draw gamma and beta. And the arithmetic is written out rather than taken from a
library, because three languages have to agree on the last bit.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from ..lib import numbers
from .special import beta_i_inv, gamma_p_inv

# e^-lambda underflows to zero above about 745, which would break the recurrence the table is
# built on. Above this, normal(mean=lambda, sd=sqrt(lambda)) is the standard approximation anyway.
MAX_LAMBDA = 700

# A guard against an absurd rank count exhausting memory before it produces anything.
MAX_ZIPF_N = 10_000_000

NAMES = (
    "normal",
    "lognormal",
    "exponential",
    "pareto",
    "weibull",
    "poisson",
    "zipf",
    "gamma",
    "beta",
)


@dataclass(frozen=True, slots=True)
class Spec:
    name: str
    draws: int
    """How many uniforms in (0,1) one value costs. Fixed per distribution — that is the point."""

    decimals: int
    params: dict[str, float]
    table: tuple[float, ...] | None = None
    """The cumulative table a discrete distribution is searched in."""

    minimum: float | None = None
    maximum: float | None = None


def sample(spec: Spec, uniforms: list[float]) -> float:
    """The RAW value from ``uniforms``; clipping and rounding happen in :func:`format_sample`."""
    u1 = uniforms[0] if uniforms else 0.0
    u2 = uniforms[1] if len(uniforms) > 1 else 0.0
    p = spec.params

    if spec.name == "normal":
        return p["mean"] + p["sd"] * _box_muller(u1, u2)
    if spec.name == "lognormal":
        return math.exp(p["meanlog"] + p["sdlog"] * _box_muller(u1, u2))
    if spec.name == "exponential":
        return -math.log(u1) / p["rate"]
    if spec.name == "pareto":
        return p["xmin"] * (1 - u1) ** (-1 / p["alpha"])
    if spec.name == "weibull":
        return p["scale"] * (-math.log(u1)) ** (1 / p["shape"])
    if spec.name == "poisson":
        return float(_lower_bound(spec.table or (), u1))
    if spec.name == "zipf":
        return float(_lower_bound(spec.table or (), u1) + 1)  # ranks are 1-based
    if spec.name == "gamma":
        return p["scale"] * gamma_p_inv(p["shape"], u1)
    if spec.name == "beta":
        return beta_i_inv(p["alpha"], p["beta"], u1)
    raise ValueError(f'distribution: unknown distribution "{spec.name}"')


def format_sample(value: float, spec: Spec) -> str:
    """The sample clipped to ``[min, max]`` where set, then rounded to ``decimals``."""
    v = value
    if spec.minimum is not None:
        v = max(spec.minimum, v)
    if spec.maximum is not None:
        v = min(spec.maximum, v)
    return numbers.to_fixed(v, spec.decimals)


def parse(attrs: dict[str, str]) -> Spec:
    """The distribution attributes of a ``number`` gen.

    Only these attributes: whether ``distribution`` may sit beside a range or ``percent`` is a
    question about the whole generator, and the validator is where the whole generator is visible.
    """
    name = attrs.get("distribution")
    decimals = _decimals(attrs.get("decimals"))
    minimum = _optional(attrs.get("min"), "min")
    maximum = _optional(attrs.get("max"), "max")
    if minimum is not None and maximum is not None and minimum > maximum:
        raise ValueError(
            f"distribution: min ({numbers.to_text(minimum)}) must be ≤ max "
            f"({numbers.to_text(maximum)})"
        )

    def spec(draws: int, params: dict[str, float], table: tuple[float, ...] | None = None) -> Spec:
        return Spec(str(name), draws, decimals, params, table, minimum, maximum)

    if name == "normal":
        return spec(2, {"mean": _required(attrs, "mean", name), "sd": _positive(attrs, "sd", name)})
    if name == "lognormal":
        return spec(
            2,
            {
                "meanlog": _required(attrs, "meanlog", name),
                "sdlog": _positive(attrs, "sdlog", name),
            },
        )
    if name == "exponential":
        return spec(1, {"rate": _positive(attrs, "rate", name)})
    if name == "pareto":
        return spec(
            1, {"alpha": _positive(attrs, "alpha", name), "xmin": _positive(attrs, "xmin", name)}
        )
    if name == "weibull":
        return spec(
            1, {"shape": _positive(attrs, "shape", name), "scale": _positive(attrs, "scale", name)}
        )
    if name == "poisson":
        lam = _positive(attrs, "lambda", name)
        return spec(1, {"lambda": lam}, poisson_cdf(lam))
    if name == "zipf":
        n = _positive_int(attrs, "n", name)
        s = _positive(attrs, "s", name)
        return spec(1, {"n": n, "s": s}, zipf_cumulative(int(n), s))
    if name == "gamma":
        return spec(
            1, {"shape": _positive(attrs, "shape", name), "scale": _positive(attrs, "scale", name)}
        )
    if name == "beta":
        return spec(
            1, {"alpha": _positive(attrs, "alpha", name), "beta": _positive(attrs, "beta", name)}
        )
    raise ValueError(
        f'distribution: unknown distribution "{name}" — expected '
        "normal, lognormal, exponential, pareto, weibull, poisson, zipf, gamma, or beta"
    )


def poisson_cdf(lam: float) -> tuple[float, ...]:
    """``cdf[k] = P(X ≤ k)``, extended until it reaches one."""
    if lam > MAX_LAMBDA:
        raise ValueError(
            f'distribution "poisson": lambda {numbers.to_text(lam)} is too large '
            f"(max {MAX_LAMBDA}); for large means use "
            f'distribution="normal" mean="{numbers.to_text(lam)}" sd="sqrt(lambda)".'
        )
    p = math.exp(-lam)
    cumulative = p
    out = [cumulative]
    cap = lam + 40 * math.sqrt(lam) + 100
    k = 1
    while cumulative < 1 - 1e-12 and k < cap:
        p = p * lam / k
        cumulative += p
        out.append(min(1.0, cumulative))
        k += 1
    return tuple(out)


def zipf_cumulative(n: int, s: float) -> tuple[float, ...]:
    """``cum[k] = P(rank ≤ k+1)`` over the ranks 1..n."""
    if n > MAX_ZIPF_N:
        raise ValueError(f'distribution "zipf": n {n} is too large (max {MAX_ZIPF_N}).')
    weights = [1 / k**s for k in range(1, n + 1)]
    total = sum(weights)
    out = []
    c = 0.0
    for w in weights:
        c += w / total
        out.append(c)
    # The last is pinned against floating-point drift, so a uniform close to one still lands on
    # rank n rather than falling off the end of the table.
    out[n - 1] = 1.0
    return tuple(out)


def _box_muller(u1: float, u2: float) -> float:
    """A standard normal deviate from two uniforms in (0,1)."""
    return math.sqrt(-2 * math.log(u1)) * math.cos(2 * math.pi * u2)


def _lower_bound(cumulative: tuple[float, ...], u: float) -> int:
    """The smallest k with ``cumulative[k] ≥ u``, clamped to the last."""
    lo, hi = 0, len(cumulative) - 1
    while lo < hi:
        mid = (lo + hi) >> 1
        if cumulative[mid] >= u:
            hi = mid
        else:
            lo = mid + 1
    return lo


def _decimals(raw: str | None) -> int:
    if raw is None or not raw.strip():
        return 0
    n = numbers.parse(raw)
    if n != n or n != int(n) or n < 0:
        raise ValueError(f'distribution: "decimals" must be a non-negative integer (got "{raw}")')
    return int(n)


def _optional(raw: str | None, label: str) -> float | None:
    if raw is None or not raw.strip():
        return None
    n = numbers.parse(raw)
    if n != n or n in (float("inf"), float("-inf")):
        raise ValueError(f'distribution: "{label}" must be a number (got "{raw}")')
    return n


def _required(attrs: dict[str, str], key: str, dist: str | None) -> float:
    raw = attrs.get(key)
    n = float("nan") if raw is None or not raw.strip() else numbers.parse(raw)
    if n != n or n in (float("inf"), float("-inf")):
        raise ValueError(f'distribution "{dist}": "{key}" is required and must be a number')
    return n


def _positive(attrs: dict[str, str], key: str, dist: str | None) -> float:
    n = _required(attrs, key, dist)
    if not n > 0:
        raise ValueError(
            f'distribution "{dist}": "{key}" must be a positive number (got {numbers.to_text(n)})'
        )
    return n


def _positive_int(attrs: dict[str, str], key: str, dist: str | None) -> float:
    n = _required(attrs, key, dist)
    if n != int(n) or n < 1:
        raise ValueError(
            f'distribution "{dist}": "{key}" must be a positive integer (got {numbers.to_text(n)})'
        )
    return n
