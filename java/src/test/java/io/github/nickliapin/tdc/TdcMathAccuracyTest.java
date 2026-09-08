package io.github.nickliapin.tdc;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import io.github.nickliapin.tdc.mathx.TdcMath;
import java.util.ArrayList;
import java.util.List;
import java.util.function.DoubleUnaryOperator;
import java.util.stream.Stream;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;

/**
 * How far this port's TdcMath may sit from the true value.
 *
 * <p>Bit-identity across the five implementations is pinned by a shared fixture. This is the
 * other half, and it had only ever been asked in TypeScript: nothing in the parity fixture
 * would notice five implementations agreeing on a number that is wrong in its fourth digit.
 *
 * <p>The reference is the platform's libm — not because it is authoritative (the whole reason
 * TdcMath exists is that the libms disagree) but because it is within an ulp or two of correct,
 * so a large gap means TdcMath is wrong rather than that the two chose different last bits.
 *
 * <p>The grids run to their boundaries on purpose. In the reference implementation a truncated
 * series lived at |r| = π/4, the edge of the reduced interval, and was invisible on a sample of
 * convenient arguments.
 */
class TdcMathAccuracyTest {

  /**
   * The measured worst in the reference is 3 ulp (asin, acos) and everything else is 1 or 2.
   * Four leaves room for a different libm on a different machine without going red on its own.
   */
  private static final int CEILING = 4;

  /** A double's bits as a sign-magnitude ordering, so subtraction counts representable steps. */
  private static long ordinal(double x) {
    long bits = Double.doubleToLongBits(x);
    return bits < 0 ? Long.MIN_VALUE - bits : bits;
  }

  /** How many representable doubles lie between two values. */
  private static double ulpsApart(double a, double b) {
    if (a == b) return 0;
    if (!Double.isFinite(a) || !Double.isFinite(b)) return Double.POSITIVE_INFINITY;
    return Math.abs((double) (ordinal(a) - ordinal(b)));
  }

  private static double[] grid(double lo, double hi, int count) {
    double[] out = new double[count];
    for (int i = 0; i < count; i++) {
      out[i] = lo + (hi - lo) * i / (count - 1);
    }
    return out;
  }

  /**
   * Points spread evenly by RATIO rather than by distance.
   *
   * <p>{@code expm1}, {@code log1p}, {@code asinh} and {@code atanh} all exist for arguments
   * near zero, where a linear grid puts almost no points: from 1e-18 to 0.5 it would place
   * everything at the far end and never test what the function is for.
   */
  private static double[] byRatio(double lo, double hi, int count) {
    double[] out = new double[count * 2];
    for (int i = 0; i < count; i++) {
      double v = Math.exp(Math.log(lo) + (Math.log(hi) - Math.log(lo)) * i / (count - 1));
      out[i] = v;
      out[count + i] = -v;
    }
    return out;
  }

  private static double[] join(double[]... parts) {
    List<Double> all = new ArrayList<>();
    for (double[] part : parts) {
      for (double v : part) {
        all.add(v);
      }
    }
    double[] out = new double[all.size()];
    for (int i = 0; i < out.length; i++) {
      out[i] = all.get(i);
    }
    return out;
  }

  private record Case(String name, DoubleUnaryOperator mine, DoubleUnaryOperator host,
      double[] points) {}

  private static Stream<Arguments> cases() {
    return Stream.of(
            new Case("sqrt", TdcMath::sqrt, Math::sqrt, grid(0, 1e9, 2001)),
            new Case("exp", TdcMath::exp, Math::exp, join(grid(-700, 700, 2001), grid(-2, 2, 501))),
            new Case("log", TdcMath::log, Math::log,
                join(grid(1e-9, 1e9, 2001), grid(0.5, 2, 501))),
            new Case("log10", TdcMath::log10, Math::log10, grid(1e-9, 1e9, 2001)),
            new Case("sin", TdcMath::sin, Math::sin,
                join(grid(-100, 100, 2001), grid(-1, 1, 501))),
            new Case("cos", TdcMath::cos, Math::cos,
                join(grid(-100, 100, 2001), grid(-1, 1, 501))),
            new Case("tan", TdcMath::tan, Math::tan, grid(-10, 10, 2001)),
            new Case("atan", TdcMath::atan, Math::atan,
                join(grid(-50, 50, 2001), grid(-1, 1, 501))),
            new Case("asin", TdcMath::asin, Math::asin, grid(-1, 1, 2001)),
            new Case("acos", TdcMath::acos, Math::acos, grid(-1, 1, 2001)),
            new Case("sinh", TdcMath::sinh, Math::sinh,
                join(grid(-30, 30, 2001), grid(-1, 1, 501))),
            new Case("cosh", TdcMath::cosh, Math::cosh,
                join(grid(-30, 30, 2001), grid(-1, 1, 501))),
            new Case("tanh", TdcMath::tanh, Math::tanh,
                join(grid(-25, 25, 2001), grid(-1, 1, 501))),
            new Case("cbrt", TdcMath::cbrt, Math::cbrt,
                join(grid(-1000, 1000, 2001), grid(-1, 1, 501))),
            new Case("expm1", TdcMath::expm1, Math::expm1,
                join(grid(-40, 40, 1001), byRatio(1e-18, 0.5, 501))),
            new Case("log1p", TdcMath::log1p, Math::log1p,
                join(grid(-0.99, 100, 1001), byRatio(1e-18, 0.9, 501))))
        .map(c -> Arguments.of(c.name(), c));
  }

  @ParameterizedTest(name = "{0} stays close to libm")
  @MethodSource("cases")
  void staysWithinAFewUlpOfLibm(String name, Case c) {
    double worst = 0;
    double at = 0;
    for (double x : c.points()) {
      double mine = c.mine().applyAsDouble(x);
      double host = c.host().applyAsDouble(x);
      // Where the reference identity itself overflows or is undefined there is nothing to
      // compare against; the value TdcMath returns there is pinned by the shared fixture.
      if (!Double.isFinite(host)) continue;
      double d = ulpsApart(mine, host);
      if (d > worst) {
        worst = d;
        at = x;
      }
    }
    double measured = worst;
    double where = at;
    assertTrue(measured <= CEILING, () -> name + ": worst " + measured + " ulp at x = " + where);
  }

  /**
   * The inverse hyperbolics, checked by ROUND TRIP rather than against a reference.
   *
   * <p>The platform has no {@code asinh}, {@code acosh} or {@code atanh}, and their defining
   * identities are not usable as a reference where the functions matter most: at x = 1e-16,
   * {@code log(x + sqrt(x*x + 1))} loses x entirely inside the {@code 1 +} and answers zero,
   * which is not a small error but a total one. Measured while writing this — the identity
   * sat 4.4e18 ulp from TdcMath, and TdcMath was the one that was right.
   *
   * <p>So the property is asserted instead of a value: sinh undoes asinh. That is
   * well-conditioned everywhere the functions are, and needs nothing outside this file.
   */
  @Test
  @DisplayName("each inverse hyperbolic is undone by its forward function")
  void inverseHyperbolicsRoundTrip() {
    assertRoundTrip("asinh", TdcMath::asinh, TdcMath::sinh,
        join(grid(-100, 100, 1001), byRatio(1e-18, 1, 501)));
    assertRoundTrip("acosh", TdcMath::acosh, TdcMath::cosh,
        join(grid(1.0000001, 1000, 1001), grid(1.0000001, 1.001, 501)));
    assertRoundTrip("atanh", TdcMath::atanh, TdcMath::tanh,
        join(grid(-0.999999, 0.999999, 1001), byRatio(1e-18, 0.5, 501)));
  }

  /**
   * A round trip carries the error of BOTH functions, so the bound is relative and wider than
   * the one-way ulp ceiling. It is still tight enough to catch a wrong branch: the failures
   * this replaces were off by the whole value, not by a digit.
   */
  private static void assertRoundTrip(
      String name, DoubleUnaryOperator inverse, DoubleUnaryOperator forward, double[] points) {
    double worst = 0;
    double at = 0;
    for (double x : points) {
      double back = forward.applyAsDouble(inverse.applyAsDouble(x));
      if (!Double.isFinite(back)) continue;
      double relative = x == 0 ? Math.abs(back) : Math.abs((back - x) / x);
      if (relative > worst) {
        worst = relative;
        at = x;
      }
    }
    double measured = worst;
    double where = at;
    assertTrue(measured < 1e-13, () -> name + ": round trip off by " + measured + " at x = " + where);
  }

  /**
   * {@code pow} is measured differently, because two mechanisms widen it and neither is a
   * defect: a whole exponent goes through repeated squaring, which doubles whatever relative
   * error it was handed, and any other goes through exp(y·log x), where an absolute error in
   * the argument becomes a relative one in the answer.
   *
   * <p>What is asserted instead is the thing a config actually depends on: twelve correct
   * significant digits, everywhere.
   */
  @Test
  @DisplayName("pow keeps twelve significant digits over the whole grid")
  void powKeepsTwelveDigits() {
    double worst = 0;
    String at = "";
    for (double x : grid(0.01, 100, 301)) {
      for (double y : grid(-1024, 1024, 401)) {
        double host = Math.pow(x, y);
        // A subnormal result has fewer than twelve significant digits to keep: down there the
        // claim is about the double, not about pow.
        if (!Double.isFinite(host) || Math.abs(host) < 2.3e-308) continue;
        double relative = Math.abs((TdcMath.pow(x, y) - host) / host);
        if (relative > worst) {
          worst = relative;
          at = x + "^" + y;
        }
      }
    }
    double measured = worst;
    String where = at;
    assertTrue(measured < 1e-12, () -> "worst " + measured + " at " + where);
  }

  /**
   * The arguments that are not numbers, and the ones at the edge of the domain.
   *
   * <p>These are the branches a grid never reaches, and they are the ones a port is most
   * likely to have written differently — a missing sign check reads as a plausible number
   * rather than as a crash.
   */
  @Test
  @DisplayName("the special arguments answer what the platform answers")
  void specialArguments() {
    assertTrue(Double.isNaN(TdcMath.sqrt(-1)), "sqrt of a negative is not a number");
    assertEquals(Double.POSITIVE_INFINITY, TdcMath.sqrt(Double.POSITIVE_INFINITY));
    assertEquals(0.0, TdcMath.sqrt(0.0));

    assertEquals(Double.NEGATIVE_INFINITY, TdcMath.log(0.0));
    assertTrue(Double.isNaN(TdcMath.log(-1)), "log of a negative is not a number");
    assertEquals(0.0, TdcMath.log(1.0));

    assertEquals(1.0, TdcMath.exp(0.0));
    assertEquals(0.0, TdcMath.exp(-800), "exp underflows to zero rather than to a subnormal");

    assertTrue(Double.isNaN(TdcMath.asin(1.5)), "asin outside [-1,1] is not a number");
    assertTrue(Double.isNaN(TdcMath.acos(-1.5)), "acos outside [-1,1] is not a number");
    assertEquals(0.0, TdcMath.asin(0.0));

    assertTrue(Double.isNaN(TdcMath.acosh(0.5)), "acosh below one is not a number");
    assertTrue(Double.isNaN(TdcMath.atanh(2)), "atanh outside (-1,1) is not a number");
    assertEquals(Double.POSITIVE_INFINITY, TdcMath.atanh(1.0));
    assertEquals(Double.NEGATIVE_INFINITY, TdcMath.atanh(-1.0));

    assertEquals(1.0, TdcMath.pow(2, 0), "anything to the zero is one");
    assertEquals(1.0, TdcMath.pow(1, 1e9), "one to anything is one");
    assertEquals(0.25, TdcMath.pow(2, -2), "a negative exponent inverts");

    assertEquals(1.0, TdcMath.sign(5.5));
    assertEquals(-1.0, TdcMath.sign(-5.5));
    assertEquals(0.0, TdcMath.sign(0.0));

    assertEquals(5.0, TdcMath.hypot(3, 4), 1e-12);
    assertEquals(0.0, TdcMath.hypot(0, 0));
  }

  /**
   * {@code log2} has no counterpart in the platform, so it is held to its own identity
   * instead: an exact power of two must come back as the exponent, exactly.
   */
  @Test
  @DisplayName("log2 of a power of two is that power, exactly")
  void log2OfPowersOfTwo() {
    for (int k = -60; k <= 60; k++) {
      assertEquals(k, TdcMath.log2(Math.pow(2, k)), 0.0, "log2(2^" + k + ")");
    }
    assertEquals(Double.NEGATIVE_INFINITY, TdcMath.log2(0.0));
    assertTrue(Double.isNaN(TdcMath.log2(-1)), "log2 of a negative is not a number");
  }

  /**
   * {@code atan2} covers a plane, and the quadrant it lands in is decided by a chain of sign
   * checks — the classic place for a port to differ by a whole π.
   */
  @Test
  @DisplayName("atan2 puts every quadrant where the platform puts it")
  void atan2Quadrants() {
    double[] axis = {-8, -1, -0.001, 0, 0.001, 1, 8};
    double worst = 0;
    for (double y : axis) {
      for (double x : axis) {
        double host = Math.atan2(y, x);
        double d = ulpsApart(TdcMath.atan2(y, x), host);
        worst = Math.max(worst, d);
      }
    }
    double measured = worst;
    assertTrue(measured <= CEILING, () -> "worst " + measured + " ulp");
  }
}
