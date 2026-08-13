package io.github.nickliapin.tdc.lib;

/**
 * How a number becomes text when nothing asked for a particular shape.
 *
 * <p>The reference writes {@code String(x)} and the four ports each imitate it. Shared here rather
 * than copied, because a formula, a statistic and a distribution parameter all print an answer and
 * the three must agree — a whole number without a point, everything else round-tripped.
 */
public final class Numbers {

  private Numbers() {}

  /** A double as JavaScript prints it — a whole number without a decimal point. */
  public static String toText(double value) {
    if (Double.isNaN(value)
        || Double.isInfinite(value)
        || value != Math.floor(value)
        || Math.abs(value) >= 9.223372036854776e18) {
      String text = Double.toString(value);
      // Java prints a whole double as "3.0"; JavaScript prints "3". Only the fractional branch
      // reaches here, so the suffix can only come from a value too large for the long path.
      return text.endsWith(".0") ? text.substring(0, text.length() - 2) : text;
    }
    return Long.toString((long) value);
  }
}
