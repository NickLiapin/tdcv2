//! `<gen type="date" of="Admitted" plus="3..10d">` — a date measured from another date.
//!
//! The interval is in almost every real record — admitted and discharged, ordered
//! and shipped, issued and expires, the start and end of a shift — and it could
//! not be said at all. Two independent date columns put the discharge BEFORE the
//! admission on a third of the rows, and the workaround people reach for,
//! non-overlapping windows ("admitted in January, discharged April to June"),
//! throws away exactly what the interval is for: its length, and how that length
//! is distributed. "Most stay a week, a few stay months" had no way to be written.
//!
//! A generator sees no other column, by design — that is what makes a column's
//! values a function of the seed and the row index alone. This reads a sibling,
//! so it is resolved in the engine beside `running` and `stat`, in declaration
//! order, which is also why `of=` must name a column declared ABOVE it.

use std::collections::BTreeMap;

use crate::date::calendar::{apply_offset, parse_offset, OffsetSpec};
use crate::date::{format, from_epoch_millis, parse, to_epoch_millis, PlainDateTime};
use crate::engine::{invalid, EngineResult};
use crate::prng::Sfc32;

/// The column this date is measured from, or `""` when the generator did not say.
pub fn source_of(attrs: &BTreeMap<String, String>) -> &str {
    attrs.get("of").map(|s| s.trim()).unwrap_or("")
}

/// True when this `<gen type="date">` is an offset rather than a draw.
pub fn is_offset(gen_type: &str, attrs: &BTreeMap<String, String>) -> bool {
    gen_type == "date" && !source_of(attrs).is_empty()
}

/// An offset column: the rendered cells, and the instants behind them when a
/// third column measures from this one.
pub type OffsetColumn = (Vec<Option<String>>, Option<Vec<Option<i64>>>);

/// The offset column, and its own instants when a third column measures from it.
///
/// One draw per row, and only when the offset is a RANGE: `plus="7d"` is a fixed
/// distance and consumes no randomness at all, so a config that pins the interval
/// leaves every other column exactly where it was.
///
/// A row whose source is empty — outside a parent filter, or a source that was
/// itself filtered — stays empty. There is no date to measure from, and inventing
/// one would put a value in a cell the config said should have none.
#[allow(clippy::too_many_arguments)]
pub fn build(
    name: &str,
    attrs: &BTreeMap<String, String>,
    source: &[Option<String>],
    instants: Option<&Vec<Option<i64>>>,
    count: usize,
    prng: &mut Sfc32,
    locale: Option<&str>,
    keep_instants: bool,
) -> EngineResult<OffsetColumn> {
    let Ok(offset) = parse_offset(attrs.get("plus").map(String::as_str)) else {
        // A bad plus= is a diagnostic, not a crash.
        return Ok((vec![None; count], None));
    };

    let fmt = attrs.get("format").map(|s| s.trim()).unwrap_or("");
    let fmt = if fmt.is_empty() { "L" } else { fmt };
    let mut values: Vec<Option<String>> = vec![None; count];
    // An offset is itself a date this engine produced, so it keeps its own value
    // when a THIRD column measures from it — signed, expires a year later, remind
    // a month before that.
    let mut own: Option<Vec<Option<i64>>> = keep_instants.then(|| vec![None; count]);

    for (i, cell) in values.iter_mut().enumerate().take(count) {
        let Some(text) = source.get(i).and_then(Option::as_deref) else {
            continue;
        };
        if text.trim().is_empty() {
            continue;
        }
        let Some(start) = start_of_row(name, attrs, instants, i, text)? else {
            continue;
        };
        let landed = apply_offset(start, offset, draw_steps(offset, prng));
        if let Some(sink) = own.as_mut() {
            sink[i] = Some(to_epoch_millis(landed));
        }
        *cell = Some(format::format(landed, Some(fmt), locale));
    }
    Ok((values, own))
}

/// The date row `i` is measured FROM, or `None` when the row has none.
///
/// Three readings, in this order:
///
/// 1. **The instant the source column kept.** A `<gen type="date">` this engine
///    built remembers what it generated, so the offset works from the value and
///    `format=` is free to be anything at all — the cell may read `March 2` or
///    `02.03.2026` and the arithmetic is the same either way.
/// 2. **No instant on a column that carries them.** `missing="0.1"` blanked that
///    cell: the column HAS a date for other rows and none for this one. The
///    offset has nothing to measure and the cell stays empty.
/// 3. **The text, read as ISO.** A date that came from a file or a pack has only
///    its spelling left. The ISO form has one reading in every locale, so it is
///    accepted; anything else is refused rather than guessed at, because
///    `02/03/2026` is the 2nd of March in one locale and the 3rd of February in
///    another.
fn start_of_row(
    name: &str,
    attrs: &BTreeMap<String, String>,
    instants: Option<&Vec<Option<i64>>>,
    i: usize,
    text: &str,
) -> EngineResult<Option<PlainDateTime>> {
    if let Some(kept) = instants {
        return Ok(kept.get(i).copied().flatten().map(from_epoch_millis));
    }
    match parse::date_time(text.trim()) {
        Ok(parsed) => Ok(Some(parsed.value)),
        Err(_) => invalid(&format!(
            "date offset (\"{name}\"): \"{text}\" in column \"{}\" is not a date this can \
             measure from. A date TDC generated carries its own value and any format= works; \
             one read from a file or a pack has only its text, and only the ISO form \
             (YYYY-MM-DD) means the same thing in every locale.",
            source_of(attrs)
        )),
    }
}

/// How many steps this row moves.
///
/// A fixed offset takes no draw, which is what lets `plus="7d"` be added to a
/// config without shifting any other column. A range takes exactly one.
fn draw_steps(offset: OffsetSpec, prng: &mut Sfc32) -> i64 {
    if offset.lo == offset.hi {
        return offset.lo;
    }
    let span = offset.hi - offset.lo + 1;
    offset.lo + (span - 1).min((prng.next() * span as f64) as i64)
}
