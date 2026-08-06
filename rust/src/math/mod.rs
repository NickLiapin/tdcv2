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

// Clippy offers std::f64::consts for several of these. They are the same
// doubles, and that is exactly why the literals stay: this file has to read
// line-for-line like its four siblings, none of which have a Rust std to point
// at. A constant that says 3.141592653589793 in five files is checkable by eye;
// one that says FRAC_PI_2 in one of them is not.
#![allow(clippy::approx_constant)]

pub const PI: f64 = 3.141592653589793;
pub const E: f64 = 2.718281828459045;

// ln 2, split so `k * LN2_HI` keeps the low bits a single constant would drop.
// The constant carries 21 zero low bits, so any k this reduction produces
// multiplies without rounding.
const LN2_HI: f64 = 0.693_147_180_369_123_8;
const LN2_LO: f64 = 1.908_214_929_270_587_7e-10;
const LN2: f64 = 0.693_147_180_559_945_3;

// pi/2 in three pieces: a single rounded pi/2 loses most of the significant
// digits of sin(1000) before the series starts.
const PIO2: f64 = 1.570_796_326_794_896_6;
const PIO2_1: f64 = 1.570_796_326_734_125_6;
const PIO2_2: f64 = 6.077_100_506_506_192e-11;
const PIO2_3: f64 = 2.022_266_248_795_950_6e-21;

// pi/4 and 3pi/4 — the quadrant answers `atan2` returns.
const PIO4: f64 = 0.785_398_163_397_448_3;
const PI3O4: f64 = 2.356_194_490_192_345;

/// Taylor coefficients for `(sin(r) - r)/r^3` over `r^2`, ascending.
///
/// The count is set by the WORST point of the reduced interval, |r| = pi/4, not
/// by a typical one.
const SIN_COEFF: [f64; 8] = [
    -1.0 / 6.0,
    1.0 / 120.0,
    -1.0 / 5040.0,
    1.0 / 362_880.0,
    -1.0 / 39_916_800.0,
    1.0 / 6_227_020_800.0,
    -1.0 / 1_307_674_368_000.0,
    1.0 / 355_687_428_096_000.0,
];

/// Taylor coefficients for `(cos(r) - 1)/r^2` over `r^2`, ascending.
///
/// The last two are not optional: stopping at 1/14! is thirteen ulp out at
/// |r| = pi/4, and `sin` and `tan` both inherit that, since a quarter-turn
/// reduction routes half of all arguments through this series.
const COS_COEFF: [f64; 9] = [
    -1.0 / 2.0,
    1.0 / 24.0,
    -1.0 / 720.0,
    1.0 / 40320.0,
    -1.0 / 3_628_800.0,
    1.0 / 479_001_600.0,
    -1.0 / 87_178_291_200.0,
    1.0 / 20_922_789_888_000.0,
    -1.0 / 6_402_373_705_728_000.0,
];

/// Taylor coefficients for `e^r` over r, ascending: 1/n!.
///
/// Horner rather than a forward recurrence, which rounds twice per term and
/// carries the error forward: 4 ulp against 1 for the same number of terms.
const EXP_COEFF: [f64; 16] = [
    1.0,
    1.0,
    1.0 / 2.0,
    1.0 / 6.0,
    1.0 / 24.0,
    1.0 / 120.0,
    1.0 / 720.0,
    1.0 / 5040.0,
    1.0 / 40320.0,
    1.0 / 362_880.0,
    1.0 / 3_628_800.0,
    1.0 / 39_916_800.0,
    1.0 / 479_001_600.0,
    1.0 / 6_227_020_800.0,
    1.0 / 87_178_291_200.0,
    1.0 / 1_307_674_368_000.0,
];

/// Taylor coefficients for `atan(t)/t` over `t^2`, ascending.
///
/// Twenty-four, because the reduction halves the argument ONCE and no more.
/// Measured: one halving with this many terms lands at 2 ulp, two halvings with
/// sixteen at 3, three with twelve at 4. Series terms are cheaper than
/// reduction steps here, which is the opposite of the usual advice.
const ATAN_COEFF: [f64; 24] = [
    1.0,
    -1.0 / 3.0,
    1.0 / 5.0,
    -1.0 / 7.0,
    1.0 / 9.0,
    -1.0 / 11.0,
    1.0 / 13.0,
    -1.0 / 15.0,
    1.0 / 17.0,
    -1.0 / 19.0,
    1.0 / 21.0,
    -1.0 / 23.0,
    1.0 / 25.0,
    -1.0 / 27.0,
    1.0 / 29.0,
    -1.0 / 31.0,
    1.0 / 33.0,
    -1.0 / 35.0,
    1.0 / 37.0,
    -1.0 / 39.0,
    1.0 / 41.0,
    -1.0 / 43.0,
    1.0 / 45.0,
    -1.0 / 47.0,
];

/// Taylor coefficients for `sinh(x)/x` over `x^2`, ascending: 1/(2n+1)!.
const SINH_COEFF: [f64; 8] = [
    1.0,
    1.0 / 6.0,
    1.0 / 120.0,
    1.0 / 5040.0,
    1.0 / 362_880.0,
    1.0 / 39_916_800.0,
    1.0 / 6_227_020_800.0,
    1.0 / 1_307_674_368_000.0,
];

/// Taylor coefficients for `cosh(x)` over `x^2`, ascending: 1/(2n)!.
const COSH_COEFF: [f64; 8] = [
    1.0,
    1.0 / 2.0,
    1.0 / 24.0,
    1.0 / 720.0,
    1.0 / 40320.0,
    1.0 / 3_628_800.0,
    1.0 / 479_001_600.0,
    1.0 / 87_178_291_200.0,
];

const EXP_OVERFLOW: f64 = 709.782_712_893_384;
const EXP_UNDERFLOW: f64 = -745.133_219_101_941_1;

/// The most halvings that keep a value near 1 inside the normal range.
const DEEPEST_NORMAL_HALVING: i64 = 1021;

/// Horner over z, ascending coefficients — the shape every series here uses.
fn horner(coeff: &[f64], z: f64) -> f64 {
    let mut total = 0.0f64;
    for i in (0..coeff.len()).rev() {
        total = total * z + coeff[i];
    }
    total
}

/// Delegated: IEEE-754 requires square root to be correctly rounded, so there
/// is one legal answer and every implementation must give it.
pub fn sqrt(x: f64) -> f64 {
    if x.is_nan() || x < 0.0 {
        return f64::NAN;
    }
    x.sqrt()
}

/// Halve `value` exactly `count` times. Exact while the result stays normal.
fn halve_times(value: f64, count: i64) -> f64 {
    let mut out = value;
    let mut i = 0;
    while i < count {
        out /= 2.0;
        i += 1;
    }
    out
}

/// `value * 2^n` for `value` near 1.
///
/// Stepping one power at a time is exact — while the numbers stay normal. Below
/// 2^-1022 they are not: a subnormal has fewer bits than it started with, and
/// every further halving rounds again. Halving all the way down that way threw
/// away most of the answer — `exp(-730)` came back 9.22631e-318 against a true
/// 9.226315e-318, and `exp(-745)` came back 0 against 5e-324.
///
/// So a deep scaling is split: down to the edge of the normal range in exact
/// steps, then ONE multiplication by a small power of two — itself exact, being
/// no smaller than 2^-54 — which rounds once and only once.
fn scale_by_power_of_two(value: f64, n: i64) -> f64 {
    if n >= -DEEPEST_NORMAL_HALVING {
        let mut out = value;
        let mut k = n;
        while k > 0 {
            out *= 2.0;
            k -= 1;
        }
        return halve_times(out, -k);
    }
    let at_the_edge = halve_times(value, DEEPEST_NORMAL_HALVING);
    let remainder = halve_times(1.0, -(n + DEEPEST_NORMAL_HALVING));
    at_the_edge * remainder
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
    scale_by_power_of_two(horner(&EXP_COEFF, r), k as i64)
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
    r + r * z * horner(&SIN_COEFF, z)
}

fn cos_core(r: f64) -> f64 {
    let z = r * r;
    1.0 + z * horner(&COS_COEFF, z)
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

fn repeated_squaring(base: f64, exponent: i64) -> f64 {
    let mut result = 1.0f64;
    let mut b = base;
    let mut n = exponent;
    while n > 0 {
        if n % 2 == 1 {
            result *= b;
        }
        b *= b;
        n /= 2;
    }
    result
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
        return repeated_squaring(if y < 0.0 { 1.0 / x } else { x }, y.abs() as i64);
    }
    // A negative base with a fractional exponent has no real answer, and saying
    // so is better than returning whatever the general route would produce.
    if x < 0.0 {
        return f64::NAN;
    }
    if x == 0.0 {
        return if y > 0.0 { 0.0 } else { f64::INFINITY };
    }
    // A half-integer exponent is the fractional one people actually write, and
    // `x^(n/2)` is `(sqrt x)^n` — both halves exact. Without this, `pow(100, 0.5)`
    // came back 9.999999999999998 and `pow(9, 1.5)` 26.99999999999999.
    let half = 2.0 * y;
    if half == half.trunc() && half.abs() <= 2048.0 {
        let root = x.sqrt();
        return repeated_squaring(
            if half < 0.0 { 1.0 / root } else { root },
            half.abs() as i64,
        );
    }
    exp(y * log(x))
}

// ── The second wave: inverses and hyperbolics ────────────────────────────────
//
// Same rule as everything above: `+ - * /`, `f64::sqrt`, and the functions this
// module already built. Nothing here calls a transcendental of the host.

/// Half-angle for the arctangent: `atan(t) = 2*atan(h(t))`. Built from sqrt alone.
fn atan_half(t: f64) -> f64 {
    t / (1.0 + (1.0 + t * t).sqrt())
}

/// `atan` on [0, 1], halved once so the series runs on |t| <= 0.4143.
fn atan_core(t: f64) -> f64 {
    let h = atan_half(t);
    2.0 * (h * horner(&ATAN_COEFF, h * h))
}

/// `atan(x)` — the arctangent, in radians, over the whole real line.
pub fn atan(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    if x == f64::INFINITY {
        return PIO2;
    }
    if x == f64::NEG_INFINITY {
        return -PIO2;
    }
    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    let a = x.abs();
    let r = if a > 1.0 {
        PIO2 - atan_core(1.0 / a)
    } else {
        atan_core(a)
    };
    sign * r
}

/// `atan2(y, x)` — the angle of the point (x, y), in radians, over (-pi, pi].
///
/// The quadrant cannot be recovered from `y/x` alone: the ratio is the same in
/// opposite quadrants, which is the whole reason this exists separately.
pub fn atan2(y: f64, x: f64) -> f64 {
    if y.is_nan() || x.is_nan() {
        return f64::NAN;
    }
    if y.is_infinite() && x.is_infinite() {
        let magnitude = if x > 0.0 { PIO4 } else { PI3O4 };
        return if y > 0.0 { magnitude } else { -magnitude };
    }
    if y.is_infinite() {
        return if y > 0.0 { PIO2 } else { -PIO2 };
    }
    if x.is_infinite() {
        if x > 0.0 {
            return 0.0;
        }
        return if y < 0.0 { -PI } else { PI };
    }
    if x == 0.0 && y == 0.0 {
        return 0.0;
    }
    if x == 0.0 {
        return if y > 0.0 { PIO2 } else { -PIO2 };
    }
    if y == 0.0 {
        return if x > 0.0 { 0.0 } else { PI };
    }
    let r = atan(y / x);
    if x > 0.0 {
        return r;
    }
    if y > 0.0 {
        r + PI
    } else {
        r - PI
    }
}

/// `asin` on [0, 0.5], where `1 - a*a` keeps every bit it started with.
fn asin_small(a: f64) -> f64 {
    atan(a / (1.0 - a * a).sqrt())
}

/// `asin(x)` — the arcsine, in radians, over [-1, 1].
///
/// Past a half the direct route would compute `1 - a*a` with a and 1 nearly
/// equal, and lose most of its digits before `sqrt` ever saw them. The
/// half-angle identity moves the subtraction to `1 - a`, exact in that range.
pub fn asin(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    let a = x.abs();
    if a > 1.0 {
        return f64::NAN;
    }
    if a == 1.0 {
        return sign * PIO2;
    }
    if a <= 0.5 {
        return sign * asin_small(a);
    }
    sign * (PIO2 - 2.0 * asin_small(((1.0 - a) / 2.0).sqrt()))
}

/// `acos(x)` — the arccosine, in radians, over [-1, 1].
///
/// Not `pi/2 - asin(x)` everywhere: near x = 1 the answer approaches zero, and
/// that subtraction would compute it as the difference of two numbers that are
/// nearly pi/2, throwing away every digit that matters.
pub fn acos(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    if x > 1.0 || x < -1.0 {
        return f64::NAN;
    }
    if x == 1.0 {
        return 0.0;
    }
    if x == -1.0 {
        return PI;
    }
    if x >= 0.5 {
        return 2.0 * asin_small(((1.0 - x) / 2.0).sqrt());
    }
    if x <= -0.5 {
        return PI - 2.0 * asin_small(((1.0 + x) / 2.0).sqrt());
    }
    PIO2 - asin_small(x.abs()) * if x < 0.0 { -1.0 } else { 1.0 }
}

/// `sinh(x)` — below a half the exponential route would cancel the answer away.
pub fn sinh(x: f64) -> f64 {
    if x.is_nan() || x.is_infinite() {
        return x;
    }
    let a = x.abs();
    if a < 0.5 {
        return x * horner(&SINH_COEFF, x * x);
    }
    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    // Past this point e^x overflows but sinh(x) still fits, so the halving is
    // folded into the exponent rather than applied after it.
    if a > 709.0 {
        return sign * exp(a - LN2);
    }
    let t = exp(a);
    sign * (t - 1.0 / t) / 2.0
}

/// `cosh(x)` — a sum rather than a difference, so nothing cancels.
pub fn cosh(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    if x.is_infinite() {
        return f64::INFINITY;
    }
    let a = x.abs();
    if a < 0.5 {
        return horner(&COSH_COEFF, x * x);
    }
    if a > 709.0 {
        return exp(a - LN2);
    }
    let t = exp(a);
    (t + 1.0 / t) / 2.0
}

/// `tanh(x)` — past 20 the true value is within 1e-17 of 1, closer than the
/// next double, so the answer is 1 and computing e^40 to find that is waste.
pub fn tanh(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    if x.is_infinite() {
        return sign;
    }
    let a = x.abs();
    if a > 20.0 {
        return sign;
    }
    if a < 0.5 {
        let z = x * x;
        return x * horner(&SINH_COEFF, z) / horner(&COSH_COEFF, z);
    }
    let u = exp(2.0 * a);
    sign * (u - 1.0) / (u + 1.0)
}

/// `cbrt(x)` — the cube root, defined for negatives too.
///
/// `pow(x, 1/3)` is not the same function: one third is not a double, and a
/// negative base with a fractional exponent has no real answer at all. So this
/// is its own function, reduced by powers of eight — exact, being powers of two
/// — and then refined by Newton's method.
pub fn cbrt(x: f64) -> f64 {
    if x.is_nan() || x.is_infinite() || x == 0.0 {
        return x;
    }
    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    let mut a = x.abs();
    let mut e = 0i64;
    while a >= 8.0 {
        a /= 8.0;
        e += 1;
    }
    while a < 1.0 {
        a *= 8.0;
        e -= 1;
    }
    // A straight line through the ends of [1, 8): within 11% everywhere, which
    // six Newton passes take past the last bit.
    let mut y = 1.0 + (a - 1.0) / 7.0;
    for _ in 0..6 {
        y = (2.0 * y + a / (y * y)) / 3.0;
    }
    sign * scale_by_power_of_two(y, e)
}
