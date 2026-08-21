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
const CALLED: [&str; 8] = [
    "to_string",
    "to_array",
    "iterate",
    "get_at",
    "to_columns",
    "write_file",
    "seed_info",
    "preflight",
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
    assert_eq!(named, CALLED, "api.json and this test disagree about the names");
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
}
