package io.github.nickliapin.tdc.compute;

import java.math.BigInteger;
import java.util.List;

/**
 * The value model of the compute layer: three types, and no more.
 *
 * <p>An integer, a string, or a list of those. No boolean and no floating point — deliberately.
 * Every check digit in the world is integer arithmetic over the characters of a string, and a
 * float in that computation is a way to get the wrong answer on one number in a million and
 * never find out which.
 *
 * <p>Integers are arbitrary precision but range-checked to signed 64 bits, so an overflow is the
 * same deterministic error in every implementation rather than a silent wrap in whichever one
 * has 64-bit ints.
 */
public sealed interface Value {

  record Int(BigInteger v) implements Value {}

  record Str(String v) implements Value {}

  record Lst(List<Value> v) implements Value {}

  BigInteger INT64_MIN = BigInteger.valueOf(Long.MIN_VALUE);
  BigInteger INT64_MAX = BigInteger.valueOf(Long.MAX_VALUE);

  static Value of(BigInteger v) {
    return new Int(guard64(v));
  }

  static Value of(long v) {
    return new Int(BigInteger.valueOf(v));
  }

  static Value of(String v) {
    return new Str(v);
  }

  static Value of(List<Value> v) {
    return new Lst(List.copyOf(v));
  }

  static BigInteger guard64(BigInteger v) {
    if (v.compareTo(INT64_MIN) < 0 || v.compareTo(INT64_MAX) > 0) {
      throw new ComputeError("integer overflow: " + v + " is outside the signed 64-bit range");
    }
    return v;
  }

  /**
   * Coerce to an integer for arithmetic.
   *
   * <p>A <em>single</em> digit character coerces, because iterating a string yields characters
   * and summing them is the whole point. A multi-digit string does not: {@code "12"} in an
   * arithmetic slot is far more often a mistake than an intention, so it has to say {@code
   * <to_number>} out loud.
   */
  static BigInteger asInt(Value value, String context) {
    if (value instanceof Int i) {
      return i.v();
    }
    if (value instanceof Str s) {
      if (s.v().length() == 1 && Character.isDigit(s.v().charAt(0))) {
        return new BigInteger(s.v());
      }
      String hint =
          s.v().matches("^-?[0-9]+$")
              ? " — wrap it in <to_number> to convert a multi-digit string"
              : "";
      throw new ComputeError(
          "expected an integer in " + context + ", got the string \"" + s.v() + "\"" + hint);
    }
    throw new ComputeError("expected an integer in " + context + ", got a list");
  }

  static BigInteger asInt(Value value) {
    return asInt(value, "arithmetic");
  }

  /** An int or a string renders to text. A list never does. */
  static String asStr(Value value) {
    if (value instanceof Str s) {
      return s.v();
    }
    if (value instanceof Int i) {
      return i.v().toString();
    }
    throw new ComputeError("cannot use a list where a string is expected");
  }

  static String toOutput(Value value) {
    if (value instanceof Lst) {
      throw new ComputeError("compute result must be an int or str, not a list");
    }
    return asStr(value);
  }

  static BigInteger parseIntStrict(String s) {
    if (!s.matches("^-?[0-9]+$")) {
      throw new ComputeError("<to_number>: \"" + s + "\" is not a valid integer");
    }
    return guard64(new BigInteger(s));
  }

  /**
   * Euclidean remainder — always in {@code [0, |b|)}.
   *
   * <p>Not the host language's {@code %}: Java and JavaScript both give a negative remainder for
   * a negative dividend, Python does not, and a check digit computed with the wrong sign
   * convention is wrong only for some inputs. Pinning it here makes every implementation agree.
   */
  static BigInteger mod(BigInteger a, BigInteger b) {
    if (b.signum() == 0) {
      throw new ComputeError("<mod>: the modulus (second child) must not be zero");
    }
    return a.mod(b.abs());
  }

  /** Integer division that rounds toward negative infinity. */
  static BigInteger floorDiv(BigInteger a, BigInteger b) {
    if (b.signum() == 0) {
      throw new ComputeError("<divide>: the divisor (second child) must not be zero");
    }
    BigInteger[] qr = a.divideAndRemainder(b);
    BigInteger q = qr[0];
    if (qr[1].signum() != 0 && a.signum() < 0 != b.signum() < 0) {
      q = q.subtract(BigInteger.ONE);
    }
    return q;
  }
}
