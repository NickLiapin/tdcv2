package io.github.nickliapin.tdc.mathx;

/**
 * TdcMath — the transcendental functions, computed by TDC rather than by Java.
 *
 * <p>IEEE-754 pins down {@code +}, {@code -}, {@code *}, {@code /} and {@code sqrt}: each has
 * exactly one legal answer, so every language agrees. It says nothing about {@code sin},
 * {@code cos}, {@code exp}, {@code log} or {@code pow} — every libm picks its own algorithm — and
 * the difference is real. Measured on one machine:
 *
 * <pre>
 * tan(1)      Node 3ff8eb245cbee3a6   Python 3ff8eb245cbee3a5
 * cos(1000)   Node 3fe1ff026793f1bb   Python 3fe1ff026793f1bc
 * </pre>
 *
 * <p>In {@code timeseries} that never shows, because every number is rounded to a decimal string
 * before it becomes output. An {@code if=} has no rounding step, so a comparison turns that bit
 * into a different row and a different file.
 *
 * <p><b>Nothing here may call a transcendental of the host.</b> No {@code Math.sin}, no
 * {@code Math.exp}, no {@code Math.pow}. Only {@code + - * /}, {@code Math.sqrt} (which Java
 * documents as correctly rounded, and which was measured equal across the implementations), and
 * the exact operations {@code Math.abs} and truncation.
 *
 * <p>No {@code strictfp} keyword: since Java 17 every floating-point expression is evaluated
 * strictly, so no JVM may widen an intermediate to a longer register on its way through an
 * expression. On an older JVM this class would need the keyword to hold its promise.
 *
 * <p>Every line mirrors {@code typescript/src/math/tdc-math.ts} in the same ORDER of operations.
 * That order is the contract: float addition is not associative, so regrouping a sum would change
 * the last bit and break the shared case that compares them.
 */
public final class TdcMath {

  public static final double PI = 3.141592653589793;
  public static final double E = 2.718281828459045;

  /** ln 2, split so {@code k * LN2_HI} keeps the low bits a single constant would drop. */
  private static final double LN2_HI = 0.6931471803691238;

  private static final double LN2_LO = 1.9082149292705877e-10;
  private static final double LN2 = 0.6931471805599453;

  // pi/2 in three pieces: a single rounded pi/2 loses most of the significant
  // digits of sin(1000) before the series starts.
  private static final double PIO2 = 1.5707963267948966;
  private static final double PIO2_1 = 1.5707963267341256;
  private static final double PIO2_2 = 6.077100506506192e-11;
  private static final double PIO2_3 = 2.0222662487959506e-21;

  // pi/4 and 3pi/4 — the quadrant answers atan2 returns.
  private static final double PIO4 = 0.7853981633974483;
  private static final double PI3O4 = 2.356194490192345;

  /**
   * Taylor coefficients for (sin(r) - r)/r^3 over r^2, ascending. The count is set by the WORST
   * point of the reduced interval, |r| = pi/4, not by a typical one.
   */
  private static final double[] SIN_COEFF = {
    -1.0 / 6.0,
    1.0 / 120.0,
    -1.0 / 5040.0,
    1.0 / 362880.0,
    -1.0 / 39916800.0,
    1.0 / 6227020800.0,
    -1.0 / 1307674368000.0,
    1.0 / 355687428096000.0,
  };

  /**
   * Taylor coefficients for (cos(r) - 1)/r^2 over r^2, ascending. The last two are not optional:
   * stopping at 1/14! is thirteen ulp out at |r| = pi/4, and sin and tan both inherit that, since
   * a quarter-turn reduction routes half of all arguments through this series.
   */
  private static final double[] COS_COEFF = {
    -1.0 / 2.0,
    1.0 / 24.0,
    -1.0 / 720.0,
    1.0 / 40320.0,
    -1.0 / 3628800.0,
    1.0 / 479001600.0,
    -1.0 / 87178291200.0,
    1.0 / 20922789888000.0,
    -1.0 / 6402373705728000.0,
  };

  /**
   * Taylor coefficients for e^r over r, ascending: 1/n!. Horner rather than a forward recurrence,
   * which rounds twice per term and carries the error forward: 4 ulp against 1 for the same number
   * of terms.
   */
  private static final double[] EXP_COEFF = {
    1.0,
    1.0,
    1.0 / 2.0,
    1.0 / 6.0,
    1.0 / 24.0,
    1.0 / 120.0,
    1.0 / 720.0,
    1.0 / 5040.0,
    1.0 / 40320.0,
    1.0 / 362880.0,
    1.0 / 3628800.0,
    1.0 / 39916800.0,
    1.0 / 479001600.0,
    1.0 / 6227020800.0,
    1.0 / 87178291200.0,
    1.0 / 1307674368000.0,
  };

  /**
   * Taylor coefficients for atan(t)/t over t^2, ascending. Twenty-four, because the reduction
   * halves the argument ONCE and no more: measured, one halving with this many terms lands at
   * 2 ulp, two halvings with sixteen at 3, three with twelve at 4. Series terms are cheaper than
   * reduction steps here, which is the opposite of the usual advice.
   */
  private static final double[] ATAN_COEFF = {
    1.0,
    -1.0 / 3.0,
    1.0 / 5.0,
    -1.0 / 7.0,
    1.0 / 9.0,
    -1.0 / 11.0,
    1.0 / 13.0,
    -1.0 / 15.0,
    1.0 / 17.0,
    -1.0 / 19.0,
    1.0 / 21.0,
    -1.0 / 23.0,
    1.0 / 25.0,
    -1.0 / 27.0,
    1.0 / 29.0,
    -1.0 / 31.0,
    1.0 / 33.0,
    -1.0 / 35.0,
    1.0 / 37.0,
    -1.0 / 39.0,
    1.0 / 41.0,
    -1.0 / 43.0,
    1.0 / 45.0,
    -1.0 / 47.0,
  };

  /** Taylor coefficients for sinh(x)/x over x^2, ascending: 1/(2n+1)!. */
  private static final double[] SINH_COEFF = {
    1.0,
    1.0 / 6.0,
    1.0 / 120.0,
    1.0 / 5040.0,
    1.0 / 362880.0,
    1.0 / 39916800.0,
    1.0 / 6227020800.0,
    1.0 / 1307674368000.0,
  };

  /** Taylor coefficients for (e^x - 1)/x over x, ascending: 1/(n+1)!. */
  private static final double[] EXPM1_COEFF = {
    1.0,
    1.0 / 2.0,
    1.0 / 6.0,
    1.0 / 24.0,
    1.0 / 120.0,
    1.0 / 720.0,
    1.0 / 5040.0,
    1.0 / 40320.0,
    1.0 / 362880.0,
    1.0 / 3628800.0,
    1.0 / 39916800.0,
    1.0 / 479001600.0,
    1.0 / 6227020800.0,
    1.0 / 87178291200.0,
    1.0 / 1307674368000.0,
    1.0 / 20922789888000.0,
  };

  /** Taylor coefficients for cosh(x) over x^2, ascending: 1/(2n)!. */
  private static final double[] COSH_COEFF = {
    1.0,
    1.0 / 2.0,
    1.0 / 24.0,
    1.0 / 720.0,
    1.0 / 40320.0,
    1.0 / 3628800.0,
    1.0 / 479001600.0,
    1.0 / 87178291200.0,
  };

  private static final double EXP_OVERFLOW = 709.782712893384;
  private static final double EXP_UNDERFLOW = -745.1332191019411;

  /** The most halvings that keep a value near 1 inside the normal range. */
  private static final long DEEPEST_NORMAL_HALVING = 1021;

  private TdcMath() {}

  /** Horner over z, ascending coefficients — the shape every series here uses. */
  private static double horner(double[] coeff, double z) {
    double total = 0;
    for (int i = coeff.length - 1; i >= 0; i -= 1) {
      total = total * z + coeff[i];
    }
    return total;
  }

  /**
   * Delegated: IEEE-754 requires square root to be correctly rounded, so there is one legal answer
   * and every implementation must give it.
   */
  public static double sqrt(double x) {
    if (Double.isNaN(x) || x < 0) {
      return Double.NaN;
    }
    return Math.sqrt(x);
  }

  /** Truncation toward zero, written out because Java has no {@code Math.trunc}. */
  private static double trunc(double x) {
    return x < 0 ? Math.ceil(x) : Math.floor(x);
  }

  /** Halve {@code value} exactly {@code count} times. Exact while the result stays normal. */
  private static double halveTimes(double value, long count) {
    double out = value;
    for (long i = 0; i < count; i += 1) {
      out /= 2;
    }
    return out;
  }

  /**
   * {@code value * 2^n} for a value near 1.
   *
   * <p>Stepping one power at a time is exact — while the numbers stay normal. Below 2^-1022 they
   * are not: a subnormal has fewer bits than it started with, and every further halving rounds
   * again. Halving all the way down that way threw away most of the answer — {@code exp(-730)}
   * came back 9.22631e-318 against a true 9.226315e-318, and {@code exp(-745)} came back 0 against
   * 5e-324.
   *
   * <p>So a deep scaling is split: down to the edge of the normal range in exact steps, then ONE
   * multiplication by a small power of two — itself exact, being no smaller than 2^-54.
   */
  private static double scaleByPowerOfTwo(double value, long n) {
    if (n >= -DEEPEST_NORMAL_HALVING) {
      double out = value;
      long k = n;
      while (k > 0) {
        out *= 2;
        k -= 1;
      }
      return halveTimes(out, -k);
    }
    double atTheEdge = halveTimes(value, DEEPEST_NORMAL_HALVING);
    double remainder = halveTimes(1, -(n + DEEPEST_NORMAL_HALVING));
    return atTheEdge * remainder;
  }

  /** {@code exp(x)} — range-reduced to 2^k * e^r with |r| &lt;= ln2/2, then Taylor. */
  public static double exp(double x) {
    if (Double.isNaN(x)) {
      return Double.NaN;
    }
    if (x > EXP_OVERFLOW) {
      return Double.POSITIVE_INFINITY;
    }
    if (x < EXP_UNDERFLOW) {
      return 0;
    }
    double k = trunc(x / LN2 + (x >= 0 ? 0.5 : -0.5));
    double r = x - k * LN2_HI - k * LN2_LO;
    return scaleByPowerOfTwo(horner(EXP_COEFF, r), (long) k);
  }

  /** {@code log(x)} — x = m * 2^e by exact halving, then 2*atanh((m-1)/(m+1)). */
  public static double log(double x) {
    if (Double.isNaN(x) || x < 0) {
      return Double.NaN;
    }
    if (x == 0) {
      return Double.NEGATIVE_INFINITY;
    }
    if (x == Double.POSITIVE_INFINITY) {
      return Double.POSITIVE_INFINITY;
    }
    double m = x;
    double e = 0;
    while (m >= 1.4142135623730951) {
      m /= 2;
      e += 1;
    }
    while (m < 0.7071067811865476) {
      m *= 2;
      e -= 1;
    }
    double s = (m - 1) / (m + 1);
    return 2 * s * atanhSeries(s * s, 25) + e * LN2_HI + e * LN2_LO;
  }

  /**
   * The series for atanh(s)/s over s^2, shared by {@code log} and {@code log1p}.
   *
   * <p>The two callers reduce to different intervals, so each names how far to go: {@code log}
   * halves its argument until |s| &lt;= 0.1716 and thirteen terms suffice, while {@code log1p}
   * cannot halve — it must not form 1 + x at all — and reaches |s| &lt;= 1/3, where thirteen terms
   * are 63 ulp out and twenty are 2.
   */
  private static double atanhSeries(double s2, int highestOddPower) {
    double sum = 0;
    for (int i = highestOddPower; i >= 1; i -= 2) {
      sum = sum * s2 + 1.0 / i;
    }
    return sum;
  }

  public static double log10(double x) {
    return log(x) / 2.302585092994046;
  }

  /** The quadrant (0-3) and the remainder in [-pi/4, pi/4], packed so both cross one return. */
  private static double[] reduceByQuarterTurn(double x) {
    double k = trunc(x / PIO2 + (x >= 0 ? 0.5 : -0.5));
    double remainder = x - k * PIO2_1 - k * PIO2_2 - k * PIO2_3;
    long q = (long) k;
    return new double[] {((q % 4) + 4) % 4, remainder};
  }

  private static double sinCore(double r) {
    double z = r * r;
    return r + r * z * horner(SIN_COEFF, z);
  }

  private static double cosCore(double r) {
    double z = r * r;
    return 1 + z * horner(COS_COEFF, z);
  }

  public static double sin(double x) {
    if (Double.isNaN(x) || Double.isInfinite(x)) {
      return Double.NaN;
    }
    double[] reduced = reduceByQuarterTurn(x);
    int quadrant = (int) reduced[0];
    double remainder = reduced[1];
    if (quadrant == 0) {
      return sinCore(remainder);
    }
    if (quadrant == 1) {
      return cosCore(remainder);
    }
    if (quadrant == 2) {
      return -sinCore(remainder);
    }
    return -cosCore(remainder);
  }

  public static double cos(double x) {
    if (Double.isNaN(x) || Double.isInfinite(x)) {
      return Double.NaN;
    }
    double[] reduced = reduceByQuarterTurn(x);
    int quadrant = (int) reduced[0];
    double remainder = reduced[1];
    if (quadrant == 0) {
      return cosCore(remainder);
    }
    if (quadrant == 1) {
      return -sinCore(remainder);
    }
    if (quadrant == 2) {
      return -cosCore(remainder);
    }
    return sinCore(remainder);
  }

  /**
   * One reduction shared by both halves, so numerator and denominator can never come from
   * different quadrants.
   */
  public static double tan(double x) {
    if (Double.isNaN(x) || Double.isInfinite(x)) {
      return Double.NaN;
    }
    double[] reduced = reduceByQuarterTurn(x);
    int quadrant = (int) reduced[0];
    double remainder = reduced[1];
    double s = sinCore(remainder);
    double c = cosCore(remainder);
    return quadrant % 2 == 0 ? s / c : -c / s;
  }

  /**
   * An integer exponent goes through repeated squaring, so {@code pow(10, 3)} is exactly 1000
   * rather than 999.9999999999998.
   */
  public static double pow(double x, double y) {
    if (Double.isNaN(y)) {
      return Double.NaN;
    }
    if (y == 0) {
      return 1;
    }
    if (Double.isNaN(x)) {
      return Double.NaN;
    }
    if (y == trunc(y) && !Double.isInfinite(y) && Math.abs(y) <= 1024) {
      return repeatedSquaring(y < 0 ? 1 / x : x, (long) Math.abs(y));
    }
    if (x < 0) {
      return Double.NaN;
    }
    if (x == 0) {
      return y > 0 ? 0 : Double.POSITIVE_INFINITY;
    }
    // A half-integer exponent is the fractional one people actually write, and
    // x^(n/2) is (sqrt x)^n — both halves exact. Without this, pow(100, 0.5)
    // came back 9.999999999999998 and pow(9, 1.5) 26.99999999999999.
    double half = 2 * y;
    if (half == trunc(half) && Math.abs(half) <= 2048) {
      double root = Math.sqrt(x);
      return repeatedSquaring(half < 0 ? 1 / root : root, (long) Math.abs(half));
    }
    return exp(y * log(x));
  }

  private static double repeatedSquaring(double base, long exponent) {
    double result = 1;
    double b = base;
    long n = exponent;
    while (n > 0) {
      if (n % 2 == 1) {
        result *= b;
      }
      b *= b;
      n /= 2;
    }
    return result;
  }

  // ── The second wave: inverses and hyperbolics ──────────────────────────────
  //
  // Same rule as everything above: + - * /, Math.sqrt, and the functions this
  // class already built. Nothing here calls a transcendental of the host.

  /** Half-angle for the arctangent: atan(t) = 2*atan(h(t)). Built from sqrt alone. */
  private static double atanHalf(double t) {
    return t / (1 + Math.sqrt(1 + t * t));
  }

  /** {@code atan} on [0, 1], halved once so the series runs on |t| &lt;= 0.4143. */
  private static double atanCore(double t) {
    double h = atanHalf(t);
    return 2 * (h * horner(ATAN_COEFF, h * h));
  }

  /** {@code atan(x)} — the arctangent, in radians, over the whole real line. */
  public static double atan(double x) {
    if (Double.isNaN(x)) {
      return Double.NaN;
    }
    if (x == Double.POSITIVE_INFINITY) {
      return PIO2;
    }
    if (x == Double.NEGATIVE_INFINITY) {
      return -PIO2;
    }
    double sign = x < 0 ? -1 : 1;
    double a = Math.abs(x);
    double r = a > 1 ? PIO2 - atanCore(1 / a) : atanCore(a);
    return sign * r;
  }

  /**
   * {@code atan2(y, x)} — the angle of the point (x, y), in radians, over (-pi, pi].
   *
   * <p>The quadrant cannot be recovered from {@code y/x} alone: the ratio is the same in opposite
   * quadrants, which is the whole reason this exists separately from {@code atan}.
   */
  public static double atan2(double y, double x) {
    if (Double.isNaN(y) || Double.isNaN(x)) {
      return Double.NaN;
    }
    if (Double.isInfinite(y) && Double.isInfinite(x)) {
      double magnitude = x > 0 ? PIO4 : PI3O4;
      return y > 0 ? magnitude : -magnitude;
    }
    if (Double.isInfinite(y)) {
      return y > 0 ? PIO2 : -PIO2;
    }
    if (Double.isInfinite(x)) {
      if (x > 0) {
        return 0;
      }
      return y < 0 ? -PI : PI;
    }
    if (x == 0 && y == 0) {
      return 0;
    }
    if (x == 0) {
      return y > 0 ? PIO2 : -PIO2;
    }
    if (y == 0) {
      return x > 0 ? 0 : PI;
    }
    double r = atan(y / x);
    if (x > 0) {
      return r;
    }
    return y > 0 ? r + PI : r - PI;
  }

  /** {@code asin} on [0, 0.5], where 1 - a*a keeps every bit it started with. */
  private static double asinSmall(double a) {
    return atan(a / Math.sqrt(1 - a * a));
  }

  /**
   * {@code asin(x)} — the arcsine, in radians, over [-1, 1].
   *
   * <p>Past a half the direct route would compute 1 - a*a with a and 1 nearly equal, and lose most
   * of its digits before sqrt ever saw them. The half-angle identity moves the subtraction to
   * 1 - a, which is exact in that range.
   */
  public static double asin(double x) {
    if (Double.isNaN(x)) {
      return Double.NaN;
    }
    double sign = x < 0 ? -1 : 1;
    double a = Math.abs(x);
    if (a > 1) {
      return Double.NaN;
    }
    if (a == 1) {
      return sign * PIO2;
    }
    if (a <= 0.5) {
      return sign * asinSmall(a);
    }
    return sign * (PIO2 - 2 * asinSmall(Math.sqrt((1 - a) / 2)));
  }

  /**
   * {@code acos(x)} — the arccosine, in radians, over [-1, 1].
   *
   * <p>Not pi/2 - asin(x) everywhere: near x = 1 the answer approaches zero, and that subtraction
   * would compute it as the difference of two numbers that are nearly pi/2, throwing away every
   * digit that matters.
   */
  public static double acos(double x) {
    if (Double.isNaN(x)) {
      return Double.NaN;
    }
    if (x > 1 || x < -1) {
      return Double.NaN;
    }
    if (x == 1) {
      return 0;
    }
    if (x == -1) {
      return PI;
    }
    if (x >= 0.5) {
      return 2 * asinSmall(Math.sqrt((1 - x) / 2));
    }
    if (x <= -0.5) {
      return PI - 2 * asinSmall(Math.sqrt((1 + x) / 2));
    }
    return PIO2 - asinSmall(Math.abs(x)) * (x < 0 ? -1 : 1);
  }

  /** {@code sinh(x)} — below a half the exponential route would cancel the answer away. */
  public static double sinh(double x) {
    if (Double.isNaN(x) || Double.isInfinite(x)) {
      return x;
    }
    double a = Math.abs(x);
    if (a < 0.5) {
      return x * horner(SINH_COEFF, x * x);
    }
    double sign = x < 0 ? -1 : 1;
    // Past this point e^x overflows but sinh(x) still fits, so the halving is
    // folded into the exponent rather than applied after it.
    if (a > 709) {
      return sign * exp(a - LN2);
    }
    double t = exp(a);
    return sign * (t - 1 / t) / 2;
  }

  /** {@code cosh(x)} — a sum rather than a difference, so nothing cancels. */
  public static double cosh(double x) {
    if (Double.isNaN(x)) {
      return Double.NaN;
    }
    if (Double.isInfinite(x)) {
      return Double.POSITIVE_INFINITY;
    }
    double a = Math.abs(x);
    if (a < 0.5) {
      return horner(COSH_COEFF, x * x);
    }
    if (a > 709) {
      return exp(a - LN2);
    }
    double t = exp(a);
    return (t + 1 / t) / 2;
  }

  /**
   * {@code tanh(x)} — past 20 the true value is within 1e-17 of 1, closer than the next double, so
   * the answer is 1 and computing e^40 to discover that would be waste.
   */
  public static double tanh(double x) {
    if (Double.isNaN(x)) {
      return Double.NaN;
    }
    double sign = x < 0 ? -1 : 1;
    if (Double.isInfinite(x)) {
      return sign;
    }
    double a = Math.abs(x);
    if (a > 20) {
      return sign;
    }
    if (a < 0.5) {
      double z = x * x;
      return x * horner(SINH_COEFF, z) / horner(COSH_COEFF, z);
    }
    double u = exp(2 * a);
    return sign * (u - 1) / (u + 1);
  }

  /**
   * {@code cbrt(x)} — the cube root, defined for negatives too.
   *
   * <p>{@code pow(x, 1/3)} is not the same function: one third is not a double, and a negative
   * base with a fractional exponent has no real answer at all. So this is its own function,
   * reduced by powers of eight — exact, being powers of two — and then refined by Newton's method.
   */
  public static double cbrt(double x) {
    if (Double.isNaN(x) || Double.isInfinite(x) || x == 0) {
      return x;
    }
    double sign = x < 0 ? -1 : 1;
    double a = Math.abs(x);
    long e = 0;
    while (a >= 8) {
      a /= 8;
      e += 1;
    }
    while (a < 1) {
      a *= 8;
      e -= 1;
    }
    // A straight line through the ends of [1, 8): within 11% everywhere, which
    // six Newton passes take past the last bit.
    double y = 1 + (a - 1) / 7;
    for (int i = 0; i < 6; i += 1) {
      y = (2 * y + a / (y * y)) / 3;
    }
    return sign * scaleByPowerOfTwo(y, e);
  }

  // ── The third wave: the shapes that exist to avoid cancellation ────────────
  //
  // expm1 and log1p are not conveniences. Near zero, exp(x) - 1 and log(1 + x)
  // each throw away most of their answer to a subtraction or to a rounding that
  // happens before the function is even called — and these two are what the
  // inverse hyperbolics are built from, which is why they come first.

  /**
   * {@code expm1(x)} — e^x - 1, computed so that small x keeps its digits.
   *
   * <p>{@code exp(0.0000001) - 1} in plain arithmetic is a subtraction of two numbers that agree
   * to seven places, and most of the answer dies in it.
   */
  public static double expm1(double x) {
    if (Double.isNaN(x)) {
      return Double.NaN;
    }
    if (Math.abs(x) < 0.5) {
      return x * horner(EXPM1_COEFF, x);
    }
    return exp(x) - 1;
  }

  /**
   * {@code log1p(x)} — log(1 + x), computed so that small x keeps its digits.
   *
   * <p>The loss here happens before the logarithm is reached: {@code 1 + 1e-20} IS 1 as a double,
   * so {@code log(1 + x)} returns zero for every x under 1e-16. Reducing instead to
   * 2*atanh(x/(2+x)) never forms 1 + x at all.
   */
  public static double log1p(double x) {
    if (Double.isNaN(x) || x < -1) {
      return Double.NaN;
    }
    if (x == -1) {
      return Double.NEGATIVE_INFINITY;
    }
    if (x == Double.POSITIVE_INFINITY) {
      return Double.POSITIVE_INFINITY;
    }
    // Past a half, 1 + x has nothing left to lose and the direct route is both
    // shorter and better conditioned.
    if (Math.abs(x) >= 0.5) {
      return log(1 + x);
    }
    double s = x / (2 + x);
    return 2 * s * atanhSeries(s * s, 39);
  }

  /**
   * {@code log2(x)}.
   *
   * <p>Not {@code log(x) / ln2}: that would make {@code log2(8)} come out 2.9999999999999996, and
   * a power of two is precisely the argument someone passes to log2. The exponent is separated
   * first.
   */
  public static double log2(double x) {
    if (Double.isNaN(x) || x < 0) {
      return Double.NaN;
    }
    if (x == 0) {
      return Double.NEGATIVE_INFINITY;
    }
    if (x == Double.POSITIVE_INFINITY) {
      return Double.POSITIVE_INFINITY;
    }
    double m = x;
    double e = 0;
    while (m >= 1.4142135623730951) {
      m /= 2;
      e += 1;
    }
    while (m < 0.7071067811865476) {
      m *= 2;
      e -= 1;
    }
    if (m == 1) {
      return e;
    }
    return e + log(m) / LN2;
  }

  /**
   * {@code hypot(x, y)} — the length of the vector, without an intermediate that overflows.
   *
   * <p>{@code sqrt(x*x + y*y)} is the definition and the wrong implementation: for x = 1e200 the
   * square overflows to infinity and the answer comes back infinite, though it is perfectly
   * representable. Factoring the larger side out first keeps every intermediate near 1.
   */
  public static double hypot(double x, double y) {
    // An infinite side wins even against a NaN on the other, which is what
    // IEEE-754 recommends: the length is infinite whatever the other side is.
    if (Double.isInfinite(x) || Double.isInfinite(y)) {
      return Double.POSITIVE_INFINITY;
    }
    if (Double.isNaN(x) || Double.isNaN(y)) {
      return Double.NaN;
    }
    double a = Math.abs(x);
    double b = Math.abs(y);
    if (a < b) {
      double swap = a;
      a = b;
      b = swap;
    }
    if (a == 0) {
      return 0;
    }
    double ratio = b / a;
    return a * Math.sqrt(1 + ratio * ratio);
  }

  /** {@code sign(x)} — -1, 0 or 1. Exact: there is nothing here to round. */
  public static double sign(double x) {
    if (Double.isNaN(x)) {
      return Double.NaN;
    }
    if (x > 0) {
      return 1;
    }
    if (x < 0) {
      return -1;
    }
    return 0;
  }

  /**
   * {@code asinh(x)} — the inverse hyperbolic sine, over the whole real line.
   *
   * <p>log(x + sqrt(x*x + 1)) is the textbook form and cancels for small x. Rewriting the argument
   * as x + x*x/(1 + sqrt(1 + x*x)) leaves log1p a number near x rather than a number near 1.
   */
  public static double asinh(double x) {
    if (Double.isNaN(x) || Double.isInfinite(x)) {
      return x;
    }
    double sign = x < 0 ? -1 : 1;
    double a = Math.abs(x);
    // Past this, a*a would overflow while asinh(a) is still a small number; up
    // there sqrt(1 + a*a) is a to every bit, so the answer is log(2a).
    if (a > 1e150) {
      return sign * (log(a) + LN2);
    }
    return sign * log1p(a + (a * a) / (1 + Math.sqrt(1 + a * a)));
  }

  /**
   * {@code acosh(x)} — the inverse hyperbolic cosine, defined for x &gt;= 1.
   *
   * <p>Written around t = x - 1, which is exact for the x near 1 where the answer approaches zero
   * and the textbook form loses it.
   */
  public static double acosh(double x) {
    if (Double.isNaN(x)) {
      return Double.NaN;
    }
    if (x < 1) {
      return Double.NaN;
    }
    if (x == 1) {
      return 0;
    }
    if (x == Double.POSITIVE_INFINITY) {
      return Double.POSITIVE_INFINITY;
    }
    if (x > 1e150) {
      return log(x) + LN2;
    }
    double t = x - 1;
    return log1p(t + Math.sqrt(2 * t + t * t));
  }

  /**
   * {@code atanh(x)} — the inverse hyperbolic tangent, over (-1, 1).
   *
   * <p>0.5*log((1+x)/(1-x)) forms a ratio near 1 for small x and loses it. The same ratio written
   * as 1 + 2x/(1-x) hands log1p the small part directly.
   */
  public static double atanh(double x) {
    if (Double.isNaN(x)) {
      return Double.NaN;
    }
    if (x > 1 || x < -1) {
      return Double.NaN;
    }
    if (x == 1) {
      return Double.POSITIVE_INFINITY;
    }
    if (x == -1) {
      return Double.NEGATIVE_INFINITY;
    }
    // The identity is only well-conditioned on the positive side. Fed
    // x = -0.999999 directly it hands log1p an argument of -0.9999995, which is
    // the very cancellation log1p exists to avoid — and the answer came back
    // 37618 ulp wrong. Folding to |x| first keeps that argument positive.
    double sign = x < 0 ? -1 : 1;
    double a = Math.abs(x);
    return sign * 0.5 * log1p((2 * a) / (1 - a));
  }
}
