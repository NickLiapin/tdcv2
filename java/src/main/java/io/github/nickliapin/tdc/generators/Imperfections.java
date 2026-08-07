package io.github.nickliapin.tdc.generators;

import io.github.nickliapin.tdc.prng.Prng;
import java.util.List;
import java.util.Map;

/**
 * The two things real data has that generated data usually does not: gaps and outliers.
 *
 * <p>Both are attributes on any {@code <gen>} rather than generator types of their own, because
 * both apply to whatever the generator produced. They run as a pass over the finished column,
 * anomaly first and missing second — so a value can be spiked and then blanked, and a blanked
 * value is never spiked afterwards.
 *
 * <p>Each takes exactly one draw per row when it is active and none at all when it is not. That
 * is what lets a config add {@code missing="0.1"} to one column without changing any other.
 */
public final class Imperfections {

  /** {@code missing="p"} with an optional {@code missing_as="NULL"}. */
  public record Missing(double probability, String token) {}

  /** {@code anomaly="p"} with an optional {@code anomaly_factor="10"}. */
  public record Anomaly(double probability, double factor) {}

  private static final double DEFAULT_FACTOR = 10;

  private Imperfections() {}

  public static Missing parseMissing(Map<String, String> attrs) {
    String raw = attrs.get("missing");
    if (raw == null || raw.isBlank()) {
      return null;
    }
    double p = probability(raw, "missing");
    return new Missing(p, attrs.getOrDefault("missing_as", ""));
  }

  public static Anomaly parseAnomaly(Map<String, String> attrs) {
    String raw = attrs.get("anomaly");
    if (raw == null || raw.isBlank()) {
      return null;
    }
    double p = probability(raw, "anomaly");
    String factorRaw = attrs.get("anomaly_factor");
    double factor;
    if (factorRaw == null || factorRaw.isBlank()) {
      factor = DEFAULT_FACTOR;
    } else {
      try {
        factor = Double.parseDouble(factorRaw.trim());
        if (!Double.isFinite(factor)) {
          throw new NumberFormatException();
        }
      } catch (NumberFormatException e) {
        throw new IllegalArgumentException(
            "anomaly: anomaly_factor \"" + factorRaw + "\" must be a number");
      }
    }
    return new Anomaly(p, factor);
  }

  /**
   * Blank each value with the given probability — missing completely at random.
   *
   * <p>Real datasets have holes, and code that has only ever seen complete data tends to fall
   * over on the first one.
   */
  public static void applyMissing(List<String> values, Missing spec, Prng.Sfc32 prng) {
    if (spec.probability() <= 0) {
      // No draws at all when nothing can go missing, so `missing="0"` costs nothing.
      return;
    }
    for (int i = 0; i < values.size(); i++) {
      if (prng.next() < spec.probability()) {
        values.set(i, spec.token());
      }
    }
  }

  /**
   * Multiply selected values out of their normal range, for testing detectors and pipelines
   * against spikes.
   *
   * <p>A non-numeric value is selected but left alone: an outlier is a numeric idea, and there
   * is nothing sensible to do to the word "Tuesday". {@code flags}, when supplied, records the
   * selection rather than the change, so a ground-truth column marks the rows the run chose.
   */
  public static void applyAnomaly(
      List<String> values, Anomaly spec, Prng.Sfc32 prng, boolean[] flags) {
    for (int i = 0; i < values.size(); i++) {
      boolean selected = spec.probability() > 0 && prng.next() < spec.probability();
      if (flags != null) {
        flags[i] = selected;
      }
      if (!selected) {
        continue;
      }
      values.set(i, spike(values.get(i), spec.factor()));
    }
  }

  /**
   * Whether {@link #spike} would actually change this value: it is a finite number.
   *
   * <p>Split out so the flag can be computed WITHOUT comparing before and after. That comparison
   * looks equivalent and is not — {@code 0} times any factor is still {@code 0}, and a row that
   * really was spiked would come back unflagged.
   */
  public static boolean isSpikeable(String value) {
    try {
      return Double.isFinite(Double.parseDouble(value.trim()));
    } catch (NumberFormatException notANumber) {
      return false;
    }
  }

  /**
   * One value made an outlier, or returned untouched when it is not a number.
   *
   * <p>Shared with the streaming engine, which decides row by row rather than over a column but
   * has to spike a selected value in exactly the same way.
   */
  public static String spike(String value, double factor) {
    try {
      double n = Double.parseDouble(value.trim());
      return Double.isFinite(n) ? numberToString(n * factor) : value;
    } catch (NumberFormatException | NullPointerException e) {
      // Not a number, so there is no outlier to make. Left exactly as it was.
      return value;
    }
  }

  /** {@code String(n)} as JavaScript writes it: a whole number carries no decimal point. */
  private static String numberToString(double n) {
    if (n == Math.rint(n) && Math.abs(n) < 1e21) {
      return String.valueOf((long) n);
    }
    return String.valueOf(n);
  }

  private static double probability(String raw, String label) {
    double p;
    try {
      p = Double.parseDouble(raw.trim());
    } catch (NumberFormatException e) {
      throw new IllegalArgumentException(
          label + ": probability \"" + raw + "\" must be a number in [0, 1]");
    }
    if (!Double.isFinite(p) || p < 0 || p > 1) {
      throw new IllegalArgumentException(
          label + ": probability \"" + raw + "\" must be a number in [0, 1]");
    }
    return p;
  }
}
