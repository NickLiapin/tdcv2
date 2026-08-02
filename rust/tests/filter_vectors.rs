//! The formatting layer, against the reference's own vectors.
//!
//! The layer is shared by three places that mean the same thing — the `case=`
//! attribute, the compute tags and the `${{Name|filter}}` syntax — so one of
//! them drifting shows up in all of them. These vectors pin the answer once,
//! which is why the fixture exists rather than each caller carrying its own
//! expectations.
//!
//! Note what an UNKNOWN filter does: it passes the value through untouched. That
//! is deliberate, and the validator is what complains about it (TDC192) — a
//! formatting layer that threw here would turn a typo into a crash halfway
//! through a run instead of a diagnostic before it starts.

mod common;

use tdcv2::format::{mask, transforms};
use tdcv2::json::Value;

fn apply(kind: &str, arg: &str, input: &str) -> String {
    if kind == "mask" {
        return mask::apply(arg, input).unwrap_or_else(|e| panic!("mask {arg:?}: {e}"));
    }
    if transforms::is_case_transform(kind) {
        return transforms::apply_case(kind, input);
    }
    let argument = (!arg.is_empty()).then_some(arg);
    transforms::apply_filter(kind, argument, input)
        .unwrap_or_else(|e| panic!("{kind}({arg:?}): {e}"))
}

#[test]
fn every_filter_vector_matches_the_reference() {
    let fixture = common::read_fixture("filter-vectors.json");
    let vectors = fixture
        .get("vectors")
        .and_then(Value::as_array)
        .expect("the fixture has vectors");
    assert!(vectors.len() >= 25, "only {} vectors", vectors.len());

    let text = |node: &Value, key: &str| {
        node.get(key)
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string()
    };

    let mut checked = 0;
    for vector in vectors {
        let (kind, arg, input, expected) = (
            text(vector, "kind"),
            text(vector, "arg"),
            text(vector, "input"),
            text(vector, "expected"),
        );
        assert_eq!(
            apply(&kind, &arg, &input),
            expected,
            "{kind}({arg:?}) over {input:?}"
        );
        checked += 1;
    }
    println!("filter vectors: {checked} match the reference");
}
