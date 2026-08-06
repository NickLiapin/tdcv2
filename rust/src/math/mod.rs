//! TdcMath — the transcendental functions, computed by TDC rather than by Rust.
//!
//! IEEE-754 pins down `+`, `-`, `*`, `/` and `sqrt`: each has exactly one legal
//! answer, so every language agrees. It says nothing about `sin`, `cos`, `exp`,
//! `log` or `powf` — every libm picks its own algorithm — and the difference is
//! real. Measured on one machine:
//!
//! ```text
//! tan(1)      Node 3ff8eb245cbee3a6   Python 3ff8eb245cbee3a5
//! cos(1000)   Node 3fe1ff026793f1bb   Python 3fe1ff026793f1bc
//! ```
//!
//! In `timeseries` that never shows, because every number is rounded to a
//! decimal string before it becomes output. An `if=` has no rounding step, so a
//! comparison turns that bit into a different row and a different file.
//!
//! **Nothing here may call a transcendental of the host.** No `f64::sin`, no
//! `f64::exp`, no `powf`. Only `+ - * /`, `f64::sqrt` (correctly rounded by the
//! standard, verified equal across the implementations), and the exact
//! operations `abs` and `trunc`.
//!
//! Every line mirrors `typescript/src/math/tdc-math.ts` in the same ORDER of
//! operations. That order is the contract: float addition is not associative,
//! so regrouping a sum would change the last bit and break the shared case that
//! compares them.

pub const PI: f64 = 3.141592653589793;
pub const E: f64 = 2.718281828459045;

// ln 2, split so `k * LN2_HI` keeps the low bits a single constant would drop.
const LN2_HI: f64 = 0.693_147_180_369_123_8;
const LN2_LO: f64 = 1.908_214_929_270_587_7e-10;
const LN2: f64 = 0.693_147_180_559_945_3;

// pi/2 in three pieces: a single rounded pi/2 loses most of the significant
// digits of sin(1000) before the series starts.
const PIO2: f64 = 1.570_796_326_794_896_6;
const PIO2_1: f64 = 1.570_796_326_734_125_6;
const PIO2_2: f64 = 6.077_100_506_506_192e-11;
const PIO2_3: f64 = 2.022_266_248_795_950_6e-21;

const SIN_COEFF: [f64; 7] = [
    -1.0 / 6.0,
    1.0 / 120.0,
    -1.0 / 5040.0,
    1.0 / 362_880.0,
    -1.0 / 39_916_800.0,
    1.0 / 6_227_020_800.0,
    -1.0 / 1_307_674_368_000.0,
];

const COS_COEFF: [f64; 7] = [
    -1.0 / 2.0,
    1.0 / 24.0,
    -1.0 / 720.0,
    1.0 / 40320.0,
    -1.0 / 3_628_800.0,
    1.0 / 479_001_600.0,
    -1.0 / 87_178_291_200.0,
];

const EXP_OVERFLOW: f64 = 709.782_712_893_384;
const EXP_UNDERFLOW: f64 = -745.133_219_101_941_1;

/// Delegated: IEEE-754 requires square root to be correctly rounded, so there
/// is one legal answer and every implementation must give it.
pub fn sqrt(x: f64) -> f64 {
    if x.is_nan() || x < 0.0 {
        return f64::NAN;
    }
    x.sqrt()
}

/// `value * 2^n` by exact doubling — a power of two is exact in binary.
fn scale_by_power_of_two(value: f64, n: i64) -> f64 {
    let mut out = value;
    let mut k = n;
    while k > 0 {
        out *= 2.0;
        k -= 1;
    }
    while k < 0 {
        out /= 2.0;
        k += 1;
    }
    out
}

/// `exp(x)` — range-reduced to `2^k * e^r` with |r| <= ln2/2, then Taylor.
pub fn exp(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    if x > EXP_OVERFLOW {
        return f64::INFINITY;
    }
    if x < EXP_UNDERFLOW {
        return 0.0;
    }
    let k = (x / LN2 + if x >= 0.0 { 0.5 } else { -0.5 }).trunc();
    let r = x - k * LN2_HI - k * LN2_LO;
    let mut term = 1.0f64;
    let mut total = 1.0f64;
    for i in 1..=13 {
        term = term * r / f64::from(i);
        total += term;
    }
    scale_by_power_of_two(total, k as i64)
}

/// `log(x)` — `x = m * 2^e` by exact halving, then `2*atanh((m-1)/(m+1))`.
pub fn log(x: f64) -> f64 {
    if x.is_nan() || x < 0.0 {
        return f64::NAN;
    }
    if x == 0.0 {
        return f64::NEG_INFINITY;
    }
    if x == f64::INFINITY {
        return f64::INFINITY;
    }
    let mut m = x;
    let mut e = 0.0f64;
    while m >= 1.414_213_562_373_095_1 {
        m /= 2.0;
        e += 1.0;
    }
    while m < 0.707_106_781_186_547_6 {
        m *= 2.0;
        e -= 1.0;
    }
    let s = (m - 1.0) / (m + 1.0);
    let s2 = s * s;
    let mut total = 0.0f64;
    let mut i = 25;
    while i >= 1 {
        total = total * s2 + 1.0 / f64::from(i);
        i -= 2;
    }
    2.0 * s * total + e * LN2_HI + e * LN2_LO
}

pub fn log10(x: f64) -> f64 {
    log(x) / 2.302_585_092_994_046
}

/// The quadrant (0-3) and the remainder in `[-pi/4, pi/4]`.
fn reduce_by_quarter_turn(x: f64) -> (i64, f64) {
    let k = (x / PIO2 + if x >= 0.0 { 0.5 } else { -0.5 }).trunc();
    let remainder = x - k * PIO2_1 - k * PIO2_2 - k * PIO2_3;
    let q = k as i64;
    (((q % 4) + 4) % 4, remainder)
}

fn sin_core(r: f64) -> f64 {
    let z = r * r;
    let mut total = 0.0f64;
    for i in (0..SIN_COEFF.len()).rev() {
        total = total * z + SIN_COEFF[i];
    }
    r + r * z * total
}

fn cos_core(r: f64) -> f64 {
    let z = r * r;
    let mut total = 0.0f64;
    for i in (0..COS_COEFF.len()).rev() {
        total = total * z + COS_COEFF[i];
    }
    1.0 + z * total
}

pub fn sin(x: f64) -> f64 {
    if x.is_nan() || x.is_infinite() {
        return f64::NAN;
    }
    let (quadrant, remainder) = reduce_by_quarter_turn(x);
    match quadrant {
        0 => sin_core(remainder),
        1 => cos_core(remainder),
        2 => -sin_core(remainder),
        _ => -cos_core(remainder),
    }
}

pub fn cos(x: f64) -> f64 {
    if x.is_nan() || x.is_infinite() {
        return f64::NAN;
    }
    let (quadrant, remainder) = reduce_by_quarter_turn(x);
    match quadrant {
        0 => cos_core(remainder),
        1 => -sin_core(remainder),
        2 => -cos_core(remainder),
        _ => sin_core(remainder),
    }
}

/// One reduction shared by both halves, so numerator and denominator can never
/// come from different quadrants.
pub fn tan(x: f64) -> f64 {
    if x.is_nan() || x.is_infinite() {
        return f64::NAN;
    }
    let (quadrant, remainder) = reduce_by_quarter_turn(x);
    let s = sin_core(remainder);
    let c = cos_core(remainder);
    if quadrant % 2 == 0 {
        s / c
    } else {
        -c / s
    }
}

/// An integer exponent goes through repeated squaring, so `pow(10, 3)` is
/// exactly 1000 rather than 999.999_999_999_999_8.
pub fn pow(x: f64, y: f64) -> f64 {
    if y.is_nan() {
        return f64::NAN;
    }
    if y == 0.0 {
        return 1.0;
    }
    if x.is_nan() {
        return f64::NAN;
    }
    if y == y.trunc() && y.is_finite() && y.abs() <= 1024.0 {
        let mut result = 1.0f64;
        let mut base = if y < 0.0 { 1.0 / x } else { x };
        let mut n = y.abs() as i64;
        while n > 0 {
            if n % 2 == 1 {
                result *= base;
            }
            base *= base;
            n /= 2;
        }
        return result;
    }
    if x < 0.0 {
        return f64::NAN;
    }
    if x == 0.0 {
        return if y > 0.0 { 0.0 } else { f64::INFINITY };
    }
    exp(y * log(x))
}
