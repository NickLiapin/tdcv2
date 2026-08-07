//! The `<compute>` layer — a declarative little language for check digits.
//!
//! Real identifiers are not random strings. A tax number, an IBAN, a national
//! ID: each carries a check digit computed from the rest of itself, and a
//! generated one without it is rejected by the very system it was generated to
//! test. This is what makes the difference between data that merely looks right
//! and data that passes validation.
//!
//! It is a language rather than a list of built-in algorithms because there is
//! no such list. Every country invented its own weighting, and a data pack that
//! can express the rule can add a country without touching the engine — which is
//! exactly how the bundled packs do it.
//!
//! **The parse tree is the syntax tree.** The evaluator walks the config
//! elements directly. That is not a shortcut, it is the portability contract:
//! every implementation walks the same shape, so there is no expression grammar
//! for anyone to re-implement slightly differently.
//!
//! Pure: no clock, no randomness, no files. Its only inputs are the fields
//! visible to it.

pub mod encode;
pub mod value;

use std::collections::BTreeMap;

use value::{as_int, as_str, err, ComputeResult, Value};

use crate::format::{mask, transforms};
use crate::parser::ast::{Element, Kind};

/// What an evaluation can see: the sequence values in scope, by name.
pub trait Fields {
    fn get(&self, name: &str) -> Option<String>;
}

/// Bindings and the contextual values that exist only inside an iteration.
#[derive(Clone)]
struct Scope<'a> {
    fields: &'a dyn Fields,
    vars: BTreeMap<String, Value>,
    current: Option<Value>,
    current_index: Option<i128>,
    acc: Option<Value>,
}

impl<'a> Scope<'a> {
    fn new(fields: &'a dyn Fields) -> Self {
        Self {
            fields,
            vars: BTreeMap::new(),
            current: None,
            current_index: None,
            acc: None,
        }
    }

    fn with_var(&self, name: &str, value: Value) -> Scope<'a> {
        let mut next = self.clone();
        next.vars.insert(name.to_string(), value);
        // The whole scope carries over: a <let> inside an iteration must not
        // drop current/acc.
        next
    }

    fn with_iteration(&self, item: Value, index: i128, accumulator: Option<Value>) -> Scope<'a> {
        let mut next = self.clone();
        next.current = Some(item);
        next.current_index = Some(index);
        next.acc = accumulator;
        next
    }
}

/// Evaluate a `<compute>` element to its output string.
pub fn evaluate(compute_el: &Element, fields: &dyn Fields) -> ComputeResult<String> {
    let scope = Scope::new(fields);
    value::to_output(&eval_slot(&compute_el.children, &scope)?)
}

/// Evaluate a `<valid>` element's predicate.
///
/// Some identifiers have combinations that are structurally impossible — a date
/// that does not exist inside a national ID, a region code that was never
/// issued. A pack draws again rather than emitting one.
pub fn evaluate_predicate(valid_el: &Element, fields: &dyn Fields) -> ComputeResult<bool> {
    let scope = Scope::new(fields);
    for child in &valid_el.children {
        if is_element(child) {
            return eval_predicate(child, &scope);
        }
    }
    err("<valid> requires a predicate child")
}

// ── slots ────────────────────────────────────────────────────────────────────

/// A slot: any number of `<let>` bindings followed by exactly one value
/// expression.
///
/// Bindings accumulate, so a later `<let>` and the final expression both see the
/// earlier ones — which is what lets a long check-digit computation be written
/// as a series of named steps instead of one unreadable nest.
fn eval_slot(children: &[Element], scope: &Scope) -> ComputeResult<Value> {
    let mut local = scope.clone();
    let mut result: Option<Value> = None;
    for child in children.iter().filter(|c| is_element(c)) {
        if child.name == "let" {
            let bound = eval_slot(&child.children, &local)?;
            local = local.with_var(child.attr_value("name").unwrap_or(""), bound);
        } else {
            result = Some(eval(child, &local)?);
        }
    }
    match result {
        Some(value) => Ok(value),
        None => err("empty expression slot: no value produced"),
    }
}

fn eval_wrapper(n: &Element, wrapper: &str, scope: &Scope) -> ComputeResult<Value> {
    eval_slot(&require_child(n, wrapper)?.children, scope)
}

// ── the evaluator ────────────────────────────────────────────────────────────

/// The builtin row counters, which are numbers rather than text. `_first` and
/// `_last` are deliberately absent: they are the strings "true" and "false".
const NUMERIC_BUILTIN_FIELDS: [&str; 2] = ["_count", "_total"];

fn eval(el: &Element, scope: &Scope) -> ComputeResult<Value> {
    let attr = |name: &str| el.attr_value(name);
    let children: Vec<&Element> = el.children.iter().filter(|c| is_element(c)).collect();

    match el.name.as_str() {
        // literals
        "int" => {
            let raw = attr("v").unwrap_or("");
            if !value::is_integer_text(raw) {
                return err(format!("<int>: \"{raw}\" is not an integer"));
            }
            match raw.parse::<i128>() {
                Ok(v) => Value::int(v),
                Err(_) => err(format!(
                    "integer overflow: {raw} is outside the signed 64-bit range"
                )),
            }
        }
        "str" => Ok(Value::str(attr("v").unwrap_or(""))),
        "list" => {
            if let Some(raw) = attr("v") {
                let mut literal = Vec::new();
                for part in raw.split(',') {
                    let p = part.trim();
                    if p.is_empty() {
                        continue;
                    }
                    if !value::is_integer_text(p) {
                        return err(format!("<list>: \"{p}\" is not an integer"));
                    }
                    literal.push(Value::int(p.parse::<i128>().unwrap_or(i128::MAX))?);
                }
                return Ok(Value::Lst(literal));
            }
            let mut built = Vec::with_capacity(children.len());
            for c in &children {
                built.push(eval(c, scope)?);
            }
            Ok(Value::Lst(built))
        }

        // references
        "field" => {
            let name = attr("name").unwrap_or("");
            match scope.fields.get(name) {
                // A sequence's value is text, and `coerce_int` deliberately refuses
                // a multi-digit string so that "the third character" and "the number
                // 375" stay different things. The row counters are not text: `_count`
                // and `_total` are numbers by nature. Without this they were strings,
                // so the single-digit escape hatch carried them to row 9 and the
                // tenth row failed. `_first` and `_last` stay out — they are the
                // words "true" and "false".
                Some(v) if NUMERIC_BUILTIN_FIELDS.contains(&name) => match v.parse::<i128>() {
                    Ok(n) => Value::int(n),
                    Err(_) => Ok(Value::str(v)),
                },
                Some(v) => Ok(Value::str(v)),
                None => err(format!("<field>: \"{name}\" is not in scope")),
            }
        }
        "var" => {
            let name = attr("name").unwrap_or("");
            match scope.vars.get(name) {
                Some(v) => Ok(v.clone()),
                None => err(format!("<var>: \"{name}\" is not bound")),
            }
        }
        "current" => match &scope.current {
            Some(v) => Ok(v.clone()),
            None => err("<current/> used outside an iteration"),
        },
        "current_index" => match scope.current_index {
            Some(i) => Value::int(i),
            None => err("<current_index/> used outside an iteration"),
        },
        "acc" => match &scope.acc {
            Some(v) => Ok(v.clone()),
            None => err("<acc/> used outside a <reduce>"),
        },
        "let" => err("<let> is a binding prefix, not a value expression"),

        // collections
        "each" => {
            let items = iterable_of(&eval_wrapper(el, "over", scope)?)?;
            let body = require_child(el, "do")?;
            let mut mapped = Vec::with_capacity(items.len());
            for (i, item) in items.into_iter().enumerate() {
                mapped.push(eval_slot(
                    &body.children,
                    &scope.with_iteration(item, i as i128, None),
                )?);
            }
            Ok(Value::Lst(mapped))
        }
        "reduce" => {
            let items = iterable_of(&eval_wrapper(el, "over", scope)?)?;
            let body = require_child(el, "do")?;
            let mut acc = eval_wrapper(el, "init", scope)?;
            for (i, item) in items.into_iter().enumerate() {
                acc = eval_slot(
                    &body.children,
                    &scope.with_iteration(item, i as i128, Some(acc.clone())),
                )?;
            }
            Ok(acc)
        }
        "join" => {
            let sep = attr("sep").unwrap_or("");
            let Value::Lst(list) = eval_slot(&el.children, scope)? else {
                return err("<join>: expected a list");
            };
            let parts: ComputeResult<Vec<String>> = list.iter().map(as_str).collect();
            Ok(Value::str(parts?.join(sep)))
        }
        // The exact inverse of `join`, and the fourth way to get a list.
        //
        // Before it there were three — a literal `<list v="…">`, the result of `<each>`, and a
        // string walked CHARACTER by character — and none of them could read back a column that
        // `repeat=` had joined. So "sum quantity x price over the lines of this order" could not
        // be said at all unless the two lists happened to have the same length.
        "split" => {
            let sep = attr("sep").unwrap_or("");
            // An empty separator is refused rather than given a meaning. Rust would answer with
            // an empty piece at each end, JavaScript with every character, Python not at all —
            // so any reading here would make one implementation disagree with the rest. Walking
            // a string character by character already has a spelling: `<over>` takes a string.
            if sep.is_empty() {
                return err(
                    "<split>: sep= is empty — to walk a string character by character, put it in \
                     <over> directly, which is what an empty separator would have to mean",
                );
            }
            let Value::Str(text) = eval_slot(&el.children, scope)? else {
                return err("<split>: expected a string, got a list");
            };
            Ok(Value::Lst(
                text.split(sep).map(|piece| Value::str(piece)).collect(),
            ))
        }
        "at" => {
            let Value::Lst(list) = eval_wrapper(el, "in", scope)? else {
                return err("<at>: <in> must be a list");
            };
            let idx = as_int(&eval_wrapper(el, "index", scope)?, "<at> index")?;
            if idx >= 0 && (idx as usize) < list.len() {
                return Ok(list[idx as usize].clone());
            }
            match attr("default") {
                Some(dflt) => Value::int(value::parse_int_strict(dflt)?),
                None => err(format!(
                    "<at>: index {idx} is out of range and no default is set"
                )),
            }
        }
        "length" => match eval_slot(&el.children, scope)? {
            Value::Str(s) => Value::int(s.chars().count() as i128),
            Value::Lst(l) => Value::int(l.len() as i128),
            Value::Int(_) => err("<length>: expected a string or list"),
        },

        // arithmetic
        "add" => {
            let mut sum: i128 = 0;
            for c in &children {
                sum += as_int(&eval(c, scope)?, "<add>")?;
            }
            Value::int(sum)
        }
        "multiply" => {
            let mut product: i128 = 1;
            for c in &children {
                product *= as_int(&eval(c, scope)?, "<multiply>")?;
            }
            Value::int(product)
        }
        "subtract" => {
            if children.is_empty() {
                return err("<subtract> requires at least one child");
            }
            let mut acc = as_int(&eval(children[0], scope)?, "<subtract>")?;
            for c in &children[1..] {
                acc -= as_int(&eval(c, scope)?, "<subtract>")?;
            }
            Value::int(acc)
        }
        "mod" => {
            let two = require_two(el, &children)?;
            Value::int(value::modulo(
                as_int(&eval(two[0], scope)?, "arithmetic")?,
                as_int(&eval(two[1], scope)?, "arithmetic")?,
            )?)
        }
        "divide" => {
            let two = require_two(el, &children)?;
            Value::int(value::floor_div(
                as_int(&eval(two[0], scope)?, "arithmetic")?,
                as_int(&eval(two[1], scope)?, "arithmetic")?,
            )?)
        }

        // conversion
        "encode" => {
            let Value::Str(s) = eval_slot(&el.children, scope)? else {
                return err("<encode>: expected a single-character string");
            };
            Ok(Value::str(encode::encode_char(
                &s,
                attr("as").unwrap_or(""),
            )?))
        }
        "to_number" => Value::int(value::parse_int_strict(&as_str(&eval_slot(
            &el.children,
            scope,
        )?)?)?),
        "pad" => {
            let width = int_attr(el, "width", 0)?;
            let fill = attr("fill").unwrap_or("0");
            Ok(Value::str(pad_start(
                &as_str(&eval_slot(&el.children, scope)?)?,
                width,
                fill,
            )))
        }
        "concat" => {
            let mut text = String::new();
            for c in &children {
                text.push_str(&as_str(&eval(c, scope)?)?);
            }
            Ok(Value::str(text))
        }

        // text
        "upper" | "lower" | "capitalize" | "title" => Ok(Value::str(transforms::apply_case(
            &el.name,
            &as_str(&eval_slot(&el.children, scope)?)?,
        ))),
        "mask" => {
            let text = as_str(&eval_slot(&el.children, scope)?)?;
            match mask::apply(attr("pattern").unwrap_or(""), &text) {
                Ok(v) => Ok(Value::str(v)),
                Err(e) => err(e.message().to_string()),
            }
        }
        "slice" => {
            let to = match attr("to") {
                None => None,
                Some(raw) => match raw.trim().parse::<i32>() {
                    Ok(v) => Some(v),
                    Err(_) => return err("<slice>: \"to\" must be a whole number"),
                },
            };
            Ok(Value::str(transforms::slice(
                &as_str(&eval_slot(&el.children, scope)?)?,
                int_attr(el, "from", 0)?,
                to,
            )))
        }
        "replace" => {
            let from = attr("from").unwrap_or("");
            let text = as_str(&eval_slot(&el.children, scope)?)?;
            Ok(Value::str(if from.is_empty() {
                text
            } else {
                text.replace(from, attr("to").unwrap_or(""))
            }))
        }
        "trim" => Ok(Value::str(
            as_str(&eval_slot(&el.children, scope)?)?.trim().to_string(),
        )),
        "group" => Ok(Value::str(transforms::group(
            &as_str(&eval_slot(&el.children, scope)?)?,
            int_attr(el, "size", 3)?,
            attr("sep").unwrap_or(" "),
        ))),

        "choose" => eval_choose(el, scope),

        // Role wrappers carry no meaning of their own; they name a slot.
        "result" | "do" | "over" | "init" | "in" | "index" | "then" | "otherwise" => {
            eval_slot(&el.children, scope)
        }

        other => err(format!("unknown compute tag <{other}>")),
    }
}

fn eval_choose(n: &Element, scope: &Scope) -> ComputeResult<Value> {
    let mut otherwise: Option<&Element> = None;
    for child in n.children.iter().filter(|c| is_element(c)) {
        if child.name == "when" {
            if eval_test(require_child(child, "test")?, scope)? {
                return eval_slot(&require_child(child, "then")?.children, scope);
            }
        } else if child.name == "otherwise" {
            otherwise = Some(child);
        }
    }
    match otherwise {
        Some(o) => eval_slot(&o.children, scope),
        None => err("<choose>: no <when> matched and no <otherwise> present"),
    }
}

fn eval_test(test: &Element, scope: &Scope) -> ComputeResult<bool> {
    match test.children.iter().find(|c| is_element(c)) {
        Some(first) => eval_predicate(first, scope),
        None => err("<test> requires a predicate child"),
    }
}

fn eval_predicate(el: &Element, scope: &Scope) -> ComputeResult<bool> {
    let children: Vec<&Element> = el.children.iter().filter(|c| is_element(c)).collect();
    match el.name.as_str() {
        "equals" | "greater_than" | "less_than" => {
            let two = require_two(el, &children)?;
            let context = format!("<{}>", el.name);
            let x = as_int(&eval(two[0], scope)?, &context)?;
            let y = as_int(&eval(two[1], scope)?, &context)?;
            Ok(match el.name.as_str() {
                "equals" => x == y,
                "greater_than" => x > y,
                _ => x < y,
            })
        }
        "is_digit" => {
            let Some(first) = children.first() else {
                return err("<is_digit> requires a child");
            };
            Ok(match eval(first, scope)? {
                Value::Str(s) => {
                    let mut chars = s.chars();
                    matches!((chars.next(), chars.next()), (Some(c), None) if c.is_ascii_digit())
                }
                _ => false,
            })
        }
        other => err(format!(
            "unknown predicate <{other}> (valid only inside <test>)"
        )),
    }
}

// ── tree helpers ─────────────────────────────────────────────────────────────

/// A string iterates by CODE POINT, a list by element. Anything else cannot be
/// walked.
fn iterable_of(value: &Value) -> ComputeResult<Vec<Value>> {
    match value {
        Value::Str(s) => Ok(s.chars().map(|c| Value::str(c.to_string())).collect()),
        Value::Lst(l) => Ok(l.clone()),
        Value::Int(_) => err("<over>: expected a string or list to iterate"),
    }
}

/// A `<data>` or `<map>` body has no meaning inside `<compute>`; only tags do.
fn is_element(el: &Element) -> bool {
    matches!(el.kind, Kind::OpenClose | Kind::SelfClosing)
}

fn require_child<'a>(n: &'a Element, name: &str) -> ComputeResult<&'a Element> {
    match n.children.iter().find(|c| is_element(c) && c.name == name) {
        Some(child) => Ok(child),
        None => err(format!("<{}> requires a <{name}> child", n.name)),
    }
}

fn require_two<'a>(n: &Element, children: &'a [&'a Element]) -> ComputeResult<&'a [&'a Element]> {
    if children.len() != 2 {
        return err(format!("<{}> requires exactly 2 children", n.name));
    }
    Ok(children)
}

fn int_attr(n: &Element, name: &str, fallback: i32) -> ComputeResult<i32> {
    let Some(raw) = n.attr_value(name) else {
        return Ok(fallback);
    };
    if raw.trim().is_empty() {
        return Ok(fallback);
    }
    match raw.trim().parse::<i32>() {
        Ok(v) => Ok(v),
        Err(_) => err(format!("<{}>: \"{name}\" must be a whole number", n.name)),
    }
}

/// Pad on the left by code point, so a multi-character fill repeats and then
/// truncates.
fn pad_start(value: &str, width: i32, fill: &str) -> String {
    let length = value.chars().count() as i32;
    if length >= width || fill.is_empty() {
        return value.to_string();
    }
    let needed = (width - length) as usize;
    let mut pad = String::new();
    while pad.chars().count() < needed {
        pad.push_str(fill);
    }
    let head: String = pad.chars().take(needed).collect();
    head + value
}
