"""Distributions, time series and drawn shapes, against the shared statistical cases."""

from __future__ import annotations

import pytest

from tdcv2.lib.numbers import to_fixed
from tdcv2.pattern import curve as curves
from tdcv2.pattern import gen as patterns
from tdcv2.prng.prng import create
from tdcv2.prng.seekable import open_unit
from tdcv2.stats import distribution as dist
from tdcv2.stats import special, timeseries


def _draw(attrs: dict[str, str], count: int) -> list[str]:
    spec = dist.parse(attrs)
    prng = create("unit-test")
    out = []
    for _ in range(count):
        uniforms = [open_unit(prng.next()) for _ in range(spec.draws)]
        out.append(dist.format_sample(dist.sample(spec, uniforms), spec))
    return out


# ── rounding ────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("value", "decimals", "expected"),
    [
        # 1.005 is stored as 1.00499999999999989, so it rounds DOWN. Rounding the printed
        # "1.005" instead would answer 1.01 and diverge from the reference on money columns.
        (1.005, 2, "1.00"),
        (2.5, 0, "3"),
        (-2.5, 0, "-3"),
        (1.45, 1, "1.4"),
        (-0.004, 2, "-0.00"),
        (-0.0, 2, "0.00"),
        (1234.5678, 3, "1234.568"),
    ],
)
def test_rounding_follows_the_reference_rule(value: float, decimals: int, expected: str) -> None:
    assert to_fixed(value, decimals) == expected


# ── distributions ───────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("attrs", "expected"),
    [
        (
            {"distribution": "normal", "mean": "170", "sd": "10", "decimals": "2"},
            ["172.67", "176.14", "188.76", "183.98", "165.65", "160.54"],
        ),
        (
            {"distribution": "lognormal", "meanlog": "10", "sdlog": "1", "decimals": "0"},
            ["28755", "40720", "143725", "89136", "14263", "8549"],
        ),
        (
            {"distribution": "exponential", "rate": "0.5", "decimals": "3"},
            ["0.735", "0.445", "1.143", "0.331", "3.892", "0.103"],
        ),
        (
            {"distribution": "pareto", "alpha": "1.5", "xmin": "100", "decimals": "1"},
            ["219.5", "292.7", "174.1", "350.2", "110.8", "735.1"],
        ),
        (
            {"distribution": "weibull", "shape": "2", "scale": "5", "decimals": "3"},
            ["3.031", "2.360", "3.780", "2.034", "6.975", "1.134"],
        ),
        ({"distribution": "poisson", "lambda": "4"}, ["5", "6", "4", "6", "2", "8"]),
        ({"distribution": "zipf", "n": "20", "s": "1.2"}, ["5", "8", "3", "10", "1", "16"]),
        (
            {"distribution": "gamma", "shape": "2", "scale": "3", "decimals": "4"},
            ["7.2120", "8.9893", "5.6824", "10.0513", "1.9871", "14.2193"],
        ),
        (
            {"distribution": "beta", "alpha": "2", "beta": "5", "decimals": "5"},
            ["0.35620", "0.42267", "0.29301", "0.45911", "0.11400", "0.58149"],
        ),
        (
            {
                "distribution": "normal",
                "mean": "0",
                "sd": "1",
                "decimals": "1",
                "min": "-1",
                "max": "1",
            },
            ["0.3", "0.6", "1.0", "1.0", "-0.4", "-0.9"],
        ),
    ],
)
def test_a_distribution_matches_the_reference(attrs: dict[str, str], expected: list[str]) -> None:
    assert _draw(attrs, 6) == expected


def test_every_distribution_declares_a_fixed_draw_count() -> None:
    # Fixed draws are what make a row's value follow from its index alone. A distribution that
    # needed a variable number would quietly break the streaming engines.
    minimal = {
        "normal": {"mean": "0", "sd": "1"},
        "lognormal": {"meanlog": "0", "sdlog": "1"},
        "exponential": {"rate": "1"},
        "pareto": {"alpha": "1", "xmin": "1"},
        "weibull": {"shape": "1", "scale": "1"},
        "poisson": {"lambda": "1"},
        "zipf": {"n": "5", "s": "1"},
        "gamma": {"shape": "1", "scale": "1"},
        "beta": {"alpha": "1", "beta": "1"},
    }
    for name in dist.NAMES:
        spec = dist.parse({"distribution": name, **minimal[name]})
        assert spec.draws in (1, 2)


def test_an_unknown_distribution_lists_the_ones_that_exist() -> None:
    with pytest.raises(ValueError, match="normal, lognormal, exponential"):
        dist.parse({"distribution": "gaussian"})


def test_a_missing_parameter_is_named() -> None:
    with pytest.raises(ValueError, match='"sd" is required'):
        dist.parse({"distribution": "normal", "mean": "0"})


def test_a_non_positive_scale_is_refused() -> None:
    with pytest.raises(ValueError, match='"sd" must be a positive number'):
        dist.parse({"distribution": "normal", "mean": "0", "sd": "0"})


def test_a_lambda_too_large_to_compute_says_what_to_use_instead() -> None:
    with pytest.raises(ValueError, match='distribution="normal"'):
        dist.parse({"distribution": "poisson", "lambda": "800"})


def test_a_clip_that_runs_backwards_is_refused() -> None:
    with pytest.raises(ValueError, match="must be ≤ max"):
        dist.parse({"distribution": "normal", "mean": "0", "sd": "1", "min": "5", "max": "1"})


def test_the_zipf_table_ends_at_exactly_one() -> None:
    # Pinned against floating-point drift, so a uniform close to one still lands on the last rank.
    assert dist.zipf_cumulative(20, 1.2)[-1] == 1.0


def test_the_incomplete_gamma_and_beta_invert_themselves() -> None:
    for u in (0.05, 0.25, 0.5, 0.9):
        x = special.gamma_p_inv(2.0, u)
        assert abs(special.gamma_p(2.0, x) - u) < 1e-9
        y = special.beta_i_inv(2.0, 5.0, u)
        assert abs(special.beta_i(y, 2.0, 5.0) - u) < 1e-9


# ── time series ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("attrs", "expected"),
    [
        (
            {"base": "100", "trend": "2", "decimals": "0"},
            ["100", "102", "104", "106", "108", "110"],
        ),
        (
            {"base": "100", "trend": "0.5", "period": "4", "amplitude": "10", "decimals": "2"},
            ["100.00", "110.50", "101.00", "91.50", "102.00", "112.50"],
        ),
        (
            {"base": "50", "noise": "3", "decimals": "3"},
            ["50.800", "51.843", "55.627", "54.194", "48.696", "47.161"],
        ),
    ],
)
def test_a_time_series_matches_the_reference(attrs: dict[str, str], expected: list[str]) -> None:
    spec = timeseries.parse(attrs)
    prng = create("unit-test")
    produced = []
    for i in range(6):
        z = (
            timeseries.standard_normal(open_unit(prng.next()), open_unit(prng.next()))
            if spec.has_noise()
            else 0.0
        )
        produced.append(timeseries.format_value(timeseries.value_at(spec, i, z), spec.decimals))
    assert produced == expected


def test_a_series_without_noise_spends_no_draw() -> None:
    assert timeseries.parse({"base": "1"}).has_noise() is False
    assert timeseries.parse({"base": "1", "noise": "0.5"}).has_noise() is True


def test_a_negative_period_is_refused() -> None:
    with pytest.raises(ValueError, match='"period" must be'):
        timeseries.parse({"period": "-1"})


# ── patterns ────────────────────────────────────────────────────────────────────────────────


def _pattern(attrs: dict[str, str], count: int) -> list[str]:
    upper = attrs.get("upper")
    if upper:
        lower = attrs.get("lower")
        pattern = patterns.from_edges(
            attrs, curves.parse_points(upper), curves.parse_points(lower) if lower else None
        )
    else:
        pattern = patterns.from_points(attrs, curves.parse_points(attrs["points"]))
    if curves.parse_mode(attrs.get("mode")) == "density":
        pattern = patterns.as_density(pattern)

    draws = patterns.draws(pattern)
    prng = create("unit-test")
    denom = count - 1 if count > 1 else 1
    return [
        patterns.value_at(pattern, i / denom, open_unit(prng.next()) if draws else 0.0)
        for i in range(count)
    ]


@pytest.mark.parametrize(
    ("attrs", "count", "expected"),
    [
        # Config and expectation both taken from fixtures/cross-language/cases/patterns.json, so
        # these are pinned to the TypeScript reference rather than to whatever this port prints.
        (
            {"points": "0,0 5,100 10,0", "y_range": "0..10", "decimals": "2"},
            8,
            ["0.00", "2.86", "5.71", "8.57", "8.57", "5.71", "2.86", "0.00"],
        ),
        (
            {"points": "0,0 5,100 10,0", "y_range": "0..10", "decimals": "2", "interp": "smooth"},
            8,
            ["0.00", "3.44", "7.11", "9.62", "9.62", "7.11", "3.44", "0.00"],
        ),
        # The last row is the drawn point, not the plateau before it: a step holds a value in the
        # band to its RIGHT, and the last point has no band.
        (
            {"points": "0,0 5,100 10,0", "y_range": "0..10", "decimals": "2", "interp": "step"},
            8,
            ["0.00", "0.00", "0.00", "0.00", "10.00", "10.00", "10.00", "0.00"],
        ),
        (
            {"points": "0,0 5,100 10,0", "y_range": "100..200", "decimals": "1"},
            8,
            ["100.0", "128.6", "157.1", "185.7", "185.7", "157.1", "128.6", "100.0"],
        ),
        # The three below spend a random draw, and this helper feeds the generator a raw PRNG
        # rather than running a whole config, so its draw sequence differs from the fixture's.
        # Their numbers are therefore this path's own, unchanged by the canvas rule; what pins
        # them to the reference is the shared case of the same name, not this file.
        (
            {"points": "0,0 5,100 10,0", "y_range": "0..10", "decimals": "2", "spread": "1"},
            8,
            ["0.38", "3.46", "5.84", "9.27", "7.86", "6.61", "2.59", "-0.95"],
        ),
        (
            {"upper": "0,100 10,100", "lower": "0,0 10,0", "y_range": "0..100", "decimals": "1"},
            8,
            ["69.2", "80.0", "56.5", "84.7", "14.3", "95.0", "36.5", "2.7"],
        ),
        (
            {"points": "0,0 5,100 10,0", "y_range": "0..100", "decimals": "1", "mode": "density"},
            8,
            ["60.8", "68.4", "53.3", "72.4", "26.7", "84.2", "42.7", "11.7"],
        ),
        # More drawn detail than rows: each row reads where its own line crosses the drawing,
        # never an average of the slice around it.
        (
            {"points": "0,0 1,50 2,10 3,90 4,0", "y_range": "0..10", "decimals": "3"},
            3,
            ["0.000", "1.000", "0.000"],
        ),
        # A flat line halfway up the board is the MIDDLE of whatever range it is asked in —
        # not the floor (measuring the ink) and not the ceiling (clamping).
        (
            {"points": "0,50 10,50", "y_range": "-5..5", "decimals": "1"},
            8,
            ["0.0", "0.0", "0.0", "0.0", "0.0", "0.0", "0.0", "0.0"],
        ),
        (
            {"points": "0,50 10,50", "y_range": "0..200", "decimals": "1"},
            8,
            ["100.0", "100.0", "100.0", "100.0", "100.0", "100.0", "100.0", "100.0"],
        ),
    ],
)
def test_a_drawing_matches_the_reference(
    attrs: dict[str, str], count: int, expected: list[str]
) -> None:
    assert _pattern(attrs, count) == expected


def test_a_signal_without_spread_spends_no_draw() -> None:
    plain = patterns.from_points(
        {"points": "0,0 1,1", "y_range": "0..100"}, curves.parse_points("0,0 1,1")
    )
    assert patterns.draws(plain) is False
    scattered = patterns.from_points(
        {"points": "0,0 1,1", "spread": "1", "y_range": "0..100"}, [(0, 0), (1, 1)]
    )
    assert patterns.draws(scattered) is True


def test_spread_and_density_together_are_refused() -> None:
    scattered = patterns.from_points(
        {"points": "0,0 1,1", "spread": "1", "y_range": "0..100"}, [(0, 0), (1, 1)]
    )
    with pytest.raises(ValueError, match='"spread" has no meaning'):
        patterns.as_density(scattered)


def test_one_point_is_not_a_curve() -> None:
    with pytest.raises(ValueError, match="at least two points"):
        curves.build([(0, 0)], None, 0)


def test_an_odd_points_list_is_refused() -> None:
    with pytest.raises(ValueError, match="even list"):
        curves.parse_points("0,0 5")
