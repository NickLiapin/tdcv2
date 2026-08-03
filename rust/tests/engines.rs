//! The other two scoreboards: what the STREAMING and the EXACT-ON-DISK engines
//! produce for every shared case.
//!
//! `engines.json` records what the reference produces on each, and its lines
//! MATCH the `expected` in the cases themselves — all three engines agree on one
//! seed. Checked here per engine anyway, because that agreement is the property
//! at stake: an engine that quietly drew in its own order would still look
//! self-consistent, and only a comparison against the reference catches it.
//!
//! Every case is forced onto the engine under test, including the ones the
//! router would send elsewhere. That is deliberate: the fixture holds an answer
//! for each of them, and a config that reaches an engine by any route has to
//! render the same bytes.

mod common;

use std::collections::BTreeMap;

use common::{all_cases, config_of, now_of, print_excused, Case};
use tdcv2::engine::{self, EngineError};
use tdcv2::json::Value;

/// What the reference does with a case on one engine.
///
/// A refusal is an answer too. Skipping those cases used to hide the other half
/// of the contract: an engine that happily rendered what the reference declines
/// to render is as wrong as one that renders the wrong bytes, and nothing here
/// would have said so.
enum Expected {
    Lines(String),
    Refused,
}

/// The reference's answer on one engine, keyed by `group/name`.
fn expected_on(engine: &str) -> BTreeMap<String, Expected> {
    let fixture = common::read_fixture("engines.json");
    let mut result = BTreeMap::new();
    let Some(cases) = fixture.get("cases").and_then(Value::as_object) else {
        panic!("engines.json has no cases");
    };
    for (name, node) in cases {
        let Some(on_engine) = node.get(&format!("engine{engine}")) else {
            continue;
        };
        if let Some(lines) = on_engine.get("lines").and_then(Value::as_array) {
            let mut text = String::new();
            for line in lines {
                text.push_str(line.as_str().unwrap_or_default());
                text.push('\n');
            }
            result.insert(name.clone(), Expected::Lines(text));
        } else if on_engine.get("refused").is_some() {
            result.insert(name.clone(), Expected::Refused);
        }
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
        expected.len() >= 120,
        "only {} expectations for engine {which} — the fixture moved",
        expected.len()
    );

    let mut matched = 0usize;
    let mut not_yet: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut wrong: Vec<String> = Vec::new();

    for case in &all_cases() {
        let Some(want) = expected.get(&case.name) else {
            continue;
        };
        let produced = render_on(case, which);
        // WHAT is refused is the contract; how each language phrases it is not,
        // so any error counts and an `Unsupported` is not excused here — the
        // reference declines this case, and declining it is the right answer.
        if matches!(want, Expected::Refused) {
            match produced {
                Err(_) => matched += 1,
                Ok(_) => wrong.push(format!(
                    "{}\n     want: refused\n      got: output",
                    case.name
                )),
            }
            continue;
        }
        let Expected::Lines(want) = want else {
            unreachable!("handled above")
        };
        match produced {
            Err(EngineError::Unsupported(what)) => {
                not_yet.entry(what).or_default().push(case.name.clone());
            }
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

    let missing: usize = not_yet.values().map(Vec::len).sum();
    println!(
        "engine {which}: {matched} match the reference, {missing} not ported yet, {} wrong",
        wrong.len()
    );
    print_excused(&not_yet);
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
