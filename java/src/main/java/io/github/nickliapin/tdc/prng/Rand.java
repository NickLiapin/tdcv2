package io.github.nickliapin.tdc.prng;

import java.util.ArrayList;
import java.util.List;

/**
 * Helpers layered on a {@link Prng.Sfc32}. They hold no state of their own; every draw comes
 * from the generator passed in, so the number and order of draws is what makes a run
 * reproducible.
 *
 * <p>The shuffle in particular has to match the reference exactly: it walks from the end and
 * swaps with a random earlier-or-equal index. Walking the other direction, or drawing before
 * the swap instead of after, produces a different permutation from the same seed.
 */
public final class Rand {

  private Rand() {}

  /** An integer in [min, max). The caller guarantees {@code min < max}. */
  public static int nextInt(Prng.Sfc32 prng, int min, int max) {
    return (int) Math.floor(prng.next() * (max - min) + min);
  }

  /** A uniformly chosen element of a non-empty list. */
  public static <T> T pick(Prng.Sfc32 prng, List<T> items) {
    return items.get((int) Math.floor(prng.next() * items.size()));
  }

  /** Fisher-Yates, returning a new list and leaving the input untouched. */
  public static <T> List<T> shuffle(Prng.Sfc32 prng, List<T> items) {
    List<T> out = new ArrayList<>(items);
    for (int i = out.size() - 1; i > 0; i--) {
      int j = (int) Math.floor(prng.next() * (i + 1));
      T tmp = out.get(i);
      out.set(i, out.get(j));
      out.set(j, tmp);
    }
    return out;
  }
}
