//! The captured baselines: parse, generate, render, compare bytes.
//!
//! The other four implementations have had this test since they were ported;
//! this crate did not, and the gap was not theoretical — it hid a column of
//! e-mail domains that had drifted from the reference. `shared_cases.rs` reads
//! `cases/*.json`, which is a different corpus: those are small configs written
//! to pin one behaviour each. These ten are whole documents, output formats and
//! all, and they are the ones that catch a defect in how the pieces meet.
//!
//! The fixture list comes from the manifest every implementation reads, never
//! from a list typed here. A typed list drifts in silence: a fixture added for
//! the reference would simply never run against this engine, and the port would
//! look finished while missing a feature.

mod common;

use std::path::Path;

use common::{fixtures_dir, parse_iso_millis, read_fixture};
use tdcv2::json::Value;
use tdcv2::parser::{self, config_builder};
use tdcv2::{engine, Severity};

struct Fixture {
    name: String,
    source: std::path::PathBuf,
    expected: std::path::PathBuf,
}

/// Every runtime fixture the manifest names, with its paths resolved.
///
/// Manifest paths are relative to the manifest's own folder, so they are joined
/// to it rather than to the crate — the test binary's working directory is not
/// something to depend on.
fn manifest_fixtures() -> (Vec<Fixture>, i64) {
    let manifest = read_fixture("manifest.json");
    let now = manifest
        .get("fixedNow")
        .and_then(Value::as_str)
        .and_then(parse_iso_millis)
        .expect("the manifest pins a fixedNow, and every implementation reads it from there");

    let dir = fixtures_dir();
    let fixtures = manifest
        .get("runtimeFixtures")
        .and_then(Value::as_array)
        .unwrap_or_default()
        .iter()
        .filter_map(|node| {
            Some(Fixture {
                name: node.get("name").and_then(Value::as_str)?.to_string(),
                source: dir.join(node.get("source").and_then(Value::as_str)?),
                expected: dir.join(node.get("expected").and_then(Value::as_str)?),
            })
        })
        .collect();
    (fixtures, now)
}

/// What one fixture renders, on the engine its baseline was captured from.
///
/// The in-memory engine BY NAME, not through the router. None of these configs
/// declares a mode, so routing them would send them to engine 2 — which draws in
/// a different order and is meant to. Comparing against the wrong engine's bytes
/// would report a portability defect that is not one.
fn render(source: &Path, now_millis: i64) -> String {
    let text = std::fs::read_to_string(source)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", source.display()));
    let parsed = parser::parse(&text);
    assert!(
        parsed.ok(),
        "{} does not parse: {}",
        source.display(),
        parsed
            .problems
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join("; ")
    );

    let base_dir = source.parent().map(|p| p.display().to_string());
    // Through the validator first, for the reason `common::config_of` gives:
    // building straight off the parse tree passes a config that `tdcv2 check`
    // on the same file would refuse.
    //
    // With the PACKS, as the command line has them. A pack declares its own
    // parameters — `domain=` on `common.internet.email` is one — and a validator
    // that cannot see the pack reports the parameter as an unknown attribute.
    let refused: Vec<String> = tdcv2::validator::validate_in(
        &parsed.tree,
        tdcv2::packs::DataPacks::discover().ok(),
        base_dir.as_deref(),
    )
    .into_iter()
    .filter(|d| d.severity == Severity::Error)
    .map(|d| format!("{} {}", d.code, d.message))
    .collect();
    assert!(
        refused.is_empty(),
        "{}: the validator refuses a shared fixture: {}",
        source.display(),
        refused.join("; ")
    );

    let config = config_builder::build(&parsed.tree, None)
        .unwrap_or_else(|e| panic!("{}: {}", source.display(), e.message));
    engine::memory::render_in(&config, now_millis, base_dir.as_deref())
        .unwrap_or_else(|e| panic!("{}: {}", source.display(), e.message()))
}

#[test]
fn every_runtime_fixture_renders_byte_identical_to_its_baseline() {
    let (fixtures, now) = manifest_fixtures();
    assert!(
        fixtures.len() >= 10,
        "only {} runtime fixtures — the manifest moved",
        fixtures.len()
    );

    let mut wrong: Vec<String> = Vec::new();
    for fixture in &fixtures {
        let expected = std::fs::read_to_string(&fixture.expected)
            .unwrap_or_else(|e| panic!("cannot read {}: {e}", fixture.expected.display()));
        let actual = render(&fixture.source, now);
        if actual == expected {
            continue;
        }
        // A whole-file diff of a hundred lines is unreadable in a failure
        // report; the first differing line is what a person needs to see.
        let difference = expected
            .lines()
            .zip(actual.lines())
            .enumerate()
            .find(|(_, (want, got))| want != got)
            .map_or_else(
                || {
                    format!(
                        "  the shorter file ends first: {} baseline lines, {} rendered",
                        expected.lines().count(),
                        actual.lines().count()
                    )
                },
                |(i, (want, got))| {
                    format!(
                        "  first difference at line {}\n    want: {want}\n     got: {got}",
                        i + 1
                    )
                },
            );
        wrong.push(format!("{}\n{difference}", fixture.name));
    }

    assert!(
        wrong.is_empty(),
        "{} of {} baselines differ:\n{}",
        wrong.len(),
        fixtures.len(),
        wrong.join("\n")
    );
}
