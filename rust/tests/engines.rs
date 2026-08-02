//! The other two scoreboards: what the STREAMING and the EXACT-ON-DISK engines
//! produce for every shared case.
//!
//! The engines draw in different orders, so engine 1 and engine 2 do not agree
//! on the same seed — and are not meant to. `engines.json` records what the
//! reference produces on each, which makes them separate contracts with the same
//! standard: match byte for byte, or refuse by name.
//!
//! Every case is forced onto the engine under test, including the ones the
//! router would send elsewhere. That is deliberate: the fixture holds an answer
//! for each of them, and a config that reaches an engine by any route has to
//! render the same bytes.

mod common;

use std::collections::BTreeMap;

use common::{all_cases, config_of, now_of, Case};
use tdcv2::engine::{self, EngineError};
use tdcv2::json::Value;

/// The reference's output on one engine, keyed by `group/name`.
fn expected_on(engine: &str) -> BTreeMap<String, String> {
    let fixture = common::read_fixture("engines.json");
    let mut result = BTreeMap::new();
    let Some(cases) = fixture.get("cases").and_then(Value::as_object) else {
        panic!("engines.json has no cases");
    };
    for (name, node) in cases {
        let Some(lines) = node
            .get(&format!("engine{engine}"))
            .and_then(|e| e.get("lines"))
            .and_then(Value::as_array)
        else {
            continue;
        };
        let mut text = String::new();
        for line in lines {
            text.push_str(line.as_str().unwrap_or_default());
            text.push('\n');
        }
        result.insert(name.clone(), text);
    }
    result
}

fn render_on(case: &Case, engine: &str) -> Result<String, EngineError> {
    let config = config_of(case)?.with_engine(engine);
    engine::render(&config, now_of(case)?)
}

#[test]
fn no_shared_case_streams_something_other_than_the_reference() {
    check_engine("2");
}

#[test]
fn no_shared_case_is_exact_on_disk_in_a_way_the_reference_is_not() {
    check_engine("3");
}

fn check_engine(which: &str) {
    let expected = expected_on(which);
    assert!(
        expected.len() >= 90,
        "only {} engine-2 expectations — the fixture moved",
        expected.len()
    );

    let mut matched = 0usize;
    let mut not_yet: BTreeMap<String, usize> = BTreeMap::new();
    let mut wrong: Vec<String> = Vec::new();

    for case in &all_cases() {
        let Some(want) = expected.get(&case.name) else {
            continue;
        };
        match render_on(case, which) {
            Err(EngineError::Unsupported(what)) => *not_yet.entry(what).or_default() += 1,
            Err(EngineError::Invalid(why)) => wrong.push(format!("{}: {why}", case.name)),
            Ok(actual) if actual == *want => matched += 1,
            Ok(actual) => wrong.push(format!(
                "{}\n     want: {:?}\n      got: {:?}",
                case.name,
                first_line(want),
                first_line(&actual)
            )),
        }
    }

    let missing: usize = not_yet.values().sum();
    println!(
        "engine {which}: {matched} match the reference, {missing} not ported yet, {} wrong",
        wrong.len()
    );
    let mut ranked: Vec<(&String, &usize)> = not_yet.iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
    for (what, n) in ranked {
        println!("  {n:3}  {what}");
    }
    for w in wrong.iter().take(10) {
        println!("  wrong: {w}");
    }

    assert!(
        wrong.is_empty(),
        "engine {which}: {} case(s) render something other than the reference",
        wrong.len()
    );
    assert!(matched > 0, "engine {which}: no case renders correctly yet");
}

fn first_line(text: &str) -> &str {
    text.split('\n').next().unwrap_or("")
}
