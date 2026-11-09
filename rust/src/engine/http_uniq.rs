//! `uniq="true"` on a `<gen type="http">` sequence: a CHECK of the answers.
//!
//! Everywhere else `uniq` is a property of a draw — take without replacement, or
//! rearrange — and a service's answer is neither: it belongs to the row it was
//! asked for, and the service answers each row once. So the run cannot MAKE the
//! column unique. What it can do is refuse to write a file that claims to be
//! unique and is not: every answer is read once, before the first row goes out,
//! and the first repeat stops the run with the two rows that share it.
//!
//! The hunt is an external sort, so it holds a sort buffer, not the column. A
//! blank answer is no value at all (`on_error="empty"`, a `parent=` row the child
//! does not hold, a `missing=` draw) and repeats freely. Mirrors
//! `typescript/src/sequence/http-uniq.ts`.

use super::external_sort;
use super::{invalid, EngineResult};
use crate::model::config::{Config, Source};

const SEP: char = '\u{0}';
const INDEX_WIDTH: usize = 16;

/// The sequences whose `uniq="true"` is a check of a service's answers.
pub fn sequences(config: &Config) -> Vec<String> {
    config
        .sequences
        .iter()
        .filter(|s| s.uniq && matches!(&s.source, Source::Gen(gen) if gen.gen_type == "http"))
        .map(|s| s.name.clone())
        .collect()
}

/// Fail, naming the first repeated answer, unless every non-blank answer differs.
pub fn check(
    name: &str,
    value: &dyn Fn(usize) -> EngineResult<String>,
    count: usize,
) -> EngineResult<()> {
    let mut failure = None;
    let records = (0..count).filter_map(|row| match value(row) {
        Ok(key) if key.is_empty() => None,
        Ok(key) => Some(format!("{key}{SEP}{row:0>INDEX_WIDTH$}")),
        Err(e) => {
            failure.get_or_insert(e);
            None
        }
    });
    let mut sorted = external_sort::sort(records, 0, &std::env::temp_dir())?;
    // The groups arrive in key order; the one reported is the first a reader of
    // the file would meet — the lowest row that repeats an answer above it.
    let mut first: Option<(usize, usize)> = None;
    let mut repeats = 0usize;
    let mut current: Option<String> = None;
    let mut group: Vec<usize> = Vec::new();
    let mut close = |group: &[usize], first: &mut Option<(usize, usize)>| {
        if group.len() < 2 {
            return;
        }
        repeats += group.len() - 1;
        if first.is_none_or(|(_, b)| group[1] < b) {
            *first = Some((group[0], group[1]));
        }
    };
    while let Some(record) = sorted.take()? {
        let Some(split) = record.rfind(SEP) else {
            return invalid("a sorted answer lost its separator");
        };
        let key = &record[..split];
        let Ok(row) = record[split + 1..].parse::<usize>() else {
            return invalid("a sorted answer has no row index");
        };
        if current.as_deref() != Some(key) {
            close(&group, &mut first);
            group.clear();
            current = Some(key.to_string());
        }
        group.push(row);
    }
    close(&group, &mut first);
    drop(close);
    if let Some(e) = failure {
        return Err(e);
    }
    let Some((a, b)) = first else {
        return Ok(());
    };
    let more = if repeats > 1 {
        format!(" ({repeats} rows repeat an earlier answer)")
    } else {
        String::new()
    };
    invalid(&format!(
        "uniq=\"true\" on \"{name}\": the service answered \"{}\" on row {} and again on row {}{more} \u{2014} uniq on an http column checks the answers; it cannot ask the service for others",
        value(a)?,
        a + 1,
        b + 1
    ))
}
