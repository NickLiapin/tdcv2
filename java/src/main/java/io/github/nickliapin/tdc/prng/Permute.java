package io.github.nickliapin.tdc.prng;

/**
 * A shuffle you can evaluate at one position without performing it.
 *
 * <p>This is what lets an exact quota be resolved row by row. Laying out a {@code percent="20,80"}
 * split is easy — twenty per cent of the slots, then eighty — but the result would come out
 * sorted, every {@code A} before every {@code B}. Shuffling fixes that and normally requires the
 * whole column in memory.
 *
 * <p>A format-preserving permutation removes the requirement: a small Feistel network over the
 * index space is a bijection, so row {@code i} can ask which slot it owns and get an answer that
 * is consistent with every other row's answer, without any of them existing.
 *
 * <p>The cycle-walking loop is what keeps it exact for a size that is not a power of two: the
 * network works over a padded domain, and any result past the end is fed back through until it
 * lands inside. It terminates because the network is a bijection on the padded space.
 */
public final class Permute {

  private static final int ROUNDS = 4;

  private Permute() {}

  /** A key private to one stream, so two columns shuffle independently. */
  public static int key(String seed, String streamId) {
    return Prng.cyrb128(seed + "|perm|" + streamId)[0];
  }

  /** The slot row {@code index} owns, among {@code n}. */
  public static int permute(int index, int n, int key) {
    if (n <= 1) {
      return 0;
    }
    int halfSize = halfSizeFor(n);
    int x = index;
    do {
      x = forward(x, halfSize, key);
    } while (x >= n);
    return x;
  }

  /** The inverse: which row owns {@code slot}. */
  public static int unpermute(int slot, int n, int key) {
    if (n <= 1) {
      return 0;
    }
    int halfSize = halfSizeFor(n);
    int x = slot;
    do {
      x = inverse(x, halfSize, key);
    } while (x >= n);
    return x;
  }

  /** The padded domain: two equal halves whose product covers {@code n}. */
  private static int halfSizeFor(int n) {
    int bits = Math.max(2, (int) Math.ceil(Math.log(n) / Math.log(2)));
    int half = (int) Math.ceil(bits / 2.0);
    return 1 << half;
  }

  private static int roundFn(int r, int round, int key) {
    int h = r ^ ((round + 1) * 0x9e3779b1);
    h = (h ^ (h >>> 16)) * 0x85ebca6b;
    h = (h ^ (h >>> 13)) * 0xc2b2ae35;
    h = (h ^ key) * 0x27d4eb2f;
    return h ^ (h >>> 16);
  }

  private static int forward(int x, int halfSize, int key) {
    int left = x / halfSize;
    int right = x % halfSize;
    for (int round = 0; round < ROUNDS; round++) {
      int mixed = Integer.remainderUnsigned(roundFn(right, round, key), halfSize);
      int nextRight = left ^ mixed;
      left = right;
      right = nextRight;
    }
    return left * halfSize + right;
  }

  private static int inverse(int y, int halfSize, int key) {
    int left = y / halfSize;
    int right = y % halfSize;
    for (int round = ROUNDS - 1; round >= 0; round--) {
      int prevRight = left;
      int mixed = Integer.remainderUnsigned(roundFn(prevRight, round, key), halfSize);
      int prevLeft = right ^ mixed;
      left = prevLeft;
      right = prevRight;
    }
    return left * halfSize + right;
  }
}
