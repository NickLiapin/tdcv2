//! Writing a number the way the reference writes it.
//!
//! Every expected value in this file was taken from `node` running the same
//! expression, not from reading a specification. That matters here more than
//! anywhere else in the port: `toFixed` is where Rust and JavaScript disagree
//! *silently*, and a table written from memory would have agreed with my
//! memory rather than with the reference.

use tdcv2::numbers::{to_fixed, to_text};

#[test]
fn to_fixed_matches_javascript_on_the_cases_the_two_languages_disagree_about() {
    // `(v).toFixed(d)` in node, verbatim.
    let cases: &[(f64, usize, &str)] = &[
        // A true tie: JavaScript rounds away from zero, Rust's own formatter
        // rounds to even and would answer "0.2".
        (0.25, 1, "0.3"),
        (-0.25, 1, "-0.3"),
        (0.125, 2, "0.13"),
        (2.5, 0, "3"),
        (0.5, 0, "1"),
        (1.5, 0, "2"),
        (-2.5, 0, "-3"),
        (-0.5, 0, "-1"),
        // Not ties at all, though they are written as if they were. 1.005 is
        // held as 1.00499999999999989…, so it rounds DOWN — and a port that
        // rounded the printed "1.005" would answer 1.01 on every price column.
        (1.005, 2, "1.00"),
        (-1.005, 2, "-1.00"),
        (2.675, 2, "2.67"),
        (9.995, 2, "9.99"),
        (0.35, 1, "0.3"),
        (1.45, 1, "1.4"),
        (2.675, 1, "2.7"),
        // Carrying all the way into a new digit.
        (99.995, 2, "100.00"),
        // A negative that rounds to zero is not written "-0".
        (-0.0001, 2, "-0.00"),
        (0.0, 2, "0.00"),
        (1e-7, 0, "0"),
        (0.000001, 2, "0.00"),
        // Plain arithmetic, and the exact expansion of a double past the point
        // where a short decimal stops describing it.
        (1234.5678, 3, "1234.568"),
        (123_456_789.123_456_79, 6, "123456789.123457"),
        (0.1, 20, "0.10000000000000000555"),
        (0.333_333_333_333_333_3, 10, "0.3333333333"),
        (7.0, 0, "7"),
        (100.0, 0, "100"),
        (1e20, 2, "100000000000000000000.00"),
    ];

    for (value, decimals, want) in cases {
        assert_eq!(
            to_fixed(*value, *decimals),
            *want,
            "({value}).toFixed({decimals})"
        );
    }
}

#[test]
fn the_negative_zero_case_is_the_one_a_port_gets_backwards() {
    // JavaScript keeps the sign of the INPUT, not of the result — so a small
    // negative that rounds to nothing still prints "-0.00", while a value that
    // is genuinely zero prints "0.00".
    assert_eq!(to_fixed(-0.0001, 2), "-0.00");
    assert_eq!(to_fixed(-0.0, 2), "0.00");
    assert_eq!(to_fixed(0.0, 2), "0.00");
}

#[test]
fn to_text_writes_a_whole_number_without_a_point() {
    // `String(v)` in node, verbatim. Every diagnostic that quotes a number
    // compares as text, so "100.0" where the reference says "100" fails a
    // diagnostic case rather than a formatting one.
    let cases: &[(f64, &str)] = &[
        (0.0, "0"),
        (-0.0, "0"),
        (1.0, "1"),
        (100.0, "100"),
        (1.5, "1.5"),
        (-2.25, "-2.25"),
        (0.1, "0.1"),
        (0.333_333_333_333_333_3, "0.3333333333333333"),
    ];
    for (value, want) in cases {
        assert_eq!(to_text(*value), *want, "String({value})");
    }
    assert_eq!(to_text(f64::NAN), "NaN");
    assert_eq!(to_text(f64::INFINITY), "Infinity");
    assert_eq!(to_text(f64::NEG_INFINITY), "-Infinity");
}

#[test]
fn the_exact_expansion_is_exact_and_not_merely_long() {
    // 0.1 to twenty places shows the double's real value. A port that formatted
    // through an f64 intermediate loses this at about seventeen digits and
    // starts printing zeros, which looks plausible and is not the number.
    assert_eq!(to_fixed(0.1, 20), "0.10000000000000000555");
    assert_eq!(to_fixed(0.1, 30), "0.100000000000000005551115123126");

    // The smallest subnormal. Nothing in a config produces it; it is here
    // because it is the value that breaks an expansion built on the implicit
    // leading one.
    assert_eq!(
        to_fixed(f64::MIN_POSITIVE / 4_503_599_627_370_496.0, 0),
        "0"
    );
}
