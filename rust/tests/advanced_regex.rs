//! The advanced dialect: the same pattern subset, plus `(?%{70:RU;30:US})`.
//!
//! The property worth testing is the one that makes this a separate generator —
//! the share is EXACT. A test that only checked "roughly seventy per cent" would
//! pass on an independent per-row draw, which is precisely the implementation
//! this exists to avoid.

use std::collections::BTreeMap;

use tdcv2::generators::advanced_regex;
use tdcv2::prng;

fn gen(pattern: &str, count: usize, seed: &str) -> Vec<String> {
    let attrs: BTreeMap<String, String> = [("value".to_string(), pattern.to_string())]
        .into_iter()
        .collect();
    let mut prng = prng::create(seed);
    advanced_regex::generate(&attrs, count, 32, &mut prng)
        .unwrap_or_else(|e| panic!("{pattern:?}: {e}"))
}

fn refuse(pattern: &str) -> String {
    let attrs: BTreeMap<String, String> = [("value".to_string(), pattern.to_string())]
        .into_iter()
        .collect();
    let mut prng = prng::create("s");
    advanced_regex::generate(&attrs, 10, 32, &mut prng)
        .err()
        .unwrap_or_else(|| panic!("{pattern:?} should be refused"))
        .message()
        .to_string()
}

fn count_of(values: &[String], wanted: &str) -> usize {
    values.iter().filter(|v| *v == wanted).count()
}

#[test]
fn a_weighted_choice_is_an_exact_share_not_an_average() {
    // 1000 rows, 70/20/10. Not "about 700" — 700, from any seed. An independent
    // draw per row would land near it and miss it, which is the whole difference.
    for seed in ["a", "b", "c", "quota"] {
        let values = gen("(?%{70:RU;20:US;10:DE})", 1000, seed);
        assert_eq!(count_of(&values, "RU"), 700, "seed {seed}");
        assert_eq!(count_of(&values, "US"), 200, "seed {seed}");
        assert_eq!(count_of(&values, "DE"), 100, "seed {seed}");
    }
}

#[test]
fn the_seed_decides_which_rows_get_which_branch_not_how_many() {
    // Same quotas, different arrangement. That is the shape of an apportionment:
    // the counts are arithmetic, the order is random.
    let one = gen("(?%{50:A;50:B})", 40, "one");
    let two = gen("(?%{50:A;50:B})", 40, "two");
    assert_eq!(count_of(&one, "A"), 20);
    assert_eq!(count_of(&two, "A"), 20);
    assert_ne!(one, two, "two seeds should not arrange the column the same");
}

#[test]
fn a_remainder_is_apportioned_rather_than_dropped() {
    // 7 rows over thirds: 2.33, 2.33, 2.33. Every row still gets a branch, and
    // the extra one goes to a largest remainder rather than nowhere.
    let values = gen("(?%{33.34:A;33.33:B;33.33:C})", 7, "remainder");
    assert_eq!(values.len(), 7);
    let total = count_of(&values, "A") + count_of(&values, "B") + count_of(&values, "C");
    assert_eq!(total, 7, "{values:?}");
}

#[test]
fn a_branch_is_a_whole_pattern_and_may_hold_another_weighted_choice() {
    // The recursion is the point: a share of a share is still exact. 60% of 100
    // rows are +7, and 25% of those 60 read 495.
    let values = gen(
        "(?%{60:\\+7 (?%{25:495;75:701});40:\\+1 555})",
        100,
        "nested",
    );
    assert_eq!(values.len(), 100);
    let sevens: Vec<&String> = values.iter().filter(|v| v.starts_with("+7 ")).collect();
    assert_eq!(sevens.len(), 60);
    assert_eq!(sevens.iter().filter(|v| v.ends_with("495")).count(), 15);
    assert_eq!(count_of(&values, "+1 555"), 40);
}

#[test]
fn a_weighted_branch_can_be_any_pattern_including_a_quantified_one() {
    let values = gen("(?%{50:RU-[0-9]{4};50:US-[A-Z]{2}})", 20, "mixed");
    let russian: Vec<&String> = values.iter().filter(|v| v.starts_with("RU-")).collect();
    assert_eq!(russian.len(), 10);
    for v in &russian {
        assert_eq!(v.len(), 7, "{v}");
        assert!(v[3..].bytes().all(|b| b.is_ascii_digit()), "{v}");
    }
    for v in values.iter().filter(|v| v.starts_with("US-")) {
        assert_eq!(v.len(), 5, "{v}");
        assert!(v[3..].bytes().all(|b| b.is_ascii_uppercase()), "{v}");
    }
}

#[test]
fn percentages_that_do_not_sum_to_a_hundred_are_refused_by_name() {
    // The alternative is a silent renormalisation, which turns a typo into data
    // that looks right and is not what the config asked for.
    let message = refuse("(?%{70:A;20:B})");
    assert!(
        message.contains("sum to 90") && message.contains("expected 100"),
        "{message}"
    );
    assert!(refuse("(?%{})").contains("at least one branch"));
    // A comma where a semicolon belongs is not a separator, so the whole thing
    // reads as ONE branch — and the sum check is what catches it.
    assert!(refuse("(?%{50:A,50:B})").contains("sum to 50"));
    assert!(refuse("(?%{50:A;50:B)").contains("expected \";\" or \"}\""));
    assert!(refuse("(?%{x:A;100:B})").contains("invalid weighted choice percent"));
}

#[test]
fn the_plain_subset_still_applies_inside_the_advanced_dialect() {
    // Same finite-output discipline: no unbounded quantifiers, in either dialect.
    assert!(refuse("[0-9]+").contains("unbounded \"+\""));
    assert!(refuse("[0-9]*").contains("unbounded \"*\""));
    assert!(refuse("[0-9]{40}").contains("exceeds regex_max_length=32"));
}

#[test]
fn a_pattern_with_no_weighted_choice_is_not_routed_as_one() {
    // What the router asks. `(?%{` inside a character class is four ordinary
    // characters, and a pattern that merely fails to parse is not this
    // question's business.
    assert!(advanced_regex::has_weighted_choice("(?%{50:A;50:B})"));
    assert!(!advanced_regex::has_weighted_choice("[0-9]{3}"));
    assert!(!advanced_regex::has_weighted_choice(r"[(?%{]{4}"));
    assert!(!advanced_regex::has_weighted_choice("(?%{unparseable"));
}
