package io.github.nickliapin.tdc.output.parquet;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * {@code MAP} columns: {@code type="{}int64"} over a cell that reads {@code alpha:1,beta:2}.
 *
 * <p>Parquet stores a map as a repeated group of key/value pairs, so the shape is the LIST shape
 * with two leaves instead of one:
 *
 * <pre>
 * required group &lt;name&gt; (MAP) {
 *     repeated group key_value {
 *         required BYTE_ARRAY key (STRING);
 *         required|optional &lt;physical&gt; value;
 *     }
 * }
 * </pre>
 *
 * <p>Max rep is 1 for both leaves. Max def is 1 for the key — it is REQUIRED, as the format
 * insists, because a pair with no key is not a pair — and 1 or 2 for the value depending on
 * whether it is nullable.
 *
 * <p>The KEY is always text. A cell arrives here as text and Parquet forbids a null key, so a
 * second type parameter would double the syntax to buy a conversion nobody has asked for.
 *
 * <p>Kept apart from the writer so the level streams can be checked against hand-computed ones.
 * Getting them wrong produces a file readers accept and then mis-assemble, which is the worst
 * failure this writer has.
 */
public final class MapLevels {

  /** The key leaf's max definition level. Always 1: the key is REQUIRED inside a pair. */
  public static final int KEY_MAX_DEF = 1;

  private MapLevels() {}

  /** One pair. A {@code null} value is a NULL, which only a nullable map can hold. */
  public record Entry(String key, String value) {}

  /** The two leaves' values, and the level streams describing their shape. */
  public record Built(
      List<String> keys,
      List<String> present,
      int[] repLevels,
      int[] keyDefLevels,
      int[] valueDefLevels,
      int maxValueDef) {}

  /** The max definition level for a map value that is, or is not, nullable. */
  public static int valueMaxDef(boolean valueNullable) {
    return valueNullable ? 2 : 1;
  }

  /**
   * Split one cell into pairs — {@code alpha:1,beta:2} on the column's separator.
   *
   * <p>The key is everything before the FIRST {@code :}, the value everything after, so a value
   * may hold colons (a timestamp does) and a key may not. That asymmetry is the one worth having:
   * keys are short labels, values are whatever the column generates.
   *
   * <p>Three things are refused rather than guessed at, and each would otherwise produce a map
   * quietly missing an entry: a piece with no {@code :} at all (is it a key with no value, or the
   * reverse?); an empty key, which Parquet has no way to store; and a key that repeats inside one
   * row, because readers disagree about which of the two wins and some drop the row's map.
   */
  public static List<Entry> parseCell(String text, String separator, boolean valueNullable) {
    // An empty cell is an EMPTY MAP, not a map holding one blank pair — the same rule a list
    // follows, for the same reason.
    if (text.isEmpty()) {
      return List.of();
    }

    List<Entry> entries = new ArrayList<>();
    Set<String> seen = new HashSet<>();
    for (String piece : text.split(java.util.regex.Pattern.quote(separator), -1)) {
      int at = piece.indexOf(':');
      if (at < 0) {
        throw new IllegalArgumentException(
            "map entry \"" + piece + "\" has no \":\" — a map cell reads key:value"
                + separator + "key:value");
      }
      String key = piece.substring(0, at);
      if (key.isEmpty()) {
        throw new IllegalArgumentException("map entry \"" + piece + "\" has an empty key");
      }
      if (!seen.add(key)) {
        throw new IllegalArgumentException("map key \"" + key + "\" appears twice in one cell");
      }
      String value = piece.substring(at + 1);
      entries.add(new Entry(key, valueNullable && value.isEmpty() ? null : value));
    }
    return entries;
  }

  /**
   * The key, value, repetition and definition streams for one map column.
   *
   * <p>An empty map still occupies one level slot in BOTH leaves: definition 0 is the statement
   * "this row has no pairs". Without it the row would vanish from the column, and every row after
   * it would shift up by one.
   */
  public static Built build(List<List<Entry>> rows, boolean valueNullable) {
    int deepest = valueMaxDef(valueNullable);
    List<String> keys = new ArrayList<>();
    List<String> present = new ArrayList<>();
    List<Integer> repLevels = new ArrayList<>();
    List<Integer> keyDefLevels = new ArrayList<>();
    List<Integer> valueDefLevels = new ArrayList<>();

    for (List<Entry> row : rows) {
      if (row.isEmpty()) {
        repLevels.add(0);
        keyDefLevels.add(0);
        valueDefLevels.add(0);
        continue;
      }
      for (int k = 0; k < row.size(); k++) {
        Entry entry = row.get(k);
        repLevels.add(k == 0 ? 0 : 1);
        keyDefLevels.add(KEY_MAX_DEF);
        keys.add(entry.key());
        if (entry.value() == null) {
          valueDefLevels.add(deepest - 1); // the pair exists, the value does not
          continue;
        }
        valueDefLevels.add(deepest);
        present.add(entry.value());
      }
    }

    return new Built(
        keys,
        present,
        toArray(repLevels),
        toArray(keyDefLevels),
        toArray(valueDefLevels),
        deepest);
  }

  private static int[] toArray(List<Integer> values) {
    int[] out = new int[values.size()];
    for (int i = 0; i < out.length; i++) {
      out[i] = values.get(i);
    }
    return out;
  }
}
