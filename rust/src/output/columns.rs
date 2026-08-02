//! The typed columns a `<block>` declares, and the types they carry.
//!
//! A `<data>` with a `name` is a column; one without is decorative text and
//! columnar output ignores it. Which `<line>` it sits on does not matter — the
//! columns are every named `<data>` in document order. That keeps the text block
//! and the schema the same construct, so a config gains typed output without
//! learning a second way to describe itself.
//!
//! A column's type is resolved in one order, and the order is the point: an
//! explicit `type=` wins; failing that, the generator feeding the column is
//! asked; failing that, it is text. Nothing is ever guessed from the rendered
//! values, because that is exactly how `007` turns into `7`.

use std::collections::BTreeSet;

use crate::model::{Config, Gen, Mix, SequenceSpec, Source};
use crate::output::column_type::{ColumnType, Kind, TypeError};

/// One declared column: its name, the text it renders from, and its type if it
/// declared one.
#[derive(Clone, Debug)]
pub struct Declared {
    pub name: String,
    pub template: String,
    pub ty: Option<ColumnType>,
}

/// A column's type, resolved.
///
/// `None` for a column with no declared type whose source cannot be told
/// confidently — the caller falls back to text, which never corrupts anything.
pub fn resolve(column: &Declared, config: &Config) -> Option<ColumnType> {
    if let Some(ty) = &column.ty {
        return Some(ty.clone());
    }
    let inject = config.inject.as_deref().unwrap_or("${{%}}");
    let source = sole_reference(&column.template, inject)?;
    derive_output(&source, config)
}

/// The single sequence a template refers to, when it is exactly one substitution
/// and nothing else (`${{Id}}`).
///
/// Composite text has no single source type: `${{First}} ${{Last}}` is a
/// sentence, not a number that happens to be spelled with a space in it.
pub fn sole_reference(template: &str, inject: &str) -> Option<String> {
    let marker = inject.find('%')?;
    let prefix = &inject[..marker];
    let suffix = &inject[marker + 1..];
    let text = template.trim();
    if !text.starts_with(prefix) || !text.ends_with(suffix) {
        return None;
    }

    let inner = &text[prefix.len()..text.len() - suffix.len()];
    // A second marker means more than one substitution, or literal text between
    // them.
    if inner.is_empty() || inner.contains(prefix) || inner.contains('|') {
        return None;
    }
    Some(inner.trim().to_string())
}

/// The type of a column fed by `name`, as a LIST when its generator repeats.
///
/// A repeating generator puts several values in one cell, so the column is a
/// list of whatever one value would have been. When the element cannot be typed
/// the list survives anyway — `repeat` says this IS a list, and flattening it
/// back into comma-joined text would throw away structure that is known for
/// certain.
pub fn derive_output(name: &str, config: &Config) -> Option<ColumnType> {
    let element = derive(name, config);
    if separator_of(name, config).is_none() {
        return element;
    }
    let inner = match &element {
        Some(ty) => spell(ty),
        None => element_fallback(name, config),
    };
    ColumnType::parse_output(&format!("[]{inner}")).ok()
}

/// A column's type from the generator that feeds it, or `None` when it cannot be
/// told.
///
/// The reliable middle step: a column that came from `type="number"` with no
/// decimals is an int64, which is knowledge rather than inference. Everything
/// uncertain returns nothing and becomes text.
pub fn derive(name: &str, config: &Config) -> Option<ColumnType> {
    // A ground-truth flag column is minted by a gen's anomaly_flag or a
    // <mix flag=>, and is never declared as a <sequence> of its own — so it has
    // to be found by looking.
    for spec in &config.sequences {
        if let Source::Mix(mix) = &spec.source {
            if mix.flag.as_deref().map(str::trim) == Some(name) {
                return ColumnType::parse("bool").ok();
            }
        }
        for gen in gens_of(spec) {
            if gen.attr("anomaly_flag").map(str::trim) == Some(name) {
                return ColumnType::parse("bool").ok();
            }
        }
    }

    let named = spec_named(name, config)?;
    match &named.source {
        Source::Mix(mix) => derive_mix(mix, config),
        Source::Gen(gen) => derive_gen(gen, config),
        _ => None,
    }
}

/// The rules for one generator, shared between a plain sequence and a mix's
/// cases.
fn derive_gen(gen: &Gen, config: &Config) -> Option<ColumnType> {
    // Output formatting rewrites the text, so the value is no longer of its raw
    // type.
    if gen.attrs.contains_key("mask") || gen.attrs.contains_key("case") {
        return None;
    }

    let nullable = gen.attr("missing").is_some_and(positive);

    match gen.gen_type.as_str() {
        "number" | "timeseries" => {
            with_nullable(if decimals(gen) > 0 { "double" } else { "int64" }, nullable)
        }
        "increment" | "decrement" => with_nullable("int64", nullable),
        // The default rendering is locale-shaped (05/25/1996), not ISO, so a
        // date column is only safe to infer when the config asked for ISO.
        // Otherwise it stays text, and the author can still say type="date" if
        // they mean it.
        "date" if gen.attr("format") == Some("YYYY-MM-DD") => with_nullable("date", nullable),
        "template" if gen.attr_or("value", "").ends_with(".uuid") => {
            with_nullable("uuid", nullable)
        }
        _ => {
            let _ = config;
            None
        }
    }
}

/// A `<mix>` column's type, when every branch agrees on one.
///
/// Deliberately strict: each case must be exactly one generator, and all of them
/// must derive to the same type. A mix of a number and a word is text, and any
/// doubt falls back to text — the rule that keeps a leading zero from being
/// optimised away.
fn derive_mix(mix: &Mix, config: &Config) -> Option<ColumnType> {
    if mix.cases.is_empty() {
        return None;
    }
    let mut agreed: Option<ColumnType> = None;
    for case in &mix.cases {
        let [crate::model::CasePart::Gen(gen)] = case.parts.as_slice() else {
            return None;
        };
        let ty = derive_gen(gen, config)?;
        match &agreed {
            None => agreed = Some(ty),
            Some(current) if current.kind == ty.kind && current.nullable == ty.nullable => {}
            Some(_) => return None,
        }
    }
    agreed
}

/// The separator of the generator feeding `name`, or `None` when it does not
/// repeat.
///
/// A list column splits its rendered text on exactly this, so the text view and
/// the typed view can never disagree about where one value ends and the next
/// begins.
pub fn separator_of(name: &str, config: &Config) -> Option<String> {
    let gen = spec_named(name, config)?.gen()?;
    if gen.attr_or("repeat", "").trim().is_empty() {
        return None;
    }
    Some(gen.attr_or("separator", ",").to_string())
}

/// The element type for a repeating generator whose values cannot be typed.
///
/// Text stays text, but `missing=` still makes the ELEMENT nullable — that is
/// what it blanks.
fn element_fallback(name: &str, config: &Config) -> String {
    let nullable = spec_named(name, config)
        .and_then(SequenceSpec::gen)
        .and_then(|gen| gen.attr("missing"))
        .is_some_and(positive);
    if nullable { "string|null" } else { "string" }.to_string()
}

/// Refuse a duplicate name before anything is written — two columns cannot share
/// one.
pub fn check_unique(columns: &[Declared]) -> Result<(), TypeError> {
    let mut seen: BTreeSet<&str> = BTreeSet::new();
    for column in columns {
        if !seen.insert(&column.name) {
            return Err(TypeError(format!(
                "duplicate column name \"{}\"",
                column.name
            )));
        }
    }
    Ok(())
}

fn spec_named<'a>(name: &str, config: &'a Config) -> Option<&'a SequenceSpec> {
    config.sequences.iter().find(|spec| spec.name == name)
}

fn gens_of(spec: &SequenceSpec) -> Vec<&Gen> {
    match &spec.source {
        Source::Gen(gen) => vec![gen],
        Source::Fields(fields) => fields.iter().map(|f| &f.gen).collect(),
        _ => Vec::new(),
    }
}

fn with_nullable(ty: &str, nullable: bool) -> Option<ColumnType> {
    let spelled = if nullable {
        format!("{ty}|null")
    } else {
        ty.to_string()
    };
    ColumnType::parse(&spelled).ok()
}

/// A resolved type written back out, so a list can be spelled around it.
fn spell(ty: &ColumnType) -> String {
    let head = match ty.kind {
        Kind::Decimal => format!("decimal({},{})", ty.precision, ty.scale),
        Kind::Bool => "bool".to_string(),
        Kind::Int32 => "int32".to_string(),
        Kind::Int64 => "int64".to_string(),
        Kind::UInt8 => "uint8".to_string(),
        Kind::UInt16 => "uint16".to_string(),
        Kind::UInt32 => "uint32".to_string(),
        Kind::UInt64 => "uint64".to_string(),
        Kind::Float => "float".to_string(),
        Kind::Float16 => "float16".to_string(),
        Kind::Double => "double".to_string(),
        Kind::String => "string".to_string(),
        Kind::Enum => "enum".to_string(),
        Kind::Date => "date".to_string(),
        Kind::Timestamp => "timestamp".to_string(),
        Kind::Uuid => "uuid".to_string(),
        Kind::Json => "json".to_string(),
        Kind::List => "list".to_string(),
    };
    if ty.nullable {
        format!("{head}|null")
    } else {
        head
    }
}

fn decimals(gen: &Gen) -> i32 {
    gen.attr_or("decimals", "0").parse::<f64>().unwrap_or(0.0) as i32
}

fn positive(raw: &str) -> bool {
    raw.trim().parse::<f64>().is_ok_and(|v| v > 0.0)
}
