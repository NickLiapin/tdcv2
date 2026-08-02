package io.github.nickliapin.tdc.prng;

/**
 * Seeded pseudo-random number generator: cyrb128 feeding sfc32.
 *
 * <p>This is the foundation of TDC's cross-language guarantee. The same seed has to produce
 * the same sequence of doubles here, in the TypeScript reference implementation, and in the
 * Python port. If this file drifts by one bit, every generated dataset drifts with it.
 *
 * <p>The TypeScript original leans on {@code Math.imul}, {@code | 0} and {@code >>> 0} to
 * force 32-bit arithmetic out of a language whose only number is a double. Java's {@code int}
 * is already 32-bit two's complement with wrapping arithmetic, so those operations translate
 * one for one and no masking is needed until the final division:
 *
 * <ul>
 *   <li>{@code Math.imul(x, y)} is plain {@code x * y}
 *   <li>{@code (x + y) | 0} is plain {@code x + y}
 *   <li>{@code x >>> n} is Java's {@code >>>}
 *   <li>{@code (t >>> 0) / 4294967296} needs {@code t & 0xFFFFFFFFL}, because Java has no
 *       unsigned int and a negative {@code t} would otherwise produce a negative double
 * </ul>
 *
 * <p>The one place a port can silently diverge is the seed string. JavaScript's
 * {@code charCodeAt} returns a UTF-16 code unit, and so does Java's {@code charAt}. Any port
 * that iterates code points instead of code units gets different numbers for any seed outside
 * the Basic Multilingual Plane.
 *
 * <p>Verified against {@code fixtures/cross-language/prng-vectors.json}.
 */
public final class Prng {

  private Prng() {}

  /** Derive four 32-bit state words from a seed string. */
  public static int[] cyrb128(String seed) {
    int h1 = 1779033703;
    int h2 = -1150833019; // 3144134277 as a signed 32-bit int
    int h3 = 1013904242;
    int h4 = -1521486534; // 2773480762
    for (int i = 0; i < seed.length(); i++) {
      int k = seed.charAt(i);
      h1 = h2 ^ ((h1 ^ k) * 597399067);
      h2 = h3 ^ ((h2 ^ k) * -1425107063); // 2869860233
      h3 = h4 ^ ((h3 ^ k) * 951274213);
      h4 = h1 ^ ((h4 ^ k) * -1578923117); // 2716044179
    }
    h1 = (h3 ^ (h1 >>> 18)) * 597399067;
    h2 = (h4 ^ (h2 >>> 22)) * -1425107063;
    h3 = (h1 ^ (h3 >>> 17)) * 951274213;
    h4 = (h2 ^ (h4 >>> 19)) * -1578923117;
    return new int[] {h1 ^ h2 ^ h3 ^ h4, h2 ^ h1, h3 ^ h1, h4 ^ h1};
  }

  /**
   * An sfc32 generator over four state words. Each call returns a double in [0, 1).
   *
   * <p>Stateful by nature, and deliberately not thread-safe: two threads sharing one instance
   * would interleave their draws and destroy reproducibility, which is the whole point.
   */
  public static final class Sfc32 {
    private int a;
    private int b;
    private int c;
    private int d;

    public Sfc32(int a, int b, int c, int d) {
      this.a = a;
      this.b = b;
      this.c = c;
      this.d = d;
    }

    /** The next double in [0, 1). */
    public double next() {
      int t = a + b;
      a = b ^ (b >>> 9);
      b = c + (c << 3);
      c = (c << 21) | (c >>> 11);
      d = d + 1;
      t = t + d;
      c = c + t;
      return (t & 0xFFFFFFFFL) / 4294967296.0;
    }
  }

  /** Build a generator from a seed string. */
  public static Sfc32 create(String seed) {
    int[] s = cyrb128(seed);
    return new Sfc32(s[0], s[1], s[2], s[3]);
  }
}
