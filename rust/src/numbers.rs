//! Numbers written the way the reference writes them.
//!
//! JavaScript's `toFixed` rounds a tie **away from zero**. Rust's `{:.n}`
//! rounds a tie **to even**. They disagree on exactly the values a money column
//! is full of:
//!
//! | value | `toFixed(1)` | `format!("{:.1}")` |
//! |---|---|---|
//! | `0.25` | `0.3` | `0.2` |
//! | `-0.25` | `-0.3` | `-0.2` |
//! | `0.125` (to 2) | `0.13` | `0.12` |
//!
//! So it is written out. The Python port hit this first and its note is worth
//! repeating: the tie is decided on the number the double **actually holds**,
//! not on the short decimal that prints back as it. Those two rules disagree
//! more often than they look like they should — `1.005` is stored as
//! `1.00499999999999989…`, so it rounds DOWN to `1.00`, and a port that rounded
//! the printed `"1.005"` would answer `1.01` and diverge on every price.
//!
//! Getting that right means working with the double's exact decimal expansion,
//! which always terminates: a finite double is `m × 2^e`, and for `e < 0` that
//! is `m × 5^|e|` over `10^|e|`. So the expansion is computed exactly, in
//! decimal, and rounded there.

/// `value` as JavaScript's `String(value)` would write it.
///
/// The rule that catches a port out: a whole number carries no decimal point.
/// `100`, never `100.0` — and every diagnostic that quotes a number compares as
/// text.
pub fn to_text(value: f64) -> String {
    if value.is_nan() {
        return "NaN".to_string();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if value == value.trunc() && value.abs() < 1e21 {
        // `-0` prints as `0` in JavaScript.
        let whole = value as i64;
        return whole.to_string();
    }
    let mut s = format!("{value}");
    if s.contains('e') {
        // Rust writes `1e21`; JavaScript writes `1e+21`.
        s = s.replace('e', "e+").replace("e+-", "e-");
    }
    s
}

/// `value` rounded to `decimals` places, as JavaScript's `toFixed` rounds it.
pub fn to_fixed(value: f64, decimals: usize) -> String {
    if value.is_nan() || value.is_infinite() || value.abs() >= 1e21 {
        return to_text(value);
    }

    let negative = value < 0.0;
    let (mut digits, point) = exact_decimal(value.abs());
    round_half_up(&mut digits, point, decimals);

    // `point` is how many of `digits` sit before the decimal point. Rounding may
    // have carried into a new leading digit, which `round_half_up` reports by
    // pushing one on the front — so it is read back rather than remembered.
    let point = digits.len() - decimals;
    let whole: String = digits[..point].iter().map(|d| (b'0' + d) as char).collect();
    let whole = whole.trim_start_matches('0');
    let whole = if whole.is_empty() { "0" } else { whole };

    let mut out = String::new();
    // The sign comes from the INPUT, not from the result: `(-0.0001).toFixed(2)`
    // is `"-0.00"`, a signed zero that says the value was below it. What does
    // NOT get a sign is `-0` itself, and that falls out of `negative` being
    // `value < 0.0` — which is false for `-0.0`, in Rust as in JavaScript.
    if negative {
        out.push('-');
    }
    out.push_str(whole);
    if decimals > 0 {
        out.push('.');
        for d in &digits[point..] {
            out.push((b'0' + d) as char);
        }
    }
    out
}

/// The exact decimal digits of a non-negative finite double, and how many of
/// them sit before the point.
///
/// Exact, not approximate. A double is `m × 2^e`; for `e < 0` that is
/// `m × 5^|e| / 10^|e|`, so multiplying the mantissa by five `|e|` times gives
/// the complete expansion with `|e|` fractional digits. Nothing is rounded here,
/// which is the whole point — the rounding decision is made afterwards, on
/// digits that are the number rather than a printed approximation of it.
fn exact_decimal(value: f64) -> (Vec<u8>, usize) {
    debug_assert!(value >= 0.0 && value.is_finite());

    let bits = value.to_bits();
    let raw_exponent = ((bits >> 52) & 0x7FF) as i32;
    let raw_mantissa = bits & 0x000F_FFFF_FFFF_FFFF;
    let (mantissa, exponent) = if raw_exponent == 0 {
        // Subnormal: no implicit leading one, and a fixed exponent.
        (raw_mantissa, -1074i32)
    } else {
        (raw_mantissa | 0x0010_0000_0000_0000, raw_exponent - 1075)
    };

    // Big-endian decimal digits of the mantissa.
    let mut digits: Vec<u8> = if mantissa == 0 {
        vec![0]
    } else {
        mantissa.to_string().bytes().map(|b| b - b'0').collect()
    };

    if exponent >= 0 {
        for _ in 0..exponent {
            multiply_small(&mut digits, 2);
        }
        let len = digits.len();
        return (digits, len);
    }

    let fractional = (-exponent) as usize;
    for _ in 0..fractional {
        multiply_small(&mut digits, 5);
    }
    // Left-pad so there are at least `fractional` digits after the point.
    while digits.len() <= fractional {
        digits.insert(0, 0);
    }
    let point = digits.len() - fractional;
    (digits, point)
}

/// Multiply a big-endian decimal digit vector by a single digit.
fn multiply_small(digits: &mut Vec<u8>, factor: u8) {
    let mut carry = 0u32;
    for d in digits.iter_mut().rev() {
        let v = u32::from(*d) * u32::from(factor) + carry;
        *d = (v % 10) as u8;
        carry = v / 10;
    }
    while carry > 0 {
        digits.insert(0, (carry % 10) as u8);
        carry /= 10;
    }
}

/// Cut the expansion to `decimals` fractional digits, ties away from zero.
///
/// The sign was taken off before this, so "away from zero" is simply "up".
fn round_half_up(digits: &mut Vec<u8>, point: usize, decimals: usize) {
    let keep = point + decimals;
    if digits.len() <= keep {
        // Shorter than asked for: pad rather than round.
        digits.resize(keep, 0);
        return;
    }

    let first_dropped = digits[keep];
    let rest_nonzero = digits[keep + 1..].iter().any(|d| *d != 0);
    digits.truncate(keep);

    // Half-up: a five rounds up whether or not anything follows it. `rest` is
    // read anyway, because it is what distinguishes a genuine tie from a value
    // that merely prints like one — and that distinction is the reason these
    // digits are exact rather than formatted.
    let _tie = first_dropped == 5 && !rest_nonzero;
    if first_dropped < 5 {
        return;
    }

    let mut at = digits.len();
    loop {
        if at == 0 {
            digits.insert(0, 1);
            return;
        }
        at -= 1;
        if digits[at] == 9 {
            digits[at] = 0;
        } else {
            digits[at] += 1;
            return;
        }
    }
}
