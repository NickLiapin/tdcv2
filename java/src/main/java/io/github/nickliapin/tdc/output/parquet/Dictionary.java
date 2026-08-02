package io.github.nickliapin.tdc.output.parquet;

import io.github.nickliapin.tdc.output.ColumnType;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Dictionary encoding — store each distinct value once, then point at it.
 *
 * <p>A column of city names repeats "Moscow" ten thousand times. PLAIN writes those bytes ten
 * thousand times; a dictionary writes them once and spends two BITS per row pointing at them.
 * That is the largest size win available short of compression, and it costs no dependency.
 *
 * <p>Whether to use it has to be decided from the data, and the decision has to be reproducible.
 * A heuristic that consulted anything else — a clock, a memory figure, a sampling rate — would
 * put different bytes in the file on different runs and break the guarantee the whole writer
 * exists to keep. So the rule below reads only the values.
 */
public final class Dictionary {

  /**
   * A dictionary pays for itself when values repeat. Requiring at least a halving keeps it away
   * from near-unique columns — ids, timestamps, uuids — where the indices would be pure overhead
   * on top of values that are already all different.
   */
  private static final double MAX_DISTINCT_RATIO = 0.5;

  /**
   * Beyond this, the dictionary page itself grows large enough that a reader pays to load it even
   * when it wants only a few rows.
   */
  private static final int MAX_DISTINCT = 1 << 16;

  /** The distinct values in first-seen order, and one index per present value. */
  public record Built(List<Convert.Value> values, int[] indices) {}

  private Dictionary() {}

  /**
   * Build a dictionary for these values, or {@code null} when it would not pay.
   *
   * <p>Null is the signal to keep PLAIN encoding, not an error.
   */
  public static Built build(ColumnType type, List<Convert.Value> present) {
    // A boolean already costs one bit; a dictionary would only add a page to carry two values.
    if (type.kind() == ColumnType.Kind.BOOL || present.isEmpty()) {
      return null;
    }

    Map<String, Integer> seen = new HashMap<>();
    List<Convert.Value> values = new ArrayList<>();
    int[] indices = new int[present.size()];

    for (int i = 0; i < present.size(); i++) {
      Convert.Value value = present.get(i);
      String key = keyOf(value);
      Integer index = seen.get(key);
      if (index == null) {
        index = values.size();
        seen.put(key, index);
        values.add(value);
        // Give up as soon as it is clearly not worth it, rather than building a dictionary the
        // size of the column and then throwing it away.
        if (values.size() > MAX_DISTINCT) {
          return null;
        }
      }
      indices[i] = index;
    }

    if (values.size() > present.size() * MAX_DISTINCT_RATIO) {
      return null;
    }
    return new Built(values, indices);
  }

  /** A stable identity key. It must never merge two values a reader would tell apart. */
  private static String keyOf(Convert.Value value) {
    if (value == null) {
      return "n:";
    }
    if (value instanceof Convert.BytesValue bytes) {
      StringBuilder out = new StringBuilder("b:");
      for (byte b : bytes.value()) {
        out.append(b & 0xff).append(',');
      }
      return out.toString();
    }
    if (value instanceof Convert.TextValue text) {
      return "s:" + text.value();
    }
    if (value instanceof Convert.LongValue number) {
      return "i:" + number.value();
    }
    if (value instanceof Convert.IntValue number) {
      // Distinguished from a long by its prefix, so the same digits in two slots cannot merge.
      return "j:" + number.value();
    }
    if (value instanceof Convert.DoubleValue number) {
      return "d:" + number.value();
    }
    return "z:" + ((Convert.BoolValue) value).value();
  }
}
