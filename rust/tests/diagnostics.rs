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
//! A case either matches the reference exactly or it fails, as it does in the
//! other four. Saying LESS than the reference used to be tolerated here as
//! "progress not yet made", and the cost was precise: TDC229 was absent for as
//! long as the tolerance was, and nothing failed to say so.

mod common;

use tdcv2::json::Value;
use tdcv2::parser;
use tdcv2::validator;

struct Case {
    name: String,
    demonstrates: String,
    config: String,
    expected: Vec<String>,
    /// A folder beside the fixtures holding files the config reads. TDC062 is
    /// about a CSV column that is not in the header, which cannot be said
    /// without a header for it to be absent from.
    data_path: Option<String>,
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
                data_path: node
                    .get("dataPath")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            });
        }
    }
    cases
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
    let base_dir = case.data_path.as_ref().map(|p| {
        common::fixtures_dir()
            .join("diagnostics")
            .join(p)
            .to_string_lossy()
            .to_string()
    });
    validator::validate_in(&parsed.tree, packs, base_dir.as_deref())
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
        } else {
            // Anything at all that is not the reference's answer: a code
            // invented, a code withheld, or the right code in the wrong place.
            wrong.push(format!(
                "{}\n     want: {:?}\n      got: {:?}",
                case.name, case.expected, actual
            ));
        }
    }

    println!(
        "diagnostics: {matched}/{} match the reference, {} wrong",
        cases.len(),
        wrong.len()
    );
    for w in &wrong {
        println!("  wrong: {w}");
    }

    assert!(
        wrong.is_empty(),
        "{} case(s) diagnosed differently from the reference",
        wrong.len()
    );
}
