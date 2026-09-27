//! The object a finished run hands back answers to the SAME names in all five
//! implementations.
//!
//! There was no guard on this surface and it drifted: Python had no `to_string`,
//! Java no `toArray`, C# neither `GetAt` nor `Iterate`, Rust neither `to_array`
//! nor `get_at`. Each was reasonable in its own language and wrong for a reader
//! crossing between them — which is the only way this library is ever read,
//! because it exists to be used beside the generator.
//!
//! Rust has no reflection, so this test proves the names two ways at once: the
//! calls below will not COMPILE if a name goes missing, and the list is checked
//! against the shared fixture so a rename cannot quietly leave the other four
//! behind.

mod common;

use tdcv2::json::Value;
use tdcv2::Tdc;

/// Every `rust` spelling this test actually calls, in fixture order.
const CALLED: [&str; 9] = [
    "to_string",
    "to_array",
    "iterate",
    "get_at",
    "to_columns",
    "write_file",
    "seed_info",
    "preflight",
    "count",
];

#[test]
fn the_shared_names_are_the_ones_this_crate_answers_to() {
    let fixture = common::read_fixture("api.json");
    let members = match fixture.get("members") {
        Some(Value::Array(items)) => items,
        _ => panic!("api.json has no members array"),
    };
    // A fixture that says nothing would let the comparison below pass by saying nothing.
    assert!(members.len() > 5, "the vocabulary is not empty");

    let named: Vec<String> = members
        .iter()
        .map(|m| match m.get("rust") {
            Some(Value::String(s)) => s.clone(),
            _ => panic!("a member with no rust spelling"),
        })
        .collect();
    assert_eq!(
        named, CALLED,
        "api.json and this test disagree about the names"
    );
}

#[test]
fn every_name_in_the_list_is_a_real_method() {
    let config = "<tdc><env count=\"3\" seed=\"s\" local=\"en\"><sequence name=\"N\">\
                  <gen type=\"increment\" value=\"1\"/></sequence></env><block><line>\
                  <data>${{N}}</data></line></block></tdc>";
    let tdc = Tdc::from_string(config).expect("the config is valid");

    // Each line is one entry in CALLED. The compiler is the assertion: a renamed
    // method breaks the build here, which is louder than a test that skips.
    assert_eq!(tdc.to_string(), "1\n2\n3\n");
    assert_eq!(tdc.to_array().len(), 3);
    assert_eq!(tdc.iterate().count(), 3);
    assert!(tdc.get_at(1).is_some());
    assert!(tdc.to_columns().iter().any(|(name, _)| name == "N"));
    // Written to a real path rather than merely named: a generic method is not proved to exist
    // by being mentioned, and this also checks that the shared name does the shared thing.
    let target = std::env::temp_dir().join("tdcv2-api-vocabulary.txt");
    tdc.write_file(&target).expect("the temp dir is writable");
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "1\n2\n3\n");
    let _ = std::fs::remove_file(&target);
    assert!(!tdc.seed_info().value.is_empty());
    let _ = tdc.preflight(true);
    assert_eq!(tdc.count(), 3);
}

/// A failing `<assert each=>` stops every reader. Here a `Tdc` IS the finished
/// run — the rows are made, and checked, when it is created — so the refusal
/// arrives at creation and no reader is ever handed a row that failed. The
/// fixture's readers are all covered by that one refusal; the test still names
/// them, so a reader added to the fixture must be thought about here too.
#[test]
fn a_failing_each_assertion_stops_every_reader() {
    let fixture = common::read_fixture("api.json");
    let rule = fixture
        .get("everyReaderKeepsEachAssert")
        .expect("api.json has the each= rule");
    let text = |key: &str| match rule.get(key) {
        Some(Value::String(s)) => s.clone(),
        _ => panic!("the rule has no {key}"),
    };
    let readers = match rule.get("readers") {
        Some(Value::Array(items)) => items,
        _ => panic!("the rule has no readers"),
    };
    const KNOWN: [&str; 5] = [
        "the whole run as text",
        "every record, materialised",
        "every record, one at a time",
        "one record by position",
        "the run as columns rather than rows",
    ];
    for reader in readers {
        let concept = match reader.get("concept") {
            Some(Value::String(s)) => s.clone(),
            _ => panic!("a reader with no concept"),
        };
        assert!(
            KNOWN.contains(&concept.as_str()),
            "no reader mapped for {concept}"
        );
    }
    match Tdc::from_string(text("config")) {
        Ok(_) => panic!("a run whose rows fail their own each= was handed out"),
        Err(e) => {
            let message = e.to_string();
            assert!(
                message.contains(&text("message")),
                "expected {:?}, got {message:?}",
                text("message")
            );
        }
    }
}
