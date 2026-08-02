package io.github.nickliapin.tdc.prng;

/**
 * Draws that can be taken for one row without taking them for any other.
 *
 * <p>The in-memory engine walks one generator from the start, so row 900 000's value exists only
 * after the 899 999 before it. That is fine when the whole run is in memory and impossible when
 * it is not.
 *
 * <p>Here each draw is keyed by {@code seed | streamId | index}, so a row's values are a function
 * of its own number. Nothing has to be kept, nothing has to be replayed, and a run of any size
 * costs the memory of one row. It is also what would let separate workers each render a slice of
 * the same file and agree at the seams.
 */
public final class Seekable {

  /** Half of a 32-bit unit in the last place — see {@link #openUnit}. */
  private static final double HALF_ULP = 0.5 / 4294967296.0;

  private Seekable() {}

  /** A generator private to one row of one stream. */
  public static Prng.Sfc32 generator(String seed, String streamId, int index) {
    int[] s = Prng.cyrb128(seed + "|" + streamId + "|" + index);
    return new Prng.Sfc32(s[0], s[1], s[2], s[3]);
  }

  public static double next(String seed, String streamId, int index) {
    return generator(seed, streamId, index).next();
  }

  /** An integer in {@code [0, n)} for this row. */
  public static int nextInt(String seed, String streamId, int index, int n) {
    if (n <= 1) {
      return 0;
    }
    return (int) Math.floor(next(seed, streamId, index) * n);
  }

  /**
   * Nudge a raw draw into the open interval (0,1).
   *
   * <p>sfc32 emits values in {@code [0, 1)}, and inverse-CDF sampling takes logarithms — at
   * exactly zero those are infinite. The shift is about 1e-10 and changes nothing statistically.
   */
  public static double openUnit(double u) {
    return Math.min(1 - HALF_ULP, Math.max(HALF_ULP, u + HALF_ULP));
  }

  /** {@code count} uniforms in (0,1) for one row — what a fixed-draw sampler needs. */
  public static double[] uniforms(String seed, String streamId, int index, int count) {
    Prng.Sfc32 gen = generator(seed, streamId, index);
    double[] out = new double[count];
    for (int k = 0; k < count; k++) {
      out[k] = openUnit(gen.next());
    }
    return out;
  }
}
