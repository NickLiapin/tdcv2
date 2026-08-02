package io.github.nickliapin.tdc.sequence;

import io.github.nickliapin.tdc.prng.Seekable;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * {@code <pool>} — a small table computed once, before the rows.
 *
 * <p>Twenty doctors for two thousand patients. The problem an ordinary sequence cannot solve: a
 * doctor is not a VALUE, he is a RECORD, and his gender, first name and last name have to agree
 * with each other.
 *
 * <p>A pool is not read directly — {@code ${{Doctors.lastName}}} would give the dot a second
 * meaning next to {@code ${{Sequence.Field}}}. A sequence draws from it instead, and that hands us
 * the hardest rule for free: one sequence holds one value per row, so every field read from the
 * same reference in the same row comes from the same member.
 */
public final class Pool {

  /** Measured on the reference: ~320 bytes a member with four fields. */
  public static final long WARN_MEMBERS = 100_000L;

  public static final long MAX_MEMBERS = 1_000_000L;

  private Pool() {}

  /**
   * A computed pool: {@code count} members, each a set of named fields.
   *
   * <p>Column-first because that is how a member is read — a row asks for one field of one member,
   * never for a whole member at once.
   */
  public record Table(String name, int count, List<String> fields, Map<String, List<String>> columns) {}

  /**
   * The seed a pool's own values are drawn from. Part of the cross-language contract.
   *
   * <p>Derived rather than taken off the main stream, so adding a pool to a config leaves every
   * other column exactly where it was and an old snapshot still matches.
   */
  public static String poolSeed(String seed, String poolName) {
    return seed + "#pool:" + poolName;
  }

  /** The PRNG stream a reference draws its member from. Seekable by row. */
  public static String refStream(String refName) {
    return "pool-ref:" + refName;
  }

  public static int pickMember(String seed, String refName, Table table, int row) {
    return Seekable.nextInt(seed, refStream(refName), row, table.count());
  }

  /**
   * {@code field == Column}, recognised only when BOTH sides are what they look like.
   *
   * <p>Without the column test, {@code filter="clinic == North"} — where North is a bare word,
   * which the expression language has always allowed and which is the obvious way to write
   * "northern doctors only" — reads as a comparison against a column named North, finds nothing,
   * and refuses the run.
   */
  public static String[] parseEqualityFilter(
      String expression, Table table, java.util.function.Predicate<String> isColumn) {
    String[] parts = expression.split("==", -1);
    if (parts.length != 2) {
      return null;
    }
    String left = parts[0].trim();
    String right = parts[1].trim();
    if (!plain(left) || !plain(right)) {
      return null;
    }
    if (table.fields().contains(left) && isColumn.test(right)) {
      return new String[] {left, right};
    }
    if (table.fields().contains(right) && isColumn.test(left)) {
      return new String[] {right, left};
    }
    return null;
  }

  /** member value → the members holding it. Built once per reference. */
  public static Map<String, List<Integer>> bucketByField(Table table, String field) {
    Map<String, List<Integer>> buckets = new LinkedHashMap<>();
    List<String> column = table.columns().getOrDefault(field, List.of());
    for (int m = 0; m < table.count(); m++) {
      String key = m < column.size() ? column.get(m) : "";
      buckets.computeIfAbsent(key, k -> new ArrayList<>()).add(m);
    }
    return buckets;
  }

  /** The refusal a row gets when the filter leaves it with no member at all. */
  public static String noCandidateMessage(
      String poolName, String expression, int row, String detail) {
    return "pool \"" + poolName + "\": no member satisfies filter=\"" + expression + "\" for row "
        + (row + 1) + detail
        + ". A filter narrows the members a row may draw from; when it narrows them to none there "
        + "is nothing to substitute. Add a member that matches, or widen the filter.";
  }

  private static boolean plain(String text) {
    if (text.isEmpty() || !(isLetter(text.charAt(0)) || text.charAt(0) == '_')) {
      return false;
    }
    for (int i = 1; i < text.length(); i++) {
      char c = text.charAt(i);
      if (!isLetter(c) && !(c >= '0' && c <= '9') && c != '_') {
        return false;
      }
    }
    return true;
  }

  private static boolean isLetter(char c) {
    return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
  }
}
