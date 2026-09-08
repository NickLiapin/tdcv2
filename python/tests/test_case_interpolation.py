"""``${{Name}}`` inside a ``<case>`` — a case body that reads the row it is on.

The shared fixtures pin what it renders and the diagnostic a typo earns. What only lives here
is the pairing: a case is built for the SUBSET of rows that chose it, so an implementation
reading a position rather than an absolute row would pair the wrong values together and still
produce a plausible-looking file that no fixture line would catch.
"""

from __future__ import annotations

from tdcv2.tdc import TDC

NOW = 1777032000000  # 2026-04-23T12:00:00Z, the fixed instant every implementation shares

CITY = '<sequence name="City"><gen type="text" value="Alpha,Beta,Gamma"/></sequence>'


def lines(env: str, count: int, line: str, mode: str = "memory") -> list[str]:
    config = (
        f'<tdc><env count="{count}" seed="s" local="en" mode="{mode}">{env}</env>'
        f"<block><line><data>{line}</data></line></block></tdc>"
    )
    return str(TDC(config_string=config, now=NOW)).rstrip("\n").split("\n")


def test_a_case_body_pairs_each_row_with_its_own_value() -> None:
    env = (
        CITY + '<mix name="S" percent="50">'
        "<case><data>${{City}}/north</data></case>"
        "<case><data>${{City}}/south</data></case></mix>"
    )
    for row in lines(env, 12, "${{City}}|${{S}}"):
        city, composed = row.split("|")
        assert composed.startswith(f"{city}/"), row


def test_the_filters_a_line_may_use_work_here_too() -> None:
    env = (
        CITY + '<mix name="S" percent="0">'
        "<case><data>${{City}} plain</data></case>"
        "<case><data>${{City|upper}} loud</data></case></mix>"
    )
    for row in lines(env, 4, "${{S}}"):
        assert row.endswith(" loud")
        assert row.split(" ")[0].isupper()


def test_a_column_empty_on_this_row_renders_empty_not_marked() -> None:
    # A declared column with no value here is not the same thing as a name nobody declared:
    # printing the marker would read as a broken config rather than as an empty cell.
    env = (
        '<sequence name="K"><gen type="text" value="a,b" percent="50,50"/></sequence>'
        '<sequence name="Only" parent="K.a"><gen type="text" value="X"/></sequence>'
        '<mix name="S" percent="100"><case><data>[${{Only}}]</data></case>'
        "<case><data>never</data></case></mix>"
    )
    out = lines(env, 6, "${{S}}")
    assert set(out) <= {"[X]", "[]"}
    assert "[]" in out


def test_the_row_builtins_are_readable() -> None:
    env = (
        '<mix name="S" percent="100"><case><data>row ${{_count}}</data></case>'
        "<case><data>never</data></case></mix>"
    )
    assert lines(env, 3, "${{S}}") == ["row 1", "row 2", "row 3"]


def test_both_engines_answer_the_same_way() -> None:
    env = (
        CITY + '<mix name="S" percent="60">'
        "<case><data>${{City}} North</data></case>"
        "<case><data>${{City|upper}} South</data></case></mix>"
    )
    assert lines(env, 12, "${{S}}", "disk") == lines(env, 12, "${{S}}", "memory")


def test_plain_text_is_left_alone() -> None:
    env = (
        '<mix name="S" percent="100"><case><data>just text</data></case>'
        "<case><data>never</data></case></mix>"
    )
    assert lines(env, 2, "${{S}}") == ["just text", "just text"]
