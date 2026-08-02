package io.github.nickliapin.tdc.prng;

import java.util.ArrayList;
import java.util.List;

/**
 * Draws built on top of a raw {@link Prng.Sfc32}.
 *
 * <p>Kept apart from the generator itself so the generator stays small enough to audit against
 * the reference line by line. Everything here consumes a documented number of draws, which is
 * what makes two implementations produce the same data rather than merely similar-looking data.
 */
public final class Random {

  private Random() {}

  /**
   * An integer in {@code [min, max)} — half-open, as in the reference. Callers that mean an
   * inclusive upper bound pass {@code max + 1}, and every one of them says so at the call site.
   */
  public static int nextInt(Prng.Sfc32 prng, int min, int max) {
    return (int) Math.floor(prng.next() * (max - min) + min);
  }

  public static <T> T pick(Prng.Sfc32 prng, List<T> values) {
    return values.get((int) Math.floor(prng.next() * values.size()));
  }

  /**
   * Fisher-Yates, from the end backwards.
   *
   * <p>The direction is not a detail. Walking the array the other way consumes the same number
   * of draws but pairs them with different indices, so a port that flips it produces a shuffle
   * that is still uniform and still deterministic — and still disagrees with every other
   * implementation from the same seed.
   */
  public static <T> List<T> shuffle(Prng.Sfc32 prng, List<T> values) {
    List<T> out = new ArrayList<>(values);
    for (int i = out.size() - 1; i > 0; i--) {
      int j = (int) Math.floor(prng.next() * (i + 1));
      T tmp = out.get(i);
      out.set(i, out.get(j));
      out.set(j, tmp);
    }
    return out;
  }
}
