"""What the carets cover.

The position a diagnostic carries is pinned by the shared fixtures; how much of the line it
underlines is not, and it is the difference between being shown the mistake and being shown where
to start looking. These are the two shapes a position ever has, and the two that would be easy to
get wrong.
"""

from __future__ import annotations

from tdcv2.errors.diagnostic import Diagnostic
from tdcv2.errors.render import format_diagnostic


def carets(source: str, line: int, column: int) -> str:
    text = format_diagnostic(
        Diagnostic.error("TDC000", "x", "", line, column), source, "t.tdc", False
    )
    marked = next((row for row in text.split("\n") if "^" in row), "")
    return marked.strip().lstrip("|").strip()


def test_a_value_is_underlined_to_its_closing_quote() -> None:
    source = '<gen type="number" value="notanumber"/>'
    assert carets(source, 1, 26) == "^" * len("notanumber")


def test_an_element_is_underlined_whole_children_and_all() -> None:
    # Not to the first ">": that would stop at the opening tag and leave the body — the part being
    # complained about — unmarked.
    source = "<block><line><data>${{Nope}}</data></line></block>"
    assert carets(source, 1, 13) == "^" * len("<data>${{Nope}}</data>")


def test_a_self_closing_element_stops_at_its_own_slash() -> None:
    source = '<sequence name="B"><gen type="file" row="k"/></sequence>'
    assert carets(source, 1, 19) == "^" * len('<gen type="file" row="k"/>')


def test_a_greater_than_inside_a_value_does_not_end_the_tag() -> None:
    source = '<data value="a>b"/>'
    assert carets(source, 1, 0) == "^" * len(source)


def test_a_comment_is_not_a_tag() -> None:
    # "<!--" starts with "<" and is not an element; underlining it whole would point at the comment
    # rather than at the empty document being complained about.
    assert carets("<!-- nothing here -->", 1, 0) == "^"


def test_a_position_past_the_end_of_the_line_still_renders() -> None:
    assert carets("<tdc/>", 1, 99) == "^"
