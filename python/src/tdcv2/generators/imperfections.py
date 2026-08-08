"""Blanks and outliers, on purpose.

Real data has holes and it has values nobody expected. A dataset that has neither is the wrong
dataset to test against: the code that trips over an empty field or a price a thousand times too
large is exactly the code worth exercising.

The order the two passes run in is the contract — outliers first, then blanks, then formatting.
Spiking after blanking would multiply an empty string, and formatting before either would format
a value about to be replaced.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass

_DEFAULT_FACTOR = 10.0


@dataclass(frozen=True, slots=True)
class Missing:
    """``missing="p"`` with an optional ``missing_as="NULL"``."""

    probability: float
    token: str


@dataclass(frozen=True, slots=True)
class Anomaly:
    """``anomaly="p"`` with an optional ``anomaly_factor="10"``."""

    probability: float
    factor: float


def parse_missing(attrs: dict[str, str]) -> Missing | None:
    raw = attrs.get("missing")
    if raw is None or not raw.strip():
        return None
    return Missing(_probability(raw, "missing"), attrs.get("missing_as", ""))


def parse_anomaly(attrs: dict[str, str]) -> Anomaly | None:
    raw = attrs.get("anomaly")
    if raw is None or not raw.strip():
        return None
    p = _probability(raw, "anomaly")

    factor_raw = attrs.get("anomaly_factor")
    if factor_raw is None or not factor_raw.strip():
        factor = _DEFAULT_FACTOR
    else:
        try:
            factor = float(factor_raw.strip())
            if not math.isfinite(factor):
                raise ValueError
        except ValueError:
            raise ValueError(f'anomaly: anomaly_factor "{factor_raw}" must be a number') from None
    return Anomaly(p, factor)


def apply_missing(values: list[str], spec: Missing, draw: Callable[[int], float]) -> None:
    """Blank the selected rows, in place.

    A draw is taken for every row even at probability zero would be wasteful, so the whole pass
    is skipped instead — which is also what keeps a config without ``missing`` producing the same
    values as one with ``missing="0"``.

    ``draw`` is asked for the uniform OF ROW i rather than for the next one — see
    ``apply_anomaly`` for why.
    """
    if spec.probability <= 0:
        return
    for i in range(len(values)):
        if draw(i) < spec.probability:
            values[i] = spec.token


def apply_anomaly(
    values: list[str],
    spec: Anomaly,
    draw: Callable[[int], float],
    flags: list[bool] | None = None,
) -> None:
    """Spike the selected rows, recording which ones — the flag is ground truth for a detector.

    A draw is taken for EVERY row, even at probability zero, because the flag column has to be
    the same length as the values and the stream has to advance identically either way.

    ``draw`` is asked for the uniform OF ROW i rather than for "the next" one: the streaming
    engine derives it from the row, and the in-memory engine passes a closure over its own
    PRNG. Same rows selected either way, and one function serves both.
    """
    for i in range(len(values)):
        # The draw is taken on EVERY row whether or not it is used, so the stream stays
        # aligned: a column that skipped it would give different values to every row after
        # the first one.
        selected = spec.probability > 0 and draw(i) < spec.probability
        spiked = selected and is_spikeable(values[i])
        if flags is not None:
            # What HAPPENED, not what was selected. Recording the selection was right only
            # for the gens whose output is numeric by construction; a template column of
            # surnames is selected like any other and then left alone, and came out flagged
            # true beside an ordinary name — while the docs promise the flag and the spike
            # can never disagree.
            flags[i] = spiked
        if spiked:
            values[i] = spike(values[i], spec.factor)


def spike(value: str, factor: float) -> str:
    """One value made an outlier, or returned untouched when it is not a number."""
    try:
        n = float(value.strip())
    except (ValueError, AttributeError):
        # Not a number, so there is no outlier to make. Left exactly as it was.
        return value
    if not math.isfinite(n):
        return value
    return _keep_shape(value, n * factor)


def _keep_shape(original: str, spiked: float) -> str:
    """The spike keeps the SHAPE of the value it replaced.
    
    Multiplying and re-stringifying threw away everything the column had already been
    rendered with — the zero padding length= asked for, and the decimal places decimals=
    asked for — so the outlier rows were the only ones in the file with a different shape:
    
        length="5"    00014 00046 00053 ...  and then  117
        decimals="2"  85.66 40.97 11.52 ...  and then  6.445
    
    A column of fixed-width identifiers stopped being fixed width on exactly the rows a test
    is about to exercise, and a column declared with decimals is typed a float in Parquet — a
    third place is a value the declared type never promised. An outlier is meant to be far
    from the others in VALUE, not in format.

    So: the same number of decimal places, and at least the same digit width where the
    column was zero-padded. The padding only ever adds, so a spike that genuinely outgrew
    the width keeps its extra digits — which is the whole point of one.
    """
    dot = original.find(".")
    places = 0 if dot < 0 else len(original) - dot - 1

    # Rounded on the SCALED integer, half away from zero, rather than by handing an
    # arbitrary product to a host formatter: `round` already means that everywhere else in
    # TDC, and it is the one rule all five spell the same.
    scale = 10**places
    scaled = spiked * scale
    rounded = -math.floor(-scaled + 0.5) if scaled < 0 else math.floor(scaled + 0.5)
    text = f"{rounded / scale:.{places}f}"

    # Only a value that was ZERO-PADDED has a width to preserve. `12.89` is five characters
    # wide because the number is, not because the column asked for five.
    bare = original[1:] if original.startswith("-") else original
    whole_part = bare if dot < 0 else bare[: bare.find(".")]
    if not whole_part.startswith("0") or len(whole_part) < 2:
        return text

    negative = text.startswith("-")
    body = text[1:] if negative else text
    cut = body.find(".")
    whole = body if cut < 0 else body[:cut]
    rest = "" if cut < 0 else body[cut:]
    return ("-" if negative else "") + whole.rjust(len(whole_part), "0") + rest


def _number_to_string(n: float) -> str:
    """``String(n)`` as JavaScript writes it: a whole number carries no decimal point."""
    if n == round(n) and abs(n) < 1e21:
        return str(int(n))
    return repr(n)


def _probability(raw: str, label: str) -> float:
    try:
        p = float(raw.strip())
    except ValueError:
        raise ValueError(f'{label}: probability "{raw}" must be a number in [0, 1]') from None
    if not math.isfinite(p) or p < 0 or p > 1:
        raise ValueError(f'{label}: probability "{raw}" must be a number in [0, 1]')
    return p

def is_spikeable(value: str) -> bool:
    """Whether ``spike`` would actually change this value: it is a finite number.

    Split out so the flag can be computed WITHOUT comparing before and after. That comparison
    looks equivalent and is not — ``0`` times any factor is still ``0``, and a row that really
    was spiked would come back unflagged.
    """
    try:
        n = float(value.strip())
    except (ValueError, AttributeError):
        return False
    return math.isfinite(n)
