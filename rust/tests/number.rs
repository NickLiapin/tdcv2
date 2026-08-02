//! The number generator's own decisions, below the level the shared cases reach.
//!
//! The 23 shared cases pin the values. These pin the reasoning behind them —
//! particularly the two rules a port gets wrong quietly: how many draws a shape
//! costs, and where zero-padding comes from.

use std::collections::BTreeMap;

use tdcv2::generators::number;
use tdcv2::prng;

fn attrs(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
    pairs
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

fn gen(pairs: &[(&str, &str)], count: usize, seed: &str) -> Vec<String> {
    let mut prng = prng::create(seed);
    number::generate(&attrs(pairs), count, &mut prng).expect("generates")
}

#[test]
fn padding_comes_from_how_the_bounds_were_written_not_their_size() {
    // `00..99` pads and `0..99` does not, even though both can produce 7.
    let padded = gen(&[("value", "00..99")], 40, "pad");
    assert!(
        padded.iter().all(|v| v.len() == 2),
        "00..99 pads every value: {padded:?}"
    );

    let bare = gen(&[("value", "0..99")], 40, "pad");
    assert!(
        bare.iter().any(|v| v.len() == 1),
        "0..99 does not pad: {bare:?}"
    );
}

#[test]
fn a_single_length_choice_costs_no_draw() {
    // This is why `length="4"` can be added to a config without shifting every
    // column after it. Spending a draw to "choose" among one option would.
    let mut with_length = prng::create("s");
    number::generate(&attrs(&[("length", "4")]), 3, &mut with_length).unwrap();
    let after_length = with_length.next();

    // The same run with the width reached the other way: four digits drawn one
    // at a time is 12 draws either way, so what is left of the stream must match.
    let mut baseline = prng::create("s");
    for _ in 0..12 {
        baseline.next();
    }
    assert_eq!(after_length, baseline.next());
}

#[test]
fn a_single_range_costs_no_draw_to_choose_between_ranges() {
    let mut one = prng::create("s");
    number::generate(&attrs(&[("value", "1..9")]), 3, &mut one).unwrap();
    let after_one = one.next();

    let mut baseline = prng::create("s");
    for _ in 0..3 {
        baseline.next();
    }
    assert_eq!(
        after_one,
        baseline.next(),
        "one range: three values, three draws"
    );

    // Two ranges cost a second draw per value, to pick which one.
    let mut two = prng::create("s");
    number::generate(&attrs(&[("value", "[1..9],[20..30]")]), 3, &mut two).unwrap();
    let after_two = two.next();

    let mut baseline = prng::create("s");
    for _ in 0..6 {
        baseline.next();
    }
    assert_eq!(after_two, baseline.next());
}

#[test]
fn exclude_is_interval_arithmetic_and_not_enumeration() {
    // A billion values with one removed has to stay instant. If this ever became
    // a list, the test would not fail — it would hang, which is why the range is
    // this large.
    let values = gen(
        &[("value", "1..1000000000"), ("exclude", "7")],
        50,
        "exclude",
    );
    assert_eq!(values.len(), 50);
    assert!(values.iter().all(|v| v != "7"));
}

#[test]
fn include_and_exclude_compose_into_one_set_of_disjoint_intervals() {
    let values = gen(
        &[
            ("value", "1..5"),
            ("include", "20..22"),
            ("exclude", "3,21"),
        ],
        200,
        "sets",
    );
    let seen: std::collections::BTreeSet<&str> = values.iter().map(String::as_str).collect();
    let want: std::collections::BTreeSet<&str> =
        ["1", "2", "4", "5", "20", "22"].into_iter().collect();
    assert_eq!(seen, want, "(base ∪ include) − exclude");
}

#[test]
fn touching_intervals_join_so_the_draw_does_not_double_count() {
    // 1..3 and 4..6 are one run of six, not two runs the draw might weight
    // unevenly. Over enough rows an uneven weighting is visible; over few it is
    // not, which is why this is checked as a property rather than by eye.
    let values = gen(&[("value", "1..3"), ("include", "4..6")], 600, "join");
    let mut tally = BTreeMap::new();
    for v in &values {
        *tally.entry(v.clone()).or_insert(0usize) += 1;
    }
    assert_eq!(tally.len(), 6, "every value appears: {tally:?}");
    for (value, n) in &tally {
        assert!(
            *n > 40,
            "{value} appeared {n} times in 600 — the intervals are being weighted unevenly"
        );
    }
}

#[test]
fn a_range_emptied_by_exclude_says_so_rather_than_looping() {
    let mut prng = prng::create("s");
    let err = number::generate(
        &attrs(&[("value", "1..3"), ("exclude", "1..3")]),
        1,
        &mut prng,
    )
    .unwrap_err();
    assert!(
        err.message().contains("empty after include/exclude"),
        "{err}"
    );
}

#[test]
fn decimals_are_written_from_the_scaled_integer() {
    // Not by dividing and formatting the double: the value has exactly this many
    // places by construction, and rounding is where .NET, JavaScript and Rust
    // each pick a different rule for a tie.
    let values = gen(&[("value", "1..3"), ("decimals", "2")], 30, "dec");
    for v in &values {
        let (whole, frac) = v
            .split_once('.')
            .unwrap_or_else(|| panic!("no point in {v}"));
        assert_eq!(frac.len(), 2, "{v}");
        let n: f64 = v.parse().unwrap();
        assert!((1.0..=3.0).contains(&n), "{v} is outside 1..3");
        assert!(!whole.is_empty());
    }
}

#[test]
fn a_reversed_or_unreadable_range_is_refused_by_name() {
    for bad in ["9..1", "a..b", "1..", "[1..2],", "[1..2] [3..4]"] {
        let mut prng = prng::create("s");
        let result = number::generate(&attrs(&[("value", bad)]), 1, &mut prng);
        assert!(result.is_err(), "value={bad:?} should be refused");
    }
}

#[test]
fn bit_is_the_one_named_range() {
    let values = gen(&[("value", "bit")], 40, "bit");
    assert!(values.iter().all(|v| v == "0" || v == "1"), "{values:?}");
    assert!(values.iter().any(|v| v == "0") && values.iter().any(|v| v == "1"));
}
