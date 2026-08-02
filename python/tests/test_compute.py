"""The compute layer and the ``if`` expression language."""

from __future__ import annotations

import pytest

from tdcv2.compute import ComputeError, evaluate
from tdcv2.compute.encode import encode_char
from tdcv2.compute.value import euclidean_mod, floor_div, guard64, parse_int_strict
from tdcv2.expr import as_condition
from tdcv2.expr.parse import Binary, Name, Num, parse
from tdcv2.parser import facade


def _compute(body: str, fields: dict[str, str] | None = None) -> str:
    """A ``<compute>`` body evaluated the way a sequence would evaluate it."""
    config = (
        f'<tdc><env count="1"><sequence name="V"><compute>{body}</compute></sequence></env>'
        "<block><line><data>x</data></line></block></tdc>"
    )
    element = _find_compute(facade.parse(config).tree)
    assert element is not None
    return evaluate(element, (fields or {}).get)


def _find_compute(document):
    found = []

    def walk(node):
        opener = node.openCloseElement()
        if opener is None:
            return
        if opener.name.text == "compute":
            found.append(opener)
            return
        content = opener.content()
        if content is not None:
            for child in content.element() or []:
                walk(child)

    for child in document.element() or []:
        walk(child)
    return found[0] if found else None


# ── arithmetic ──────────────────────────────────────────────────────────────────────────────


def test_the_remainder_is_never_negative() -> None:
    # Languages disagree about the sign of % for negative operands, and a check digit computed
    # with the wrong sign is wrong everywhere the number is later validated.
    assert euclidean_mod(-7, 3) == 2
    assert euclidean_mod(7, -3) == 1
    assert floor_div(-7, 3) == -3


def test_the_shared_case_for_signed_arithmetic() -> None:
    body = (
        "<result><concat>"
        '<mod><int v="-7"/><int v="3"/></mod><str v=" "/>'
        '<mod><int v="7"/><int v="-3"/></mod><str v=" "/>'
        '<divide><int v="-7"/><int v="3"/></divide>'
        "</concat></result>"
    )
    assert _compute(body) == "2 1 -3"


def test_dividing_by_zero_names_which_child() -> None:
    with pytest.raises(ComputeError, match="divisor"):
        _compute('<result><divide><int v="1"/><int v="0"/></divide></result>')


def test_an_overflow_is_an_error_rather_than_a_silent_wrap() -> None:
    with pytest.raises(ComputeError, match="signed 64-bit"):
        guard64(2**63)


# ── strings and padding ─────────────────────────────────────────────────────────────────────


def test_padding_and_length_match_the_reference() -> None:
    body = (
        '<let name="s"><str v="42"/></let>'
        '<result><concat><pad width="6"><var name="s"/></pad><str v="|"/>'
        '<pad width="6" fill="*"><var name="s"/></pad><str v="|"/>'
        '<length><str v="hello"/></length></concat></result>'
    )
    assert _compute(body) == "000042|****42|5"


def test_a_binding_is_visible_to_the_bindings_after_it() -> None:
    body = (
        '<let name="a"><int v="2"/></let>'
        '<let name="b"><multiply><var name="a"/><int v="3"/></multiply></let>'
        '<result><var name="b"/></result>'
    )
    assert _compute(body) == "6"


def test_an_unbound_variable_is_named() -> None:
    with pytest.raises(ComputeError, match='"nope" is not bound'):
        _compute('<result><var name="nope"/></result>')


# ── iteration ───────────────────────────────────────────────────────────────────────────────


def test_reduce_folds_encoded_characters() -> None:
    body = (
        "<result><reduce>"
        '<over><field name="Code"/></over><init><int v="0"/></init>'
        '<do><add><acc/><to_number><encode as="base36"><current/></encode></to_number></add></do>'
        "</reduce></result>"
    )
    assert _compute(body, {"Code": "AB12"}) == "24"


def test_each_maps_and_join_puts_it_back_together() -> None:
    body = (
        '<result><join sep="-"><each><over><str v="abc"/></over>'
        "<do><upper><current/></upper></do></each></join></result>"
    )
    assert _compute(body) == "A-B-C"


def test_the_position_is_readable_inside_an_iteration() -> None:
    body = (
        '<result><join sep=","><each><over><str v="ab"/></over>'
        "<do><current_index/></do></each></join></result>"
    )
    assert _compute(body) == "0,1"


def test_the_iteration_values_do_not_exist_outside_one() -> None:
    with pytest.raises(ComputeError, match="outside an iteration"):
        _compute("<result><current/></result>")
    with pytest.raises(ComputeError, match="outside a <reduce>"):
        _compute("<result><acc/></result>")


# ── indexing and conditionals ───────────────────────────────────────────────────────────────


def test_an_index_past_the_end_falls_back_when_told_to() -> None:
    body = (
        '<result><at default="0"><in><list v="3,1,4"/></in>'
        '<index><int v="9"/></index></at></result>'
    )
    assert _compute(body) == "0"


def test_an_index_past_the_end_with_no_default_is_an_error() -> None:
    body = '<result><at><in><list v="3,1,4"/></in><index><int v="9"/></index></at></result>'
    with pytest.raises(ComputeError, match="out of range"):
        _compute(body)


def test_choose_takes_the_first_branch_that_holds() -> None:
    body = (
        "<result><choose>"
        '<when><test><is_digit><str v="7"/></is_digit></test><then><str v="digit"/></then></when>'
        '<otherwise><str v="other"/></otherwise></choose></result>'
    )
    assert _compute(body) == "digit"


def test_choose_with_nothing_matching_and_no_otherwise_is_an_error() -> None:
    body = (
        "<result><choose><when><test>"
        '<equals><int v="1"/><int v="2"/></equals>'
        '</test><then><str v="x"/></then></when></choose></result>'
    )
    with pytest.raises(ComputeError, match="no <when> matched"):
        _compute(body)


# ── coercion ────────────────────────────────────────────────────────────────────────────────


def test_a_multi_digit_string_in_arithmetic_says_to_convert_it() -> None:
    # Reading a digit out of a number and adding it is the whole job, so one digit converts. A
    # longer string has to say <to_number>, or "the third character" and "the number 375" would
    # be the same thing.
    with pytest.raises(ComputeError, match="<to_number>"):
        _compute('<result><add><str v="375"/><int v="1"/></add></result>')


def test_a_single_digit_string_converts_by_itself() -> None:
    assert _compute('<result><add><str v="7"/><int v="1"/></add></result>') == "8"


def test_a_list_can_never_be_the_result() -> None:
    with pytest.raises(ComputeError, match="not a list"):
        _compute('<result><list v="1,2"/></result>')


def test_to_number_refuses_what_is_not_one() -> None:
    with pytest.raises(ComputeError, match="not a valid integer"):
        parse_int_strict("12a")


# ── encoding ────────────────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("ch", "as_what", "expected"),
    [
        ("A", "base36", "10"),
        ("z", "base36", "35"),
        ("7", "base36", "7"),
        ("A", "ascii", "65"),
        ("A", "unicode", "65"),
        ("A", "hex", "41"),
        ("A", "binary", "1000001"),
        ("A", "octal", "101"),
    ],
)
def test_a_character_encodes_the_way_the_reference_encodes_it(
    ch: str, as_what: str, expected: str
) -> None:
    assert encode_char(ch, as_what) == expected


def test_a_non_ascii_character_is_refused_under_ascii() -> None:
    with pytest.raises(ComputeError, match="not an ASCII character"):
        encode_char("Ж", "ascii")


def test_an_unknown_encoding_lists_the_ones_that_exist() -> None:
    with pytest.raises(ComputeError, match="base36, ascii, unicode"):
        encode_char("A", "rot13")


# ── if expressions ──────────────────────────────────────────────────────────────────────────


VALUES = {"Gender": "Male", "_count": "5", "_last": "false", "N": "12", "Person.City": "Praha"}


def _holds(expr: str) -> bool:
    return as_condition(expr, lambda name: name in VALUES, lambda name: VALUES[name])


@pytest.mark.parametrize(
    ("expr", "expected"),
    [
        ("Gender == Male", True),
        ("Gender == Female", False),
        # `A.B` where A is a sequence reads as "is A currently B?", the way parent= reads.
        ("Gender.Male", True),
        ("Gender.Female", False),
        # A compound field is looked up by its whole dotted name first.
        ("Person.City == Praha", True),
        # _count arrives as text; a number on the other side compares numerically.
        ("_count == 5", True),
        # "false" is the one falsy non-empty string, which is what makes !_last work.
        ("!_last", True),
        ("N > 10 && N < 20", True),
        ("N > 10 && N < 12", False),
        ("(N + 1) == 13", True),
        ("N / 4 == 3", True),
        ("N % 5 == 2", True),
        ("-N == -12", True),
        ("'quoted' == quoted", True),
        ("true || false", True),
        # An unknown name is its own text, which is what lets a bare word be a value.
        ("Unknown == Unknown", True),
    ],
)
def test_an_if_expression_matches_the_reference(expr: str, expected: bool) -> None:
    assert _holds(expr) is expected


def test_precedence_is_the_reference_parsers_precedence() -> None:
    # `a == b && c` binds as `(a == b) && c`. Getting this wrong changes which rows appear, and
    # no test of a single value would catch it.
    assert isinstance(parse("a == b && c"), Binary)
    tree = parse("a == b && c")
    assert isinstance(tree, Binary)
    assert tree.op == "&&"
    assert isinstance(tree.left, Binary)
    assert tree.left.op == "=="


def test_a_negative_number_reads_as_a_number_not_a_negation() -> None:
    tree = parse("-5")
    assert isinstance(tree, Num)
    assert tree.value == -5


def test_a_bare_word_is_a_name() -> None:
    assert parse("Male") == Name("Male")


@pytest.mark.parametrize("expr", ["(1 + 2", "'unterminated", "1 +", "a[0", "1 $$ 2"])
def test_a_malformed_expression_is_refused(expr: str) -> None:
    with pytest.raises(ValueError, match="if expression"):
        parse(expr)
