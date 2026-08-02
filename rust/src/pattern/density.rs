//! The other question the same drawing can answer: `mode="density"`.
//!
//! A signal reads the line as a trajectory — the horizontal axis is the row
//! index, the height is that row's value, and the rows walk along the line in
//! order. A density asks the opposite: the horizontal axis is the *value* and
//! the height is how *often* that value comes up. Draw a hump over the middle
//! and the numbers pile up in the middle, in no particular order.
//!
//! It is "draw your own probability" instead of picking `normal` or `poisson`
//! from a list — which matters when the real shape has two peaks, or a long tail
//! on one side only, and no named distribution fits.

use super::curve::Curve;

/// How finely the drawing is integrated; every drawn vertex is kept on top of this.
const GRID: usize = 512;

#[derive(Clone, Debug)]
pub struct Density {
    xs: Vec<f64>,
    dens: Vec<f64>,
    cdf: Vec<f64>,
    area: f64,
    y_range: Option<[f64; 2]>,
    decimals: usize,
}

impl Density {
    pub fn decimals(&self) -> usize {
        self.decimals
    }

    /// Turn a curve into a distribution.
    ///
    /// Zero probability is the drawing's own floor — the lowest point on it — so
    /// the deepest part of the drawing is the value that never appears. A drawing
    /// with no height at all has nothing to weight by, and becomes a flat
    /// distribution rather than an error.
    pub fn of(curve: &Curve) -> Density {
        let vertices = curve.xs();
        let x_max = vertices[vertices.len() - 1];

        let mut grid: Vec<f64> = Vec::new();
        let per = (GRID as f64 / (vertices.len() - 1).max(1) as f64).ceil() as usize;
        let per = per.max(1);
        for i in 0..vertices.len() - 1 {
            let (a, b) = (vertices[i], vertices[i + 1]);
            for k in 0..per {
                grid.push(a + (b - a) * k as f64 / per as f64);
            }
        }
        grid.push(x_max);

        let xs = grid;
        let dens: Vec<f64> = xs
            .iter()
            .map(|x| (curve.height_at_x(*x) - curve.y_min()).max(0.0))
            .collect();

        let mut cum = vec![0.0; xs.len()];
        let mut total = 0.0;
        for i in 0..xs.len() - 1 {
            let h = xs[i + 1] - xs[i];
            total += h * (dens[i] + dens[i + 1]) / 2.0;
            cum[i + 1] = total;
        }

        if total <= 0.0 {
            let n = xs.len();
            let flat = vec![1.0; n];
            let uniform: Vec<f64> = (0..n)
                .map(|i| {
                    if n > 1 {
                        i as f64 / (n - 1) as f64
                    } else {
                        0.0
                    }
                })
                .collect();
            let first = xs[0];
            return Density {
                xs,
                dens: flat,
                cdf: uniform,
                area: x_max - first,
                y_range: curve.y_range(),
                decimals: curve.decimals(),
            };
        }

        let cdf: Vec<f64> = cum.iter().map(|c| c / total).collect();
        Density {
            xs,
            dens,
            cdf,
            area: total,
            y_range: curve.y_range(),
            decimals: curve.decimals(),
        }
    }

    /// Invert the distribution: one uniform becomes one value.
    ///
    /// Inside a grid cell the density is a straight line, so the area up to a
    /// point is a quadratic and the exact crossing is solved rather than
    /// searched. Bucketing would be simpler and would bias every value towards
    /// its cell's edge.
    pub fn value_at(&self, u: f64) -> f64 {
        let target = u.clamp(0.0, 1.0);
        let mut lo = 0usize;
        let mut hi = self.cdf.len() - 1;
        while lo < hi {
            // Upper-half bisection: the last index whose value is <= the target,
            // not the first that exceeds it. Written as `(lo + hi + 1) / 2` because
            // rounding DOWN here would leave `lo` where it was and loop forever;
            // clippy reads it as an unrolled `div_ceil` and is right about the
            // arithmetic, so it is spelled that way.
            let mid = (lo + hi).div_ceil(2);
            if self.cdf[mid] <= target {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }

        let k = lo.min(self.xs.len() - 2);
        let xa = self.xs[k];
        let h = self.xs[k + 1] - xa;
        let d0 = self.dens[k];
        let d1 = self.dens[k + 1];
        let cell_area = (target - self.cdf[k]) * self.area;

        let slope = d1 - d0;
        let s = if h <= 0.0 {
            0.0
        } else if slope.abs() < 1e-12 {
            if d0 == 0.0 {
                0.0
            } else {
                (cell_area / (h * d0)).min(1.0)
            }
        } else {
            // (slope/2)·s² + d0·s − cellArea/h = 0
            let c = -cell_area / h;
            let disc = (d0 * d0 - 2.0 * slope * c).max(0.0);
            let mut s = (-d0 + disc.sqrt()) / slope;
            if !s.is_finite() || s < 0.0 {
                s = 0.0;
            }
            s.min(1.0)
        };

        let x = xa + s * h;

        let Some(range) = self.y_range else { return x };
        let x0 = self.xs[0];
        let xn = self.xs[self.xs.len() - 1];
        let span = xn - x0;
        let xn_norm = if span == 0.0 { 0.0 } else { (x - x0) / span };
        range[0] + xn_norm * (range[1] - range[0])
    }
}
