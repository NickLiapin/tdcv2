package io.github.nickliapin.tdc.stats;

import io.github.nickliapin.tdc.prng.Prng;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * {@code <gen type="timeseries" .../>} — a value that depends on when it happened.
 *
 * <p>The layered model every real series is built from:
 *
 * <pre>{@code value(i) = base + trend·i + amplitude·cos(2π·(i − peak)/period) + noise·z}</pre>
 *
 * <p>A trend, one seasonal wave, and gaussian noise, with the row index as the clock. Sales,
 * sensor readings and traffic look like this. A uniform draw over the same range does not, and
 * anything that plots the column will show the difference immediately.
 *
 * <p>Like the counters, the value comes from the absolute row index rather than from the row
 * before it, so any row can be computed on its own.
 */
public final class Timeseries {

  public record Spec(
      double base,
      double trend,
      /** Seasonal period in rows; zero means no seasonality. */
      double period,
      double amplitude,
      /**
       * Which row the wave peaks on, or null for the classic sine.
       *
       * <p>A plain {@code sin(2π·i/period)} crosses zero at row 0 and peaks a QUARTER PERIOD
       * later, so a year of daily rows peaks in early April — the one season nobody means by
       * "warmer in summer". {@code peak_at} names the ROW rather than a shift, because the row
       * is what the author knows: 182 of 365 is the first of July.
       */
      Double peakAt,
      /** Standard deviation of the noise; zero means no noise, and no draws. */
      double noiseSd,
      int decimals) {

    public boolean hasNoise() {
      return noiseSd != 0;
    }
  }

  private Timeseries() {}

  public static List<String> generate(Map<String, String> attrs, int count, Prng.Sfc32 prng) {
    Spec spec = parse(attrs);
    boolean noisy = spec.hasNoise();
    List<String> out = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
      // Two uniforms per row when there is noise, none at all when there is not — the draw
      // budget has to be exactly this, or a column declared after this one shifts.
      double z =
          noisy
              ? standardNormal(Distribution.openUnit(prng.next()), Distribution.openUnit(prng.next()))
              : 0;
      out.add(format(valueAt(spec, i, z), spec.decimals()));
    }
    return out;
  }

  public static Spec parse(Map<String, String> attrs) {
    double period = number(attrs, "period", 0);
    double noiseSd = number(attrs, "noise", 0);
    if (period < 0) {
      throw new IllegalArgumentException("timeseries: \"period\" must be >= 0");
    }
    if (noiseSd < 0) {
      throw new IllegalArgumentException("timeseries: \"noise\" must be >= 0");
    }

    String decimalsRaw = attrs.get("decimals");
    int decimals;
    if (decimalsRaw == null || decimalsRaw.isBlank()) {
      decimals = 0;
    } else {
      try {
        decimals = Integer.parseInt(decimalsRaw.trim());
      } catch (NumberFormatException e) {
        throw new IllegalArgumentException("timeseries: \"decimals\" must be a non-negative integer");
      }
      if (decimals < 0) {
        throw new IllegalArgumentException("timeseries: \"decimals\" must be a non-negative integer");
      }
    }

    return new Spec(
        number(attrs, "base", 0),
        number(attrs, "trend", 0),
        period,
        number(attrs, "amplitude", 0),
        attrs.get("peak_at") == null || attrs.get("peak_at").trim().isEmpty()
            ? null
            : number(attrs, "peak_at", 0),
        noiseSd,
        decimals);
  }

  /** A standard normal deviate by Box–Muller, from two uniforms in (0,1). */
  public static double standardNormal(double u1, double u2) {
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  public static double valueAt(Spec spec, int i, double z) {
    double v = spec.base() + spec.trend() * i;
    if (spec.period() > 0 && spec.amplitude() != 0) {
      // One formula for both. `cos` peaks where its argument is zero, so the wave peaks exactly
      // on `peak`. The DEFAULT peak is a quarter period in, which is where a plain
      // `sin(2π·i/period)` already peaked — so a config without `peak_at` produces the same
      // bytes it always did, without a second branch saying so.
      double peak = spec.peakAt() == null ? spec.period() / 4 : spec.peakAt();
      v += spec.amplitude() * Math.cos(2 * Math.PI * (i - peak) / spec.period());
    }
    if (spec.noiseSd() != 0) {
      v += spec.noiseSd() * z;
    }
    return v;
  }

  private static String format(double v, int decimals) {
    return io.github.nickliapin.tdc.lib.Fixed.toFixed(v, decimals);
  }

  private static double number(Map<String, String> attrs, String key, double fallback) {
    String raw = attrs.get(key);
    if (raw == null || raw.isBlank()) {
      return fallback;
    }
    try {
      double n = Double.parseDouble(raw.trim());
      if (!Double.isFinite(n)) {
        throw new NumberFormatException();
      }
      return n;
    } catch (NumberFormatException e) {
      throw new IllegalArgumentException(
          "timeseries: \"" + key + "\" must be a number (got \"" + raw + "\")");
    }
  }
}
