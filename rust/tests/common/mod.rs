//! Reading the shared fixtures — the ones all five implementations answer to.
//!
//! Compiled separately into every test binary, so anything one of them does not
//! use is dead there. The allow is on the module rather than on each caller,
//! which is the only place it stays true as tests come and go.
#![allow(dead_code)]

use std::path::{Path, PathBuf};

use tdcv2::engine::{self, EngineError};
use tdcv2::json::{self, Value};
use tdcv2::model::Config;
use tdcv2::parser::{self, config_builder};

/// The repository's `fixtures/cross-language/`, found by walking up.
///
/// Not a relative path from the crate: `cargo test` runs from the crate root
/// but a workspace or an IDE may not, and a fixture file silently not found
/// would make a test pass by checking nothing.
pub fn fixtures_dir() -> PathBuf {
    let mut dir: &Path = Path::new(env!("CARGO_MANIFEST_DIR"));
    loop {
        let candidate = dir.join("fixtures/cross-language");
        if candidate.is_dir() {
            return candidate;
        }
        dir = dir.parent().unwrap_or_else(|| {
            panic!(
                "no fixtures/cross-language above {}",
                env!("CARGO_MANIFEST_DIR")
            )
        });
    }
}

pub fn read_fixture(relative: &str) -> Value {
    let path = fixtures_dir().join(relative);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|e| panic!("cannot read {}: {e}", path.display()));
    json::parse(&text).unwrap_or_else(|e| panic!("{} is not valid JSON: {e}", path.display()))
}

pub struct Case {
    pub name: String,
    pub config: String,
    pub expected: String,
    pub count: Option<i32>,
    pub seed: Option<String>,
    pub locale: Option<String>,
    pub now: Option<String>,
}

pub fn all_cases() -> Vec<Case> {
    let dir = fixtures_dir().join("cases");
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
        let fixture = read_fixture(&format!(
            "cases/{}",
            path.file_name().unwrap().to_string_lossy()
        ));
        for node in fixture
            .get("cases")
            .and_then(Value::as_array)
            .unwrap_or_default()
        {
            let name = node.get("name").and_then(Value::as_str).unwrap_or("?");
            let Some(config) = node.get("config").and_then(Value::as_str) else {
                continue;
            };
            let mut expected = String::new();
            for line in node
                .get("expected")
                .and_then(Value::as_array)
                .unwrap_or_default()
            {
                expected.push_str(line.as_str().unwrap_or_default());
                expected.push('\n');
            }
            cases.push(Case {
                name: format!("{group}/{name}"),
                config: config.to_string(),
                expected,
                count: node.get("count").and_then(Value::as_i64).map(|n| n as i32),
                seed: node.get("seed").and_then(Value::as_str).map(str::to_string),
                locale: node
                    .get("locale")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                now: node.get("now").and_then(Value::as_str).map(str::to_string),
            });
        }
    }
    cases
}

/// The case's config, ready to run.
pub fn config_of(case: &Case) -> Result<Config, EngineError> {
    let parsed = parser::parse(&case.config);
    if !parsed.ok() {
        let problems: Vec<String> = parsed.problems.iter().map(ToString::to_string).collect();
        return Err(EngineError::Invalid(format!(
            "does not parse: {}",
            problems.join("; ")
        )));
    }
    Ok(config_builder::build(&parsed.tree, None)
        .map_err(|e| EngineError::Invalid(e.message))?
        .with_overrides(case.count, case.seed.as_deref(), case.locale.as_deref()))
}

/// The instant a case pins, or the epoch.
///
/// `value="today"` reads it, and without this a case would pass today and fail
/// tomorrow.
pub fn now_of(case: &Case) -> Result<i64, EngineError> {
    match &case.now {
        Some(text) => parse_iso_millis(text)
            .ok_or_else(|| EngineError::Invalid(format!("cannot read now=\"{text}\""))),
        None => Ok(0),
    }
}

/// What a case renders, or why it could not.
pub fn render(case: &Case) -> Result<String, EngineError> {
    engine::render(&config_of(case)?, now_of(case)?)
}

/// Every case a scoreboard let through as "not ported yet", by name.
///
/// The count alone says how far there is to go; the names say what the work
/// actually is. A scoreboard that reports only a number lets a whole feature sit
/// excused indefinitely, because nothing in the output ever points at a case to
/// go and read.
pub fn print_excused(excused: &std::collections::BTreeMap<String, Vec<String>>) {
    let mut ranked: Vec<(&String, &Vec<String>)> = excused.iter().collect();
    ranked.sort_by(|a, b| b.1.len().cmp(&a.1.len()).then(a.0.cmp(b.0)));
    for (what, names) in ranked {
        println!("  {:3}  excused: {what}", names.len());
        for name in names {
            println!("         {name}");
        }
    }
}

/// `2024-01-15T00:00:00Z` to milliseconds since the epoch.
///
/// Written out because the crate has no date dependency and, more to the point,
/// no *time zone* one: every `now` in the fixtures is UTC, and a parser that
/// quietly applied a local offset would move every generated date by a few hours
/// on one developer's machine and not another's.
pub fn parse_iso_millis(text: &str) -> Option<i64> {
    // Length first: every read below is a fixed slice of an ISO-8601 instant.
    if text.len() < 19 {
        return None;
    }
    let num = |from: usize, to: usize| text.get(from..to)?.parse::<i64>().ok();
    let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
    let (h, mi, s) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);

    // Days from the civil epoch — Howard Hinnant's algorithm, which is exact for
    // the whole proleptic Gregorian calendar and needs no table.
    let y = if mo <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;

    Some((days * 86_400 + h * 3600 + mi * 60 + s) * 1000)
}

#[test]
fn the_clock_reader_agrees_with_a_known_instant() {
    // 2024-01-15T00:00:00Z. Checked against a value taken from outside this
    // crate, because a date routine that is wrong in a self-consistent way is
    // exactly what a hand-written one is at risk of being.
    assert_eq!(
        parse_iso_millis("2024-01-15T00:00:00Z"),
        Some(1_705_276_800_000)
    );
    assert_eq!(parse_iso_millis("1970-01-01T00:00:00Z"), Some(0));
    assert_eq!(
        parse_iso_millis("2000-02-29T12:00:00Z"),
        Some(951_825_600_000)
    );
    assert_eq!(parse_iso_millis("1969-12-31T23:59:59Z"), Some(-1000));
}
