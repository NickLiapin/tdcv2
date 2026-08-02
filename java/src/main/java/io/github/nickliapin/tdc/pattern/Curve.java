package io.github.nickliapin.tdc.pattern;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;

/**
 * A drawn line, read as data.
 *
 * <p>The horizontal axis is the row index: row {@code i} of {@code count} reads the curve at
 * {@code t = i/(count-1)}, so a sketch of half a dozen points stretches over however many rows
 * are generated — ten, or a million. The vertical axis is the value, and since a drawing has no
 * inherent scale the config declares the range with {@code y_range="min..max"}; only the shape
 * of the line matters, never the numbers it was drawn with.
 *
 * <p>This is what a config reaches for when the data has to look like something — a daily
 * traffic curve, a sales year with a Christmas peak — and no named distribution has that shape.
 */
public final class Curve {

  /** How the line is read between two drawn points. */
  public enum Interp {
    /**
     * The straight segment. Faithful to a polyline, but one segment stretched over thousands of
     * rows climbs by an identical step every time, which reads as obviously machine-made.
     */
    LINEAR,
    /**
     * A monotone cubic through the points: it eases in and out of each one and, unlike an
     * ordinary spline, never overshoots past a drawn value — which matters when the drawing is
     * the specification.
     */
    SMOOTH,
    /** Hold each value until the next point. */
    STEP
  }

  private final double[] xs;
  private final double[] ys;
  private final double yMin;
  private final double yMax;
  private final double[] yRange;
  private final int decimals;
  private final Interp interp;
  private final double[] slopes;

  private Curve(
      double[] xs,
      double[] ys,
      double yMin,
      double yMax,
      double[] yRange,
      int decimals,
      Interp interp,
      double[] slopes) {
    this.xs = xs;
    this.ys = ys;
    this.yMin = yMin;
    this.yMax = yMax;
    this.yRange = yRange;
    this.decimals = decimals;
    this.interp = interp;
    this.slopes = slopes;
  }

  public double[] xs() {
    return xs;
  }

  public double yMin() {
    return yMin;
  }

  public double[] yRange() {
    return yRange;
  }

  public int decimals() {
    return decimals;
  }

  /**
   * Build a curve from raw points.
   *
   * @param normExtent overrides the height extent used to normalize into {@code yRange}; a
   *     corridor passes the extent shared by both of its lines so the two live in one value
   *     space and the band between them means something.
   */
  public static Curve of(
      List<double[]> points, double[] yRange, int decimals, double[] normExtent, Interp interp) {
    if (points.size() < 2) {
      throw new IllegalArgumentException("pattern: need at least two points to define a curve");
    }
    List<double[]> sorted = new ArrayList<>(points);
    sorted.sort(Comparator.comparingDouble(p -> p[0]));

    double[] xs = new double[sorted.size()];
    double[] ys = new double[sorted.size()];
    for (int i = 0; i < sorted.size(); i++) {
      xs[i] = sorted.get(i)[0];
      ys[i] = sorted.get(i)[1];
    }
    double lo = ys[0];
    double hi = ys[0];
    for (double y : ys) {
      lo = Math.min(lo, y);
      hi = Math.max(hi, y);
    }
    double nyMin = normExtent != null ? normExtent[0] : lo;
    double nyMax = normExtent != null ? normExtent[1] : hi;
    double[] slopes = interp == Interp.SMOOTH ? pchipSlopes(xs, ys) : null;
    return new Curve(xs, ys, nyMin, nyMax, yRange, decimals, interp, slopes);
  }

  /**
   * Fritsch–Carlson tangents: the slope at a point is a weighted harmonic mean of its
   * neighbouring secants, forced to zero wherever the data turns. That is what keeps the
   * smoothed line inside the values that were actually drawn.
   */
  private static double[] pchipSlopes(double[] xs, double[] ys) {
    int n = xs.length;
    double[] h = new double[n - 1];
    double[] d = new double[n - 1];
    for (int i = 0; i < n - 1; i++) {
      h[i] = xs[i + 1] - xs[i];
      d[i] = h[i] == 0 ? 0 : (ys[i + 1] - ys[i]) / h[i];
    }
    double[] m = new double[n];
    m[0] = d[0];
    m[n - 1] = d[n - 2];
    for (int i = 1; i < n - 1; i++) {
      double d0 = d[i - 1];
      double d1 = d[i];
      if (d0 * d1 <= 0) {
        m[i] = 0;
      } else {
        double w1 = 2 * h[i] + h[i - 1];
        double w2 = h[i] + 2 * h[i - 1];
        m[i] = (w1 + w2) / (w1 / d0 + w2 / d1);
      }
    }
    return m;
  }

  /** The segment {@code [xs[k], xs[k+1]]} that contains {@code x}. */
  static int segmentAt(double[] xs, double x) {
    int lo = 0;
    int hi = xs.length - 1;
    while (lo < hi) {
      int mid = (lo + hi + 1) >>> 1;
      if (xs[mid] <= x) {
        lo = mid;
      } else {
        hi = mid - 1;
      }
    }
    return Math.min(lo, xs.length - 2);
  }

  /** The drawn height at a horizontal coordinate. */
  double heightAtX(double x) {
    int k = segmentAt(xs, x);
    double xa = xs[k];
    double xb = xs[k + 1];
    double ya = ys[k];
    double yb = ys[k + 1];
    double dx = xb - xa;
    if (dx <= 0) {
      return ya;
    }
    double s = (x - xa) / dx;
    if (interp == Interp.STEP) {
      return ya;
    }
    if (interp == Interp.SMOOTH && slopes != null) {
      double ma = slopes[k];
      double mb = slopes[k + 1];
      double s2 = s * s;
      double s3 = s2 * s;
      return (2 * s3 - 3 * s2 + 1) * ya
          + (s3 - 2 * s2 + s) * dx * ma
          + (-2 * s3 + 3 * s2) * yb
          + (s3 - s2) * dx * mb;
    }
    return ya + s * (yb - ya);
  }

  /**
   * The value at position {@code t} in [0,1].
   *
   * <p>{@code dt} is how much of the drawing one row covers. When the rows outnumber the drawn
   * points, that window is shorter than a segment and the reading is simply the point on the
   * line. When the drawing has <em>more</em> points than there are rows — a thousand-point trace
   * squeezed into ten — each row averages the line across its whole window instead, so the
   * detail in between is summarised rather than silently dropped by landing on one arbitrary
   * sample.
   */
  public double valueAt(double t, double dt) {
    double x0 = xs[0];
    double xN = xs[xs.length - 1];
    double span = xN - x0;

    double half = dt / 2;
    double xa = x0 + clamp01(t - half) * span;
    double xb = x0 + clamp01(t + half) * span;
    int inside = dt > 0 ? segmentAt(xs, xb) - segmentAt(xs, xa) : 0;

    double y;
    if (inside <= 0) {
      y = heightAtX(x0 + clamp01(t) * span);
    } else {
      int steps = Math.min(64, Math.max(2, inside * 2));
      double sum = 0;
      for (int i = 0; i <= steps; i++) {
        double w = i == 0 || i == steps ? 0.5 : 1;
        sum += w * heightAtX(xa + (xb - xa) * i / steps);
      }
      y = sum / steps;
    }

    if (yRange == null) {
      return y;
    }
    double vspan = yMax - yMin;
    double yn = vspan == 0 ? 0 : (y - yMin) / vspan;
    return yRange[0] + yn * (yRange[1] - yRange[0]);
  }

  private static double clamp01(double v) {
    return Math.min(Math.max(v, 0), 1);
  }
}
