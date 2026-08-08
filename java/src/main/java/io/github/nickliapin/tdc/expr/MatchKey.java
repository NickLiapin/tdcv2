package io.github.nickliapin.tdc.expr;

/**
 * The key two TEXTS share when {@code ==} calls them equal.
 *
 * <p>{@code ==} between two texts has one rule that is not plain string equality: if both read as
 * whole numbers, they are compared as whole numbers. So {@code "01" == "1"} is true, and {@code
 * "0" == "00"} is true.
 *
 * <p>Most of the engine never needs this, because it evaluates the expression. Two places do not
 * evaluate it and must still agree with it: a {@code <gen type="pool" filter="field == Column">}
 * is BUCKETED, so a row costs a map lookup instead of a walk over every member; and TDC225 asks,
 * before the run, whether the two sides can ever overlap.
 *
 * <p>Both compared raw text, and both were therefore wrong about the same configs. Measured on a
 * pool whose {@code code} holds {@code 01,02,03} against a column producing {@code 1,2,3},
 * {@code filter="code == Want"} was REFUSED by check as unmatchable while {@code filter="code ==
 * Want && 1 == 1"} — the same question with one term that changes nothing — matched every row.
 */
public final class MatchKey {
  private MatchKey() {}

  /**
   * {@code "01"} and {@code "1"} share the key {@code "1"}; {@code "1.0"} and {@code "1"} do not,
   * because {@code ==} between two texts does not read a decimal point either.
   */
  public static String of(String value) {
    String body =
        !value.isEmpty() && (value.charAt(0) == '+' || value.charAt(0) == '-')
            ? value.substring(1)
            : value;
    if (body.isEmpty()) {
      return value;
    }
    for (int i = 0; i < body.length(); i++) {
      char c = body.charAt(i);
      if (c < '0' || c > '9') {
        return value;
      }
    }
    // Outside the exact domain the evaluator stops treating it as a whole number, and so does
    // this.
    try {
      return Long.toString(Long.parseLong(value));
    } catch (NumberFormatException e) {
      return value;
    }
  }
}
