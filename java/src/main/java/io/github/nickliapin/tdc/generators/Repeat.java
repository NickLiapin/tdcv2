package io.github.nickliapin.tdc.generators;

import io.github.nickliapin.tdc.distribution.Hamilton;
import io.github.nickliapin.tdc.prng.Prng;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.IntFunction;

/**
 * {@code repeat="N"} or {@code repeat="A..B"} — several values in one cell instead of one.
 *
 * <p>A customer with three orders, a post with a handful of tags. The values are joined by
 * {@code separator} in text output, and {@code each=} on a line walks them.
 *
 * <p>The whole difficulty is that a row has to be computable without computing the rows before
 * it. A variable number of values would mean a variable number of draws, which breaks that. The
 * way out is to decide the <b>lengths first</b>, as an exact quota over the whole run: once the
 * lengths are known the total number of value slots is a fixed number, so nothing is generated
 * and discarded, and a row finds its slice from its own position rather than from a running
 * total over its predecessors.
 *
 * <p>Deciding lengths first also keeps {@code percent=} exact. The obvious alternative — give
 * every row {@code max} slots and throw away the extras — spends quota on the discarded slots,
 * and a declared 50/50 split quietly stops coming out 50/50.
 */
public final class Repeat {

  /** A ceiling, so one careless attribute cannot make a run a thousand times slower. */
  public static final int MAX_REPEAT = 64;

  public static final String DEFAULT_SEPARATOR = ",";

  /** Bounded retries before a {@code distinct} draw admits it cannot find a fresh value. */
  public static final int DISTINCT_MAX_TRIES = 64;

  /**
   * @param distinct {@code distinct=}: the row's values are drawn WITHOUT replacement.
   *     <p>This changes the regime the column is built in, which is why {@code percent} is
   *     refused beside it. Ordinarily a listed column lays its values out over the whole run as
   *     an exact quota; under {@code distinct} it draws per row instead, because holding an
   *     exact whole-run quota AND a per-row guarantee at once costs either streaming or the
   *     randomness of the sample. Frequencies stay approximate, rows stay independent.
   */
  /**
   * @param lengths {@code lengths=}: the share of rows that get each possible length, {@code min}
   *     first, or {@code null} for an even split.
   *     <p>Without it every length is equally likely, and exactly so — the lengths are laid out as
   *     a Hamilton quota, which is the wrong shape for every real one-to-many relationship. The
   *     shares live HERE, in the spec, rather than in a per-row draw: a per-row count would make a
   *     row's draws depend on the rows before it.
   */
  public record Spec(
      int min,
      int max,
      String separator,
      String accumulate,
      boolean distinct,
      double[] lengths) {}

  private Repeat() {}

  /** {@code null} when the generator has no {@code repeat}, which is the ordinary case. */
  public static Spec parse(Map<String, String> attrs) {
    String raw = attrs.get("repeat");
    if (raw == null || raw.isBlank()) {
      return null;
    }
    String text = raw.trim();
    int dots = text.indexOf("..");
    String minText = dots < 0 ? text : text.substring(0, dots).trim();
    String maxText = dots < 0 ? text : text.substring(dots + 2).trim();

    int min = whole(minText, raw, "minimum");
    int max = whole(maxText, raw, "maximum");
    if (min < 0) {
      throw new IllegalArgumentException("repeat: minimum of \"" + raw + "\" must not be negative");
    }
    if (max < min) {
      throw new IllegalArgumentException(
          "repeat: \"" + raw + "\" has its maximum below its minimum");
    }
    if (max > MAX_REPEAT) {
      throw new IllegalArgumentException(
          "repeat: maximum of \"" + raw + "\" must not exceed " + MAX_REPEAT);
    }
    return new Spec(
        min,
        max,
        attrs.getOrDefault("separator", DEFAULT_SEPARATOR),
        Accumulate.read(attrs),
        readDistinct(attrs),
        parseLengths(attrs.get("lengths"), min, max));
  }

  /**
   * {@code lengths="40,25,15,10,7,3"} — one share per possible length, {@code min} first.
   *
   * <p>One share per length and a sum of 100, both refused rather than repaired: a fan-out written
   * with five shares for six lengths is a config whose author is thinking of a different range,
   * and quietly filling the sixth in would hide that.
   */
  public static double[] parseLengths(String raw, int min, int max) {
    String text = raw == null ? "" : raw.trim();
    if (text.isEmpty()) {
      return null;
    }
    List<String> parts = new ArrayList<>();
    for (String piece : text.split(",", -1)) {
      String trimmed = piece.trim();
      if (!trimmed.isEmpty()) {
        parts.add(trimmed);
      }
    }
    int groups = Math.max(1, max - min + 1);
    if (parts.size() != groups) {
      throw new IllegalArgumentException(
          "lengths: "
              + parts.size()
              + " share(s) for "
              + groups
              + " possible length(s) — repeat=\""
              + min
              + ".."
              + max
              + "\" can produce "
              + min
              + " to "
              + max
              + " values, so it needs one share for each");
    }
    double[] values = new double[parts.size()];
    for (int i = 0; i < parts.size(); i++) {
      double value;
      try {
        value = Double.parseDouble(parts.get(i));
      } catch (NumberFormatException e) {
        throw new IllegalArgumentException(
            "lengths: share for length " + (min + i) + " is not a number >= 0");
      }
      if (Double.isNaN(value) || Double.isInfinite(value) || value < 0) {
        throw new IllegalArgumentException(
            "lengths: share for length " + (min + i) + " is not a number >= 0");
      }
      values[i] = value;
    }
    double total = 0;
    for (double value : values) {
      total += value;
    }
    if (Math.abs(total - 100.0) > 1e-9) {
      throw new IllegalArgumentException(
          "lengths: shares sum to " + io.github.nickliapin.tdc.lib.Numbers.toText(total)
              + ", expected 100");
    }
    return values;
  }

  /**
   * Produce {@code count} rows of joined values.
   *
   * <p>{@code buildFlat} is the caller's ordinary "give me N values" builder, already applying
   * anomaly, missing and formatting per value — which is exactly why those come out per element
   * here with no extra work.
   *
   * <p>The draw order is fixed: all the length draws first, then the values. Both engines depend
   * on it staying that way.
   */
  /**
   * Where each row's values sit in one flat run of slots.
   *
   * <p>The lengths are an exact quota decided before any value exists, so a row's slice follows
   * from its own position rather than from a running total over the rows before it. That is what
   * lets the streaming engine answer row nine million without having built the first eight.
   */
  public record Plan(Spec spec, int totalSlots, int[] rowCumLo, int[] slotOffset) {

    /** How many values the row at permuted position {@code p} keeps. */
    public int lengthAt(int p) {
      return spec.min() + groupOf(p);
    }

    /** The first slot the row at permuted position {@code p} owns. */
    public int slotStartAt(int p) {
      int j = groupOf(p);
      return slotOffset[j] + (p - rowCumLo[j]) * (spec.min() + j);
    }

    private int groupOf(int p) {
      int lo = 0;
      int hi = rowCumLo.length - 1;
      while (lo < hi) {
        int mid = (lo + hi + 1) >>> 1;
        if (p >= rowCumLo[mid]) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
      return lo;
    }
  }

  /** Lay out {@code rowCount} rows whose lengths were apportioned as {@code counts}. */
  public static Plan plan(Spec spec, int rowCount, int[] counts) {
    int groups = spec.max() - spec.min() + 1;
    int[] rowCumLo = new int[groups];
    int[] slotOffset = new int[groups];
    int rowAcc = 0;
    int slotAcc = 0;
    for (int j = 0; j < groups; j++) {
      rowCumLo[j] = rowAcc;
      slotOffset[j] = slotAcc;
      int c = j < counts.length ? counts[j] : 0;
      rowAcc += c;
      slotAcc += c * (spec.min() + j);
    }
    return new Plan(spec, slotAcc, rowCumLo, slotOffset);
  }

  /**
   * The shares {@link #plan} quotas by: {@code lengths=} when the config gave one, an even split
   * otherwise.
   */
  public static double[] lengthPercents(Spec spec) {
    if (spec.lengths() != null) {
      return spec.lengths();
    }
    int groups = spec.max() - spec.min() + 1;
    double[] out = new double[groups];
    java.util.Arrays.fill(out, 100.0 / groups);
    return out;
  }

  /** The same attributes without {@code repeat}, for building one element at a time. */
  public static Map<String, String> without(Map<String, String> attrs) {
    Map<String, String> out = new java.util.LinkedHashMap<>(attrs);
    out.remove("repeat");
    return out;
  }

  public static List<String> build(
      Spec spec, int count, Prng.Sfc32 prng, IntFunction<List<String>> buildFlat) {
    int groups = spec.max() - spec.min() + 1;

    // The lengths, as an exact quota rather than a per-row coin flip — `lengths=` when the config
    // declared a shape, an even split otherwise.
    List<Integer> groupIds = new ArrayList<>(groups);
    double[] percents = lengthPercents(spec);
    for (int j = 0; j < groups; j++) {
      groupIds.add(j);
    }
    List<Integer> perRowGroup = Hamilton.distribute(count, groupIds, percents, prng);

    int[] counts = new int[groups];
    for (int j : perRowGroup) {
      counts[j]++;
    }

    // Each length group owns one contiguous block of slots, so a row's slice follows from its
    // rank inside its own group and from nothing else.
    int[] offsets = new int[groups];
    int acc = 0;
    for (int j = 0; j < groups; j++) {
      offsets[j] = acc;
      acc += counts[j] * (spec.min() + j);
    }
    int totalSlots = acc;

    int[] nextRank = new int[groups];
    int[] starts = new int[count];
    int[] keeps = new int[count];
    for (int i = 0; i < count; i++) {
      int j = perRowGroup.get(i);
      int length = spec.min() + j;
      starts[i] = offsets[j] + nextRank[j] * length;
      nextRank[j]++;
      keeps[i] = length;
    }

    List<String> flat = buildFlat.apply(totalSlots);

    List<String> out = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
      List<String> parts = new ArrayList<>(keeps[i]);
      for (int k = 0; k < keeps[i]; k++) {
        int at = starts[i] + k;
        parts.add(at < flat.size() ? flat.get(at) : "");
      }
      out.add(join(parts, spec));
    }
    return out;
  }

  /**
   * Split a cell back into the elements {@code each=} walks.
   *
   * <p>An empty cell is an empty list, not a list holding one blank. Splitting {@code ""} would
   * invent a phantom element and emit an order row for a customer who placed none.
   */
  /**
   * The last step every repeat list goes through: accumulate, then join.
   *
   * <p>One method rather than three copies because there are three places a list becomes a cell —
   * one in the in-memory engine and two in the streaming one — and a running total that appeared
   * on one engine and not the other is the failure this shape prevents.
   */
  public static String join(List<String> parts, Spec spec) {
    List<String> running =
        spec.accumulate() == null ? parts : Accumulate.apply(parts, spec.accumulate());
    return String.join(spec.separator(), running);
  }

  public static List<String> split(String cell, String separator) {
    if (cell == null || cell.isEmpty()) {
      return List.of();
    }
    return List.of(cell.split(java.util.regex.Pattern.quote(separator), -1));
  }

  /**
   * The key for one element: card {@code card} (1-based), position {@code position} (1-based).
   *
   * <p>Each card owns a block of {@code stride} keys and each list owns a lane inside it. Both
   * parts are needed — a config with two repeating sequences writes both into the same child
   * table, and one shared counter would make their keys collide.
   *
   * <p>Derived from the card index alone, so a row still resolves without knowing anything about
   * the rows before it. That leaves gaps when a card holds fewer elements than its list allows,
   * which is the deliberate trade: keys that increase down the file read better in a dump than
   * gapless keys that jump around.
   */
  public static long itemKey(int card, int position, int lane, int stride) {
    return (long) (card - 1) * stride + lane + position;
  }

  private static int whole(String text, String raw, String label) {
    try {
      return Integer.parseInt(text);
    } catch (NumberFormatException e) {
      throw new IllegalArgumentException(
          "repeat: " + label + " of \"" + raw + "\" must be a whole number");
    }
  }

  /** {@code distinct="true"}. Anything but the two words is refused by the validator. */
  public static boolean readDistinct(Map<String, String> attrs) {
    return "true".equals(attrs.getOrDefault("distinct", "").trim());
  }

  /**
   * Draw {@code keep} DIFFERENT values from a weighted list, one uniform per pick.
   *
   * <p>Weights survive — a frequent name is still likelier to be picked first — but the exact
   * whole-run quota does not, which is the documented price of {@code distinct} and the reason
   * {@code percent} may not appear beside it.
   *
   * <p>Running out throws rather than returning a short list: a cell quietly shorter than
   * {@code repeat} asked for is the silent-and-wrong outcome the feature exists to prevent.
   */
  public static List<String> drawDistinct(
      List<String> values,
      double[] weights,
      int keep,
      java.util.function.DoubleSupplier nextUniform,
      String describePool) {
    if (keep > values.size()) {
      throw new IllegalArgumentException(
          "repeat with distinct=\"true\" asks for "
              + keep
              + " different values, but "
              + describePool
              + " holds only "
              + values.size());
    }

    // Weighted draw without replacement: pick against the remaining weight, then swap the
    // winner out with the last live candidate. What remains is a pure function of the picks
    // already made, so the draw stays deterministic.
    List<String> pool = new ArrayList<>(values);
    double[] w = new double[values.size()];
    for (int i = 0; i < w.length; i++) {
      w[i] = weights != null && weights.length == values.size() ? weights[i] : 1.0;
    }
    double total = 0;
    for (double x : w) {
      if (x > 0) {
        total += x;
      }
    }

    List<String> out = new ArrayList<>(keep);
    for (int picked = 0; picked < keep; picked++) {
      int size = pool.size() - picked;
      int index = size - 1;
      if (total > 0) {
        double target = nextUniform.getAsDouble() * total;
        for (int i = 0; i < size; i++) {
          target -= Math.max(0, w[i]);
          if (target < 0) {
            index = i;
            break;
          }
        }
      } else {
        index = Math.min(size - 1, (int) (nextUniform.getAsDouble() * size));
      }
      String chosen = pool.get(index);
      out.add(chosen);
      total -= Math.max(0, w[index]);
      int last = size - 1;
      pool.set(index, pool.get(last));
      w[index] = w[last];
      pool.set(last, chosen);
    }
    return out;
  }

  /**
   * Ask {@code draw} for a value that is not already in {@code seen}.
   *
   * <p>A drawn generator has no pool to draw down, so {@code distinct} is rejection sampling.
   * {@code draw} receives the sub-stream suffix: empty for the first attempt (so a config
   * WITHOUT {@code distinct} reads the very same stream), then {@code r1}, {@code r2} and so on.
   *
   * <p>Exhausting the tries throws rather than returning a duplicate or a short list.
   * {@code regex="[01]"} under {@code repeat="5"} cannot be satisfied by anything, and saying so
   * is the entire point of the attribute.
   */
  public static String redrawUntilFresh(
      List<String> seen, String genType, java.util.function.Function<String, String> draw) {
    return redrawUntilFreshAt(seen, genType, draw)[0];
  }

  /**
   * The same loop, reporting WHICH sub-stream won, as {@code [value, suffix]}.
   *
   * <p>The anomaly flag needs this. A flag is resolved by re-running the element's draw and
   * asking whether it spiked — and under {@code distinct} the value that survived may have come
   * from {@code r3} rather than the first attempt. Resolving the flag on the first attempt would
   * describe a value that was thrown away: the list would say {@code false} beside a number that
   * plainly spiked, which is worse than no flag at all.
   */
  public static String[] redrawUntilFreshAt(
      List<String> seen, String genType, java.util.function.Function<String, String> draw) {
    String suffix = "";
    String value = draw.apply(suffix);
    for (int attempt = 1; seen.contains(value) && attempt <= DISTINCT_MAX_TRIES; attempt++) {
      suffix = "r" + attempt;
      value = draw.apply(suffix);
    }
    if (seen.contains(value)) {
      throw new IllegalArgumentException(
          "repeat with distinct=\"true\" could not find "
              + (seen.size() + 1)
              + " different values for <gen type=\""
              + genType
              + "\"> after "
              + DISTINCT_MAX_TRIES
              + " tries — the generator does not produce that many");
    }
    return new String[] {value, suffix};
  }
}
