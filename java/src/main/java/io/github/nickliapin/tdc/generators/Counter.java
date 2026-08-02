package io.github.nickliapin.tdc.generators;

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
    long start = number(attrs.get("value"), 0);
    long step = number(attrs.get("step"), 1);
    List<String> out = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
      out.add(String.valueOf(ascending ? start + step * i : start - step * i));
    }
    return out;
  }

  private static long number(String raw, long fallback) {
    if (raw == null || raw.isBlank()) {
      return fallback;
    }
    return Long.parseLong(raw.trim());
  }
}
