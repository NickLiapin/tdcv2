//! Evaluates a parsed [`Expr`] against the row being rendered.
//!
//! Values live in the same three-type world the reference works in: a number, a
//! string, or a boolean. The rules for moving between them are JavaScript's,
//! with one deliberate change the reference also makes — **the string `"false"`
//! counts as false**. Without that, `if="!_last"` would be true on every row,
//! because the string "false" is a non-empty string.

use std::borrow::Cow;
use std::cmp::Ordering;

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
pub enum V {
    Null,
    Num(f64),
    /// A whole number, kept exact.
    ///
    /// A double holds every integer up to 2^53 and then starts skipping. Past
    /// that point two DIFFERENT whole numbers become the same double, and an
    /// expression built on doubles alone answers accordingly:
    ///
    /// ```text
    /// 9007199254740993 == 9007199254740992   ->  true
    /// 9007199254740993 -  9007199254740992   ->  0
    /// ```
    ///
    /// Both wrong, and wrong silently — the worst way for a data generator to
    /// be wrong, since the run finishes and the file looks fine. The domain is
    /// signed 64-bit, matching the compute layer, because i64 is the widest
    /// integer all five implementations hold natively.
    Int(i64),
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

/// What `source` evaluates TO on this row, rather than whether it holds.
///
/// The same evaluator as `as_condition` and deliberately so: a distribution parameter
/// and a formula must not come to mean different things from the same words as a
/// condition does.
pub fn as_value(source: &str, scope: &dyn Scope) -> EngineResult<V> {
    let expr = super::parse(source)?;
    eval(&expr, scope)
}

fn eval(node: &Expr, scope: &dyn Scope) -> EngineResult<V> {
    Ok(match node {
        Expr::Num(n) => V::Num(*n),
        Expr::Int(n) => V::Int(*n),
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
        args.get(i).map_or_else(
            || invalid("if expression: a function was given too few arguments"),
            |v| Ok(as_number(v)),
        )
    };
    let text = |i: usize| -> EngineResult<String> {
        match args.get(i) {
            None => invalid("if expression: a function was given too few arguments"),
            Some(V::Lst(_)) => invalid("if expression: a string function was given a list"),
            Some(v) => Ok(text(v)),
        }
    };
    // A whole number already IS its own rounding, whatever its size, and taking it
    // through an f64 first throws the answer away past 2^53. Arithmetic stayed exact,
    // so the value arrives intact and must not be destroyed on the way out.
    let whole = |i: usize| -> Option<i64> { args.get(i).and_then(as_exact_int) };
    Ok(match name {
        "abs" => match whole(0) {
            Some(w) => V::Int(checked_int(w.checked_abs(), i128::from(w).abs())?),
            None => V::Num(num(0)?.abs()),
        },
        "ceil" => match whole(0) {
            Some(w) => V::Int(w),
            None => V::Num(num(0)?.ceil()),
        },
        "floor" => match whole(0) {
            Some(w) => V::Int(w),
            None => V::Num(num(0)?.floor()),
        },
        "trunc" => match whole(0) {
            Some(w) => V::Int(w),
            None => V::Num(num(0)?.trunc()),
        },
        "round" => match whole(0) {
            Some(w) => V::Int(w),
            None => {
                let x = num(0)?;
                V::Num(if x < 0.0 {
                    -(-x + 0.5).floor()
                } else {
                    (x + 0.5).floor()
                })
            }
        },
        "max" | "min" => {
            // One list argument spread out, or the arguments themselves — so
            // max(split(Prices, ",")) and max(1, 9, 4) both work.
            let spread: &[V] = match args {
                [V::Lst(items)] => items,
                other => other,
            };
            if spread.is_empty() {
                return invalid("if expression: a function needs at least one argument");
            }
            let wants_max = name == "max";
            // Exact while EVERY argument is whole. One float among them and the whole
            // comparison falls to floating point, which is honest: there is no exact
            // ordering between a big integer and a float that is not one.
            let whole: Option<Vec<i64>> = spread.iter().map(as_exact_int).collect();
            match whole {
                Some(numbers) => {
                    let mut best = numbers[0];
                    for n in numbers.into_iter().skip(1) {
                        if (wants_max && n > best) || (!wants_max && n < best) {
                            best = n;
                        }
                    }
                    V::Int(best)
                }
                None => {
                    let mut best = as_number(&spread[0]);
                    for v in spread.iter().skip(1) {
                        let n = as_number(v);
                        if (wants_max && n > best) || (!wants_max && n < best) {
                            best = n;
                        }
                    }
                    V::Num(best)
                }
            }
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
        // Lists inside one row. A sequence with repeat= puts several values in
        // one field, and an expression sees the JOINED text because that is what
        // the field holds — so `split` is the bridge and everything else works
        // on lists. No grammar changed: the list value already existed, made by
        // an array literal and consumed by `in`.
        "split" => V::Lst(split_text(&text(0)?, &text(1)?)),
        "join" => {
            let separator = text(1)?;
            let parts: Vec<String> = list_of(args, 0).iter().map(self::text).collect();
            V::Str(parts.join(&separator))
        }
        // How many. `len` is the STRING length and would answer about the separators.
        "count" => V::Num(list_of(args, 0).len() as f64),
        "at" => {
            let items = list_value(args, 0)?;
            let index = index_value(args, 1)?;
            items
                .get(index)
                .cloned()
                .unwrap_or_else(|| V::Str(String::new()))
        }
        "sum" => sum_of(&list_of(args, 0))?,
        "mean" => V::Num(mean_of(&list_of(args, 0))),
        "median" => V::Num(median_of(&list_of(args, 0))),
        "stddev" => V::Num(stddev_of(&list_of(args, 0))),
        "zeta" => V::Num(crate::math::zeta(num(0)?)),
        // Transcendentals, computed by TDC rather than by Rust — see math/mod.rs.
        // Adding one here means adding it to TdcMath in all five, not calling
        // the host's f64 method.
        "acos" => V::Num(crate::math::acos(num(0)?)),
        "acosh" => V::Num(crate::math::acosh(num(0)?)),
        "asin" => V::Num(crate::math::asin(num(0)?)),
        "asinh" => V::Num(crate::math::asinh(num(0)?)),
        "atan" => V::Num(crate::math::atan(num(0)?)),
        "atanh" => V::Num(crate::math::atanh(num(0)?)),
        "beta" => V::Num(crate::math::beta(num(0)?, num(1)?)),
        "atan2" => V::Num(crate::math::atan2(num(0)?, num(1)?)),
        "cbrt" => V::Num(crate::math::cbrt(num(0)?)),
        // x held inside [lo, hi], as min(max(x, lo), hi): with the bounds handed
        // over backwards the CEILING wins. Testing `x < lo` first reads the same
        // and is not — it lets the floor win. NOT f64::clamp, which panics when
        // lo > hi instead of answering.
        "clamp" => {
            let (x, lo, hi) = (num(0)?, num(1)?, num(2)?);
            let floored = if x > lo { x } else { lo };
            V::Num(if floored < hi { floored } else { hi })
        }
        "cos" => V::Num(crate::math::cos(num(0)?)),
        "degrees" => V::Num(crate::math::degrees(num(0)?)),
        "digamma" => V::Num(crate::math::digamma(num(0)?)),
        "cosh" => V::Num(crate::math::cosh(num(0)?)),
        "erf" => V::Num(crate::math::erf(num(0)?)),
        "erfc" => V::Num(crate::math::erfc(num(0)?)),
        "exp" => V::Num(crate::math::exp(num(0)?)),
        "expm1" => V::Num(crate::math::expm1(num(0)?)),
        "gamma" => V::Num(crate::math::gamma(num(0)?)),
        // exp(-((x - centre) / width)^2). `t * t`, not powf(t, 2.0): multiplication
        // is exact under IEEE-754 and pow is not, so this is cheaper and identical
        // in all five for free.
        "gauss" => {
            let t = (num(0)? - num(1)?) / num(2)?;
            V::Num(crate::math::exp(-(t * t)))
        }
        // The replacement for the shader sin-trick: cyrb128 + sfc32 keyed by the
        // two arguments' IEEE-754 bit patterns, so no transcendental call per row.
        "hash" => V::Num(crate::prng::seekable::hash_unit(num(0)?, num(1)?)),
        "hypot" => V::Num(crate::math::hypot(num(0)?, num(1)?)),
        // a * (1 - t) + b * t, not a + (b - a) * t: only this form lands exactly on
        // both endpoints. Measured over 200,000 random pairs, the naive one misses
        // b at t=1 in 41 per cent of them.
        "lerp" => {
            let t = num(2)?;
            V::Num(num(0)? * (1.0 - t) + num(1)? * t)
        }
        "lgamma" => V::Num(crate::math::lgamma(num(0)?)),
        "log" => V::Num(crate::math::log(num(0)?)),
        "log10" => V::Num(crate::math::log10(num(0)?)),
        "log1p" => V::Num(crate::math::log1p(num(0)?)),
        "log2" => V::Num(crate::math::log2(num(0)?)),
        "pow" => V::Num(crate::math::pow(num(0)?, num(1)?)),
        "sin" => V::Num(crate::math::sin(num(0)?)),
        "radians" => V::Num(crate::math::radians(num(0)?)),
        "sign" => V::Num(crate::math::sign(num(0)?)),
        "sinh" => V::Num(crate::math::sinh(num(0)?)),
        "sqrt" => V::Num(crate::math::sqrt(num(0)?)),
        "tanh" => V::Num(crate::math::tanh(num(0)?)),
        "tan" => V::Num(crate::math::tan(num(0)?)),
        _ => return invalid(&format!("if expression: unknown function \"{name}\"")),
    })
}

/// Text to a list. An empty subject gives an empty list, not a list of one blank.
fn split_text(subject: &str, separator: &str) -> Vec<V> {
    if subject.is_empty() {
        return Vec::new();
    }
    if separator.is_empty() {
        // CODE POINTS, the same unit `len` counts, so split(s, "") and len(s)
        // never disagree about how many characters a string has.
        return subject.chars().map(|c| V::Str(c.to_string())).collect();
    }
    subject
        .split(separator)
        .map(|p| V::Str(p.to_string()))
        .collect()
}

/// An argument as a list.
///
/// A bare value counts as a list of one, so `sum(Price)` on a single number is
/// an answer rather than an error — the alternative is a rule a caller has to
/// remember before every call.
fn list_of(args: &[V], index: usize) -> Cow<'_, [V]> {
    match args.get(index) {
        Some(V::Lst(items)) => Cow::Borrowed(items),
        Some(V::Null) | None => Cow::Owned(Vec::new()),
        Some(v) => Cow::Owned(vec![v.clone()]),
    }
}

/// `at`'s subject, which has to be a real list.
///
/// `list_of` above reads a bare value as a list of one, which is right for
/// `sum(Price)` and wrong here: a `repeat` list arrives as the JOINED text, so
/// `at(Items, 1)` — the shape everybody writes first — used to ask for the
/// second element of a one-element list and get the same empty string a
/// legitimately short row gives. Naming the mistake is the point.
fn list_value(args: &[V], index: usize) -> EngineResult<&[V]> {
    match args.get(index) {
        Some(V::Lst(items)) => Ok(items),
        None => invalid("if expression: a function was given too few arguments"),
        Some(v) => invalid(&format!(
            "at() needs a list, and {} is a single value — split it first, \
             as in at(split(Items, \",\"), 1)",
            show(v)
        )),
    }
}

/// An index: a whole number, zero or more. Anything else is a mistake, not a shape.
fn index_value(args: &[V], index: usize) -> EngineResult<usize> {
    let Some(raw) = args.get(index) else {
        return invalid("if expression: a function was given too few arguments");
    };
    let n = as_number(raw);
    if !n.is_finite() || n.fract() != 0.0 || n < 0.0 {
        return invalid(&format!(
            "at() index must be a whole number of zero or more, not {}",
            show(raw)
        ));
    }
    Ok(n as usize)
}

/// A value as it should read inside a message: text quoted, everything else plain.
fn show(v: &V) -> String {
    match v {
        V::Str(s) => format!("\"{s}\""),
        V::Lst(_) => "a list".to_string(),
        V::Null => "nothing".to_string(),
        other => text(other),
    }
}

/// The total. Whole while every element is whole, so a column of ids stays exact.
fn sum_of(items: &[V]) -> EngineResult<V> {
    let whole: Option<Vec<i64>> = items.iter().map(as_exact_int).collect();
    if let Some(parts) = whole {
        if !parts.is_empty() {
            let wide: i128 = parts.iter().map(|&n| i128::from(n)).sum();
            let narrow = parts.iter().try_fold(0i64, |acc, &n| acc.checked_add(n));
            return Ok(V::Int(checked_int(narrow, wide)?));
        }
    }
    Ok(V::Num(items.iter().map(as_number).sum()))
}

/// The average. Always a double: a mean is a ratio, and ratios are not whole.
fn mean_of(items: &[V]) -> f64 {
    if items.is_empty() {
        return f64::NAN;
    }
    items.iter().map(as_number).sum::<f64>() / items.len() as f64
}

/// The middle value; with an even count, the average of the two middle ones.
fn median_of(items: &[V]) -> f64 {
    if items.is_empty() {
        return f64::NAN;
    }
    let mut sorted: Vec<f64> = items.iter().map(as_number).collect();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    let half = sorted.len() / 2;
    if sorted.len() % 2 == 1 {
        sorted[half]
    } else {
        (sorted[half - 1] + sorted[half]) / 2.0
    }
}

/// The POPULATION standard deviation — divided by n, not by n-1.
///
/// A generated list is the whole of what it describes, not a sample drawn from
/// something larger, so n is the honest divisor. Stated because the two differ
/// and neither is the obvious default.
fn stddev_of(items: &[V]) -> f64 {
    if items.is_empty() {
        return f64::NAN;
    }
    let values: Vec<f64> = items.iter().map(as_number).collect();
    let average = values.iter().sum::<f64>() / values.len() as f64;
    let variance = values
        .iter()
        .map(|v| (v - average) * (v - average))
        .sum::<f64>()
        / values.len() as f64;
    crate::math::sqrt(variance)
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
        "-" => match as_exact_int(arg) {
            Some(whole) => V::Int(checked_int(whole.checked_neg(), -i128::from(whole))?),
            None => V::Num(-as_number(arg)),
        },
        "+" => match as_exact_int(arg) {
            Some(whole) => V::Int(whole),
            None => V::Num(as_number(arg)),
        },
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
        "<" => V::Bool(match both_whole(left, right) {
            Some((a, b)) => a < b,
            None => as_number(left) < as_number(right),
        }),
        ">" => V::Bool(match both_whole(left, right) {
            Some((a, b)) => a > b,
            None => as_number(left) > as_number(right),
        }),
        "<=" => V::Bool(match both_whole(left, right) {
            Some((a, b)) => a <= b,
            None => as_number(left) <= as_number(right),
        }),
        ">=" => V::Bool(match both_whole(left, right) {
            Some((a, b)) => a >= b,
            None => as_number(left) >= as_number(right),
        }),
        "&&" => V::Bool(to_boolean(left) && to_boolean(right)),
        "||" => V::Bool(to_boolean(left) || to_boolean(right)),
        // `+` adds when either side is already a number and joins otherwise, as
        // in JavaScript.
        "+" => match both_whole(left, right) {
            Some((a, b)) => V::Int(checked_int(
                a.checked_add(b),
                i128::from(a) + i128::from(b),
            )?),
            None => {
                if matches!(left, V::Num(_)) || matches!(right, V::Num(_)) {
                    V::Num(as_number(left) + as_number(right))
                } else {
                    V::Str(text(left) + &text(right))
                }
            }
        },
        "-" => match both_whole(left, right) {
            Some((a, b)) => V::Int(checked_int(
                a.checked_sub(b),
                i128::from(a) - i128::from(b),
            )?),
            None => V::Num(as_number(left) - as_number(right)),
        },
        "*" => match both_whole(left, right) {
            Some((a, b)) => V::Int(checked_int(
                a.checked_mul(b),
                i128::from(a) * i128::from(b),
            )?),
            None => V::Num(as_number(left) * as_number(right)),
        },
        // Division alone stays in floating point, always. It is not closed over
        // the whole numbers — 7/2 is not one — and a rule that came out exact
        // only when the division happened to be even would be a rule nobody
        // could hold in their head.
        "/" => V::Num(as_number(left) / as_number(right)),
        "%" => match both_whole(left, right) {
            // Euclidean, like the double path and like <mod> in compute.
            Some((a, b)) if b != 0 => {
                let r = a % b;
                V::Int(if r < 0 { r + b.abs() } else { r })
            }
            _ => V::Num(euclidean_remainder(as_number(left), as_number(right))?),
        },
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
    // Two whole numbers compare as whole numbers, whichever shape they arrived
    // in — a generated id is a string, the literal beside it is not.
    if let Some((a, b)) = both_whole(left, right) {
        return a == b;
    }
    // A number the config WROTE, beside text that reads as one. Both shapes of
    // number count, and the whole-number half is the repair of a bug that had
    // every money column silently failing its own equality test: `Total == 100`
    // was false while `Total > 99` was true, because 100 is a whole number and
    // "100.00" is not, so the two never met.
    if is_written(left) {
        if let V::Str(s) = right {
            let b = js_number(s);
            if !b.is_nan() {
                return as_number(left) == b;
            }
        }
    }
    if is_written(right) {
        if let V::Str(s) = left {
            let a = js_number(s);
            if !a.is_nan() {
                return a == as_number(right);
            }
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
    // Two texts stay text, whatever they look like: an empty column and a blank
    // one are not equal even though both read as zero. Only a literal drags a
    // column into numbers.
    text(left) == text(right)
}

/// A number as the config wrote it, rather than as a column produced it.
fn is_written(v: &V) -> bool {
    matches!(v, V::Num(_) | V::Int(_))
}

/* ── The two equalities ──────────────────────────────────────────────────────
 *
 * A TDC column is TEXT. Every generator produces text, every built-in is text,
 * and the only things that are not text are the literals someone writes inside
 * an expression. So "are these equal?" has two honest readings, and TDC gives
 * each one its own operator — the shape Perl settled on for the same reason,
 * where a scalar is likewise text that might be a number:
 *
 *     ==   the same NUMBER   "01" == 1     true
 *     ===  the same TEXT     "01" === 1    false
 *
 * `===` used to be the host language's identity test — "same type AND same
 * value". That is a fine question in a language with types and a meaningless
 * one here, because there is only ever one type: `N === 1` was false for EVERY
 * number on every row, silently, with `check` passing.
 */

/// `===` — do both sides print the same characters?
///
/// A list never matches, itself included: `in` is the operator for lists, and
/// TDC259 refuses one anywhere else before the run. Answering false keeps all
/// five implementations saying the same thing rather than leaving each host's
/// idea of list equality to decide it.
fn strict_equals(left: &V, right: &V) -> bool {
    if matches!(left, V::Lst(_)) || matches!(right, V::Lst(_)) {
        return false;
    }
    strict_text(left) == strict_text(right)
}

/// The characters a value prints as.
///
/// Nothing — an absent column, the `null` literal — is the EMPTY text, the same
/// thing a column that produced no value holds. One rule instead of two: absent
/// is empty, here and in `to_boolean` and in the output.
fn strict_text(v: &V) -> String {
    match v {
        V::Null => String::new(),
        V::Str(s) => s.clone(),
        V::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        // Printed from the integer itself, not through a double: past 2^53 the
        // round trip would put back the digit the exact domain exists to keep.
        V::Int(n) => n.to_string(),
        V::Num(d) => numbers::to_text(*d),
        // Unreachable: a list is turned away by `strict_equals` above.
        V::Lst(_) => String::new(),
    }
}

/// What counts as TRUE — for a bare `if="X"`, and for `!`, `&&` and `||`.
///
/// Two texts are false and every other text is true:
///
/// ```text
/// ""       false    the column produced nothing
/// "false"  false    a flag column saying no
/// "0"      TRUE     zero is a value, not an absence
/// ```
///
/// That is Lua's and Ruby's rule — only "nothing" and "no" are false — carried
/// into a language whose single carrier is text. `_last`, `_first` and every
/// `anomaly_flag` column hold literally "true" or "false", so without this
/// `if="!_last"` would be true on every row including the last.
fn to_boolean(v: &V) -> bool {
    match v {
        V::Null => false,
        V::Str(s) => !s.is_empty() && s != "false",
        V::Int(n) => *n != 0,
        V::Bool(b) => *b,
        V::Num(d) => *d != 0.0 && !d.is_nan(),
        // A list reaches here only if it stood where a condition belongs, which
        // TDC259 refuses before the run. An empty one is false, like an empty
        // string.
        V::Lst(items) => !items.is_empty(),
    }
}

/// A value seen as an exact whole number, or `None` if it is not one.
fn as_exact_int(v: &V) -> Option<i64> {
    match v {
        V::Int(n) => Some(*n),
        V::Str(s) => {
            let body = s.strip_prefix(['+', '-']).unwrap_or(s);
            if body.is_empty() || !body.bytes().all(|b| b.is_ascii_digit()) {
                return None;
            }
            s.parse::<i64>().ok()
        }
        // A double is admitted only while it is still exact. Past 2^53 it has
        // already lost the answer, and calling it exact would be the same lie
        // in a different place.
        V::Num(d) => {
            if d.fract() == 0.0 && d.abs() <= 9_007_199_254_740_991.0 {
                Some(*d as i64)
            } else {
                None
            }
        }
        _ => None,
    }
}

/// Both operands as exact whole numbers, or `None` if either is not one.
fn both_whole(left: &V, right: &V) -> Option<(i64, i64)> {
    Some((as_exact_int(left)?, as_exact_int(right)?))
}

/// The result of whole-number arithmetic, refused rather than wrapped.
///
/// The refusal NAMES the value, as the compute layer's does. Reaching it needs
/// arithmetic wider than the domain, so `wide` is computed only once the fast
/// path has already said no — the ordinary case never pays for it.
fn checked_int(v: Option<i64>, wide: i128) -> EngineResult<i64> {
    match v {
        Some(n) => Ok(n),
        None => invalid(&format!(
            "integer overflow: {wide} is outside the signed 64-bit range"
        )),
    }
}

fn as_number(v: &V) -> f64 {
    match v {
        V::Num(d) => *d,
        // A whole number handed to something that works in floating point —
        // sqrt, log, sin. Past 2^53 this loses digits, which is the honest
        // answer: those functions have no exact one to give.
        V::Int(n) => *n as f64,
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
        // Printed from the integer itself, not through a double: past 2^53 the
        // round trip would put back the digit the domain exists to keep.
        V::Int(n) => n.to_string(),
        V::Bool(b) => if *b { "true" } else { "false" }.to_string(),
        V::Str(s) => s.clone(),
        V::Lst(items) => items.iter().map(text).collect::<Vec<_>>().join(","),
    }
}
