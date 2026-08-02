package io.github.nickliapin.tdc.generators;

import java.math.BigInteger;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * {@code accumulate=} — a running total inside one record's {@code repeat} list.
 *
 * <p>A cell holding {@code 100,150,150} becomes {@code 100,250,400}. That is the shape most "I
 * need a running total" questions actually have: a receipt's subtotal, the elapsed time of a
 * session, the odometer over the legs of a trip. The accumulation lives inside ONE record, which
 * is why it costs nothing — a record is computed whole anyway, so rows stay independent and
 * streaming, parallel workers and {@code getAt} are untouched.
 *
 * <p>The one decision worth defending is the arithmetic. Five implementations have to produce the
 * same bytes, and floating point does not: {@code 0.1 + 0.2} prints differently in JavaScript,
 * Python, Java, C# and Rust. So the sum is done on SCALED INTEGERS — {@link BigInteger} here,
 * matching the reference's arbitrary precision exactly rather than picking a width and hoping.
 *
 * <p>{@code min} and {@code max} are different in a useful way: their result IS one of the inputs,
 * so the winning element's own text is returned unchanged. A value that arrived as {@code 007}
 * stays {@code 007}.
 */
public final class Accumulate {

  /** What a running accumulation can do. Each keeps a value that only ever moves one way. */
  public static final List<String> OPS = List.of("sum", "min", "max");

  private Accumulate() {}

  /** A misspelled op, or an element that is not a number. */
  public static final class AccumulateException extends RuntimeException {

    private static final long serialVersionUID = 1L;

    AccumulateException(String message) {
      super(message);
    }
  }

  /**
   * Read {@code accumulate=} where an unknown op simply means "none".
   *
   * <p>The engine path uses this one. By the time a value is drawn the validator has already
   * refused a misspelled op (TDC238), so throwing here would only turn a reported problem into a
   * crash.
   */
  public static String read(Map<String, String> attrs) {
    String raw = attrs.getOrDefault("accumulate", "").trim();
    return OPS.contains(raw) ? raw : null;
  }

  /** The same, but strict — the validator's copy, which turns a bad op into a diagnostic. */
  public static String parse(Map<String, String> attrs) {
    String raw = attrs.getOrDefault("accumulate", "").trim();
    if (raw.isEmpty()) {
      return null;
    }
    if (!OPS.contains(raw)) {
      throw new AccumulateException(
          "accumulate=\"" + raw + "\" is not one of " + String.join(", ", OPS));
    }
    return raw;
  }

  /** One element, scaled by a power of ten. */
  private record Fixed(BigInteger value, int scale) {}

  /**
   * Turn a list into its running accumulation.
   *
   * <p>An EMPTY element stays empty and leaves the accumulator alone. That is what {@code missing=}
   * produces, and "no reading that day" should not reset a meter or count as a zero-value
   * transaction.
   */
  public static List<String> apply(List<String> parts, String op) {
    // One pass to learn the widest fraction, so every element is compared and summed at the same
    // scale. Done first because the scale of the total must not depend on which elements happened
    // to come earlier.
    int scale = 0;
    List<Fixed> numbers = new ArrayList<>(parts.size());
    for (String part : parts) {
      if (part.trim().isEmpty()) {
        numbers.add(null);
        continue;
      }
      Fixed number = parseFixed(part);
      numbers.add(number);
      scale = Math.max(scale, number.scale());
    }

    List<String> out = new ArrayList<>(parts.size());
    BigInteger acc = null;
    String accText = "";
    for (int i = 0; i < parts.size(); i++) {
      Fixed number = numbers.get(i);
      if (number == null) {
        out.add(parts.get(i));
        continue;
      }
      BigInteger scaled = number.value().multiply(BigInteger.TEN.pow(scale - number.scale()));
      if (acc == null) {
        acc = scaled;
        accText = parts.get(i);
      } else if ("sum".equals(op)) {
        acc = acc.add(scaled);
      } else if ((scaled.compareTo(acc) < 0) == "min".equals(op)) {
        acc = scaled;
        accText = parts.get(i);
      }
      // min/max return an element that already exists, so its own spelling is kept; sum produces
      // a new number and is formatted at the shared scale.
      out.add("sum".equals(op) ? formatFixed(acc, scale) : accText);
    }
    return out;
  }

  /**
   * The same fold, but down a COLUMN instead of across a list.
   *
   * <p>{@code <gen type="running">} is this: row i's value is the accumulation of every row up to
   * it. Reusing {@link #apply} rather than writing a second fold is deliberate — the arithmetic,
   * the scale rule and the treatment of an empty cell then cannot drift apart between the two
   * features.
   *
   * <p>{@code base} is prepended and its result dropped, which is exactly "start from an opening
   * balance": it joins the scale pool, so an opening {@code 1000.00} widens the whole column to
   * two decimals the way a reader would expect.
   *
   * <p>{@code resetAt} splits the column into segments, each accumulated on its own — one running
   * balance per account rather than one for the file.
   */
  public static String[] applyColumn(
      String[] values, String op, String base, String[] resetAt) {
    String[] out = new String[values.length];
    int start = 0;
    while (start < values.length) {
      int end;
      if (resetAt == null) {
        end = values.length;
      } else {
        end = start + 1;
        while (end < values.length && java.util.Objects.equals(resetAt[end], resetAt[start])) {
          end++;
        }
      }
      List<String> parts = new ArrayList<>();
      if (base != null) {
        parts.add(base);
      }
      for (int i = start; i < end; i++) {
        parts.add(values[i] == null ? "" : values[i]);
      }
      List<String> running = apply(parts, op);
      int offset = base == null ? 0 : 1;
      for (int i = start; i < end; i++) {
        // A row outside a parent filter has no value, and gains none: the accumulator passed
        // over it without counting it.
        out[i] = values[i] == null ? null : running.get(i - start + offset);
      }
      start = end;
    }
    return out;
  }

  /**
   * One element as a value scaled by a power of ten.
   *
   * <p>Deliberately strict. A generator that produces words has no running total, and quietly
   * treating {@code abc} as zero would hand back a column that adds up to something and means
   * nothing.
   */
  private static Fixed parseFixed(String text) {
    String trimmed = text.trim();
    String body =
        !trimmed.isEmpty() && (trimmed.charAt(0) == '+' || trimmed.charAt(0) == '-')
            ? trimmed.substring(1)
            : trimmed;
    int dot = body.indexOf('.');
    String whole = dot < 0 ? body : body.substring(0, dot);
    String fraction = dot < 0 ? "" : body.substring(dot + 1);
    boolean shaped =
        !whole.isEmpty()
            && (dot < 0 || !fraction.isEmpty())
            && allDigits(whole)
            && allDigits(fraction);
    if (!shaped) {
      throw new AccumulateException(
          "accumulate=: \"" + text + "\" is not a number, so there is nothing to accumulate. "
              + "A running total needs numeric elements — accumulate= belongs on a numeric "
              + "generator.");
    }
    BigInteger magnitude = new BigInteger(whole + fraction);
    return new Fixed(trimmed.startsWith("-") ? magnitude.negate() : magnitude, fraction.length());
  }

  private static boolean allDigits(String text) {
    for (int i = 0; i < text.length(); i++) {
      char c = text.charAt(i);
      if (c < '0' || c > '9') {
        return false;
      }
    }
    return true;
  }

  /** Back to text at {@code scale} decimal places, with no float in the path. */
  private static String formatFixed(BigInteger value, int scale) {
    if (scale == 0) {
      return value.toString();
    }
    boolean negative = value.signum() < 0;
    StringBuilder digits = new StringBuilder(value.abs().toString());
    while (digits.length() < scale + 1) {
      digits.insert(0, '0');
    }
    int split = digits.length() - scale;
    return (negative ? "-" : "") + digits.substring(0, split) + "." + digits.substring(split);
  }
}
