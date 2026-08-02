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

  public record Spec(int min, int max, String separator, String accumulate) {}

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
        Accumulate.read(attrs));
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

  /** An even split across the possible lengths — the shares {@link #plan} quotas by. */
  public static double[] lengthPercents(Spec spec) {
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

    // The lengths, as an exact quota rather than a per-row coin flip.
    List<Integer> groupIds = new ArrayList<>(groups);
    double[] percents = new double[groups];
    for (int j = 0; j < groups; j++) {
      groupIds.add(j);
      percents[j] = 100.0 / groups;
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
}
