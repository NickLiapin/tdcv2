//! The shared cases: the same configs and expected output the other four answer to.
//!
//! A case either matches the reference byte for byte or it does not; there is no
//! partial credit. What this port has not reached yet comes back as
//! [`EngineError::Unsupported`] and is counted separately — a feature that says
//! it is missing is a different thing from a feature that quietly produces the
//! wrong column, and only the second is a failure.
//!
//! The progress number is printed rather than asserted, because it will keep
//! moving. What IS asserted is that nothing regresses: no case may produce
//! output that differs from the reference.

mod common;

use std::collections::BTreeMap;

use common::{all_cases, print_excused, render};
use tdcv2::engine::EngineError;

#[test]
fn no_shared_case_renders_something_other_than_the_reference() {
    let cases = all_cases();
    assert!(
        cases.len() >= 100,
        "only {} cases — the corpus moved",
        cases.len()
    );

    let mut matched = 0usize;
    let mut not_yet: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut wrong: Vec<String> = Vec::new();

    for case in &cases {
        match render(case) {
            Err(EngineError::Unsupported(what)) => {
                not_yet.entry(what).or_default().push(case.name.clone());
            }
            Err(EngineError::Invalid(why)) => {
                // Not a missing feature: the engine rejected a config the
                // reference accepts, which is a defect however it is phrased.
                wrong.push(format!("{}: {why}", case.name));
            }
            Ok(actual) if actual == case.expected => matched += 1,
            Ok(actual) => wrong.push(format!(
                "{}\n     want: {:?}\n      got: {:?}",
                case.name,
                first_line(&case.expected),
                first_line(&actual)
            )),
        }
    }

    let missing: usize = not_yet.values().map(Vec::len).sum();
    println!(
        "shared cases: {matched} match the reference, {missing} not ported yet, {} wrong",
        wrong.len()
    );
    print_excused(&not_yet);
    for w in wrong.iter().take(10) {
        println!("  wrong: {w}");
    }

    assert!(
        wrong.is_empty(),
        "{} case(s) render something other than the reference",
        wrong.len()
    );
    assert!(matched > 0, "no shared case matches yet");
}

fn first_line(text: &str) -> &str {
    text.split('\n').next().unwrap_or("")
}
