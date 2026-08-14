package io.github.nickliapin.tdc.generators;

import io.github.nickliapin.tdc.lib.Numbers;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * {@code <gen type="increment"/>} and {@code <gen type="decrement"/>}.
 *
 * <p>Position, not chance: the tenth cell is the start plus ten steps whatever the seed is, and
 * no draw is taken. That is what makes a counter safe to add to an existing config — every
 * column declared after it keeps the values it had.
 */
public final class Counter {

  private Counter() {}

  public static List<String> generate(Map<String, String> attrs, int count, boolean ascending) {
    List<String> out = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
      out.add(valueAt(attrs, i, ascending));
    }
    return out;
  }

  /**
   * One row's value, for the engines that build a counter a row at a time.
   *
   * <p>Shared with {@link #generate} so the streaming and the in-memory answer cannot drift — a
   * counter is position, not chance, and the two paths disagreeing about it would show in every
   * row.
   *
   * <p>A whole counter stays on integer arithmetic, where it is exact however far it runs. A
   * fractional one — {@code value="9.99" step="0.50"}, the shape the counters page teaches —
   * moves to the same floating point the reference uses and is written the same way, so the two
   * agree digit for digit. Note the value is the start plus {@code step * i}, not {@code i}
   * additions: repeated addition accumulates its own error and would drift away from the
   * reference by the thousandth row.
   */
  public static String valueAt(Map<String, String> attrs, long index, boolean ascending) {
    String rawStart = attrs.get("value");
    String rawStep = attrs.get("step");
    if (isWhole(rawStart) && isWhole(rawStep)) {
      long start = number(rawStart, 0);
      long step = number(rawStep, 1);
      return String.valueOf(ascending ? start + step * index : start - step * index);
    }
    double start = fraction(rawStart, 0);
    double step = fraction(rawStep, 1);
    return Numbers.toText(ascending ? start + step * index : start - step * index);
  }

  private static boolean isWhole(String raw) {
    if (raw == null || raw.isBlank()) {
      return true;
    }
    try {
      Long.parseLong(raw.trim());
      return true;
    } catch (NumberFormatException e) {
      return false;
    }
  }

  private static long number(String raw, long fallback) {
    if (raw == null || raw.isBlank()) {
      return fallback;
    }
    return Long.parseLong(raw.trim());
  }

  private static double fraction(String raw, double fallback) {
    if (raw == null || raw.isBlank()) {
      return fallback;
    }
    return Double.parseDouble(raw.trim());
  }
}
