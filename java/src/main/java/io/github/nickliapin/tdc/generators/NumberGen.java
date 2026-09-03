package io.github.nickliapin.tdc.generators;

import io.github.nickliapin.tdc.distribution.Hamilton;
import io.github.nickliapin.tdc.distribution.PercentMask;
import io.github.nickliapin.tdc.prng.Prng;
import io.github.nickliapin.tdc.prng.Random;
import io.github.nickliapin.tdc.lib.Fixed;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * {@code <gen type="number" .../>} — the numeric workhorse.
 *
 * <p>Four shapes, and which one runs depends on the attributes present:
 *
 * <ul>
 *   <li>{@code value="MIN..MAX"} — a uniform integer, inclusive at both ends
 *   <li>{@code value="bit"} — 0 or 1
 *   <li>{@code value="[A..B],[C..D]"} — pick a range, then a value inside it
 *   <li>{@code length="N"} with no {@code value} — a digit string, built one digit at a time
 * </ul>
 *
 * <p>The last shape is string-based rather than numeric on purpose: a 40-digit account number
 * has no business being a {@code long}, and building it digit by digit means the width is
 * whatever the config asked for instead of whatever the type allows.
 *
 * <p>Leading zeros come from the way the range was written. {@code value="0000..9999"} pads to
 * four; {@code value="0..9999"} does not. That reads as a formatting accident but it is the
 * documented rule, and it is how an existing config gets zero-padded ids without a second
 * attribute.
 */
public final class NumberGen {

  private static final Pattern RANGE = Pattern.compile("^\\s*(-?\\d+)\\s*\\.\\.\\s*(-?\\d+)\\s*$");
  private static final Pattern SINGLE = Pattern.compile("^-?\\d+$");
  private static final Pattern INT = Pattern.compile("^-?\\d+$");
  private static final Pattern LENGTH_RANGE = Pattern.compile("^(\\d+)\\s*-\\s*(\\d+)$");

  /** An inclusive integer range; {@code width} is the zero-padding the source text implied. */
  public record Range(long min, long max, int width) {}

  private record Interval(long min, long max) {}

  /** One entry of {@code length="2,10-12"}: a fixed width, or a range of them. */
  public record LengthChoice(int min, int max) {}

  private NumberGen() {}

  public static List<String> generate(Map<String, String> attrs, int count, Prng.Sfc32 prng) {
    String rangeSpec = attrs.getOrDefault("value", "").trim();
    List<Range> ranges = rangeSpec.isEmpty() ? List.of() : parseRanges(rangeSpec);

    boolean hasExplicitLength = attrs.get("length") != null;
    List<LengthChoice> lengthChoices =
        hasExplicitLength
            ? parseLengthChoices(attrs.get("length"))
            : ranges.isEmpty() ? List.of(new LengthChoice(1, 1)) : List.<LengthChoice>of();

    String firstZero = attrs.get("first_zero");
    boolean allowLeadingZero =
        firstZero != null ? Boolean.parseBoolean(firstZero.trim()) : !ranges.isEmpty() || !hasExplicitLength;

    String percent = attrs.get("percent");
    if (percent != null && lengthChoices.size() <= 1) {
      // Validates the mask and reports the same complaint the reference does. It cannot select
      // anything with one choice, but a mask that is wrong should still say so.
      PercentMask.expand(percent, lengthChoices.size());
    }

    String include = attrs.get("include");
    String exclude = attrs.get("exclude");
    boolean hasModifiers =
        (include != null && !include.isBlank()) || (exclude != null && !exclude.isBlank());
    List<Interval> allowed = null;
    int allowedWidth = 0;
    if (hasModifiers) {
      if (ranges.isEmpty()) {
        throw new IllegalArgumentException(
            "number generator: include/exclude require a numeric range in \"value\", e.g. value=\"0..9\"");
      }
      allowed = computeAllowed(ranges, include, exclude);
      allowedWidth = ranges.stream().mapToInt(Range::width).filter(w -> w > 0).findFirst().orElse(0);
    }

    int decimals = parseDecimals(attrs.get("decimals"));
    if (decimals > 0 && !ranges.isEmpty() && allowed == null) {
      List<String> out = new ArrayList<>(count);
      for (int i = 0; i < count; i++) {
        out.add(randomDecimal(ranges, decimals, prng));
      }
      return out;
    }

    int[] widths = materializeWidths(count, lengthChoices, percent, prng);
    List<String> out = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
      int width = widths[i];
      if (allowed != null) {
        out.add(drawGuarded(allowed, width > 0 ? width : allowedWidth, allowLeadingZero, prng));
      } else if (ranges.isEmpty()) {
        out.add(digitString(width, allowLeadingZero, prng));
      } else {
        out.add(drawGuardedRange(ranges, width, allowLeadingZero, prng));
      }
    }
    return out;
  }

  // ── parsing ──────────────────────────────────────────────────────────────────────────────

  /**
   * The length groups {@code percent=} apportions between, or {@code null} when there is no
   * such split.
   *
   * <p>Which group a row lands in is an exact quota over the whole column, so the streaming
   * engine has to plan it rather than draw it — with one row to apportion, the largest share
   * takes everything and an 85/15 split silently becomes 100/0.
   */
  public static List<LengthChoice> weightedLengthChoices(Map<String, String> attrs) {
    String length = attrs.get("length");
    String percent = attrs.get("percent");
    if (length == null || percent == null || percent.trim().isEmpty()) {
      return null;
    }
    try {
      List<LengthChoice> choices = parseLengthChoices(length);
      return choices.size() > 1 ? choices : null;
    } catch (RuntimeException e) {
      // Not a length spec this engine can split on; the ordinary path will report it.
      return null;
    }
  }

  /** The same attributes pinned to one length group, with {@code percent} dropped. */
  public static Map<String, String> pinLength(Map<String, String> attrs, LengthChoice group) {
    Map<String, String> out = new java.util.LinkedHashMap<>();
    for (Map.Entry<String, String> entry : attrs.entrySet()) {
      if (!"percent".equals(entry.getKey()) && !"length".equals(entry.getKey())) {
        out.put(entry.getKey(), entry.getValue());
      }
    }
    out.put(
        "length",
        group.min() == group.max()
            ? String.valueOf(group.min())
            : group.min() + "-" + group.max());
    return out;
  }

  public static List<Range> parseRanges(String source) {
    String spec = source.trim();
    if (spec.isEmpty()) {
      throw new IllegalArgumentException("number generator: range is empty");
    }
    if ("bit".equals(spec)) {
      return List.of(new Range(0, 1, 0));
    }
    // Split, then parse each piece with an anchored pattern — never one regex over
    // the whole string. `^\\[\\s*([^\\]]+?)\\s*]` once said what the bracket form means,
    // but `\\s*` and `[^\\]]+?` can both match a space, so an unclosed bracket made the
    // engine try every way to divide the run between them: `value="["` followed by
    // four thousand spaces took a minute. A generator hanging on its own config is
    // not a slow path, it is a stopped program. Splitting on a comma is linear.
    List<Range> ranges = new ArrayList<>();
    for (String piece : spec.split(",", -1)) {
      ranges.add(parseRangeItem(piece, source));
    }
    return ranges;
  }

  /** One comma-separated piece: {@code 45}, {@code 34..89}, or either in brackets. */
  private static Range parseRangeItem(String piece, String source) {
    String item = piece.trim();
    if (item.startsWith("[")) {
      if (!item.endsWith("]")) {
        throw new IllegalArgumentException("number generator: invalid range list \"" + source + "\"");
      }
      item = item.substring(1, item.length() - 1).trim();
    }
    // A bracket left INSIDE a piece means the list itself is malformed — a missing
    // comma, as in `[1..9] [2..3]`. Saying "invalid range list" there is the useful
    // answer; falling through to the range parser names the symptom, not the cause.
    if (item.contains("[") || item.contains("]") || item.isEmpty()) {
      throw new IllegalArgumentException("number generator: invalid range list \"" + source + "\"");
    }
    // A bare number is the range of one point, so the drawing code, the uniq capacity
    // check and include/exclude all keep working on it unchanged.
    if (SINGLE.matcher(item).matches()) {
      return makeRange(item, item, item);
    }
    return parseRange(item);
  }

  private static Range parseRange(String range) {
    Matcher m = RANGE.matcher(range);
    if (!m.matches()) {
      throw new IllegalArgumentException(
          "number generator: invalid range \"" + range + "\" (expected MIN..MAX)");
    }
    return makeRange(m.group(1), m.group(2), range);
  }

  private static Range makeRange(String minText, String maxText, String source) {
    long min = Long.parseLong(minText);
    long max = Long.parseLong(maxText);
    if (min > max) {
      throw new IllegalArgumentException("number generator: invalid numeric range \"" + source + "\"");
    }
    return new Range(min, max, inferWidth(minText, maxText));
  }

  /** Zero-padding is implied by the way the bounds were written, never by their magnitude. */
  private static int inferWidth(String minText, String maxText) {
    if (minText.startsWith("-") || maxText.startsWith("-")) {
      return 0;
    }
    boolean hasLeadingZeros =
        (minText.length() > 1 && minText.startsWith("0"))
            || (maxText.length() > 1 && maxText.startsWith("0"));
    return hasLeadingZeros ? Math.max(minText.length(), maxText.length()) : 0;
  }

  public static List<LengthChoice> parseLengthChoices(String source) {
    String spec = source.trim();
    if (spec.isEmpty()) {
      throw new IllegalArgumentException("number generator: length is empty");
    }
    List<LengthChoice> out = new ArrayList<>();
    for (String raw : spec.split(",", -1)) {
      String part = raw.trim();
      if (part.matches("^\\d+$")) {
        int n = Integer.parseInt(part);
        out.add(toLengthChoice(n, n, source));
        continue;
      }
      Matcher m = LENGTH_RANGE.matcher(part);
      if (m.matches()) {
        out.add(toLengthChoice(Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)), source));
        continue;
      }
      throw new IllegalArgumentException("number generator: invalid length \"" + source + "\"");
    }
    return out;
  }

  private static LengthChoice toLengthChoice(int min, int max, String source) {
    if (min <= 0 || max <= 0 || min > max) {
      throw new IllegalArgumentException("number generator: invalid length \"" + source + "\"");
    }
    return new LengthChoice(min, max);
  }

  private static int parseDecimals(String raw) {
    if (raw == null) {
      return 0;
    }
    int value;
    try {
      value = Integer.parseInt(raw.trim());
    } catch (NumberFormatException e) {
      throw new IllegalArgumentException(
          "number decimals must be an integer 0..10, got \"" + raw + "\"");
    }
    if (value < 0 || value > 10) {
      throw new IllegalArgumentException(
          "number decimals must be an integer 0..10, got \"" + raw + "\"");
    }
    return value;
  }

  private static List<Interval> parseIntervalList(String source, String label) {
    String spec = source.trim();
    if (spec.isEmpty()) {
      throw new IllegalArgumentException("number generator: " + label + " is empty");
    }
    List<Interval> out = new ArrayList<>();
    for (String raw : spec.split(",", -1)) {
      String part = raw.trim();
      if (INT.matcher(part).matches()) {
        long n = Long.parseLong(part);
        out.add(new Interval(n, n));
        continue;
      }
      Matcher m = RANGE.matcher(part);
      if (m.matches()) {
        long a = Long.parseLong(m.group(1));
        long b = Long.parseLong(m.group(2));
        if (a > b) {
          throw new IllegalArgumentException(
              "number generator: " + label + " range \"" + part + "\" is reversed");
        }
        out.add(new Interval(a, b));
        continue;
      }
      throw new IllegalArgumentException("number generator: invalid " + label + " \"" + source + "\"");
    }
    return out;
  }

  // ── include / exclude ────────────────────────────────────────────────────────────────────

  /**
   * {@code (base ∪ include) − exclude}, as disjoint intervals.
   *
   * <p>Interval arithmetic rather than enumeration: {@code value="1..1000000000" exclude="7"}
   * has to stay instant, and listing a billion values to remove one of them would not be.
   */
  static List<Interval> computeAllowed(List<Range> base, String include, String exclude) {
    List<Interval> combined = new ArrayList<>();
    for (Range r : base) {
      combined.add(new Interval(r.min(), r.max()));
    }
    if (include != null && !include.isBlank()) {
      combined.addAll(parseIntervalList(include, "include"));
    }
    combined = merge(combined);
    if (exclude != null && !exclude.isBlank()) {
      combined = subtract(combined, parseIntervalList(exclude, "exclude"));
    }
    if (combined.isEmpty()) {
      throw new IllegalArgumentException(
          "number generator: the range is empty after include/exclude");
    }
    return combined;
  }

  private static List<Interval> merge(List<Interval> intervals) {
    List<Interval> sorted = new ArrayList<>(intervals);
    sorted.sort(Comparator.comparingLong(Interval::min).thenComparingLong(Interval::max));
    List<Interval> merged = new ArrayList<>();
    for (Interval iv : sorted) {
      if (!merged.isEmpty() && iv.min() <= merged.get(merged.size() - 1).max() + 1) {
        Interval last = merged.remove(merged.size() - 1);
        merged.add(new Interval(last.min(), Math.max(last.max(), iv.max())));
      } else {
        merged.add(iv);
      }
    }
    return merged;
  }

  private static List<Interval> subtract(List<Interval> ranges, List<Interval> excludes) {
    List<Interval> result = new ArrayList<>(ranges);
    for (Interval ex : excludes) {
      List<Interval> next = new ArrayList<>();
      for (Interval r : result) {
        if (ex.max() < r.min() || ex.min() > r.max()) {
          next.add(r);
          continue;
        }
        if (ex.min() > r.min()) {
          next.add(new Interval(r.min(), ex.min() - 1));
        }
        if (ex.max() < r.max()) {
          next.add(new Interval(ex.max() + 1, r.max()));
        }
      }
      result = next;
    }
    return result;
  }

  // ── drawing ──────────────────────────────────────────────────────────────────────────────

  private static int[] materializeWidths(
      int count, List<LengthChoice> choices, String percent, Prng.Sfc32 prng) {
    int[] widths = new int[count];
    if (choices.isEmpty()) {
      return widths;
    }

    List<LengthChoice> selected;
    if (percent == null) {
      selected = randomLengthChoices(count, choices, prng);
    } else {
      selected = Hamilton.distribute(count, choices, PercentMask.expand(percent, choices.size()), prng);
    }
    for (int i = 0; i < count; i++) {
      LengthChoice c = selected.get(i);
      widths[i] = c.min() == c.max() ? c.min() : Random.nextInt(prng, c.min(), c.max() + 1);
    }
    return widths;
  }

  private static List<LengthChoice> randomLengthChoices(
      int count, List<LengthChoice> choices, Prng.Sfc32 prng) {
    List<LengthChoice> out = new ArrayList<>(count);
    if (choices.size() == 1) {
      // No draw at all with a single choice — which is why `length="4"` leaves the stream
      // untouched and a config can add it without shifting every later column.
      for (int i = 0; i < count; i++) {
        out.add(choices.get(0));
      }
      return out;
    }
    for (int i = 0; i < count; i++) {
      out.add(choices.get(Random.nextInt(prng, 0, choices.size())));
    }
    return out;
  }

  /**
   * Redraw while the result starts with a zero it is not allowed to have.
   *
   * <p>Bounded at 100 attempts. A range like {@code 0..0} with leading zeros forbidden has no
   * answer, and looping forever on an impossible config helps nobody.
   */
  private static String drawGuardedRange(
      List<Range> ranges, int width, boolean allowLeadingZero, Prng.Sfc32 prng) {
    String s = drawRange(ranges, width, prng);
    for (int guard = 0; !allowLeadingZero && s.startsWith("0") && guard < 100; guard++) {
      s = drawRange(ranges, width, prng);
    }
    return s;
  }

  private static String drawRange(List<Range> ranges, int width, Prng.Sfc32 prng) {
    Range range =
        ranges.size() == 1 ? ranges.get(0) : ranges.get(Random.nextInt(prng, 0, ranges.size()));
    long n = nextLong(prng, range.min(), range.max() + 1);
    String s = String.valueOf(n);
    int actualWidth = width > 0 ? width : range.width();
    return actualWidth > 0 ? pad(s, actualWidth) : s;
  }

  private static String drawGuarded(
      List<Interval> intervals, int width, boolean allowLeadingZero, Prng.Sfc32 prng) {
    String s = drawWeighted(intervals, width, prng);
    for (int guard = 0; !allowLeadingZero && s.startsWith("0") && guard < 100; guard++) {
      s = drawWeighted(intervals, width, prng);
    }
    return s;
  }

  /** One draw over the total size, then map it into whichever interval holds that index. */
  private static String drawWeighted(List<Interval> intervals, int width, Prng.Sfc32 prng) {
    long total = 0;
    for (Interval iv : intervals) {
      total += iv.max() - iv.min() + 1;
    }
    long k = nextLong(prng, 0, total);
    long n = intervals.get(0).min();
    for (Interval iv : intervals) {
      long size = iv.max() - iv.min() + 1;
      if (k < size) {
        n = iv.min() + k;
        break;
      }
      k -= size;
    }
    String s = String.valueOf(n);
    return width > 0 ? pad(s, width) : s;
  }

  private static String digitString(int width, boolean allowLeadingZero, Prng.Sfc32 prng) {
    StringBuilder out = new StringBuilder(width);
    for (int i = 0; i < width; i++) {
      int min = i == 0 && !allowLeadingZero ? 1 : 0;
      out.append(Random.nextInt(prng, min, 10));
    }
    return out.toString();
  }

  /**
   * A uniform draw over the decimal grid of the range.
   *
   * <p>Scaling by a power of ten and drawing one integer costs the same single draw an integer
   * range costs. Drawing the whole part and the fraction separately would cost two and would
   * over-represent the endpoints.
   */
  private static String randomDecimal(List<Range> ranges, int decimals, Prng.Sfc32 prng) {
    double scale = Math.pow(10, decimals);
    long[] lo = new long[ranges.size()];
    long[] size = new long[ranges.size()];
    long total = 0;
    for (int i = 0; i < ranges.size(); i++) {
      lo[i] = Math.round(ranges.get(i).min() * scale);
      size[i] = Math.round(ranges.get(i).max() * scale) - lo[i] + 1;
      total += size[i];
    }
    long pick = (long) Math.floor(prng.next() * total);
    for (int i = 0; i < ranges.size(); i++) {
      if (pick < size[i]) {
        return fixed(lo[i] + pick, scale, decimals);
      }
      pick -= size[i];
    }
    int last = ranges.size() - 1;
    return fixed(lo[last] + size[last] - 1, scale, decimals);
  }

  private static String fixed(long scaled, double scale, int decimals) {
    return Fixed.toFixed(scaled / scale, decimals);
  }

  /** {@code [min, max)} over longs — the range form can exceed what an int holds. */
  private static long nextLong(Prng.Sfc32 prng, long min, long max) {
    return (long) Math.floor(prng.next() * (double) (max - min) + (double) min);
  }

  private static String pad(String s, int width) {
    if (s.length() >= width) {
      return s;
    }
    char[] zeros = new char[width - s.length()];
    Arrays.fill(zeros, '0');
    return new String(zeros) + s;
  }
}
