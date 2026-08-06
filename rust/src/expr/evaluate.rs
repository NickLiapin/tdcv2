//! Evaluates a parsed [`Expr`] against the row being rendered.
//!
//! Values live in the same three-type world the reference works in: a number, a
//! string, or a boolean. The rules for moving between them are JavaScript's,
//! with one deliberate change the reference also makes — **the string `"false"`
//! counts as false**. Without that, `if="!_last"` would be true on every row,
//! because the string "false" is a non-empty string.

use super::Expr;
use crate::engine::{invalid, EngineResult};
use crate::numbers;

/// What a name resolves to. Separate `has` because an absent name is not empty.
pub trait Scope {
    fn has(&self, name: &str) -> bool;

    /// The value for `name` on the current row; `""` when the row has none.
    fn value(&self, name: &str) -> String;
}

/// The three types an expression works in.
///
/// A Rust enum where the reference uses a dynamically typed value, so the
/// coercion rules below are spelled out rather than inherited from the host
/// language — which is the point: they are JavaScript's rules, and Rust has none
/// of its own to fall back on.
#[derive(Clone, Debug, PartialEq)]
enum V {
    Null,
    Num(f64),
    Str(String),
    Bool(bool),
    /// Only ever produced by an array literal, and only ever consumed by `in`.
    Lst(Vec<V>),
}

pub fn as_condition(source: &str, scope: &dyn Scope) -> EngineResult<bool> {
    // Parsed on every call. The reference caches; caching here would need a lock
    // or a per-run map and buys nothing measurable at the sizes an `if=` runs at.
    let expr = super::parse(source)?;
    Ok(to_boolean(&eval(&expr, scope)?))
}

fn eval(node: &Expr, scope: &dyn Scope) -> EngineResult<V> {
    Ok(match node {
        Expr::Num(n) => V::Num(*n),
        Expr::Str(s) => V::Str(s.clone()),
        Expr::Bool(b) => V::Bool(*b),
        Expr::Null => V::Null,
        // An unknown name is its own value, which is what lets `Gender == Male`
        // go unquoted.
        Expr::Name(n) => {
            if scope.has(n) {
                V::Str(scope.value(n))
            } else {
                V::Str(n.clone())
            }
        }
        Expr::Member(dotted) => member_of(dotted, scope),
        Expr::Unary(op, operand) => unary_op(op, &eval(operand, scope)?)?,
        Expr::Binary(op, left, right) => binary_op(op, &eval(left, scope)?, &eval(right, scope)?)?,
        Expr::Call(name, args) => {
            let mut values = Vec::with_capacity(args.len());
            for arg in args {
                values.push(eval(arg, scope)?);
            }
            call_function(name, &values)?
        }
        Expr::Array(items) => {
            let mut values = Vec::with_capacity(items.len());
            for item in items {
                values.push(eval(item, scope)?);
            }
            V::Lst(values)
        }
        Expr::Conditional(test, consequent, alternate) => {
            let branch = if to_boolean(&eval(test, scope)?) {
                consequent
            } else {
                alternate
            };
            eval(branch, scope)?
        }
        Expr::Computed(_) => {
            return invalid("if expression: computed member access x[i] is not supported")
        }
    })
}

/// `%` — the EUCLIDEAN remainder, always in `[0, |b|)`.
///
/// Not Rust's `%`, which takes the sign of the dividend and answers -1 to
/// `-3 % 2`. The compute layer's `<mod>` answers 1, and one engine must not
/// give two answers depending on which layer the author reached for.
fn euclidean_remainder(a: f64, b: f64) -> EngineResult<f64> {
    if b == 0.0 {
        return invalid("if expression: the right side of % must not be zero");
    }
    let magnitude = b.abs();
    let r = a % magnitude;
    Ok(if r < 0.0 { r + magnitude } else { r })
}

/// The functions an `if=` may call.
///
/// Every one is EXACT — comparisons and the arithmetic IEEE-754 pins down — so
/// the five implementations cannot disagree about a result. `sin`, `cos`, `exp`
/// and the rest are absent for exactly that reason; the validator answers them
/// with it.
///
/// `round` is written out rather than delegated: Rust's `f64::round` already
/// sends a half away from zero, but JavaScript sends it toward +inf and Python
/// to even, so the rule is stated here in every implementation rather than
/// inherited from whichever host happens to agree.
fn call_function(name: &str, args: &[V]) -> EngineResult<V> {
    // Each family coerces its own arguments. The string functions must NOT be
    // numbered: `len("10")` is 2, and a caller that pre-numbered every argument
    // could not tell the two families apart.
    let num = |i: usize| -> EngineResult<f64> {
        args.get(i)
            .map_or_else(|| invalid("if expression: a function was given too few arguments"), |v| Ok(as_number(v)))
    };
    let text = |i: usize| -> EngineResult<String> {
        match args.get(i) {
            None => invalid("if expression: a function was given too few arguments"),
            Some(V::Lst(_)) => invalid("if expression: a string function was given a list"),
            Some(v) => Ok(text(v)),
        }
    };
    Ok(match name {
        "abs" => V::Num(num(0)?.abs()),
        "ceil" => V::Num(num(0)?.ceil()),
        "floor" => V::Num(num(0)?.floor()),
        "trunc" => V::Num(num(0)?.trunc()),
        "round" => {
            let x = num(0)?;
            V::Num(if x < 0.0 { -(-x + 0.5).floor() } else { (x + 0.5).floor() })
        }
        "max" | "min" => {
            if args.is_empty() {
                return invalid("if expression: a function needs at least one argument");
            }
            let wants_max = name == "max";
            let mut best = as_number(&args[0]);
            for v in args.iter().skip(1) {
                let n = as_number(v);
                if (wants_max && n > best) || (!wants_max && n < best) {
                    best = n;
                }
            }
            V::Num(best)
        }
        "contains" => V::Bool(text(0)?.contains(&text(1)?)),
        "ends_with" => V::Bool(text(0)?.ends_with(&text(1)?)),
        "starts_with" => V::Bool(text(0)?.starts_with(&text(1)?)),
        "is_empty" => V::Bool(text(0)?.is_empty()),
        // CODE POINTS, matching Python's len() over str and the reference's
        // spread; Java and C# reach the same count with codePointCount.
        "len" => V::Num(text(0)?.chars().count() as f64),
        "lower" => V::Str(text(0)?.to_lowercase()),
        "upper" => V::Str(text(0)?.to_uppercase()),
        _ => return invalid(&format!("if expression: unknown function \"{name}\"")),
    })
}

/// `A.B` is read three ways, in order: a compound field named "A.B"; else, when
/// "A" is a sequence, the test "is A currently B?" — so `if="Gender.Male"` reads
/// the way `parent="Gender.Male"` does; else the dotted text itself, so a typo
/// shows up verbatim instead of silently becoming empty.
fn member_of(dotted: &str, scope: &dyn Scope) -> V {
    if scope.has(dotted) {
        return V::Str(scope.value(dotted));
    }
    if let Some(dot) = dotted.find('.') {
        if dot > 0 && scope.has(&dotted[..dot]) {
            return V::Bool(scope.value(&dotted[..dot]) == dotted[dot + 1..]);
        }
    }
    V::Str(dotted.to_string())
}

fn unary_op(op: &str, arg: &V) -> EngineResult<V> {
    Ok(match op {
        "!" => V::Bool(!to_boolean(arg)),
        "-" => V::Num(-as_number(arg)),
        "+" => V::Num(as_number(arg)),
        other => {
            return invalid(&format!("if expression: unsupported operator {other}"));
        }
    })
}

fn binary_op(op: &str, left: &V, right: &V) -> EngineResult<V> {
    Ok(match op {
        "==" => V::Bool(loose_equals(left, right)),
        "!=" => V::Bool(!loose_equals(left, right)),
        "===" => V::Bool(strict_equals(left, right)),
        "!==" => V::Bool(!strict_equals(left, right)),
        "<" => V::Bool(as_number(left) < as_number(right)),
        ">" => V::Bool(as_number(left) > as_number(right)),
        "<=" => V::Bool(as_number(left) <= as_number(right)),
        ">=" => V::Bool(as_number(left) >= as_number(right)),
        "&&" => V::Bool(to_boolean(left) && to_boolean(right)),
        "||" => V::Bool(to_boolean(left) || to_boolean(right)),
        // `+` adds when either side is already a number and joins otherwise, as
        // in JavaScript.
        "+" => {
            if matches!(left, V::Num(_)) || matches!(right, V::Num(_)) {
                V::Num(as_number(left) + as_number(right))
            } else {
                V::Str(text(left) + &text(right))
            }
        }
        "-" => V::Num(as_number(left) - as_number(right)),
        "*" => V::Num(as_number(left) * as_number(right)),
        "/" => V::Num(as_number(left) / as_number(right)),
        "%" => V::Num(euclidean_remainder(as_number(left), as_number(right))?),
        // As loose as `==`, deliberately: a text column against a list of numeric
        // words has to match, or `in` and `==` would disagree about the same pair.
        "in" => V::Bool(match right {
            V::Lst(items) => items.iter().any(|candidate| loose_equals(left, candidate)),
            other => loose_equals(left, other),
        }),
        other => {
            return invalid(&format!("if expression: unsupported operator {other}"));
        }
    })
}

/// Loose equality.
///
/// A number against a numeric-looking string compares as NUMBERS, so
/// `_count == 5` works even though `_count` arrives as text; everything else
/// compares as text.
fn loose_equals(left: &V, right: &V) -> bool {
    if let (V::Num(a), V::Str(s)) = (left, right) {
        let b = js_number(s);
        if !b.is_nan() {
            return *a == b;
        }
    }
    if let (V::Str(s), V::Num(b)) = (left, right) {
        let a = js_number(s);
        if !a.is_nan() {
            return a == *b;
        }
    }
    if matches!(left, V::Null) || matches!(right, V::Null) {
        return matches!(left, V::Null) && matches!(right, V::Null);
    }
    if matches!(left, V::Bool(_)) || matches!(right, V::Bool(_)) {
        return as_number(left) == as_number(right);
    }
    if let (V::Num(a), V::Num(b)) = (left, right) {
        return a == b;
    }
    text(left) == text(right)
}

fn strict_equals(left: &V, right: &V) -> bool {
    match (left, right) {
        (V::Null, V::Null) => true,
        (V::Null, _) | (_, V::Null) => false,
        (V::Num(a), V::Num(b)) => a == b,
        (V::Str(a), V::Str(b)) => a == b,
        (V::Bool(a), V::Bool(b)) => a == b,
        // Different types are never strictly equal.
        _ => false,
    }
}

fn to_boolean(v: &V) -> bool {
    match v {
        V::Null => false,
        // The one deliberate departure from JavaScript, and the reference makes
        // it too: the string "false" is falsy. Every boolean column in TDC is
        // text, so without this `if="!_last"` would be true on every row.
        V::Str(s) => !s.is_empty() && s != "false",
        V::Bool(b) => *b,
        V::Num(d) => *d != 0.0 && !d.is_nan(),
        // A list reaches here only if it stood where a condition belongs, which
        // TDC259 refuses before the run. An empty one is false, like an empty
        // string.
        V::Lst(items) => !items.is_empty(),
    }
}

fn as_number(v: &V) -> f64 {
    match v {
        V::Num(d) => *d,
        V::Str(s) => js_number(s),
        V::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        V::Null => f64::NAN,
        V::Lst(_) => f64::NAN,
    }
}

/// `Number(x)` as JavaScript defines it: blank is zero, unreadable is NaN.
fn js_number(raw: &str) -> f64 {
    let s = raw.trim();
    if s.is_empty() {
        return 0.0;
    }
    if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
        return i64::from_str_radix(hex, 16).map_or(f64::NAN, |v| v as f64);
    }
    // Rust's own parser accepts things JavaScript does not read as numbers:
    // `inf`, `NaN`, and a leading `+` on some forms. Refusing them here is what
    // keeps `if="Age > inf"` behaving the same everywhere.
    if s.chars().any(|c| c.is_alphabetic()) && !s.contains('e') && !s.contains('E') {
        return f64::NAN;
    }
    s.parse::<f64>()
        .map(|n| if n.is_infinite() { f64::NAN } else { n })
        .unwrap_or(f64::NAN)
}

/// `String(x)`: a whole number prints without a decimal point, as in JavaScript.
fn text(v: &V) -> String {
    match v {
        V::Null => "null".to_string(),
        V::Num(d) => numbers::to_text(*d),
        V::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        V::Str(s) => s.clone(),
        V::Lst(items) => items.iter().map(text).collect::<Vec<_>>().join(","),
    }
}
