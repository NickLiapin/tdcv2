package io.github.nickliapin.tdc;

/**
 * A byte count written the way a person would say it: {@code 800 B}, {@code 2.6 KB},
 * {@code 123 KB}, {@code 20.5 GB}.
 *
 * <h2>Why this exists</h2>
 *
 * <p>Every one of the 294 shipped packs is smaller than a quarter of a megabyte — the largest is
 * 248 KB and 120 are under 10 KB. Printed in megabytes to one decimal, as {@code pack list} did,
 * the whole catalogue collapsed into three strings: {@code 0.0 MB} for 194 packs, {@code 0.1 MB}
 * for 53, {@code 0.2 MB} for the last 47.
 *
 * <p>A size that cannot tell two packs apart is not a size, it is a decoration; and {@code 0.0}
 * actively misinforms, because it reads as "nothing" when the honest answer is "three
 * kilobytes".
 *
 * <p>The rules are the ones people already read without noticing:
 *
 * <ul>
 *   <li>below a kilobyte, whole bytes — {@code 800 B}, never {@code 0.8 KB}
 *   <li>below a hundred of a unit, one decimal — {@code 2.6 KB} distinguishes packs that {@code 3
 *       KB} does not
 *   <li>at a hundred and above, whole numbers — {@code 123 KB}, because a tenth of a kilobyte
 *       there is noise
 * </ul>
 *
 * <h2>Why the arithmetic looks like this</h2>
 *
 * <p>All five implementations must produce the same string for the same number: a shared CLI
 * fixture compares their output byte for byte, so a size that differs in the last digit is a
 * five-way parity failure. Hence integers throughout — no float division, no
 * {@code String.format} rounding, and no reliance on how a language happens to round a half.
 */
public final class HumanBytes {

  /** Kilobyte upwards. Terabytes are the end of it; nothing here measures more. */
  private static final String[] UNITS = {"KB", "MB", "GB", "TB"};

  private HumanBytes() {}

  /**
   * {@code round(n * 10 / d)}, without ever forming {@code n * 10}.
   *
   * <p>The product overflows a {@code long} above about 800 petabytes. Splitting the division is
   * exact for every size any of the five will be handed.
   */
  private static long tenths(long n, long d) {
    long whole = n / d;
    long rest = n - whole * d;
    return whole * 10 + (rest * 10 + d / 2) / d;
  }

  public static String format(long bytes) {
    if (bytes <= 0) {
      return "0 B";
    }
    if (bytes < 1024) {
      return bytes + " B";
    }

    // Climb to the unit the number reads in, and one further when rounding has
    // pushed it to a whole 1024 of that unit — 1023.6 KB is 1.0 MB, and nobody
    // writes the other one.
    long d = 1024;
    String unit = UNITS[0];
    long t = tenths(bytes, d);
    for (int next = 1; next < UNITS.length; next++) {
      if (bytes < d * 1024 && t < 10_235) {
        break;
      }
      d *= 1024;
      unit = UNITS[next];
      t = tenths(bytes, d);
    }
    return t < 1000 ? (t / 10) + "." + (t % 10) + " " + unit : ((t + 5) / 10) + " " + unit;
  }
}
