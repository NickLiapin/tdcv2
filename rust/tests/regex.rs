//! The regex generator: what it accepts, what it refuses, and why the refusals
//! are the interesting half.
//!
//! Reading a pattern FORWARDS is a different job from matching one backwards,
//! and the difference shows up as a set of restrictions that no matching engine
//! has. Each of them exists so that a config cannot ask for a file of unbounded
//! size, and each is checked here.

use std::collections::BTreeMap;

use tdcv2::generators::regex;
use tdcv2::prng;

fn gen(pattern: &str, count: usize, seed: &str) -> Vec<String> {
    let attrs: BTreeMap<String, String> = [("value".to_string(), pattern.to_string())]
        .into_iter()
        .collect();
    let mut prng = prng::create(seed);
    regex::generate(&attrs, count, 32, &mut prng).unwrap_or_else(|e| panic!("{pattern:?}: {e}"))
}

fn refuse(pattern: &str) -> String {
    let attrs: BTreeMap<String, String> = [("value".to_string(), pattern.to_string())]
        .into_iter()
        .collect();
    let mut prng = prng::create("s");
    regex::generate(&attrs, 1, 32, &mut prng)
        .err()
        .unwrap_or_else(|| panic!("{pattern:?} should be refused"))
        .message()
        .to_string()
}

#[test]
fn a_pattern_produces_a_string_that_matches_its_shape() {
    for value in gen(r"[A-Z]{3}-[0-9]{4}", 20, "shape") {
        assert_eq!(value.len(), 8, "{value}");
        let bytes = value.as_bytes();
        assert!(bytes[..3].iter().all(u8::is_ascii_uppercase), "{value}");
        assert_eq!(bytes[3], b'-');
        assert!(bytes[4..].iter().all(u8::is_ascii_digit), "{value}");
    }
}

#[test]
fn an_unbounded_quantifier_is_refused_and_the_message_offers_the_bounded_form() {
    // Not a limitation to apologise for: a pattern with no ceiling is a request
    // for a file of unbounded size, and the run would only find that out at
    // render time. So the message names the replacement rather than only the
    // problem.
    assert!(refuse("[0-9]*").contains("{0,n}"));
    assert!(refuse("[0-9]+").contains("{1,n}"));
    assert!(refuse("[0-9]{2,}").contains("{n,m}"));
    assert!(refuse("[0-9]{2}?").contains("lazy"));
    assert!(refuse("[0-9]{2}{3}").contains("stacked"));
    assert!(refuse("*abc").contains("no target"));
}

#[test]
fn the_longest_possible_output_is_checked_before_a_single_value_is_made() {
    // 40 characters against the default ceiling of 32. Checked on the TREE, so
    // it costs nothing at render time and cannot be reached by an unlucky draw.
    let message = refuse("[A-Z]{40}");
    assert!(message.contains("40 characters"), "{message}");
    assert!(message.contains("regex_max_length=32"), "{message}");

    // The tag's own limit wins over the document's, which is how a pack ships a
    // 36-character UUID pattern without every config raising its ceiling.
    let attrs: BTreeMap<String, String> = [
        ("value".to_string(), "[A-Z]{40}".to_string()),
        ("regex_max_length".to_string(), "64".to_string()),
    ]
    .into_iter()
    .collect();
    let mut prng = prng::create("s");
    assert!(regex::generate(&attrs, 1, 32, &mut prng).is_ok());
}

#[test]
fn what_is_deliberately_absent_says_so_rather_than_misbehaving() {
    assert!(refuse(r"\p{L}").contains("Unicode property"));
    assert!(refuse("(?=abc)x").contains("lookaround"));
    assert!(refuse(r"a\n").contains("multiline"));
    assert!(refuse("[]").contains("empty character class"));
    assert!(refuse("[z-a]").contains("invalid character range"));
    assert!(refuse(r"\a{nosuch}").contains("unknown alphabet"));
    assert!(refuse(r"(a)\2").contains("not generated yet"));
}

#[test]
fn a_backreference_repeats_what_its_group_produced() {
    for value in gen(r"([A-Z]{2})-\1", 20, "backref") {
        let (left, right) = value.split_once('-').expect("a dash");
        assert_eq!(left, right, "{value}");
    }
}

#[test]
fn a_dot_is_printable_ascii_and_not_almost_anything() {
    // Which is the whole difference between generating and matching: `.` in a
    // matcher means "any character except a newline", and generating from that
    // would put control codes and unassigned code points into a data file.
    let values = gen(".{6}", 60, "dot");
    for value in &values {
        assert!(
            value.bytes().all(|b| (0x20..=0x7e).contains(&b)),
            "{value:?} has a byte outside printable ASCII"
        );
    }
}

#[test]
fn a_named_alphabet_is_a_written_down_range_and_not_a_unicode_property() {
    // The reason the escape exists at all. A property table ships with the
    // runtime and changes between versions of it, so `\p{Cyrillic}` would draw a
    // different set after an upgrade — and two languages' runtimes would never
    // agree with each other in the first place.
    let values = gen(r"\a{cyrillic.ru.lower}{4}", 40, "cyr");
    for value in &values {
        assert_eq!(value.chars().count(), 4, "{value}");
        assert!(
            value.chars().all(|c| ('а'..='я').contains(&c) || c == 'ё'),
            "{value} is not Russian lower case"
        );
    }

    let roman = gen(r"\a{roman.upper}{3}", 30, "rom");
    for value in &roman {
        assert!(value.chars().all(|c| "IVXLCDM".contains(c)), "{value}");
    }
}

#[test]
fn an_anchor_contributes_nothing_because_the_value_is_the_whole_string() {
    // `^` and `$` match a POSITION, and a generated value has nothing on either
    // side of it — so both are already true and neither emits a character.
    assert_eq!(gen("^abc$", 1, "anchor"), vec!["abc".to_string()]);
}

#[test]
fn a_class_keeps_first_occurrence_order_so_a_draw_index_means_the_same_thing() {
    // Duplicates are removed and the FIRST occurrence is kept. The order of the
    // list is what a draw index selects, so re-ordering it silently re-maps every
    // value the same seed used to produce.
    let a = gen("[abcabc]{8}", 5, "order");
    let b = gen("[abc]{8}", 5, "order");
    assert_eq!(a, b, "a duplicate in a class must not shift the draw");
}
