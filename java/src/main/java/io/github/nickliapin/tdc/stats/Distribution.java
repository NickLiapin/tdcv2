package io.github.nickliapin.tdc.stats;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * Named statistical distributions for {@code <gen type="number" distribution="..."/>}.
 *
 * <p>A column drawn from a distribution looks like real data. Heights are normal, incomes are
 * lognormal, waiting times are exponential, word frequencies are Zipf — and a uniform range over
 * the same interval looks like none of them, which is exactly what makes uniform test data feel
 * wrong to anyone who knows the domain.
 *
 * <p>Two rules hold across every distribution here, and both exist to keep a row computable from
 * its index alone:
 *
 * <ul>
 *   <li><b>A fixed number of draws.</b> Inverse-CDF or Box–Muller only, never rejection sampling.
 *       Rejection sampling consumes a variable number of uniforms, which would make each row
 *       depend on all the rows before it.
 *   <li><b>No dependency.</b> The arithmetic is written out here, so the numbers are the same in
 *       every language rather than the same as whatever library each language happened to pick.
 * </ul>
 */
public final class Distribution {

  /** {@code e^-lambda} underflows to zero past about 745, which would break the recurrence. */
  private static final double POISSON_MAX_LAMBDA = 700;

  private static final long ZIPF_MAX_N = 10_000_000L;

  /** Half of a 32-bit unit in the last place. */
  private static final double HALF_ULP = 0.5 / 4294967296.0;

  /**
   * Nudge a raw draw into the open interval (0,1).
   *
   * <p>sfc32 emits values in {@code [0, 1)}, and inverse-CDF sampling takes logarithms and
   * negative powers — at exactly 0 those are infinite. The nudge is about 1e-10 and shifts
   * nothing that matters statistically.
   */
  public static double openUnit(double u) {
    return Math.min(1 - HALF_ULP, Math.max(HALF_ULP, u + HALF_ULP));
  }

  public record Spec(
      String name,
      int draws,
      int decimals,
      Double min,
      Double max,
      Map<String, Double> params,
      double[] table) {}

  private Distribution() {}

  /** How many uniforms {@link #sample} needs for this spec. */
  public static Spec parse(Map<String, String> attrs) {
    String name = attrs.get("distribution");
    int decimals = decimals(attrs.get("decimals"));
    Double min = optional(attrs.get("min"), "min");
    Double max = optional(attrs.get("max"), "max");
    if (min != null && max != null && min > max) {
      throw new IllegalArgumentException(
          "distribution: min (" + min + ") must be <= max (" + max + ")");
    }

    String dist = name == null ? "null" : name;
    return switch (dist) {
      case "normal" -> spec(dist, 2, decimals, min, max, Map.of(
          "mean", required(attrs, "mean", dist),
          "sd", positive(attrs, "sd", dist)), null);
      case "lognormal" -> spec(dist, 2, decimals, min, max, Map.of(
          "meanlog", required(attrs, "meanlog", dist),
          "sdlog", positive(attrs, "sdlog", dist)), null);
      case "exponential" -> spec(dist, 1, decimals, min, max, Map.of(
          "rate", positive(attrs, "rate", dist)), null);
      case "pareto" -> spec(dist, 1, decimals, min, max, Map.of(
          "alpha", positive(attrs, "alpha", dist),
          "xmin", positive(attrs, "xmin", dist)), null);
      case "weibull" -> spec(dist, 1, decimals, min, max, Map.of(
          "shape", positive(attrs, "shape", dist),
          "scale", positive(attrs, "scale", dist)), null);
      case "gamma" -> spec(dist, 1, decimals, min, max, Map.of(
          "shape", positive(attrs, "shape", dist),
          "scale", positive(attrs, "scale", dist)), null);
      case "beta" -> spec(dist, 1, decimals, min, max, Map.of(
          "alpha", positive(attrs, "alpha", dist),
          "beta", positive(attrs, "beta", dist)), null);
      case "poisson" -> {
        double lambda = positive(attrs, "lambda", dist);
        yield spec(dist, 1, decimals, min, max, Map.of("lambda", lambda), poissonCdf(lambda));
      }
      case "zipf" -> {
        double n = positiveInteger(attrs, "n", dist);
        double s = positive(attrs, "s", dist);
        yield spec(dist, 1, decimals, min, max, Map.of("n", n, "s", s), zipfCumulative((int) n, s));
      }
      default -> throw new IllegalArgumentException(
          "distribution: unknown distribution \""
              + dist
              + "\" — expected normal, lognormal, exponential, pareto, weibull, poisson, zipf,"
              + " gamma, or beta");
    };
  }

  private static Spec spec(
      String name,
      int draws,
      int decimals,
      Double min,
      Double max,
      Map<String, Double> params,
      double[] table) {
    return new Spec(name, draws, decimals, min, max, params, table);
  }

  /**
   * The raw value, from uniforms that are already in the open interval (0,1). Clipping and
   * rounding happen in {@link #format}.
   */
  public static double sample(Spec spec, double[] uniforms) {
    double u1 = uniforms.length > 0 ? uniforms[0] : 0;
    double u2 = uniforms.length > 1 ? uniforms[1] : 0;
    Map<String, Double> p = spec.params();
    return switch (spec.name()) {
      case "normal" -> p.get("mean") + p.get("sd") * boxMuller(u1, u2);
      case "lognormal" -> Math.exp(p.get("meanlog") + p.get("sdlog") * boxMuller(u1, u2));
      case "exponential" -> -Math.log(u1) / p.get("rate");
      case "pareto" -> p.get("xmin") * Math.pow(1 - u1, -1 / p.get("alpha"));
      case "weibull" -> p.get("scale") * Math.pow(-Math.log(u1), 1 / p.get("shape"));
      // The smallest count k where P(X <= k) >= u.
      case "poisson" -> lowerBound(spec.table(), u1);
      // Ranks are 1-based.
      case "zipf" -> lowerBound(spec.table(), u1) + 1;
      case "gamma" -> p.get("scale") * Special.gammaPInv(p.get("shape"), u1);
      case "beta" -> Special.betaIInv(p.get("alpha"), p.get("beta"), u1);
      default -> throw new IllegalStateException("distribution: unhandled " + spec.name());
    };
  }

  public static String format(double x, Spec spec) {
    double v = x;
    if (spec.min() != null) {
      v = Math.max(spec.min(), v);
    }
    if (spec.max() != null) {
      v = Math.min(spec.max(), v);
    }
    return io.github.nickliapin.tdc.lib.Fixed.toFixed(v, spec.decimals());
  }

  /** A standard normal deviate by Box–Muller, from two uniforms in (0,1). */
  private static double boxMuller(double u1, double u2) {
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** The smallest index where {@code cum[k] >= u}, by binary search; clamped to the last. */
  private static double lowerBound(double[] cum, double u) {
    int lo = 0;
    int hi = cum.length - 1;
    while (lo < hi) {
      int mid = (lo + hi) >>> 1;
      if (cum[mid] >= u) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    return lo;
  }

  /** {@code cdf[k] = P(X <= k)}, extended until it reaches one. */
  private static double[] poissonCdf(double lambda) {
    if (lambda > POISSON_MAX_LAMBDA) {
      throw new IllegalArgumentException(
          "distribution \"poisson\": lambda "
              + lambda
              + " is too large (max "
              + (long) POISSON_MAX_LAMBDA
              + "); for large means use distribution=\"normal\" mean=\""
              + lambda
              + "\" sd=\"sqrt(lambda)\".");
    }
    List<Double> cdf = new ArrayList<>();
    double p = Math.exp(-lambda);
    double cum = p;
    cdf.add(cum);
    double cap = lambda + 40 * Math.sqrt(lambda) + 100;
    for (int k = 1; cum < 1 - 1e-12 && k < cap; k++) {
      p = p * lambda / k;
      cum += p;
      cdf.add(Math.min(1, cum));
    }
    double[] out = new double[cdf.size()];
    for (int i = 0; i < out.length; i++) {
      out[i] = cdf.get(i);
    }
    return out;
  }

  /** {@code cum[k] = P(rank <= k+1)} over ranks 1..n. */
  private static double[] zipfCumulative(int n, double s) {
    if (n > ZIPF_MAX_N) {
      throw new IllegalArgumentException(
          "distribution \"zipf\": n " + n + " is too large (max " + ZIPF_MAX_N + ").");
    }
    double sum = 0;
    double[] weights = new double[n];
    for (int k = 1; k <= n; k++) {
      double w = 1 / Math.pow(k, s);
      weights[k - 1] = w;
      sum += w;
    }
    double[] cum = new double[n];
    double c = 0;
    for (int k = 0; k < n; k++) {
      c += weights[k] / sum;
      cum[k] = c;
    }
    // Pin the last against floating-point drift, so a u near 1 lands on rank n rather than
    // falling off the end of the table.
    cum[n - 1] = 1;
    return cum;
  }

  private static int decimals(String raw) {
    if (raw == null || raw.isBlank()) {
      return 0;
    }
    int n;
    try {
      n = Integer.parseInt(raw.trim());
    } catch (NumberFormatException e) {
      throw new IllegalArgumentException(
          "distribution: \"decimals\" must be a non-negative integer (got \"" + raw + "\")");
    }
    if (n < 0) {
      throw new IllegalArgumentException(
          "distribution: \"decimals\" must be a non-negative integer (got \"" + raw + "\")");
    }
    return n;
  }

  private static Double optional(String raw, String label) {
    if (raw == null || raw.isBlank()) {
      return null;
    }
    try {
      return Double.parseDouble(raw.trim());
    } catch (NumberFormatException e) {
      throw new IllegalArgumentException(
          "distribution: \"" + label + "\" must be a number (got \"" + raw + "\")");
    }
  }

  private static double required(Map<String, String> attrs, String key, String dist) {
    String raw = attrs.get(key);
    if (raw == null || raw.isBlank()) {
      throw new IllegalArgumentException(
          "distribution \"" + dist + "\": \"" + key + "\" is required and must be a number");
    }
    try {
      double n = Double.parseDouble(raw.trim());
      if (!Double.isFinite(n)) {
        throw new NumberFormatException();
      }
      return n;
    } catch (NumberFormatException e) {
      throw new IllegalArgumentException(
          "distribution \"" + dist + "\": \"" + key + "\" is required and must be a number");
    }
  }

  private static double positive(Map<String, String> attrs, String key, String dist) {
    double n = required(attrs, key, dist);
    if (!(n > 0)) {
      throw new IllegalArgumentException(
          "distribution \"" + dist + "\": \"" + key + "\" must be a positive number (got " + n + ")");
    }
    return n;
  }

  private static double positiveInteger(Map<String, String> attrs, String key, String dist) {
    double n = required(attrs, key, dist);
    if (n != Math.rint(n) || n < 1) {
      throw new IllegalArgumentException(
          "distribution \"" + dist + "\": \"" + key + "\" must be a positive integer (got " + n + ")");
    }
    return n;
  }
}
