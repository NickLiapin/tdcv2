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

/// Taylor coefficients for `(e^x - 1)/x` over x, ascending: 1/(n+1)!.
const EXPM1_COEFF: [f64; 16] = [
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
    1.0 / 20_922_789_888_000.0,
];

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
    2.0 * s * atanh_series(s * s, 25) + e * LN2_HI + e * LN2_LO
}

/// The series for `atanh(s)/s` over s^2, shared by `log` and `log1p`.
///
/// The two callers reduce to different intervals, so each names how far to go:
/// `log` halves its argument until |s| <= 0.1716 and thirteen terms suffice,
/// while `log1p` cannot halve — it must not form `1 + x` at all — and reaches
/// |s| <= 1/3, where thirteen terms are 63 ulp out and twenty are 2.
fn atanh_series(s2: f64, highest_odd_power: i32) -> f64 {
    let mut total = 0.0f64;
    let mut i = highest_odd_power;
    while i >= 1 {
        total = total * s2 + 1.0 / f64::from(i);
        i -= 2;
    }
    total
}

/// The largest k for which 10^k and 10^-k are both exactly doubles.
///
/// Past 10^22 a power of ten is no longer representable — 10^23 is not a double
/// — so beyond here "exact" has nothing to mean.
const EXACT_POWER_OF_TEN: f64 = 22.0;

/// `log10(x)`.
///
/// A power of ten is the argument someone passes to `log10`, and `log(x)/ln10`
/// gets it wrong: it returned 2.9999999999999996 for 1000. There is no exponent
/// to separate here the way `log2` separates a power of two — a double is
/// binary — so the whole answer is checked instead: if raising ten back to it
/// returns the argument unchanged, it was exact.
pub fn log10(x: f64) -> f64 {
    let r = log(x) / 2.302_585_092_994_046;
    let whole = if r >= 0.0 { (r + 0.5).floor() } else { (r - 0.5).ceil() };
    if whole.abs() <= EXACT_POWER_OF_TEN {
        // A NEGATIVE power has to be built from the positive one and inverted.
        // `pow(10, -2)` squares 1/10, and a tenth is not exact in binary, so the
        // square misses 0.01; `1 / pow(10, 2)` is one rounding of an exact 100.
        let p = if whole >= 0.0 {
            pow(10.0, whole)
        } else {
            1.0 / pow(10.0, -whole)
        };
        if p == x {
            return whole;
        }
    }
    r
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

// ── The third wave: the shapes that exist to avoid cancellation ──────────────
//
// `expm1` and `log1p` are not conveniences. Near zero, `exp(x) - 1` and
// `log(1 + x)` each throw away most of their answer to a subtraction or to a
// rounding that happens before the function is even called — and these two are
// what the inverse hyperbolics are built from, which is why they come first.

/// `expm1(x)` — e^x - 1, computed so that small x keeps its digits.
///
/// `exp(0.0000001) - 1` in plain arithmetic is a subtraction of two numbers
/// that agree to seven places, and most of the answer dies in it. The series
/// has no subtraction to lose anything to.
pub fn expm1(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    if x.abs() < 0.5 {
        return x * horner(&EXPM1_COEFF, x);
    }
    exp(x) - 1.0
}

/// `log1p(x)` — log(1 + x), computed so that small x keeps its digits.
///
/// The loss here happens before the logarithm is reached: `1 + 1e-20` IS 1 as a
/// double, so `log(1 + x)` returns zero for every x under 1e-16. Reducing
/// instead to `2*atanh(x/(2+x))` never forms `1 + x` at all.
pub fn log1p(x: f64) -> f64 {
    if x.is_nan() || x < -1.0 {
        return f64::NAN;
    }
    if x == -1.0 {
        return f64::NEG_INFINITY;
    }
    if x == f64::INFINITY {
        return f64::INFINITY;
    }
    // Past a half, `1 + x` has nothing left to lose and the direct route is
    // both shorter and better conditioned.
    if x.abs() >= 0.5 {
        return log(1.0 + x);
    }
    let s = x / (2.0 + x);
    2.0 * s * atanh_series(s * s, 39)
}

/// `log2(x)`.
///
/// Not `log(x) / ln2`: that would make `log2(8)` come out 2.9999999999999996,
/// and a power of two is precisely the argument someone passes to `log2`. The
/// exponent is separated first.
pub fn log2(x: f64) -> f64 {
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
    if m == 1.0 {
        return e;
    }
    e + log(m) / LN2
}

/// `hypot(x, y)` — the length of the vector, without an intermediate that
/// overflows.
///
/// `sqrt(x*x + y*y)` is the definition and the wrong implementation: for
/// x = 1e200 the square overflows to infinity and the answer comes back
/// infinite, though it is perfectly representable. Factoring the larger side
/// out first keeps every intermediate near 1.
pub fn hypot(x: f64, y: f64) -> f64 {
    // An infinite side wins even against a NaN on the other, which is what
    // IEEE-754 recommends: the length is infinite whatever the other side is.
    if x.is_infinite() || y.is_infinite() {
        return f64::INFINITY;
    }
    if x.is_nan() || y.is_nan() {
        return f64::NAN;
    }
    let mut a = x.abs();
    let mut b = y.abs();
    if a < b {
        std::mem::swap(&mut a, &mut b);
    }
    if a == 0.0 {
        return 0.0;
    }
    let ratio = b / a;
    a * (1.0 + ratio * ratio).sqrt()
}

/// `sign(x)` — -1, 0 or 1. Exact: there is nothing here to round.
pub fn sign(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    if x > 0.0 {
        return 1.0;
    }
    if x < 0.0 {
        return -1.0;
    }
    0.0
}

/// `asinh(x)` — the inverse hyperbolic sine, over the whole real line.
///
/// `log(x + sqrt(x*x + 1))` is the textbook form and cancels for small x.
/// Rewriting the argument as `x + x*x/(1 + sqrt(1 + x*x))` leaves `log1p` a
/// number near x rather than a number near 1, and nothing cancels.
pub fn asinh(x: f64) -> f64 {
    if x.is_nan() || x.is_infinite() {
        return x;
    }
    let sign_of = if x < 0.0 { -1.0 } else { 1.0 };
    let a = x.abs();
    // Past this, a*a would overflow while asinh(a) is still a small number; up
    // there sqrt(1 + a*a) is a to every bit, so the answer is log(2a).
    if a > 1e150 {
        return sign_of * (log(a) + LN2);
    }
    sign_of * log1p(a + (a * a) / (1.0 + (1.0 + a * a).sqrt()))
}

/// `acosh(x)` — the inverse hyperbolic cosine, defined for x >= 1.
///
/// Written around `t = x - 1`, which is exact for the x near 1 where the answer
/// approaches zero and the textbook form loses it.
pub fn acosh(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    if x < 1.0 {
        return f64::NAN;
    }
    if x == 1.0 {
        return 0.0;
    }
    if x == f64::INFINITY {
        return f64::INFINITY;
    }
    if x > 1e150 {
        return log(x) + LN2;
    }
    let t = x - 1.0;
    log1p(t + (2.0 * t + t * t).sqrt())
}

/// `atanh(x)` — the inverse hyperbolic tangent, over (-1, 1).
///
/// `0.5*log((1+x)/(1-x))` forms a ratio near 1 for small x and loses it. The
/// same ratio written as `1 + 2x/(1-x)` hands `log1p` the small part directly.
pub fn atanh(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    if x > 1.0 || x < -1.0 {
        return f64::NAN;
    }
    if x == 1.0 {
        return f64::INFINITY;
    }
    if x == -1.0 {
        return f64::NEG_INFINITY;
    }
    // The identity is only well-conditioned on the positive side. Fed
    // x = -0.999999 directly it hands `log1p` an argument of -0.9999995, which
    // is the very cancellation `log1p` exists to avoid — and the answer came
    // back 37618 ulp wrong. Folding to |x| first keeps that argument positive.
    let sign_of = if x < 0.0 { -1.0 } else { 1.0 };
    let a = x.abs();
    sign_of * 0.5 * log1p((2.0 * a) / (1.0 - a))
}

// ── The fourth wave: statistics ──────────────────────────────────────────────
//
// `erf`, `erfc`, `gamma` and `lgamma`. These are the first functions here whose
// accuracy is bounded by something other than the series that computes them,
// and each one says so where it lives.

const TWO_OVER_SQRT_PI: f64 = 1.128_379_167_095_512_6;
const ONE_OVER_SQRT_PI: f64 = 0.564_189_583_547_756_3;
const LOG_SQRT_2PI: f64 = 0.918_938_533_204_672_8;
const SQRT_2PI: f64 = 2.506_628_274_631_000_2;

/// 2^27 + 1 — Dekker's splitting constant.
const SPLIT: f64 = 134_217_729.0;

/// Taylor coefficients for `erf(x)*sqrt(pi)/2` over `x^2`, ascending.
const ERF_COEFF: [f64; 18] = [
    1.0,
    -1.0 / 3.0,
    1.0 / 10.0,
    -1.0 / 42.0,
    1.0 / 216.0,
    -1.0 / 1320.0,
    1.0 / 9360.0,
    -1.0 / 75600.0,
    1.0 / 685_440.0,
    -1.0 / 6_894_720.0,
    1.0 / 76_204_800.0,
    -1.0 / 918_086_400.0,
    1.0 / 11_975_040_000.0,
    -1.0 / 168_129_561_600.0,
    1.0 / 2_528_170_444_800.0,
    -1.0 / 40_537_905_525_000.0,
    1.0 / 691_118_486_016_000.0,
    -1.0 / 12_460_033_493_760_000.0,
];

/// How deep the continued fraction for `erfc` runs.
const ERFC_DEPTH: i32 = 200;

/// Lanczos coefficients, g = 7, n = 9 — the classic set, good for ~15 digits.
const LANCZOS: [f64; 9] = [
    0.999_999_999_999_809_93,
    676.520_368_121_885_1,
    -1259.139_216_722_402_8,
    771.323_428_777_653_13,
    -176.615_029_162_140_59,
    12.507_343_278_686_905,
    -0.138_571_095_265_720_12,
    9.984_369_578_019_571_6e-6,
    1.505_632_735_149_311_6e-7,
];

/// `e^(-x*x)`, computed so the rounding of `x*x` never reaches the exponent.
///
/// This is the whole accuracy story for `erfc`. Squaring x rounds by about
/// x^2 · 2^-53; `exp` then turns that ABSOLUTE error in its argument into a
/// RELATIVE error in its answer, so at x = 23 the result drifts by about
/// 6e-14 — four hundred ulp. Measured before this existed: 445 ulp. After: 5.
/// The high part keeps 26 significant bits, so its square needs 52 and is exact.
fn exp_neg_square(x: f64) -> f64 {
    let s = SPLIT * x;
    let hi = s - (s - x);
    let lo = x - hi;
    exp(-hi * hi) * (1.0 + expm1(-(2.0 * hi * lo + lo * lo)))
}

/// `erf` on [0, 1] — no exponential involved, so nothing amplifies.
fn erf_small(x: f64) -> f64 {
    TWO_OVER_SQRT_PI * x * horner(&ERF_COEFF, x * x)
}

/// `erfc` for x > 1, by continued fraction.
///
/// Two hundred levels rather than a convergence test: a FIXED depth is one less
/// thing for five implementations to agree about. The depth is set by the
/// slowest point, just above x = 1, where 100 levels leave 29645 ulp and 200
/// leave 5.
fn erfc_large(x: f64) -> f64 {
    let mut f = 0.0f64;
    let mut k = ERFC_DEPTH;
    while k >= 1 {
        f = f64::from(k) / 2.0 / (x + f);
        k -= 1;
    }
    ONE_OVER_SQRT_PI * exp_neg_square(x) / (x + f)
}

/// `erf(x)` — the error function.
///
/// Below 1 the series is used directly; above it, `1 - erfc(x)`, because there
/// erfc is the small quantity and the subtraction costs nothing.
pub fn erf(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    let sign_of = if x < 0.0 { -1.0 } else { 1.0 };
    let a = x.abs();
    if a.is_infinite() {
        return sign_of;
    }
    if a <= 1.0 {
        return sign_of * erf_small(a);
    }
    sign_of * (1.0 - erfc_large(a))
}

/// `erfc(x)` — the complement, 1 − erf(x), and not computed that way past 1.
///
/// At x = 5 the true value is 1.5e-12, and `1 - erf(x)` keeps only six of its
/// twelve digits; by x = 6 erf has rounded to 1 and the answer is gone entirely.
pub fn erfc(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    if x == f64::INFINITY {
        return 0.0;
    }
    if x == f64::NEG_INFINITY {
        return 2.0;
    }
    if x < 0.0 {
        return 2.0 - erfc(-x);
    }
    if x <= 1.0 {
        return 1.0 - erf_small(x);
    }
    erfc_large(x)
}

/// `sin(pi*x)`, taken from the distance to the nearest whole number.
///
/// The reflection formula for Γ needs this near the integers, where sin(pi·x)
/// approaches zero. Computing `sin(PI * x)` directly puts the rounding of
/// `PI * x` — absolute, and growing with x — right next to a zero: at
/// x = -4.00006 the answer came out 28582 ulp wrong.
fn sin_pi(x: f64) -> f64 {
    let n = (x + 0.5).floor();
    let r = x - n;
    let s = sin(PI * r);
    if (n as i64) % 2 == 0 {
        s
    } else {
        -s
    }
}

fn lanczos_sum(z: f64) -> f64 {
    let mut a = LANCZOS[0];
    for i in 1..9 {
        a += LANCZOS[i] / (z + i as f64);
    }
    a
}

/// `lgamma(x)` — the natural logarithm of |Γ(x)|.
///
/// Away from x = 1 and x = 2 it is within 32 ulp. AT those two points lgamma is
/// ZERO, and a relative bound there is not a statement about this code — no
/// method that sums terms of size 1 can be relatively accurate about their
/// cancelling to nothing. What holds is the ABSOLUTE error, measured under
/// 1e-13 on a bounded range, and both zeros come out exactly zero.
pub fn lgamma(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    if x == f64::INFINITY {
        return f64::INFINITY;
    }
    // The poles: every whole number at or below zero.
    if x <= 0.0 && x == x.trunc() {
        return f64::INFINITY;
    }
    if x < 0.5 {
        return log(PI / sin_pi(x).abs()) - lgamma(1.0 - x);
    }
    let z = x - 1.0;
    let t = z + 7.5;
    LOG_SQRT_2PI + (z + 0.5) * log(t) - t + log(lanczos_sum(z))
}

/// `gamma(x)` — the factorial extended to the reals.
///
/// Γ of a whole number is a factorial, and multiplying it out is exact for the
/// first twenty-three and within 7 ulp for all 171 that fit in a double. The
/// general route cannot match that: it ends in an exponential, and `exp` turns
/// the absolute error of its argument into a relative error of its answer, so
/// the drift grows with log Γ(x) — about 2000 ulp near x = 146. The same
/// amplification `pow` has, for the same reason.
pub fn gamma(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    if x == f64::INFINITY {
        return f64::INFINITY;
    }
    if x == f64::NEG_INFINITY {
        return f64::NAN;
    }
    // Every whole number at or below zero is a pole, with no value to give.
    if x <= 0.0 && x == x.trunc() {
        return f64::NAN;
    }
    if x == x.trunc() && (1.0..=171.0).contains(&x) {
        let mut result = 1.0f64;
        let mut k = 2.0f64;
        while k < x {
            result *= k;
            k += 1.0;
        }
        return result;
    }
    if x < 0.5 {
        return PI / (sin_pi(x) * gamma(1.0 - x));
    }
    let z = x - 1.0;
    let t = z + 7.5;
    // One exponential rather than `t^(z+0.5) · e^(-t)`: that product overflows
    // on its first factor near x = 150, while Γ(x) is still finite to 171.
    SQRT_2PI * lanczos_sum(z) * exp((z + 0.5) * log(t) - t)
}

// ── The fifth wave: what was left ────────────────────────────────────────────
//
// Two conversions, and three functions each defined in terms of what came
// before.

const DEGREES_PER_RADIAN: f64 = 57.295_779_513_082_32;
const RADIANS_PER_DEGREE: f64 = 0.017_453_292_519_943_295;

/// Asymptotic coefficients for digamma, ascending in 1/x^2: -B_2k/(2k).
///
/// The series is asymptotic, not convergent — adding terms forever makes it
/// worse, not better.
const DIGAMMA_COEFF: [f64; 8] = [
    -1.0 / 12.0,
    1.0 / 120.0,
    -1.0 / 252.0,
    1.0 / 240.0,
    -1.0 / 132.0,
    691.0 / 32760.0,
    -1.0 / 12.0,
    3617.0 / 8160.0,
];

/// Where the recurrence stops shifting.
///
/// Ten, and larger is WORSE: each step of `psi(x) = psi(x+1) - 1/x` adds its
/// own rounding. Measured against the exact value at whole numbers —
/// psi(n) = -gamma + H(n-1) — ten gives 3 ulp, fourteen gives 12.
const DIGAMMA_SHIFT: f64 = 10.0;

/// B_2k/(2k)! for k = 1..7 — the Euler-Maclaurin tail for zeta.
const ZETA_BERNOULLI: [f64; 7] = [
    1.0 / 12.0,
    -1.0 / 720.0,
    1.0 / 30240.0,
    -1.0 / 1_209_600.0,
    1.0 / 47_900_160.0,
    -691.0 / 1_307_674_368_000.0,
    1.0 / 74_724_249_600.0,
];

const ZETA_TERMS: i32 = 12;
const ZETA_CORRECTIONS: i32 = 6;

/// `degrees(x)` — one multiplication, so all five agree trivially.
///
/// It exists because every circular function here takes radians and says so; a
/// config holding an angle in degrees needs somewhere to put the conversion.
pub fn degrees(x: f64) -> f64 {
    x * DEGREES_PER_RADIAN
}

/// `radians(x)` — the other direction, same single rounding.
pub fn radians(x: f64) -> f64 {
    x * RADIANS_PER_DEGREE
}

/// `beta(a, b)` — the Euler beta function, Γ(a)Γ(b)/Γ(a+b).
///
/// Taken directly from the gammas while they fit, because that is the accurate
/// route. Past a+b = 171 the numerator overflows although the answer is small —
/// beta SHRINKS as its arguments grow — so up there it goes through logarithms.
pub fn beta(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a > 0.0 && b > 0.0 && a + b > 171.0 {
        return exp(lgamma(a) + lgamma(b) - lgamma(a + b));
    }
    gamma(a) * gamma(b) / gamma(a + b)
}

/// `digamma(x)` — the derivative of log Γ(x).
///
/// Small arguments are lifted by the recurrence until the asymptotic series is
/// usable; negatives come back through the reflection
/// `psi(1-x) - psi(x) = pi*cot(pi*x)`.
pub fn digamma(x: f64) -> f64 {
    if x.is_nan() {
        return f64::NAN;
    }
    if x == f64::INFINITY {
        return f64::INFINITY;
    }
    // Every whole number at or below zero is a pole, as it is for Γ itself.
    if x <= 0.0 && x == x.trunc() {
        return f64::NAN;
    }
    if x < 0.5 {
        return digamma(1.0 - x) - PI / tan(PI * x);
    }
    let mut shifted = x;
    let mut correction = 0.0f64;
    while shifted < DIGAMMA_SHIFT {
        correction -= 1.0 / shifted;
        shifted += 1.0;
    }
    let f = 1.0 / (shifted * shifted);
    correction + log(shifted) - 0.5 / shifted + f * horner(&DIGAMMA_COEFF, f)
}

/// ζ(s) for s > 1, by Euler-Maclaurin.
fn zeta_sum(s: f64) -> f64 {
    let mut total = 0.0f64;
    let mut n = 1;
    while n < ZETA_TERMS {
        total += pow(f64::from(n), -s);
        n += 1;
    }
    let tail = pow(f64::from(ZETA_TERMS), -s);
    total += tail / 2.0 + f64::from(ZETA_TERMS) * tail / (s - 1.0);
    // Then the Bernoulli corrections, each a rising factorial over a growing power.
    let mut rising = s;
    let mut power = tail / f64::from(ZETA_TERMS);
    let mut k = 1;
    while k <= ZETA_CORRECTIONS {
        total += ZETA_BERNOULLI[(k - 1) as usize] * rising * power;
        rising *= (s + f64::from(2 * k - 1)) * (s + f64::from(2 * k));
        power /= f64::from(ZETA_TERMS) * f64::from(ZETA_TERMS);
        k += 1;
    }
    total
}

/// `zeta(s)` — the Riemann zeta function, for real s.
///
/// Above 1 the sum converges and Euler-Maclaurin makes twelve terms behave like
/// thousands. Below it the functional equation reflects the argument across
/// s = 1/2, which is why this needs Γ and sin and could not have been written
/// before them. ζ(1) is the pole; ζ(0) is -1/2, which the reflection cannot
/// give because it meets 0 · ∞ there.
pub fn zeta(s: f64) -> f64 {
    if s.is_nan() {
        return f64::NAN;
    }
    if s == 1.0 {
        return f64::INFINITY;
    }
    if s == 0.0 {
        return -0.5;
    }
    if s > 1.0 {
        return zeta_sum(s);
    }
    pow(2.0, s) * pow(PI, s - 1.0) * sin(PI * s / 2.0) * gamma(1.0 - s) * zeta_sum(1.0 - s)
}
