package io.github.nickliapin.tdc.distribution;

import io.github.nickliapin.tdc.prng.Prng;
import io.github.nickliapin.tdc.prng.Rand;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.stream.IntStream;

/**
 * Hamilton's largest-remainder method: split {@code count} rows across values in the declared
 * percentages, exactly.
 *
 * <p>This is what makes {@code percent="60,40"} produce 60 and 40 rather than "about" 60 and
 * 40. Each value first takes its whole share; the rows left over by rounding go to the largest
 * fractional remainders.
 *
 * <p>Two details decide whether a port matches the reference, and both are easy to get wrong:
 *
 * <ol>
 *   <li><b>Tie order.</b> Values with equal remainders are served lowest index first. Only when
 *       a tie group is larger than the number of rows left does the generator get consulted,
 *       one draw per row, from a pool that shrinks as it goes.
 *   <li><b>Draw accounting.</b> Tie-breaking and the final shuffle both consume from the same
 *       generator, in that order. Drawing a different number of times leaves the generator in a
 *       different state, and everything generated afterwards diverges — even though the counts
 *       themselves would still look correct.
 * </ol>
 *
 * <p>Verified against {@code fixtures/cross-language/hamilton-vectors.json}.
 */
public final class Hamilton {

  private Hamilton() {}

  /** How many rows each value receives. */
  public static int[] countsPerValue(int count, double[] percents, Prng.Sfc32 prng) {
    double cardPercent = 100.0 / count;
    int[] counts = new int[percents.length];
    double[] remainders = new double[percents.length];

    int filled = 0;
    for (int i = 0; i < percents.length; i++) {
      double rawCells = percents[i] / cardPercent;
      int whole = (int) rawCells; // truncation toward zero, as Math.trunc does
      counts[i] = whole;
      remainders[i] = rawCells % 1;
      filled += whole;
    }

    int unallocated = count - filled;
    if (unallocated <= 0) {
      return counts;
    }

    // Remainder descending, index ascending — the order the reference walks in.
    Integer[] order =
        IntStream.range(0, remainders.length).boxed().toArray(Integer[]::new);
    java.util.Arrays.sort(
        order,
        Comparator.<Integer>comparingDouble(i -> -remainders[i]).thenComparingInt(i -> i));

    int at = 0;
    while (unallocated > 0 && at < order.length) {
      double remainder = remainders[order[at]];
      int end = at;
      while (end < order.length && remainders[order[end]] == remainder) {
        end++;
      }
      int groupSize = end - at;

      if (groupSize <= unallocated) {
        for (int k = at; k < end; k++) {
          counts[order[k]]++;
          unallocated--;
        }
        at = end;
        continue;
      }

      // More values tied than rows left: pick one at random per row, from a pool that
      // shrinks with each pick. One draw per row, which is what keeps the generator in step.
      List<Integer> pool = new ArrayList<>(List.of(order).subList(at, end));
      while (unallocated > 0) {
        int pick = (int) Math.floor(prng.next() * pool.size());
        counts[pool.get(pick)]++;
        pool.remove(pick);
        unallocated--;
      }
    }

    return counts;
  }

  /** The materialized, shuffled sequence of {@code count} values. */
  public static <T> List<T> distribute(
      int count, List<T> values, double[] percents, Prng.Sfc32 prng) {
    int[] counts = countsPerValue(count, percents, prng);
    List<T> sequence = new ArrayList<>(count);
    for (int i = 0; i < values.size(); i++) {
      for (int j = 0; j < counts[i]; j++) {
        sequence.add(values.get(i));
      }
    }
    return Rand.shuffle(prng, sequence);
  }
}
