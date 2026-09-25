//! A formula or a date offset standing in a BRANCH — inside a `<case>`, or as one of the
//! `<gen if="…">` branches of a sequence — rather than as a whole column.
//!
//! Of the four derived constructs, these two read nothing but their own row. So a branch can
//! have them as cheaply as a whole column can: for each row the branch holds, compute that row.
//! Before this module, a date offset in a branch lost `of=` and `plus=` without a word and drew
//! an unrelated date, and a formula stopped the run with `<gen type="formula"> is not ported
//! yet` after `check` had called the config valid.
//!
//! `running`, `stat`, a formula that reads `prev()` and a pool reference are whole columns by
//! nature, and the validator keeps them out of branches (TDC295, TDC268). They never reach here.

use std::collections::BTreeSet;

use super::memory::Env;
use super::per_row::{self, Stream};
use super::EngineResult;
use crate::date::calendar::{apply_offset, parse_offset};
use crate::date::{format, to_epoch_millis};
use crate::generators::{date_offset, formula};
use crate::model::{Case, CasePart, Config, Gen, Source, Switch};
use crate::prng::Sfc32;

/// A formula, or a date measured from another column: the two that read only their row.
pub fn is_row_local(gen: &Gen) -> bool {
    gen.gen_type == "formula" || date_offset::is_offset(&gen.gen_type, &gen.attrs)
}

/// The branch's values, one per position — `""` for a row the build will not keep.
pub fn values(
    gen: &Gen,
    count: usize,
    prng: &mut Sfc32,
    env: &Env,
    stream: Option<&Stream>,
    instants: Option<&mut Vec<Option<i64>>>,
) -> EngineResult<Vec<String>> {
    let row_of = |i: usize| stream.map_or(i, |s| s.row_at(i));
    let kept = |row: usize| stream.is_none_or(|s| s.keeps(row));
    let mut out = vec![String::new(); count];
    if gen.gen_type == "formula" {
        let source = gen.attrs.get("expr").map(|s| s.trim()).unwrap_or("");
        if source.is_empty() {
            return Ok(out); // no expr= — the validator reports it
        }
        let decimals = formula::decimals_of(&gen.attrs)?;
        for (i, cell) in out.iter_mut().enumerate() {
            let row = row_of(i);
            if !kept(row) {
                continue;
            }
            // A column this row does not have leaves the cell empty, as it does for a
            // formula that is a whole column: a zero nobody generated is not an answer.
            // No previous row: `prev()` makes a formula a whole column, which TDC295 keeps
            // out of a branch.
            *cell = formula::value_at_row(
                source,
                decimals,
                row,
                &|name| env.has_sibling(name),
                &|name| env.sibling_at(name, row),
                None,
            )?
            .unwrap_or_default();
        }
        return Ok(out);
    }

    // A date offset: the same measurement the whole-column offset makes, row by row. A ranged
    // `plus=` draws its step from the row's own stream — `(seed, stream, row)` — so the step a
    // row gets does not depend on which other rows the branch holds.
    let mut stamps: Vec<Option<i64>> = vec![None; count];
    let source = date_offset::source_of(&gen.attrs).to_string();
    let parsed = parse_offset(gen.attrs.get("plus").map(String::as_str));
    if let (true, Ok(offset)) = (env.has_sibling(&source), parsed) {
        let fmt = gen.attrs.get("format").map(|s| s.trim()).unwrap_or("");
        let fmt = if fmt.is_empty() { "L" } else { fmt };
        let kept_instants = env.sibling_instants(&source);
        let column = stream
            .map(|s| s.id.split('#').next().unwrap_or("").to_string())
            .unwrap_or_default();
        for i in 0..count {
            let row = row_of(i);
            if !kept(row) {
                continue;
            }
            let Some(text) = env.sibling_at(&source, row) else {
                continue;
            };
            if text.trim().is_empty() {
                continue;
            }
            let Some(start) =
                date_offset::start_of_row(&column, &gen.attrs, kept_instants.as_ref(), row, &text)?
            else {
                continue;
            };
            let steps = match stream {
                Some(s) => date_offset::draw_steps(offset, &mut per_row::row_generator(s, row)),
                None => date_offset::draw_steps(offset, prng),
            };
            let landed = apply_offset(start, offset, steps);
            stamps[i] = Some(to_epoch_millis(landed));
            out[i] = format::format(landed, Some(fmt), env.config.locale.as_deref());
        }
    }
    if let Some(sink) = instants {
        sink.extend(stamps);
    }
    Ok(out)
}

/// Every column some date offset measures from, wherever the offset stands — a whole column,
/// a `<case>` at any depth, an `if=` branch. Those columns keep the instant they generated, so
/// the offset works from the value whatever `format=` spelled it as.
pub fn offset_sources(config: &Config) -> BTreeSet<String> {
    fn visit(gen: &Gen, out: &mut BTreeSet<String>) {
        if date_offset::is_offset(&gen.gen_type, &gen.attrs) {
            out.insert(date_offset::source_of(&gen.attrs).to_string());
        }
    }
    fn visit_case(case: &Case, out: &mut BTreeSet<String>) {
        for part in &case.parts {
            match part {
                CasePart::Gen(gen) => visit(gen, out),
                CasePart::Mix(mix) => mix.cases.iter().for_each(|c| visit_case(c, out)),
                CasePart::Switch(sw) => visit_switch(sw, out),
                CasePart::Text(_) => {}
            }
        }
    }
    fn visit_switch(sw: &Switch, out: &mut BTreeSet<String>) {
        sw.entries.iter().for_each(|e| visit_case(&e.value, out));
        if let Some(fallback) = &sw.fallback {
            visit_case(fallback, out);
        }
    }
    let mut out = BTreeSet::new();
    for spec in &config.sequences {
        match &spec.source {
            Source::Gen(gen) => visit(gen, &mut out),
            Source::Branches(branches) => branches.iter().for_each(|b| visit(&b.gen, &mut out)),
            Source::Mix(mix) => mix.cases.iter().for_each(|c| visit_case(c, &mut out)),
            Source::Switch(sw) => visit_switch(sw, &mut out),
            _ => {}
        }
    }
    out
}
