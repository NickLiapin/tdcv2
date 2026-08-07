//! `<assert that="Rows == 700" says="…"/>` — a config that checks its own output.
//!
//! What is worth asserting is not what the config already states. You wrote
//! `percent="70"` and you assert 70 percent — you have tested that TDC can
//! count. What the config does NOT state is where the value ends up: a `parent=`
//! filter removes rows, a second condition removes more, and the share that
//! reaches the file is 42 percent with nothing to say so.
//!
//! Three existing mechanisms, no new language: `that=` is the `if=` expression
//! language, the numbers come from `<gen type="stat">`, and `says=` is the
//! sentence a reader gets in a CI log months later.
//!
//! Every name the expression reads must be WHOLE-RUN CONSTANT, or `Amount > 100`
//! reads row 0 and reports on one row out of a thousand — a check that passed
//! because it barely looked, wearing a badge that says verified. Which names an
//! expression reads is discovered by handing the evaluator a scope that records
//! what it is asked for, so no parser knows this feature exists.

use std::cell::RefCell;

use crate::engine::{invalid, EngineResult};
use crate::expr::evaluate::{as_condition, Scope};
use crate::model::config::{AssertSpec, SequenceSpec};

/// Built-ins an assertion may read. `_count` is deliberately absent: it says
/// which row you are on, which is what an assertion must not depend on.
const WHOLE_RUN_BUILTINS: [&str; 1] = ["_total"];

/// Attributes that make a cell which may or may not be there, so the spec
/// settles nothing about the column.
const UNSETTLING: [&str; 4] = ["missing", "anomaly", "if", "repeat"];

/// What reading the column found.
#[derive(PartialEq, Eq)]
enum Constancy {
    Constant,
    Varies,
    EmptyOnSomeRows,
}

/// A scope that answers from row 0 and remembers every real column it was asked
/// for — the whole discovery mechanism, and the reason no parser changes.
struct Recording<'a> {
    value_at: &'a dyn Fn(&str, usize) -> Option<String>,
    known: &'a dyn Fn(&str) -> bool,
    read: RefCell<Vec<(String, String)>>,
}

impl Scope for Recording<'_> {
    fn has(&self, name: &str) -> bool {
        (self.known)(name)
    }

    fn value(&self, name: &str) -> String {
        let found = (self.value_at)(name, 0).unwrap_or_default();
        // Only a real column is recorded. A name that is not declared is not
        // data at all — the expression language reads it as its own literal
        // text, which is what lets `Kind == a` go unquoted — so it has nothing
        // to be constant about, and the validator is the one that asks whether
        // it was a typo.
        if (self.known)(name) {
            let mut read = self.read.borrow_mut();
            if !read.iter().any(|(seen, _)| seen == name) {
                read.push((name.to_string(), found.clone()));
            }
        }
        found
    }
}

/// Constant from the SPEC alone, without reading a single row.
///
/// Reading the column is the honest test and stays below, but it costs a pass
/// over the run — and on a streaming engine that pass regenerates every value.
/// Measured at two million rows it cost a third of a second per name, which at a
/// billion rows is minutes spent proving what the spec already said. So this
/// runs first and, like the `uniq` capacity check, only ever answers "definitely
/// constant": anything it cannot prove falls through to the scan, so no config
/// is refused that would have been accepted.
fn constant_by_construction(spec: Option<&SequenceSpec>) -> bool {
    let Some(spec) = spec else { return false };
    let Some(gen) = spec.gen() else {
        return false; // a compound, a mix, a switch — read it
    };
    if spec.parent.is_some() {
        return false; // a filtered column is empty on the rows the filter excluded
    }
    if UNSETTLING.iter().any(|attr| gen.attrs.contains_key(*attr)) {
        return false;
    }
    match gen.gen_type.as_str() {
        "stat" => true, // one number for the whole run, by definition
        "text" => gen.attrs.get("value").is_some_and(|raw| !raw.contains(',')), // a list of one
        _ => false,
    }
}

/// Whether this column holds one and the same value on every row of the run.
///
/// An EMPTY cell fails the rule as surely as a different one: a column a
/// `parent=` filter leaves blank on half the run has no whole-run value at all,
/// and the condition would compare against whatever row 0 happened to hold.
fn constancy(
    name: &str,
    value_at: &dyn Fn(&str, usize) -> Option<String>,
    spec: Option<&SequenceSpec>,
    count: usize,
) -> Constancy {
    if WHOLE_RUN_BUILTINS.contains(&name) || constant_by_construction(spec) {
        return Constancy::Constant;
    }
    let mut seen: Option<String> = None;
    for row in 0..count {
        let value = value_at(name, row).unwrap_or_default();
        if value.is_empty() {
            return Constancy::EmptyOnSomeRows;
        }
        match seen.as_deref() {
            None => seen = Some(value),
            Some(first) if first != value => return Constancy::Varies,
            Some(_) => {}
        }
    }
    if seen.is_some() {
        Constancy::Constant
    } else {
        Constancy::EmptyOnSomeRows
    }
}

/// Check every assertion against the finished run, refusing on the first that
/// does not hold.
///
/// `value_at` and `known` come from the engine, because a column is a vector on
/// one engine and a function of the row on another — and an assertion has to
/// mean the same thing on both.
pub fn check(
    asserts: &[AssertSpec],
    specs: &[SequenceSpec],
    value_at: &dyn Fn(&str, usize) -> Option<String>,
    known: &dyn Fn(&str) -> bool,
    count: usize,
) -> EngineResult<()> {
    for spec in asserts {
        let scope = Recording {
            value_at,
            known,
            read: RefCell::new(Vec::new()),
        };
        let held = match as_condition(&spec.that, &scope) {
            Ok(held) => held,
            Err(e) => {
                return invalid(&format!(
                    "assert: cannot read \"{}\" — {}",
                    spec.that,
                    e.message()
                ))
            }
        };
        let read = scope.read.into_inner();

        // The honesty rule, applied to every name the expression touched. The
        // evaluator walks both sides of `&&` rather than short-circuiting — in
        // all five implementations, since they share this walk — so which names
        // are checked does not depend on operand order.
        for (name, _) in &read {
            let declared = specs.iter().find(|s| s.name == *name);
            let why = match constancy(name, value_at, declared, count) {
                Constancy::Constant => continue,
                Constancy::Varies => format!(
                    "\"{name}\" is not the same on every row, so this would have checked the \
                     first row and called the run verified"
                ),
                Constancy::EmptyOnSomeRows => format!(
                    "\"{name}\" is empty on some rows, so the run has no single value for it — \
                     this would have checked whatever the first row happened to hold"
                ),
            };
            return invalid(&format!(
                "assert (\"{}\"): {why}. An assertion reads whole-run values: give it a \
                 <gen type=\"stat\" of=\"{name}\" op=\"…\"/> column, or _total.",
                spec.that
            ));
        }

        if !held {
            let detail = read
                .iter()
                .map(|(name, value)| {
                    let shown = if value.is_empty() { "(empty)" } else { value };
                    format!("{name} = {shown}")
                })
                .collect::<Vec<_>>()
                .join(", ");
            let shown = if detail.is_empty() {
                spec.that.clone()
            } else {
                format!("{}   with {detail}", spec.that)
            };
            return invalid(&format!("assert failed: {}\n  {shown}", spec.says));
        }
    }
    Ok(())
}
