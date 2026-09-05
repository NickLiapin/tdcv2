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

  /**
   * The value this row would have held, inside {@code missing_when}.
   *
   * <p>Named like the run's other built-ins ({@code _count}, {@code _first}, {@code _last},
   * {@code _total}) because it is one: a name the language provides rather than one a config
   * declares. The underscore is what keeps it from colliding with a column.
   */
  public static final String MISSING_VALUE_NAME = "_value";

  /**
   * {@code missing="p"} with an optional {@code missing_as="NULL"} and {@code missing_when="…"}.
   *
   * <p>{@code when} is {@code null} when every row is eligible — MCAR. It is kept as the source
   * TEXT rather than a parsed tree because the evaluator takes text, and because the streaming
   * engine builds this spec per row.
   */
  public record Missing(double probability, String token, String when) {}

  /** Is row {@code i} eligible to go missing? {@code null} means every row is — MCAR. */
  @FunctionalInterface
  public interface Eligible {
    boolean test(int i, String value);
  }

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
    String when = attrs.get("missing_when");
    when = when == null || when.isBlank() ? null : when.trim();
    return new Missing(p, attrs.getOrDefault("missing_as", ""), when);
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
   * Blank each ELIGIBLE value with the given probability.
   *
   * <p>Real datasets have holes, and code that has only ever seen complete data tends to fall
   * over on the first one. {@code missing_when=} decides which rows are eligible, and that one
   * attribute is the whole difference between the three mechanisms the literature names:
   *
   * <pre>
   * MCAR  missing="0.2"                                 every row eligible
   * MAR   missing="0.4" missing_when="Age &lt; 30"          eligibility from ANOTHER column
   * MNAR  missing="0.5" missing_when="_value &gt; 150000"   from the value itself
   * </pre>
   *
   * <p>{@code eligible} of {@code null} means every row is. <b>The draw is made only for an
   * eligible row</b>, and that is deliberate: drawing for every row and discarding the result
   * would spend a number per row on a column that may never blank, and would tie the eligible
   * rows' randomness to how many ineligible ones came before — so widening a condition would
   * change rows it does not cover.
   */
  public static void applyMissing(List<String> values, Missing spec, Prng.Sfc32 prng) {
    applyMissing(values, spec, prng, null);
  }

  public static void applyMissing(
      List<String> values, Missing spec, Prng.Sfc32 prng, Eligible eligible) {
    if (spec.probability() <= 0) {
      // No draws at all when nothing can go missing, so `missing="0"` costs nothing.
      return;
    }
    for (int i = 0; i < values.size(); i++) {
      if (eligible != null && !eligible.test(i, values.get(i))) {
        continue;
      }
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
      return Double.isFinite(n) ? keepShape(value, n * factor) : value;
    } catch (NumberFormatException | NullPointerException e) {
      // Not a number, so there is no outlier to make. Left exactly as it was.
      return value;
    }
  }

  /**
   * The spike keeps the SHAPE of the value it replaced.
   *
   * <p>Multiplying and re-stringifying threw away everything the column had already been
   * rendered with — the zero padding {@code length=} asked for, and the decimal places {@code
   * decimals=} asked for — so the outlier rows were the only ones in the file with a different
   * shape: {@code length="5"} gave 00014, 00046 and then 117; {@code decimals="2"} gave 85.66,
   * 40.97 and then 6.445. A column of fixed-width identifiers stopped being fixed width on
   * exactly the rows a test is about to exercise, and a column declared with decimals is typed
   * a float in Parquet — a third place is a value the declared type never promised. An outlier
   * is meant to be far from the others in VALUE, not in format.
   */
  private static String keepShape(String original, double spiked) {
    int dot = original.indexOf('.');
    int places = dot < 0 ? 0 : original.length() - dot - 1;

    // Rounded on the SCALED integer, half away from zero, rather than by handing an arbitrary
    // product to a host formatter: `round` already means that everywhere else in TDC, and it
    // is the one rule all five spell the same.
    double scale = Math.pow(10, places);
    double scaled = spiked * scale;
    double rounded = scaled < 0 ? -Math.floor(-scaled + 0.5) : Math.floor(scaled + 0.5);
    String text = String.format(java.util.Locale.ROOT, "%." + places + "f", rounded / scale);

    // Only a value that was ZERO-PADDED has a width to preserve. `12.89` is five characters
    // wide because the number is, not because the column asked for five.
    String bare = original.startsWith("-") ? original.substring(1) : original;
    int bareDot = bare.indexOf('.');
    String wholePart = bareDot < 0 ? bare : bare.substring(0, bareDot);
    if (!wholePart.startsWith("0") || wholePart.length() < 2) {
      return text;
    }

    boolean negative = text.startsWith("-");
    String body = negative ? text.substring(1) : text;
    int cut = body.indexOf('.');
    String whole = cut < 0 ? body : body.substring(0, cut);
    String rest = cut < 0 ? "" : body.substring(cut);
    StringBuilder padded = new StringBuilder();
    if (negative) {
      padded.append('-');
    }
    for (int i = whole.length(); i < wholePart.length(); i++) {
      padded.append('0');
    }
    return padded.append(whole).append(rest).toString();
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
