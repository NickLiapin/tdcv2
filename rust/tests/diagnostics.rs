//! The shared diagnostic cases: the same configs and the same complaints.
//!
//! What is compared is the SEVERITY, the stable CODE, and WHERE the diagnostic
//! points — never the message text. Wording is edited for clarity over time, and
//! holding five implementations to a sentence would make every improvement a
//! breaking change.
//!
//! The position is compared because it is what an editor underlines and what a
//! CLI prints a caret under. An implementation that reports the right code at the
//! wrong place has not told anyone what is wrong with their config — only which
//! file to go looking in.
//!
//! Same standard as the render scoreboards: a case either matches or does not.
//! Reporting NOTHING for a case is progress not yet made; reporting the wrong
//! thing — or a complaint about a config the reference accepts — is a defect,
//! and that is what this asserts.

mod common;

use std::collections::BTreeMap;

use tdcv2::json::Value;
use tdcv2::parser;
use tdcv2::validator;

struct Case {
    name: String,
    demonstrates: String,
    config: String,
    expected: Vec<String>,
}

fn all_cases() -> Vec<Case> {
    let dir = common::fixtures_dir().join("diagnostics");
    let mut files: Vec<std::path::PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("cannot list {}: {e}", dir.display()))
        .filter_map(|e| {
            let path = e.ok()?.path();
            (path.extension()?.to_str()? == "json").then_some(path)
        })
        .collect();
    files.sort();

    let mut cases = Vec::new();
    for path in files {
        let group = path.file_stem().unwrap().to_string_lossy().to_string();
        let fixture = common::read_fixture(&format!(
            "diagnostics/{}",
            path.file_name().unwrap().to_string_lossy()
        ));
        for node in fixture
            .get("cases")
            .and_then(Value::as_array)
            .unwrap_or_default()
        {
            let Some(config) = node.get("config").and_then(Value::as_str) else {
                continue;
            };
            cases.push(Case {
                name: format!(
                    "{group}/{}",
                    node.get("name").and_then(Value::as_str).unwrap_or("?")
                ),
                demonstrates: node
                    .get("demonstrates")
                    .and_then(Value::as_str)
                    .unwrap_or("?")
                    .to_string(),
                config: config.to_string(),
                expected: node
                    .get("expected")
                    .and_then(Value::as_array)
                    .unwrap_or_default()
                    .iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect(),
            });
        }
    }
    cases
}

/// `Some(first missing code)` when `actual` is a subsequence of `expected` —
/// nothing invented, only something not said yet.
fn only_missing(actual: &[String], expected: &[String]) -> Option<String> {
    let mut at = 0usize;
    let mut first_missing = None;
    for want in expected {
        if actual.get(at) == Some(want) {
            at += 1;
        } else if first_missing.is_none() {
            first_missing = Some(want.split(' ').nth(1).unwrap_or(want).to_string());
        }
    }
    (at == actual.len()).then_some(first_missing?)
}

fn report(case: &Case) -> Vec<String> {
    let parsed = parser::parse(&case.config);
    if !parsed.ok() {
        // A parse error stops the run: there is no tree to validate, and the
        // parser's own complaint is the only honest thing to report. The PARSE
        // signature matches the Python and Java harnesses.
        return parsed
            .problems
            .iter()
            .map(|p| format!("error PARSE {}:{}", p.line, p.column))
            .collect();
    }
    // With the packs, as the reference runs it: a template address is checked
    // against the registry, and without one the check cannot be made at all.
    let packs = tdcv2::packs::DataPacks::discover().ok();
    validator::validate_with(&parsed.tree, packs)
        .iter()
        .map(tdcv2::errors::Diagnostic::signature)
        .collect()
}

#[test]
fn no_shared_case_is_diagnosed_differently_from_the_reference() {
    let cases = all_cases();
    assert!(
        cases.len() >= 100,
        "only {} cases — the corpus moved",
        cases.len()
    );

    let mut matched = 0usize;
    let mut not_yet: BTreeMap<String, usize> = BTreeMap::new();
    let mut wrong: Vec<String> = Vec::new();

    for case in &cases {
        // The fixture's own guard, re-checked here: a case named after TDC062
        // whose config actually produces TDC050 would otherwise be recorded as
        // correct and then held over every implementation forever.
        assert!(
            // "?" or nothing: a case that demonstrates the ABSENCE of a code —
            // there its empty expectation is the assertion.
            case.demonstrates == "?"
                || case.demonstrates.is_empty()
                || case
                    .expected
                    .iter()
                    .any(|e| e.split(' ').nth(1) == Some(case.demonstrates.as_str())),
            "{} claims to demonstrate {} but expects {:?}",
            case.name,
            case.demonstrates,
            case.expected
        );

        let actual = report(case);
        if actual == case.expected {
            matched += 1;
        } else if let Some(missing) = only_missing(&actual, &case.expected) {
            // Everything reported IS reported by the reference, at the same
            // place and in the same order — there is just less of it. That is a
            // check not ported yet, and it is grouped by the first code that did
            // not speak, so the biggest remaining piece of work is a number
            // rather than a guess.
            *not_yet.entry(missing).or_default() += 1;
        } else {
            // Something the reference does not report, or the right code in the
            // wrong place. Either way the config was told something untrue.
            wrong.push(format!(
                "{}\n     want: {:?}\n      got: {:?}",
                case.name, case.expected, actual
            ));
        }
    }

    let missing: usize = not_yet.values().sum();
    println!(
        "diagnostics: {matched} match the reference, {missing} not ported yet, {} wrong",
        wrong.len()
    );
    let mut ranked: Vec<(&String, &usize)> = not_yet.iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
    for (code, n) in ranked {
        println!("  {n:3}  {code}");
    }
    for w in wrong.iter().take(12) {
        println!("  wrong: {w}");
    }

    assert!(
        wrong.is_empty(),
        "{} case(s) diagnosed differently from the reference",
        wrong.len()
    );
    assert!(matched > 0, "no case is diagnosed correctly yet");
}
