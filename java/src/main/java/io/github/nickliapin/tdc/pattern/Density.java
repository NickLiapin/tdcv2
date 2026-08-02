package io.github.nickliapin.tdc.pattern;

import java.util.ArrayList;
import java.util.List;

/**
 * The other question the same drawing can answer: {@code mode="density"}.
 *
 * <p>A signal reads the line as a trajectory — the horizontal axis is the row index, the height
 * is that row's value, and the rows walk along the line in order. A density asks the opposite:
 * the horizontal axis is the <em>value</em> and the height is how <em>often</em> that value comes
 * up. Draw a hump over the middle and the numbers pile up in the middle, in no particular order.
 *
 * <p>It is "draw your own probability" instead of picking {@code normal} or {@code poisson} from
 * a list — which matters when the real shape has two peaks, or a long tail on one side only, and
 * no named distribution fits.
 */
public final class Density {

  /** How finely the drawing is integrated; every drawn vertex is kept on top of this. */
  private static final int GRID = 512;

  private final double[] xs;
  private final double[] dens;
  private final double[] cdf;
  private final double area;
  private final double[] yRange;
  private final int decimals;

  private Density(
      double[] xs, double[] dens, double[] cdf, double area, double[] yRange, int decimals) {
    this.xs = xs;
    this.dens = dens;
    this.cdf = cdf;
    this.area = area;
    this.yRange = yRange;
    this.decimals = decimals;
  }

  public int decimals() {
    return decimals;
  }

  /**
   * Turn a curve into a distribution.
   *
   * <p>Zero probability is the drawing's own floor — the lowest point on it — so the deepest
   * part of the drawing is the value that never appears. A drawing with no height at all has
   * nothing to weight by, and becomes a flat distribution rather than an error.
   */
  public static Density of(Curve curve) {
    double[] vertices = curve.xs();
    double xMax = vertices[vertices.length - 1];

    List<Double> grid = new ArrayList<>();
    int per = Math.max(1, (int) Math.ceil((double) GRID / Math.max(1, vertices.length - 1)));
    for (int i = 0; i < vertices.length - 1; i++) {
      double a = vertices[i];
      double b = vertices[i + 1];
      for (int k = 0; k < per; k++) {
        grid.add(a + (b - a) * k / per);
      }
    }
    grid.add(xMax);

    double[] xs = new double[grid.size()];
    double[] dens = new double[grid.size()];
    for (int i = 0; i < grid.size(); i++) {
      xs[i] = grid.get(i);
      dens[i] = Math.max(0, curve.heightAtX(xs[i]) - curve.yMin());
    }

    double[] cum = new double[xs.length];
    double total = 0;
    for (int i = 0; i < xs.length - 1; i++) {
      double h = xs[i + 1] - xs[i];
      total += h * (dens[i] + dens[i + 1]) / 2;
      cum[i + 1] = total;
    }

    if (total <= 0) {
      double[] flat = new double[xs.length];
      double[] uniform = new double[xs.length];
      for (int i = 0; i < xs.length; i++) {
        flat[i] = 1;
        uniform[i] = xs.length > 1 ? (double) i / (xs.length - 1) : 0;
      }
      return new Density(xs, flat, uniform, xMax - xs[0], curve.yRange(), curve.decimals());
    }

    double[] cdf = new double[cum.length];
    for (int i = 0; i < cum.length; i++) {
      cdf[i] = cum[i] / total;
    }
    return new Density(xs, dens, cdf, total, curve.yRange(), curve.decimals());
  }

  /**
   * Invert the distribution: one uniform becomes one value.
   *
   * <p>Inside a grid cell the density is a straight line, so the area up to a point is a
   * quadratic and the exact crossing is solved rather than searched. Bucketing would be simpler
   * and would bias every value towards its cell's edge.
   */
  public double valueAt(double u) {
    double target = Math.min(Math.max(u, 0), 1);
    int lo = 0;
    int hi = cdf.length - 1;
    while (lo < hi) {
      int mid = (lo + hi + 1) >>> 1;
      if (cdf[mid] <= target) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    int k = Math.min(lo, xs.length - 2);
    double xa = xs[k];
    double h = xs[k + 1] - xa;
    double d0 = dens[k];
    double d1 = dens[k + 1];
    double cellArea = (target - cdf[k]) * area;

    double s;
    double slope = d1 - d0;
    if (h <= 0) {
      s = 0;
    } else if (Math.abs(slope) < 1e-12) {
      s = d0 == 0 ? 0 : Math.min(1, cellArea / (h * d0));
    } else {
      // (slope/2)·s² + d0·s − cellArea/h = 0
      double c = -cellArea / h;
      double disc = Math.max(0, d0 * d0 - 2 * slope * c);
      s = (-d0 + Math.sqrt(disc)) / slope;
      if (!Double.isFinite(s) || s < 0) {
        s = 0;
      }
      if (s > 1) {
        s = 1;
      }
    }
    double x = xa + s * h;

    if (yRange == null) {
      return x;
    }
    double x0 = xs[0];
    double xN = xs[xs.length - 1];
    double span = xN - x0;
    double xn = span == 0 ? 0 : (x - x0) / span;
    return yRange[0] + xn * (yRange[1] - yRange[0]);
  }
}
