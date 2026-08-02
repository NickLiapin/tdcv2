package io.github.nickliapin.tdc.lib;

import java.math.BigDecimal;
import java.math.RoundingMode;

/**
 * A number rounded to a fixed number of places, the way the reference implementation rounds it.
 *
 * <p>Ties go away from zero, and the tie is decided on the number the double ACTUALLY holds, not
 * on the short decimal that prints back as it. Those two rules disagree more often than they look
 * like they should: 1.005 is stored as 1.00499999999999989, so it rounds DOWN to 1.00 — and
 * {@code BigDecimal.valueOf}, which rounds the printed "1.005", would answer 1.01 and diverge on
 * every money column.
 */
public final class Fixed {

  private Fixed() {}

  public static String toFixed(double value, int decimals) {
    if (Double.isNaN(value) || Double.isInfinite(value)) {
      return Double.toString(value);
    }
    // `new BigDecimal(double)` is the exact binary value; `valueOf` is the shortest printed one.
    return new BigDecimal(value).setScale(decimals, RoundingMode.HALF_UP).toPlainString();
  }
}
