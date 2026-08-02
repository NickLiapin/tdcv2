//! The value model of the compute layer: three types, and no more.
//!
//! An integer, a string, or a list of those. No boolean and no floating point —
//! deliberately. Every check digit in the world is integer arithmetic over the
//! characters of a string, and a float in that computation is a way to get the
//! wrong answer on one number in a million and never find out which.
//!
//! The reference holds integers in an arbitrary-precision type and range-checks
//! them to signed 64 bits. Rust has no big integer in its standard library, so
//! they are held in `i128` instead — which is exactly enough: the guard rejects
//! anything outside `i64`, and the only way to exceed `i128` before reaching the
//! guard would be to multiply two values that are themselves already out of
//! range. Every arithmetic step is checked, so that cannot happen.

/// Anything the compute layer refuses to do, with the reason it refused.
#[derive(Clone, Debug)]
pub struct ComputeError {
    pub message: String,
}

impl std::fmt::Display for ComputeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ComputeError {}

pub type ComputeResult<T> = Result<T, ComputeError>;

pub fn err<T>(message: impl Into<String>) -> ComputeResult<T> {
    Err(ComputeError {
        message: message.into(),
    })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    Int(i128),
    Str(String),
    Lst(Vec<Value>),
}

impl Value {
    pub fn int(v: i128) -> ComputeResult<Value> {
        Ok(Value::Int(guard64(v)?))
    }

    pub fn str(v: impl Into<String>) -> Value {
        Value::Str(v.into())
    }
}

/// `^-?[0-9]+$`
pub fn is_integer_text(s: &str) -> bool {
    let digits = s.strip_prefix('-').unwrap_or(s);
    !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())
}

pub fn guard64(v: i128) -> ComputeResult<i128> {
    if v < i64::MIN as i128 || v > i64::MAX as i128 {
        return err(format!(
            "integer overflow: {v} is outside the signed 64-bit range"
        ));
    }
    Ok(v)
}

/// Coerce to an integer for arithmetic.
///
/// A *single* digit character coerces, because iterating a string yields
/// characters and summing them is the whole point. A multi-digit string does
/// not: `"12"` in an arithmetic slot is far more often a mistake than an
/// intention, so it has to say `<to_number>` out loud.
pub fn as_int(value: &Value, context: &str) -> ComputeResult<i128> {
    match value {
        Value::Int(i) => Ok(*i),
        Value::Str(s) => {
            let mut chars = s.chars();
            if let (Some(c), None) = (chars.next(), chars.next()) {
                if c.is_ascii_digit() {
                    return Ok(i128::from(c as u8 - b'0'));
                }
            }
            let hint = if is_integer_text(s) {
                " — wrap it in <to_number> to convert a multi-digit string"
            } else {
                ""
            };
            err(format!(
                "expected an integer in {context}, got the string \"{s}\"{hint}"
            ))
        }
        Value::Lst(_) => err(format!("expected an integer in {context}, got a list")),
    }
}

/// An int or a string renders to text. A list never does.
pub fn as_str(value: &Value) -> ComputeResult<String> {
    match value {
        Value::Str(s) => Ok(s.clone()),
        Value::Int(i) => Ok(i.to_string()),
        Value::Lst(_) => err("cannot use a list where a string is expected"),
    }
}

pub fn to_output(value: &Value) -> ComputeResult<String> {
    match value {
        Value::Lst(_) => err("compute result must be an int or str, not a list"),
        other => as_str(other),
    }
}

pub fn parse_int_strict(s: &str) -> ComputeResult<i128> {
    if !is_integer_text(s) {
        return err(format!("<to_number>: \"{s}\" is not a valid integer"));
    }
    match s.parse::<i128>() {
        Ok(v) => guard64(v),
        Err(_) => err(format!(
            "integer overflow: {s} is outside the signed 64-bit range"
        )),
    }
}

/// Euclidean remainder — always in `[0, |b|)`.
///
/// Not the host language's `%`: Rust, C#, Java and JavaScript all give a
/// negative remainder for a negative dividend, Python does not, and a check
/// digit computed with the wrong sign convention is wrong only for some inputs.
/// Pinning it here makes every implementation agree.
pub fn modulo(a: i128, b: i128) -> ComputeResult<i128> {
    if b == 0 {
        return err("<mod>: the modulus (second child) must not be zero");
    }
    let m = b.abs();
    let r = a % m;
    Ok(if r < 0 { r + m } else { r })
}

/// Integer division that rounds toward negative infinity.
pub fn floor_div(a: i128, b: i128) -> ComputeResult<i128> {
    if b == 0 {
        return err("<divide>: the divisor (second child) must not be zero");
    }
    let mut q = a / b;
    let r = a % b;
    if r != 0 && ((a < 0) != (b < 0)) {
        q -= 1;
    }
    Ok(q)
}
