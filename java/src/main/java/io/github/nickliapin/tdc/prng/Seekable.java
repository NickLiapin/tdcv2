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

  /** A double as the 16 hex digits of its IEEE-754 image. */
  private static String bitsHex(double value) {
    return String.format("%016x", Double.doubleToRawLongBits(value));
  }

  /**
   * A deterministic value in [0, 1) from a pair of numbers — `hash(n, salt)`.
   * 
   * The key is built from the IEEE-754 BIT PATTERNS of the two arguments, not from
   * their decimal forms: `salt` is any double, and the shortest decimal spelling of
   * a double differs between languages, while those 64 bits are pinned by the
   * standard and printing an integer as hex is exact everywhere. The mixing is
   * cyrb128 and the stream is sfc32 — the PRNG the rest of TDC already runs on.
   */
  public static double hashUnit(double n, double salt) {
    return generator("hash", bitsHex(n) + "|" + bitsHex(salt), 0).next();
  }

  /**
   * Smooth one-dimensional value noise — {@code noise(t, scale, salt)}.

   * A drifting baseline is not three sine waves: modulate those however you like and a
   * spectrum still shows three pure tones. Here each lattice point is an independent
   * draw and only the interpolation between them is smooth.
   *
   * <p>The easing is the classic smoothstep, u*u*(3-2u), zero at both ends with zero
   * slope. The interpolation is a*(1-u) + b*u for the same reason lerp uses it: the
   * lattice points come out EXACTLY equal to hashUnit there. A scale of zero gives NaN.
   */
  public static double noiseUnit(double t, double scale, double salt) {
    double x = t / scale;
    double cell = Math.floor(x);
    double u = x - cell;
    double eased = u * u * (3 - 2 * u);
    double a = hashUnit(cell, salt);
    double b = hashUnit(cell + 1, salt);
    return a * (1 - eased) + b * eased;
  }
}
