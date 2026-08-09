package io.github.nickliapin.tdc.sequence;

import io.github.nickliapin.tdc.expr.MatchKey;
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
    // A dotted name is a name too. `Doctors.clinic` is the qualified spelling TDC232 tells the
    // author to reach for when a name is both a field and a column — and it used to fall off this
    // fast path and scan every member: measured at 108 s against 0.05 s for the bare spelling of
    // the same filter, on 40,000 rows over a pool of 2,000.
    if (!name(left) || !name(right)) {
      return null;
    }
    String leftField = asField(table, left);
    if (leftField != null && isColumn.test(right)) {
      return new String[] {leftField, right};
    }
    String rightField = asField(table, right);
    if (rightField != null && isColumn.test(left)) {
      return new String[] {rightField, left};
    }
    return null;
  }

  private static String asField(Table table, String text) {
    String prefix = table.name() + ".";
    String bare = text.startsWith(prefix) ? text.substring(prefix.length()) : text;
    return table.fields().contains(bare) ? bare : null;
  }

  /** A bare name, or one qualified with a dot — {@code clinic}, {@code Doctors.clinic}. */
  private static boolean name(String text) {
    if (text.isEmpty()) {
      return false;
    }
    for (String part : text.split("\\.", -1)) {
      if (!plain(part)) {
        return false;
      }
    }
    return true;
  }

  /**
   * member value → the members holding it. Built once per reference.
   *
   * <p>Keyed by {@link MatchKey} rather than by the raw text, so the bucket answers the same
   * question {@code ==} would: a member holding {@code "01"} is found by a row producing {@code
   * "1"}, exactly as the general expression path finds it.
   */
  public static Map<String, List<Integer>> bucketByField(Table table, String field) {
    Map<String, List<Integer>> buckets = new LinkedHashMap<>();
    List<String> column = table.columns().getOrDefault(field, List.of());
    for (int m = 0; m < table.count(); m++) {
      String key = MatchKey.of(m < column.size() ? column.get(m) : "");
      buckets.computeIfAbsent(key, k -> new ArrayList<>()).add(m);
    }
    return buckets;
  }

  /** The refusal a row gets when the filter leaves it with no member at all. */
  /**
   * {@code (Clinic="North", Budget="40")} — what the row held, for the refusal below.
   *
   * <p>The bucketed {@code field == Column} path always named the value a row was looking for;
   * the general one named nothing, so the reader could not tell a pool missing a member from a
   * filter that is wrong. What the evaluator ASKED for is what the filter reads, so the names are
   * recorded during the scan rather than parsed back out of the expression.
   */
  public static String rowValuesDetail(java.util.Map<String, String> values) {
    if (values.isEmpty()) {
      return "";
    }
    StringBuilder out = new StringBuilder(" (");
    boolean first = true;
    for (java.util.Map.Entry<String, String> entry : values.entrySet()) {
      if (!first) {
        out.append(", ");
      }
      first = false;
      out.append(entry.getKey()).append("=\"").append(entry.getValue()).append('"');
    }
    return out.append(')').toString();
  }

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
