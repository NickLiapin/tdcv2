//! A distribution parameter written as an EXPRESSION rather than a number.
//!
//! `lambda="Traffic * 0.5"` is an intensity driven by another column;
//! `sd="0.5 + 0.01 * _count"` is a sensor that grows noisier as the run goes on. A bare
//! number stays the ordinary case and costs nothing — the spec is parsed once, exactly
//! as before, and only a config that names a column comes here.
//!
//! Why this is allowed at all, when a per-row `repeat=` is not: how many uniform draws a
//! row consumes depends on WHICH distribution, never on its parameters. The parameter
//! changes the value the draws are turned into, not their number, so the row stays
//! computable without its predecessors — the property every engine is built on.

use std::collections::BTreeMap;

use crate::engine::{EngineError, EngineResult};
use crate::expr::evaluate::{as_value, Scope, V};
use crate::numbers;

/// Every parameter any of the nine distributions reads.
pub const PARAMS: [&str; 15] = [
    "mean", "sd", "meanlog", "sdlog", "rate", "alpha", "xmin", "shape", "scale", "lambda", "beta",
    "s", "n", "min", "max",
];

/// The two distributions sampled from a PAIR of uniforms (Box-Muller); every other reads one.
const TWO_DRAW: [&str; 2] = ["normal", "lognormal"];

/// The attributes with every expression-valued parameter replaced by its answer.
pub struct Resolved {
    pub attrs: BTreeMap<String, String>,
    /// A referenced column was empty on this row, so nothing can be drawn.
    pub empty: bool,
}

/// Digits, a point, a sign, an exponent — anything a plain number can be.
fn is_plain_number(text: &str) -> bool {
    let body = text.trim();
    if body.is_empty() {
        return false;
    }
    body.parse::<f64>().is_ok()
}

/// The parameters this generator wrote as an expression rather than a number.
pub fn expression_params(attrs: &BTreeMap<String, String>) -> Vec<&'static str> {
    PARAMS
        .iter()
        .filter(|name| match attrs.get(**name) {
            Some(raw) if !raw.trim().is_empty() => !is_plain_number(raw),
            _ => false,
        })
        .copied()
        .collect()
}

/// How many uniforms a row of this distribution spends, known from the NAME alone.
///
/// Wanted by a row that cannot be drawn at all — a parameter read an empty cell — which
/// must still spend what a drawn row would. Otherwise blanking one cell would slide every
/// value after it, and a `parent=` filter would quietly rewrite the rest of the column.
pub fn draws(attrs: &BTreeMap<String, String>) -> usize {
    let name = attrs
        .get("distribution")
        .map(|d| d.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if TWO_DRAW.contains(&name.as_str()) {
        2
    } else {
        1
    }
}

/// A scope that watches what the expression READ, so a refusal can point at the cause.
///
/// A name the registry knows, holding nothing, marks the row EMPTY: that is a row a
/// `parent=` filter switched off or a `missing=` blank, and it is not a zero. It has to
/// be noticed here, at the lookup, because an unresolved bare word evaluates to the WORD
/// — the way `if="Tier == hi"` reads `hi` — and the two cannot be told apart afterwards.
struct WatchedScope<'a> {
    row: usize,
    has_column: &'a dyn Fn(&str) -> bool,
    value_at: &'a dyn Fn(&str) -> Option<String>,
    seen: std::cell::RefCell<Seen>,
}

#[derive(Default)]
struct Seen {
    empty: bool,
    text: Option<(String, String)>,
}

impl Scope for WatchedScope<'_> {
    fn has(&self, name: &str) -> bool {
        name == "_count" || (self.has_column)(name)
    }

    fn value(&self, name: &str) -> String {
        if name == "_count" {
            return (self.row + 1).to_string();
        }
        let cell = (self.value_at)(name).unwrap_or_default();
        if (self.has_column)(name) {
            let mut seen = self.seen.borrow_mut();
            if cell.trim().is_empty() {
                seen.empty = true;
            } else if seen.text.is_none() && !is_plain_number(&cell) {
                seen.text = Some((name.to_string(), cell.clone()));
            }
        }
        cell
    }
}

/// `attrs` with each expression parameter evaluated on this row.
pub fn resolve(
    attrs: &BTreeMap<String, String>,
    dynamic: &[&str],
    row: usize,
    has_column: &dyn Fn(&str) -> bool,
    value_at: &dyn Fn(&str) -> Option<String>,
) -> EngineResult<Resolved> {
    let mut out = attrs.clone();
    let mut empty = false;

    for name in dynamic {
        let Some(source) = attrs.get(*name) else {
            continue;
        };
        let scope = WatchedScope {
            row,
            has_column,
            value_at,
            seen: std::cell::RefCell::new(Seen::default()),
        };
        let answer = as_value(source, &scope)?;
        let seen = scope.seen.into_inner();
        empty = empty || seen.empty;

        let written = match &answer {
            V::Int(n) => Some(n.to_string()),
            V::Num(n) if n.is_finite() => Some(numbers::to_text(*n)),
            // A bare column reference resolves to the cell's TEXT — `mean="M"` where M
            // holds "100". Arithmetic would have produced a number, but naming a column
            // and nothing else is the simplest way to write this and must work too.
            V::Str(text) if is_plain_number(text) => Some(text.trim().to_string()),
            _ => None,
        };

        match written {
            Some(value) => {
                out.insert((*name).to_string(), value);
            }
            // Nothing numeric came out, and a column is the reason. Say which — the
            // distribution's own message would only repeat that the parameter is "not a
            // number", which the author can already see. Same wording as the formula
            // generator, for the same mistake read from the same columns.
            None if !empty => {
                if let Some((column, held)) = seen.text {
                    return Err(EngineError::Invalid(format!(
                        "{name}: the expression is not a number: column \"{column}\" holds \
                         \"{held}\", which is text rather than a number"
                    )));
                }
            }
            None => {}
        }
    }

    Ok(Resolved { attrs: out, empty })
}
