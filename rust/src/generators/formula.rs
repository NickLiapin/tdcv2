//! `<gen type="formula" expr="Weight / (Height * Height)">` — arithmetic over the columns
//! beside it.
//!
//! A whole COLUMN read from other columns, like `running` and `stat`, but unlike them it
//! needs only its OWN row: row nine million is `Weight[9M] / Height[9M]²` and nothing
//! before it. So it streams and it parallelises, where a running total cannot.
//!
//! Two rules decide what a cell holds, and both are the ones `stat` already follows:
//!
//! * without `decimals=` the value is printed whole, with it the answer is rounded;
//! * a source cell that is EMPTY makes the answer empty. A cell a `parent=` filter switched
//!   off is not a zero, and `0 / 0` is not the honest reading of it.

use std::collections::BTreeMap;

use crate::engine::{EngineError, EngineResult};
use crate::expr::evaluate::{as_value, Scope, V};
use crate::numbers;

/// Digits, a point, a sign, an exponent — anything a plain number can be.
pub fn is_plain_number(text: &str) -> bool {
    let body = text.trim();
    !body.is_empty() && body.parse::<f64>().is_ok()
}

/// `expr=`, which a formula cannot do without.
pub fn expression_of(attrs: &BTreeMap<String, String>) -> EngineResult<String> {
    let source = attrs.get("expr").map(|s| s.trim()).unwrap_or_default();
    if source.is_empty() {
        return Err(EngineError::Invalid(
            "<gen type=\"formula\"> needs expr=\"…\"".to_string(),
        ));
    }
    Ok(source.to_string())
}

/// `decimals=` when the config declared one, else the value is printed whole.
pub fn decimals_of(attrs: &BTreeMap<String, String>) -> EngineResult<Option<usize>> {
    let raw = attrs.get("decimals").map(|s| s.trim()).unwrap_or_default();
    if raw.is_empty() {
        return Ok(None);
    }
    let bad = || {
        EngineError::Invalid(format!(
            "decimals=\"{raw}\" is not a whole number from 0 to 10"
        ))
    };
    let value: i64 = raw.parse().map_err(|_| bad())?;
    if !(0..=10).contains(&value) {
        return Err(bad());
    }
    Ok(Some(value as usize))
}

/// What one row's evaluation read, so a refusal can point at the cause.
#[derive(Default)]
pub struct ColumnsRead {
    /// A referenced column was empty on this row.
    pub empty: bool,
    /// The first column that held TEXT rather than a number, and what it held.
    pub text: Option<(String, String)>,
}

/// One evaluated answer, as the text that goes in the cell.
///
/// NaN is how "arithmetic on text" arrives here. In an `if=` it merely makes every
/// comparison false and the branch quietly does not fire; in a COLUMN it would print, and a
/// file full of `NaN` nobody was warned about is the defect this project keeps closing. So
/// it is refused — and the refusal names the column that held the text, because the scope
/// recorded what the expression actually read.
pub fn render(value: &V, decimals: Option<usize>, read: &ColumnsRead) -> EngineResult<String> {
    match value {
        // A whole number is printed from the integer it still is: going through a double
        // would undo the exactness the expression language worked to keep.
        V::Int(n) => Ok(match decimals {
            None => n.to_string(),
            Some(places) => numbers::to_fixed(*n as f64, places),
        }),
        V::Bool(on) => Ok(if *on { "true" } else { "false" }.to_string()),
        V::Num(n) if n.is_nan() => Err(EngineError::Invalid(match &read.text {
            None => "the expression has no number as its answer — 0/0, the square root of a \
                     negative, or another sum with no value"
                .to_string(),
            Some((column, held)) => format!(
                "the expression is not a number: column \"{column}\" holds \"{held}\", which \
                 is text rather than a number"
            ),
        })),
        V::Num(n) if n.is_infinite() => Err(EngineError::Invalid(format!(
            "the expression is {} — a division by zero, the logarithm of zero, or a value \
             past the range a number can hold",
            if *n > 0.0 { "Infinity" } else { "-Infinity" }
        ))),
        V::Num(n) => Ok(match decimals {
            None => numbers::to_text(*n),
            Some(places) => numbers::to_fixed(*n, places),
        }),
        // Text. A formula is allowed to produce it — `expr="Age > 65 ? senior : adult"` is a
        // label, and labels are half of what a data-science config builds. `decimals=` says
        // nothing about a label, so it is left alone rather than forced through a number.
        V::Str(text) => Ok(text.clone()),
        // Neither can reach a cell: a list is only ever the right side of `in`, and nothing
        // in the language produces null. Empty rather than a crash, since a value that
        // cannot arrive needs no message of its own.
        V::Lst(_) | V::Null => Ok(String::new()),
    }
}

/// The scope one row's evaluation reads through.
///
/// `has` and `value` stay separate for the same reason they do in a condition: an absent
/// name is not an empty one. A name the registry does not know is its own text — that is
/// what lets `if="Gender == Male"` go unquoted — so only a name it DOES know can make the
/// row empty.
pub struct RowScope<'a> {
    pub row: usize,
    pub has_column: &'a dyn Fn(&str) -> bool,
    pub value_at: &'a dyn Fn(&str) -> Option<String>,
    pub read: std::cell::RefCell<ColumnsRead>,
}

impl Scope for RowScope<'_> {
    fn has(&self, name: &str) -> bool {
        name == "_count" || (self.has_column)(name)
    }

    fn value(&self, name: &str) -> String {
        if name == "_count" {
            return (self.row + 1).to_string();
        }
        let cell = (self.value_at)(name).unwrap_or_default();
        if (self.has_column)(name) {
            let mut read = self.read.borrow_mut();
            if cell.trim().is_empty() {
                read.empty = true;
            } else if read.text.is_none() && !is_plain_number(&cell) {
                read.text = Some((name.to_string(), cell.clone()));
            }
        }
        cell
    }
}

/// One row's answer, or `None` when a column it read was empty.
pub fn value_at_row(
    source: &str,
    decimals: Option<usize>,
    row: usize,
    has_column: &dyn Fn(&str) -> bool,
    value_at: &dyn Fn(&str) -> Option<String>,
) -> EngineResult<Option<String>> {
    let scope = RowScope {
        row,
        has_column,
        value_at,
        read: std::cell::RefCell::new(ColumnsRead::default()),
    };
    let answer = as_value(source, &scope)?;
    let read = scope.read.into_inner();
    if read.empty {
        return Ok(None);
    }
    render(&answer, decimals, &read).map(Some)
}
