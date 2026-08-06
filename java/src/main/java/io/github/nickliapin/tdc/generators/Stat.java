package io.github.nickliapin.tdc.generators;

import io.github.nickliapin.tdc.lib.Fixed;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Map;

/**
 * {@code <gen type="stat">} — one number for the WHOLE run, on every row.
 *
 * <p>{@code accumulate=} totals a list inside one record. {@code <gen type="running">} totals a
 * column as it goes, so row i knows about rows 1..i. This is the third and last axis: a row that
 * knows something about EVERY row, including the ones after it.
 *
 * <p>{@code sum}, {@code min} and {@code max} are the last value of the corresponding RUNNING
 * column, computed by {@link Accumulate#applyColumn}. That is not a shortcut — it is how the two
 * features are kept from drifting: the fixed-point scale rule, the treatment of an empty cell and
 * the "min returns the winning element's own spelling" rule are written once and used twice.
 *
 * <p>{@code mean}, {@code median} and {@code stddev} are ratios and cannot be exact, so they are
 * computed in floating point over the numeric values — the same three formulas the expression
 * language's list functions use, including the POPULATION standard deviation. {@code decimals=}
 * rounds the answer through the same {@link Fixed#toFixed} that {@code decimals=} on a number
 * already uses.
 */
public final class Stat {

  /** What a statistic can be. */
  public static final List<String> OPS =
      List.of("sum", "mean", "median", "min", "max", "count", "stddev");

  private Stat() {}

  /** A statistic that cannot be read as one. */
  public static final class StatError extends IllegalArgumentException {
    private static final long serialVersionUID = 1L;

    public StatError(String message) {
      super(message);
    }
  }

  /**
   * Read {@code op=} where an unknown op simply means "none".
   *
   * <p>The engine path uses this one: by the time a value is drawn the validator has already
   * refused a misspelled op, so throwing here would turn a reported problem into a crash.
   */
  public static String read(Map<String, String> attrs) {
    String raw = attrs.getOrDefault("op", "").trim();
    return OPS.contains(raw) ? raw : null;
  }

  /** The same, but strict — the validator's copy, which turns a bad op into a diagnostic. */
  public static String parse(Map<String, String> attrs) {
    String raw = attrs.getOrDefault("op", "").trim();
    if (raw.isEmpty()) {
      return null;
    }
    if (!OPS.contains(raw)) {
      throw new StatError("op=\"" + raw + "\" is not one of " + String.join(", ", OPS));
    }
    return raw;
  }

  /** {@code decimals=}, or null when the answer is printed at full precision. */
  public static Integer parseDecimals(Map<String, String> attrs) {
    String raw = attrs.getOrDefault("decimals", "").trim();
    if (raw.isEmpty()) {
      return null;
    }
    String bad = "decimals=\"" + raw + "\" is not a whole number from 0 to 10";
    int n;
    try {
      n = Integer.parseInt(raw);
    } catch (NumberFormatException e) {
      throw new StatError(bad);
    }
    if (n < 0 || n > 10) {
      throw new StatError(bad);
    }
    return n;
  }

  /**
   * The statistic itself, as the text that goes in every cell.
   *
   * <p>A cell the parent filter emptied does not take part — the same rule {@code applyColumn}
   * follows, so a filtered column has one meaning across the three features rather than three.
   */
  public static String statistic(String[] values, String op, Integer decimals) {
    List<String> present = new ArrayList<>();
    for (String v : values) {
      if (v != null && !v.trim().isEmpty()) {
        present.add(v);
      }
    }
    if ("count".equals(op)) {
      return String.valueOf(present.size());
    }
    if (present.isEmpty()) {
      return "";
    }

    if ("sum".equals(op) || "min".equals(op) || "max".equals(op)) {
      // The last value of the running column IS the total over every row, and reusing it is what
      // keeps the exact-decimal arithmetic from drifting.
      String[] running = Accumulate.applyColumn(values, op, null, null);
      String last = "";
      for (int i = running.length - 1; i >= 0; i--) {
        if (running[i] != null) {
          last = running[i];
          break;
        }
      }
      return decimals == null ? last : fixed(asNumber(last), decimals);
    }

    double[] figures = new double[present.size()];
    for (int i = 0; i < figures.length; i++) {
      figures[i] = asNumber(present.get(i));
    }
    double answer;
    if ("mean".equals(op)) {
      answer = mean(figures);
    } else if ("median".equals(op)) {
      answer = median(figures);
    } else {
      answer = stdDev(figures);
    }
    return decimals == null ? toText(answer) : fixed(answer, decimals);
  }

  /**
   * A double as JavaScript prints it — a whole number without a decimal point.
   *
   * <p>The reference writes {@code String(x)} and the four ports each imitate it; this is Java's
   * copy, kept beside its one caller rather than added to a shared helper nothing else needs.
   */
  private static String toText(double value) {
    if (Double.isNaN(value) || Double.isInfinite(value) || value != Math.floor(value)) {
      return String.valueOf(value);
    }
    return String.valueOf((long) value);
  }

  /** A cell as a number. The column it reads is numeric by construction. */
  private static double asNumber(String raw) {
    try {
      return Double.parseDouble(raw.trim());
    } catch (NumberFormatException e) {
      return Double.NaN;
    }
  }

  private static double mean(double[] values) {
    double sum = 0;
    for (double v : values) {
      sum += v;
    }
    return sum / values.length;
  }

  private static double median(double[] values) {
    double[] sorted = values.clone();
    Arrays.sort(sorted);
    int half = sorted.length / 2;
    return sorted.length % 2 == 1 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
  }

  /** The POPULATION standard deviation — divided by n, matching {@code stddev()} in an expression. */
  private static double stdDev(double[] values) {
    double average = mean(values);
    double variance = 0;
    for (double v : values) {
      variance += (v - average) * (v - average);
    }
    return io.github.nickliapin.tdc.mathx.TdcMath.sqrt(variance / values.length);
  }

  /**
   * {@code decimals=} applied.
   *
   * <p>The same {@link Fixed#toFixed} that {@code decimals=} on {@code <gen type="number">}
   * already uses, and nothing hand-rolled: multiplying by 10^decimals and flooring introduces a
   * rounding error of its own before the rounding rule ever runs, so two implementations could
   * land on either side of a tie for the same input.
   */
  private static String fixed(double value, int decimals) {
    if (Double.isNaN(value) || Double.isInfinite(value)) {
      return toText(value);
    }
    return Fixed.toFixed(value, decimals);
  }
}
