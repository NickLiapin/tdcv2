"""The refusal a too-tight `<uniq>` gets, worded the same in all five implementations."""

from tdcv2.engine.exact_uniq import RepairNeededError

SENTENCE = (
    'uniq "A × B" is too tight to repair without holding the whole table '
    '({rows} couldn\'t be placed) — run without mode="stream" '
    "so the in-memory engine can arrange it."
)


def test_the_count_is_named_as_a_floor_when_the_verify_stopped_at_the_cap() -> None:
    """The scan stops as soon as it is past the cap, so it no longer knows the exact figure.

    Measured on a config that misses the cap by two orders of magnitude — 1,618,803 rows against
    20,000 — finishing the count took 6.79 s against 0.08 s to stop. What it gives up is the exact
    number, so the sentence stops claiming one.
    """
    error = RepairNeededError(20_000, '"A × B"', True)
    assert str(error) == SENTENCE.format(rows="more than 20000 rows")


def test_the_count_is_named_exactly_when_it_is_exact() -> None:
    assert str(RepairNeededError(1, '"A × B"')) == SENTENCE.format(rows="1 row(s)")
