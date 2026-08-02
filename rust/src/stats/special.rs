//! The special functions gamma and beta sampling need.
//!
//! Neither distribution has a closed-form inverse CDF, but both CDFs can be
//! computed — the regularized lower incomplete gamma and the regularized
//! incomplete beta — and inverting those by bisection gives an exact sampler
//! that spends exactly **one** uniform draw.
//!
//! That draw count is the whole reason for this file. The obvious way to sample
//! a gamma is rejection sampling, which consumes a variable number of draws, and
//! a variable number of draws makes a row's value depend on every row before it.
//! Fixed draws are what let a row be computed from its index alone, which is
//! what the streaming engines need and what keeps implementations in step.
//!
//! Hand-rolled, in the standard series and continued-fraction forms. A crate
//! would be a dependency whose numerical choices this project does not control,
//! and whose last bits would differ from the other four.

const LANCZOS_G: usize = 7;

/// The published Lanczos coefficients for g = 7, digit for digit.
///
/// Two clippy lints are silenced here rather than obeyed, and the reason is the
/// same for both: they want the literals tidied. `excessive_precision` would
/// shorten them to the fewest digits that round to the same `f64`, and
/// `inconsistent_digit_grouping` would insert underscores that make them stop
/// matching the table they were copied from. The first is the dangerous one — a
/// "harmless" truncation that happened to change one last bit would move every
/// gamma and beta value in the project, and nothing would say so except a
/// fixture failing three commits later.
#[allow(clippy::excessive_precision, clippy::inconsistent_digit_grouping)]
#[rustfmt::skip]
const LANCZOS_C: [f64; 9] = [
    0.99999999999980993,
    676.5203681218851,
    -1259.1392167224028,
    771.32342877765313,
    -176.61502916214059,
    12.507343278686905,
    -0.13857109526572012,
    9.9843695780195716e-6,
    1.5056327351493116e-7,
];

const MAX_ITER: usize = 300;
const EPS: f64 = 1e-15;
const FP_MIN: f64 = 1e-300;

/// 2^-100 is far below double precision, so this always converges as far as it can.
const BISECTION_ITER: usize = 100;

/// Natural log of the gamma function, by the Lanczos approximation.
pub fn log_gamma(z: f64) -> f64 {
    if z < 0.5 {
        // Reflection, for the left half-plane.
        return (std::f64::consts::PI / (std::f64::consts::PI * z).sin()).ln() - log_gamma(1.0 - z);
    }

    let zz = z - 1.0;
    let mut x = LANCZOS_C[0];
    for (i, c) in LANCZOS_C.iter().enumerate().take(LANCZOS_G + 2).skip(1) {
        x += c / (zz + i as f64);
    }

    let t = zz + LANCZOS_G as f64 + 0.5;
    0.5 * (2.0 * std::f64::consts::PI).ln() + (zz + 0.5) * t.ln() - t + x.ln()
}

/// Regularized lower incomplete gamma `P(a,x)` — the CDF of gamma(a, 1) at x.
pub fn gamma_p(a: f64, x: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    // The series converges quickly below the mean and the continued fraction
    // above it; each is slow or unstable in the other's territory.
    if x < a + 1.0 {
        gamma_series(a, x)
    } else {
        1.0 - gamma_continued_fraction(a, x)
    }
}

fn gamma_series(a: f64, x: f64) -> f64 {
    let gln = log_gamma(a);
    let mut ap = a;
    let mut sum = 1.0 / a;
    let mut del = sum;
    for _ in 0..MAX_ITER {
        ap += 1.0;
        del *= x / ap;
        sum += del;
        if del.abs() < sum.abs() * EPS {
            break;
        }
    }
    sum * (-x + a * x.ln() - gln).exp()
}

/// `Q(a,x) = 1 - P(a,x)` by continued fraction.
fn gamma_continued_fraction(a: f64, x: f64) -> f64 {
    let gln = log_gamma(a);
    let mut b = x + 1.0 - a;
    let mut c = 1.0 / FP_MIN;
    let mut d = 1.0 / b;
    let mut h = d;
    for i in 1..MAX_ITER {
        let an = -(i as f64) * (i as f64 - a);
        b += 2.0;
        d = an * d + b;
        if d.abs() < FP_MIN {
            d = FP_MIN;
        }
        c = b + an / c;
        if c.abs() < FP_MIN {
            c = FP_MIN;
        }
        d = 1.0 / d;
        let del = d * c;
        h *= del;
        if (del - 1.0).abs() < EPS {
            break;
        }
    }
    (-x + a * x.ln() - gln).exp() * h
}

/// Regularized incomplete beta `I_x(a,b)` — the CDF of beta(a,b) at x.
pub fn beta_i(x: f64, a: f64, b: f64) -> f64 {
    if x <= 0.0 {
        return 0.0;
    }
    if x >= 1.0 {
        return 1.0;
    }

    let bt =
        (log_gamma(a + b) - log_gamma(a) - log_gamma(b) + a * x.ln() + b * (1.0 - x).ln()).exp();
    if x < (a + 1.0) / (a + b + 2.0) {
        bt * beta_continued_fraction(a, b, x) / a
    } else {
        1.0 - bt * beta_continued_fraction(b, a, 1.0 - x) / b
    }
}

fn beta_continued_fraction(a: f64, b: f64, x: f64) -> f64 {
    let qab = a + b;
    let qap = a + 1.0;
    let qam = a - 1.0;
    let mut c = 1.0;
    let mut d = 1.0 - qab * x / qap;
    if d.abs() < FP_MIN {
        d = FP_MIN;
    }
    d = 1.0 / d;
    let mut h = d;

    for m in 1..MAX_ITER {
        let m = m as f64;
        let m2 = 2.0 * m;
        let mut aa = m * (b - m) * x / ((qam + m2) * (a + m2));
        d = 1.0 + aa * d;
        if d.abs() < FP_MIN {
            d = FP_MIN;
        }
        c = 1.0 + aa / c;
        if c.abs() < FP_MIN {
            c = FP_MIN;
        }
        d = 1.0 / d;
        h *= d * c;

        aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
        d = 1.0 + aa * d;
        if d.abs() < FP_MIN {
            d = FP_MIN;
        }
        c = 1.0 + aa / c;
        if c.abs() < FP_MIN {
            c = FP_MIN;
        }
        d = 1.0 / d;
        let del = d * c;
        h *= del;
        if (del - 1.0).abs() < EPS {
            break;
        }
    }
    h
}

/// The inverse of [`gamma_p`]: the `x >= 0` where `P(a,x) = u`.
pub fn gamma_p_inv(a: f64, u: f64) -> f64 {
    let mut hi = 1.0;
    while gamma_p(a, hi) < u && hi < 1e300 {
        hi *= 2.0;
    }

    let mut lo = 0.0;
    for _ in 0..BISECTION_ITER {
        let mid = (lo + hi) / 2.0;
        if gamma_p(a, mid) < u {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    (lo + hi) / 2.0
}

/// The inverse of [`beta_i`]: the `x` in (0,1) where `I_x(a,b) = u`.
pub fn beta_i_inv(a: f64, b: f64, u: f64) -> f64 {
    let mut lo = 0.0;
    let mut hi = 1.0;
    for _ in 0..BISECTION_ITER {
        let mid = (lo + hi) / 2.0;
        if beta_i(mid, a, b) < u {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    (lo + hi) / 2.0
}
