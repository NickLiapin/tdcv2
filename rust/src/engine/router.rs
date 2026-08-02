//! Which engine a config gets.
//!
//! The engines are not interchangeable. They draw in different orders, so the
//! same seed lands on different values — that is documented behaviour, not a
//! defect. Which means routing is part of the contract: rendering a config on
//! engine 1 when the reference would have used engine 2 produces output that is
//! wrong in every row while looking perfectly plausible.
//!
//! A config does not name an engine — it states a constraint, and the router
//! picks the fastest engine that can honour it. `mode="memory"` means the whole
//! run may be held at once; `mode="disk"` means it may not. Naming an engine
//! outright with `engine="1|2|3"` skips all of this, which is what makes it
//! useful for a benchmark and a poor default for everything else.
//!
//! The interesting decisions are the ones that route a disk-mode config back to
//! memory. Each marks something whose answer depends on the whole column — an
//! interpolated pack address, an exact share declared inside a pack, a weighted
//! draw of a linked row. Answered a row at a time they do not fail; they quietly
//! produce data that is wrong in a way nobody notices, which is the worst
//! outcome available and the reason these checks exist.

use super::{invalid, EngineResult};
use crate::generators::advanced_regex;
use crate::model::{Config, Gen, SequenceSpec, Source};

/// The engine a config runs on: 1 in memory, 2 streaming, 3 exact on disk.
///
/// The pack-driven rule — a pack generator that declares its own shares — is not
/// consulted yet, because packs are not loaded yet. It is named here rather than
/// forgotten: until it lands, such a config routes to 2 where the reference
/// routes it to 1.
pub fn resolve(config: &Config) -> EngineResult<u8> {
    if let Some(forced) = trim_to_none(config.engine.as_deref()) {
        return match forced {
            "1" => Ok(1),
            "2" => Ok(2),
            "3" => Ok(3),
            other => invalid(&format!(
                "invalid engine \"{other}\" — expected \"1\" (in-memory), \"2\" (streaming), \
                 or \"3\" (exact-on-disk)"
            )),
        };
    }

    match trim_to_none(config.mode.as_deref()) {
        Some("memory") => return Ok(1),
        // "stream" is the old name for asking for Engine 2 outright, from before
        // mode described the constraint rather than the engine. Kept working;
        // the router is not consulted.
        Some("stream") => return Ok(2),
        Some(other) if other != "disk" => {
            return invalid(&format!(
                "invalid mode \"{other}\" — expected \"memory\" or \"disk\""
            ))
        }
        // No mode at all means disk: a config says how big its run is, not how
        // to hold it, and the engine that can stream is the right default for a
        // generator whose whole point is volume.
        _ => {}
    }

    // A template address that names a field resolves per row against the other
    // columns; only the in-memory engine has them all.
    if any_gen(config, |gen| {
        gen.gen_type == "template" && is_dynamic(gen.attr_or("value", ""))
    }) {
        return Ok(1);
    }

    // weight= with row= draws a linked record to an exact quota, which needs the
    // global total.
    if any_gen(config, |gen| {
        gen.gen_type == "file"
            && trim_to_none(gen.attr("weight")).is_some()
            && trim_to_none(gen.attr("row")).is_some()
    }) {
        return Ok(1);
    }

    // A network call is not reproducible, so it never runs on the reproducible
    // path.
    // uniq on a DRAWN value takes WITHOUT REPLACEMENT — simple or composed alike — the pool and the
    // taken-set span the whole column, which only the in-memory engine holds.
    let counting = |t: &str| t == "increment" || t == "decrement";
    if config.sequences.iter().any(|s| {
        use crate::model::config::{Item, Source};
        s.uniq
            && match &s.source {
                Source::Gen(gen) => !counting(&gen.gen_type),
                Source::Items(items) => items
                    .iter()
                    .any(|i| matches!(i, Item::Gen(gen) if !counting(&gen.gen_type))),
                _ => false,
            }
    }) {
        return Ok(1);
    }
    if any_gen(config, |gen| gen.gen_type == "http") {
        return Ok(1);
    }

    Ok(if needs_exact(config) { 3 } else { 2 })
}

/// Whether disk mode needs the exact engine rather than the streaming one.
///
/// Everything here is a case where a per-row answer and a whole-column answer
/// differ: exact percentages combined with uniqueness, a uniq field that is not
/// a finite list, a child of a parent whose values are not a finite list, a
/// weighted choice inside a pattern. Ordinary exact percentages, uniform
/// uniqueness, switch, distinct and text parent-child all stream.
pub fn needs_exact(config: &Config) -> bool {
    for spec in &config.sequences {
        if spec.uniq {
            if trim_to_none(spec.parent.as_deref()).is_some() {
                return true;
            }
            for field in fields_of(spec) {
                if field.gen_type != "text" || has_percent(field) {
                    return true;
                }
            }
        }

        if let Source::Gen(gen) = &spec.source {
            if is_weighted_advanced_regex(gen) {
                return true;
            }
        }
        if fields_of(spec).into_iter().any(is_weighted_advanced_regex) {
            return true;
        }

        if let Some(parent) = trim_to_none(spec.parent.as_deref()) {
            if !parent_is_finite_text(config, parent) {
                return true;
            }
        }
    }
    false
}

fn parent_is_finite_text(config: &Config, reference: &str) -> bool {
    let name = match reference.find('.') {
        Some(dot) => &reference[..dot],
        None => reference,
    };
    config
        .sequence(name)
        .and_then(SequenceSpec::gen)
        .is_some_and(|gen| gen.gen_type == "text")
}

/// A `<gen type="advanced_regex">` whose pattern weights its branches —
/// `(?%{70:RU;20:US;10:DE})`.
///
/// A weighted choice is an exact share over the whole column, so it cannot be
/// answered one row at a time. Decided by parsing the pattern and counting, not
/// by searching for the opener: `(?%{` can also appear inside a character class,
/// where it is four ordinary characters.
fn is_weighted_advanced_regex(gen: &Gen) -> bool {
    gen.gen_type == "advanced_regex"
        && advanced_regex::has_weighted_choice(gen.attr_or("value", ""))
}

fn has_percent(gen: &Gen) -> bool {
    !gen.attr_or("percent", "").is_empty()
}

/// `common.vehicle.model.${{Brand}}` — an address not known until the row is.
fn is_dynamic(value: &str) -> bool {
    value.contains("${{")
}

/// Every `<gen>` in the config, simple or a compound's field.
fn any_gen(config: &Config, test: impl Fn(&Gen) -> bool) -> bool {
    config.sequences.iter().any(|spec| match &spec.source {
        Source::Gen(gen) => test(gen),
        Source::Fields(fields) => fields.iter().any(|f| test(&f.gen)),
        _ => false,
    })
}

/// A compound's fields, or nothing — a simple sequence has none rather than an
/// empty list.
fn fields_of(spec: &SequenceSpec) -> Vec<&Gen> {
    match &spec.source {
        Source::Fields(fields) => fields.iter().map(|f| &f.gen).collect(),
        _ => Vec::new(),
    }
}

fn trim_to_none(value: Option<&str>) -> Option<&str> {
    let trimmed = value?.trim();
    (!trimmed.is_empty()).then_some(trimmed)
}
