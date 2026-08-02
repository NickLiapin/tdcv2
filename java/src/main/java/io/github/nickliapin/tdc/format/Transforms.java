package io.github.nickliapin.tdc.format;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Text transforms applied to a finished value.
 *
 * <p>Shared by three places that all mean the same thing: the {@code case=} attribute on a
 * {@code <gen>}, the compute tags, and the {@code ${{Name|upper}}} interpolation filters. One
 * implementation, so the three cannot drift apart.
 */
public final class Transforms {

  public static final List<String> CASE_TRANSFORMS = List.of("upper", "lower", "capitalize", "title");

  /** A run of non-whitespace, for {@code title}. */
  private static final Pattern WORD = Pattern.compile("\\S+");

  /** Every name accepted after a {@code |} inside an interpolation. */
  public static final List<String> FILTER_NAMES =
      List.of(
          "upper", "lower", "capitalize", "title", "mask", "slice", "replace", "trim", "group",
          "compact", "csv", "sql");

  private Transforms() {}

  public static boolean isCaseTransform(String name) {
    return CASE_TRANSFORMS.contains(name);
  }

  public static boolean isFilterName(String name) {
    return FILTER_NAMES.contains(name);
  }

  /**
   * Apply one interpolation filter.
   *
   * <p>An unknown filter passes the value through untouched. Filters are lenient by design and
   * the validator is where a typo gets named; failing here would turn a misspelling into a dead
   * run rather than a visible oddity in the output.
   */
  public static String applyFilter(String kind, String arg, String value) {
    String a = arg == null ? "" : arg;
    return switch (kind) {
      case "mask" -> Mask.apply(a, value);
      case "slice" -> {
        String[] parts = a.split(",", -1);
        Integer to = parts.length < 2 || parts[1].isEmpty() ? null : intOr(parts[1], null);
        yield slice(value, parts.length > 0 ? intOr(parts[0], 0) : 0, to);
      }
      case "replace" -> {
        int comma = a.indexOf(',');
        String from = comma < 0 ? a : a.substring(0, comma);
        String to = comma < 0 ? "" : a.substring(comma + 1);
        yield from.isEmpty() ? value : value.replace(from, to);
      }
      case "trim" -> value.trim();
      case "group" -> {
        int comma = a.indexOf(',');
        String size = comma < 0 ? a : a.substring(0, comma);
        String sep = comma < 0 ? " " : a.substring(comma + 1);
        yield group(value, size.isEmpty() ? 3 : intOr(size, 3), sep);
      }
      case "compact" -> compact(value, a.isEmpty() ? 36 : intOr(a, 36));
      case "csv" -> csv(value);
      case "sql" -> sql(value);
      case "upper", "lower", "capitalize", "title" -> applyCase(kind, value);
      default -> value;
    };
  }

  /** A substring by code-point index, {@code [from, to)}; a missing {@code to} means the end. */
  public static String slice(String s, int from, Integer to) {
    List<String> cp = Mask.codePoints(s);
    int n = cp.size();
    // Negative counts from the END, which is what the reference's Array.slice does and what
    // Python's own slicing does. Clamping a negative to zero — as this used to — turned
    // `slice:-3` from "the last three characters" into "all of them", quietly, in one
    // implementation out of three.
    int f = from < 0 ? Math.max(0, n + from) : Math.min(from, n);
    int t = to == null ? n : (to < 0 ? Math.max(0, n + to) : Math.min(to, n));
    if (t <= f) {
      return "";
    }
    return String.join("", cp.subList(f, t));
  }

  /** Group characters from the <em>right</em>, so a number's last group stays whole. */
  public static String group(String s, int size, String sep) {
    List<String> cp = Mask.codePoints(s);
    if (size <= 0 || cp.isEmpty()) {
      return s;
    }
    List<String> out = new ArrayList<>();
    for (int end = cp.size(); end > 0; end -= size) {
      out.add(0, String.join("", cp.subList(Math.max(0, end - size), end)));
    }
    return String.join(sep, out);
  }

  /**
   * Write a whole number in a shorter alphabet: {@code 1000000} becomes {@code lfls}.
   *
   * <p>The point is a unique suffix that stays readable at scale. A row id appended to a
   * generated address keeps it unique, but {@code john.smith2000000000@} is nobody's email; in
   * base 36 the same id is six characters and covers two billion rows.
   *
   * <p>Lowercase only, and deliberately. Base 62 would be shorter, but many systems fold the
   * local part of an address to lower case, so {@code aB} and {@code Ab} would merge and quietly
   * reintroduce the duplicates the suffix exists to prevent.
   */
  public static String compact(String value, int base) {
    String text = value.trim();
    if (!text.matches("^-?\\d+$") || base < 2 || base > 36) {
      return value;
    }
    try {
      long n = Long.parseLong(text);
      return (n < 0 ? "-" : "") + Long.toString(Math.abs(n), base);
    } catch (NumberFormatException e) {
      return value;
    }
  }

  /**
   * Quote a value for CSV, per RFC 4180.
   *
   * <p>{@code <data>} assembles text and knows nothing about the file being written, so a value
   * containing the delimiter silently splits the row — a product named {@code Knife set, 3 pcs}
   * turns one seven-field row into eight fields, with category landing in price and price in
   * quantity, and nothing anywhere reporting an error.
   *
   * <p>Quoted unconditionally rather than only when needed: a rule with no exceptions is one
   * nobody has to remember, every reader accepts redundant quotes, and "only when it contains a
   * comma" is exactly the reasoning that loses to a newline later.
   */
  public static String csv(String value) {
    return "\"" + value.replace("\"", "\"\"") + "\"";
  }

  /**
   * Escape a value for a single-quoted SQL literal by doubling apostrophes.
   *
   * <p>{@code O'Brien} closes the string early and the statement fails to parse — or worse, in
   * generated data, parses into something else. The body only, with no surrounding quotes, so
   * the config keeps writing {@code '${{Name|sql}}'} and the shape of the statement stays
   * visible where it is written.
   */
  public static String sql(String value) {
    return value.replace("'", "''");
  }

  private static Integer intOr(String raw, Integer fallback) {
    try {
      return Integer.valueOf(raw.trim());
    } catch (NumberFormatException e) {
      return fallback;
    }
  }

  public static String applyCase(String name, String s) {
    return switch (name) {
      case "upper" -> s.toUpperCase();
      case "lower" -> s.toLowerCase();
      case "capitalize" -> upperFirst(s);
      // Only the first letter of each word moves; the rest is left as written, so an
      // already-correct "McDonald" is not flattened to "Mcdonald".
      case "title" -> titleCase(s);
      default -> throw new IllegalArgumentException("unknown case transform \"" + name + "\"");
    };
  }

  private static String titleCase(String s) {
    Matcher m = WORD.matcher(s);
    StringBuilder out = new StringBuilder();
    int last = 0;
    while (m.find()) {
      out.append(s, last, m.start()).append(upperFirst(m.group()));
      last = m.end();
    }
    return out.append(s.substring(last)).toString();
  }

  /** Uppercase the first character by code point, so a surrogate pair is not split. */
  private static String upperFirst(String word) {
    if (word.isEmpty()) {
      return word;
    }
    int first = word.codePointAt(0);
    int width = Character.charCount(first);
    return new String(Character.toChars(first)).toUpperCase() + word.substring(width);
  }
}
