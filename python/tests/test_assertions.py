"""``<assert>`` — the run refuses itself, on both engines.

The shared fixtures pin the assertions that HOLD, because a passing one is expressible as
output. What only lives here is the refusal: there is no shared shape for "this run stopped
with this message", and a refusal that fired in the reference and not here would be a silent
green tick on a config the reference calls broken.
"""

from __future__ import annotations

import pytest

from tdcv2.sequence.assertions import AssertionFailedError
from tdcv2.tdc import TDC

NOW = 1777032000000  # 2026-04-23T12:00:00Z, the fixed instant every implementation shares

KIND = '<sequence name="Kind"><gen type="text" value="a,b" percent="70,30"/></sequence>'
AMOUNT = '<sequence name="Amount" parent="Kind.a"><gen type="number" value="1..100"/></sequence>'
ROWS = '<sequence name="Rows"><gen type="stat" of="Amount" op="count"/></sequence>'


def run(env: str, count: int = 1000, mode: str = "") -> str:
    attrs = f' mode="{mode}"' if mode else ""
    config = (
        f'<tdc><env count="{count}" seed="s" local="en"{attrs}>{env}</env>'
        "<block><line><data>${{_count}}</data></line></block></tdc>"
    )
    return str(TDC(config_string=config, now=NOW))


def test_an_assertion_that_holds_says_nothing() -> None:
    run(f'{KIND}{AMOUNT}{ROWS}<assert that="Rows == 700" says="70% of rows carry an amount"/>')


def test_a_share_eaten_by_a_second_filter_is_caught() -> None:
    # The config still reads percent="70". Nothing in it states that only the gold rows get an
    # amount as well, so the surviving share is 42% and no other check has an opinion.
    tier = '<sequence name="Tier"><gen type="text" value="gold,plain" percent="60,40"/></sequence>'
    amount = (
        '<sequence name="Amount" parent="Kind.a">'
        '<gen type="number" value="1..100" if="Tier == \'gold\'"/></sequence>'
    )
    with pytest.raises(AssertionFailedError) as caught:
        run(f'{KIND}{tier}{amount}{ROWS}<assert that="Rows == 700" says="every a-row has one"/>')
    assert "every a-row has one" in str(caught.value)
    assert "Rows = 600" in str(caught.value)  # the number, not only the word "false"


def test_a_per_row_column_is_refused_rather_than_read_at_row_zero() -> None:
    with pytest.raises(AssertionFailedError) as caught:
        run(
            '<sequence name="Amount"><gen type="number" value="1..100"/></sequence>'
            '<assert that="Amount > 0" says="amounts are positive"/>'
        )
    assert "is not the same on every row" in str(caught.value)


def test_a_column_a_filter_leaves_empty_is_refused() -> None:
    with pytest.raises(AssertionFailedError) as caught:
        run(
            f'{KIND}<sequence name="Env" parent="Kind.a"><gen type="text" value="prod"/></sequence>'
            '<assert that="Env == \'prod\'" says="…"/>'
        )
    assert "is empty on some rows" in str(caught.value)


def test_a_one_value_column_is_accepted_because_the_rule_is_about_the_data() -> None:
    run(
        '<sequence name="Env"><gen type="text" value="prod"/></sequence>'
        '<assert that="Env == \'prod\'" says="built for production"/>'
    )


def test_total_is_readable_and_checked() -> None:
    run('<assert that="_total == 1000" says="a thousand rows"/>')
    with pytest.raises(AssertionFailedError):
        run('<assert that="_total == 999" says="off by one"/>')


@pytest.mark.parametrize("mode", ["memory", "disk"])
def test_the_refusal_does_not_depend_on_the_engine(mode: str) -> None:
    # An assertion that only held on one engine would be a check that depends on how the file
    # was produced, which is the opposite of what it is for.
    with pytest.raises(AssertionFailedError):
        run(
            '<sequence name="N"><gen type="number" value="1..9"/></sequence>'
            f'<assert that="_total == 99" says="{mode} must refuse too"/>',
            count=20,
            mode=mode,
        )


def test_an_undeclared_name_is_literal_text_not_a_column() -> None:
    # `prod` unquoted is how the expression language already reads an unknown name; refusing it
    # here would report a constancy problem about something that is not data.
    run(
        '<sequence name="Env"><gen type="text" value="prod"/></sequence>'
        '<assert that="Env == prod" says="…"/>'
    )
