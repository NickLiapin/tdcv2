//! Print the diagnostic codes this crate reports for each config in a corpus.
//!
//! Exists so `fixtures/parity/audit.py` can compare Rust with the other four
//! before the Rust CLI does. The audit runs each implementation's `check`
//! command and diffs the set of codes; this is that command's answer, without
//! the command.
//!
//! Usage: cargo run --example parity_codes -- corpus.json
//! where corpus.json is `{"case name": "<tdc>…</tdc>", …}`.

use std::collections::BTreeSet;

use tdcv2::json::{self, Value};
use tdcv2::{packs::DataPacks, parser, validator};

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: parity_codes <corpus.json>");
    let text = std::fs::read_to_string(&path).expect("cannot read the corpus");
    let Value::Object(cases) = json::parse(&text).expect("corpus is not JSON") else {
        panic!("corpus must be an object of name -> config");
    };

    for (name, config) in cases {
        let config = config.as_str().unwrap_or_default();
        let parsed = parser::parse(config);
        // Rediscovered per case rather than shared: the packs are read-only and
        // this runs 43 times, so the simpler code wins over the faster one.
        let codes: BTreeSet<String> =
            validator::validate_with(&parsed.tree, DataPacks::discover().ok())
                .iter()
                .map(|d| d.code.clone())
                .collect();
        println!(
            "{name}\t{}",
            codes.into_iter().collect::<Vec<_>>().join(",")
        );
    }
}
