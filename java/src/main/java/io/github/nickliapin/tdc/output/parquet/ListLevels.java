package io.github.nickliapin.tdc.output.parquet;

import java.util.ArrayList;
import java.util.List;

/**
 * The Dremel core: rows of lists turned into the three flat streams Parquet actually stores.
 *
 * <p>Parquet keeps no brackets. A list column is the leaf values laid end to end, plus two integer
 * streams that let a reader rebuild the shape. A repetition level of 0 starts a new record and 1
 * continues the current list; a definition level says how deep the value actually exists, which is
 * how an empty list and a missing element are expressed without any value at all.
 *
 * <p>The schema here has exactly one level of repetition, so the maximum repetition level is 1 and
 * the maximum definition level is 1 for a required element or 2 for an optional one. The outer
 * group is REQUIRED because "no list at all" is not a state this can produce — an empty cell is an
 * empty list — and declaring it optional would spend a level on something never emitted.
 *
 * <p>Kept apart from the writer so it can be checked against levels worked out by hand. Getting
 * these two streams wrong produces a file that readers accept and then reassemble incorrectly,
 * which is the worst failure available.
 */
public final class ListLevels {

  /** The elements that are present, and the two level streams describing their shape. */
  public record Built(
      List<String> present, int[] repLevels, int[] defLevels, int maxDef, int maxRep) {}

  private ListLevels() {}

  /** The maximum definition level for a list whose element is, or is not, nullable. */
  public static int maxDef(boolean elementNullable) {
    return elementNullable ? 2 : 1;
  }

  /** Bits needed to hold levels up to {@code maxLevel}; zero when there is nothing to say. */
  public static int bitWidth(int maxLevel) {
    int bits = 0;
    while ((1 << bits) <= maxLevel) {
      bits++;
    }
    return bits;
  }

  /**
   * The value, repetition and definition streams for one list column.
   *
   * <p>An element is NULL when its text is empty AND the element type is nullable — the same rule
   * the scalar path uses, so {@code missing=} behaves identically whether or not the column
   * repeats. When the element is not nullable an empty string is a legitimate empty value and is
   * passed on to conversion, which refuses it if the type cannot hold it.
   */
  public static Built build(List<List<String>> rows, boolean elementNullable) {
    int maxDef = maxDef(elementNullable);
    List<String> present = new ArrayList<>();
    List<Integer> repLevels = new ArrayList<>();
    List<Integer> defLevels = new ArrayList<>();

    for (List<String> row : rows) {
      if (row.isEmpty()) {
        // An empty list still occupies one level slot; definition 0 IS the statement "this row
        // has no elements". Without it the row would vanish entirely.
        repLevels.add(0);
        defLevels.add(0);
        continue;
      }
      for (int k = 0; k < row.size(); k++) {
        repLevels.add(k == 0 ? 0 : 1);
        String text = row.get(k);
        if (elementNullable && text.isEmpty()) {
          defLevels.add(maxDef - 1); // the slot exists, the value does not
          continue;
        }
        defLevels.add(maxDef);
        present.add(text);
      }
    }

    return new Built(present, toArray(repLevels), toArray(defLevels), maxDef, 1);
  }

  private static int[] toArray(List<Integer> values) {
    int[] out = new int[values.size()];
    for (int i = 0; i < out.length; i++) {
      out[i] = values.get(i);
    }
    return out;
  }
}
