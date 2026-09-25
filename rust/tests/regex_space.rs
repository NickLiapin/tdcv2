//! How many different strings a regex pattern makes, against the shared fixture.
//!
//! `uniq="true"` over a `type="regex"` pattern refuses a count the pattern cannot meet before it
//! draws, and knows the pattern's size by counting its parse tree. That count decides which
//! configs are refused, so all five implementations are held to one set of numbers — including
//! the deliberate overcounts, which are the contract rather than a mistake.

mod common;

use tdcv2::generators::regex::{space_size, DEFAULT_MAX_LENGTH, SPACE_CAP};
use tdcv2::json::Value;

#[test]
fn saturates_at_the_same_ceiling() {
    let f = common::read_fixture("regex-space.json");
    assert_eq!(f.get("cap").and_then(Value::as_i64), Some(SPACE_CAP as i64));
}

#[test]
fn counts_the_space_the_reference_counts() {
    let f = common::read_fixture("regex-space.json");
    let patterns = f
        .get("patterns")
        .and_then(Value::as_array)
        .expect("patterns");
    for case in patterns {
        let pattern = case
            .get("pattern")
            .and_then(Value::as_str)
            .expect("pattern");
        let want = case.get("size").and_then(Value::as_i64).expect("size") as u64;
        let why = case.get("why").and_then(Value::as_str).unwrap_or("");
        let got = space_size(pattern, DEFAULT_MAX_LENGTH).expect("the pattern parses");
        assert_eq!(got, want, "{pattern} — {why}");
    }
}

#[test]
fn counts_an_advanced_pattern_the_way_the_reference_does() {
    let f = common::read_fixture("regex-space.json");
    let patterns = f
        .get("advanced")
        .and_then(Value::as_array)
        .expect("advanced");
    for case in patterns {
        let pattern = case
            .get("pattern")
            .and_then(Value::as_str)
            .expect("pattern");
        let want = case.get("size").and_then(Value::as_i64).expect("size") as u64;
        let why = case.get("why").and_then(Value::as_str).unwrap_or("");
        let got = tdcv2::generators::advanced_regex::space_size(pattern, DEFAULT_MAX_LENGTH)
            .expect("the pattern parses");
        assert_eq!(got, want, "{pattern} — {why}");
    }
}
