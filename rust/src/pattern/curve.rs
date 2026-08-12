//! A drawn line, read as data.
//!
//! The horizontal axis is the row index: row `i` of `count` reads the curve at
//! `t = i/(count-1)`, so a sketch of half a dozen points stretches over however
//! many rows are generated — ten, or a million. The vertical axis is the value,
//! and since a drawing has no inherent scale the config declares the range with
//! `y_range="min..max"`; only the shape of the line matters, never the numbers
//! it was drawn with.
//!
//! This is what a config reaches for when the data has to look like something —
//! a daily traffic curve, a sales year with a Christmas peak — and no named
//! distribution has that shape.

use crate::engine::{invalid, EngineResult};

/// How the line is read between two drawn points.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Interp {
    /// The straight segment. Faithful to a polyline, but one segment stretched
    /// over thousands of rows climbs by an identical step every time, which
    /// reads as obviously machine-made.
    Linear,
    /// A monotone cubic through the points: it eases in and out of each one and,
    /// unlike an ordinary spline, never overshoots past a drawn value — which
    /// matters when the drawing is the specification.
    Smooth,
    /// Hold each value until the next point.
    Step,
}

#[derive(Clone, Debug)]
pub struct Curve {
    xs: Vec<f64>,
    ys: Vec<f64>,
    y_min: f64,
    y_max: f64,
    y_range: Option<[f64; 2]>,
    decimals: usize,
    interp: Interp,
    slopes: Option<Vec<f64>>,
}

/// The default height of a drawn canvas — a percentage board, the same one the
/// Studio draws on.
///
/// It is a CONSTANT rather than a measurement, and that is the whole point: a
/// horizontal line at 50 sits halfway up a canvas of 100 no matter how many
/// points the drawing has, so `y_range="0..100"` gives back 50 and `-5..5` gives
/// back 0. Measuring the drawing instead would make that same line the highest
/// thing present, hence the top of the range.
const VECTOR_CANVAS_TOP: f64 = 100.0;

/// The canvas a drawn list of points is read against.
///
/// It never shrinks below 0..100; it only GROWS, to hold whatever was drawn
/// outside it. So a picture that fits the default board is measured against the
/// board, and one exported at 0..10002345345 is measured against itself — in
/// both cases the whole drawing lands inside `y_range` and its proportions
/// survive.
pub fn vector_canvas(y_min: f64, y_max: f64) -> (f64, f64) {
    (y_min.min(0.0), y_max.max(VECTOR_CANVAS_TOP))
}

impl Curve {
    /// Build a curve from raw points.
    ///
    /// `norm_extent` overrides the height extent used to normalize into
    /// `y_range`; a corridor passes the extent shared by both of its lines so
    /// the two live in one value space and the band between them means
    /// something.
    pub fn of(
        points: &[[f64; 2]],
        y_range: Option<[f64; 2]>,
        decimals: usize,
        norm_extent: Option<[f64; 2]>,
        interp: Interp,
    ) -> EngineResult<Curve> {
        if points.len() < 2 {
            return invalid("pattern: need at least two points to define a curve");
        }

        // A STABLE sort: two points at the same x keep the order they were
        // written. `sort_unstable_by` would be faster and would reorder them.
        let mut sorted = points.to_vec();
        sorted.sort_by(|a, b| a[0].partial_cmp(&b[0]).unwrap_or(std::cmp::Ordering::Equal));

        let xs: Vec<f64> = sorted.iter().map(|p| p[0]).collect();
        let ys: Vec<f64> = sorted.iter().map(|p| p[1]).collect();

        let lo = ys.iter().copied().fold(ys[0], f64::min);
        let hi = ys.iter().copied().fold(ys[0], f64::max);
        let (y_min, y_max) = match norm_extent {
            Some([a, b]) => (a, b),
            None => vector_canvas(lo, hi),
        };

        let slopes = (interp == Interp::Smooth).then(|| pchip_slopes(&xs, &ys));
        Ok(Curve {
            xs,
            ys,
            y_min,
            y_max,
            y_range,
            decimals,
            interp,
            slopes,
        })
    }

    pub fn xs(&self) -> &[f64] {
        &self.xs
    }

    pub fn y_min(&self) -> f64 {
        self.y_min
    }

    pub fn y_range(&self) -> Option<[f64; 2]> {
        self.y_range
    }

    pub fn decimals(&self) -> usize {
        self.decimals
    }

    /// The drawn height at a horizontal coordinate.
    pub fn height_at_x(&self, x: f64) -> f64 {
        let k = segment_at(&self.xs, x);
        let (xa, xb) = (self.xs[k], self.xs[k + 1]);
        let (ya, yb) = (self.ys[k], self.ys[k + 1]);
        let dx = xb - xa;
        if dx <= 0.0 {
            return ya;
        }

        let s = (x - xa) / dx;
        match self.interp {
            // A step holds each point's value in the band to its RIGHT, and the
            // last point has no band — the drawing ends there. So it used to be
            // drawn and yet unreachable, with the right edge reporting the
            // plateau before it while linear and smooth reported the point.
            Interp::Step => {
                if x >= xb {
                    yb
                } else {
                    ya
                }
            }
            Interp::Smooth => {
                let slopes = self.slopes.as_ref().expect("built for Smooth");
                let (ma, mb) = (slopes[k], slopes[k + 1]);
                let s2 = s * s;
                let s3 = s2 * s;
                (2.0 * s3 - 3.0 * s2 + 1.0) * ya
                    + (s3 - 2.0 * s2 + s) * dx * ma
                    + (-2.0 * s3 + 3.0 * s2) * yb
                    + (s3 - s2) * dx * mb
            }
            Interp::Linear => ya + s * (yb - ya),
        }
    }

    /// The value at position `t` in [0,1].
    ///
    /// `dt` is how much of the drawing one row covers. When the rows outnumber
    /// a row also owned a WINDOW — the slice of drawing between it and its
    /// neighbours — and whenever a drawn vertex fell inside it the row returned
    /// that window's average instead of the crossing. Which rule a row used
    /// depended on where the vertices happened to land, so neighbouring rows of
    /// one drawing were computed by different laws and nothing in the picture
    /// said which was which. Ten rows are a request for ten readings, and ten
    /// readings are what they get; a peak between two of them is the consequence
    /// of having asked for ten, not a lost measurement.
    pub fn value_at(&self, t: f64) -> f64 {
        let x0 = self.xs[0];
        let xn = self.xs[self.xs.len() - 1];
        let span = xn - x0;

        let y = self.height_at_x(x0 + clamp01(t) * span);

        let Some(range) = self.y_range else { return y };
        // The CANVAS is the scale, never the ink: the image for a raster, 0..100
        // grown only to hold what was drawn outside it for a list of points.
        let vspan = self.y_max - self.y_min;
        let yn = if vspan == 0.0 {
            0.5
        } else {
            (y - self.y_min) / vspan
        };
        let scaled = range[0] + yn * (range[1] - range[0]);
        // A drawn point is inside its canvas by construction, so this catches
        // only what is added AFTER the mapping — a spread's scatter and a band's
        // width.
        scaled.clamp(range[0].min(range[1]), range[0].max(range[1]))
    }
}

/// Fritsch–Carlson tangents: the slope at a point is a weighted harmonic mean of
/// its neighbouring secants, forced to zero wherever the data turns. That is
/// what keeps the smoothed line inside the values that were actually drawn.
fn pchip_slopes(xs: &[f64], ys: &[f64]) -> Vec<f64> {
    let n = xs.len();
    let mut h = vec![0.0; n - 1];
    let mut d = vec![0.0; n - 1];
    for i in 0..n - 1 {
        h[i] = xs[i + 1] - xs[i];
        d[i] = if h[i] == 0.0 {
            0.0
        } else {
            (ys[i + 1] - ys[i]) / h[i]
        };
    }

    let mut m = vec![0.0; n];
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for i in 1..n - 1 {
        let (d0, d1) = (d[i - 1], d[i]);
        if d0 * d1 <= 0.0 {
            m[i] = 0.0;
        } else {
            let w1 = 2.0 * h[i] + h[i - 1];
            let w2 = h[i] + 2.0 * h[i - 1];
            m[i] = (w1 + w2) / (w1 / d0 + w2 / d1);
        }
    }
    m
}

/// The segment `[xs[k], xs[k+1]]` that contains `x`.
pub fn segment_at(xs: &[f64], x: f64) -> usize {
    let mut lo = 0usize;
    let mut hi = xs.len() - 1;
    while lo < hi {
        // Upper-half bisection: the last index whose value is <= the target,
        // not the first that exceeds it. Written as `(lo + hi + 1) / 2` because
        // rounding DOWN here would leave `lo` where it was and loop forever;
        // clippy reads it as an unrolled `div_ceil` and is right about the
        // arithmetic, so it is spelled that way.
        let mid = (lo + hi).div_ceil(2);
        if xs[mid] <= x {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    lo.min(xs.len() - 2)
}

fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}
