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

  private static final double[] SIN_COEFF = {
    -1.0 / 6.0,
    1.0 / 120.0,
    -1.0 / 5040.0,
    1.0 / 362880.0,
    -1.0 / 39916800.0,
    1.0 / 6227020800.0,
    -1.0 / 1307674368000.0,
  };

  private static final double[] COS_COEFF = {
    -1.0 / 2.0,
    1.0 / 24.0,
    -1.0 / 720.0,
    1.0 / 40320.0,
    -1.0 / 3628800.0,
    1.0 / 479001600.0,
    -1.0 / 87178291200.0,
  };

  private static final double EXP_OVERFLOW = 709.782712893384;
  private static final double EXP_UNDERFLOW = -745.1332191019411;

  private TdcMath() {}

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

  /** {@code value * 2^n} by exact doubling — a power of two is exact in binary. */
  private static double scaleByPowerOfTwo(double value, long n) {
    double out = value;
    long k = n;
    while (k > 0) {
      out *= 2;
      k -= 1;
    }
    while (k < 0) {
      out /= 2;
      k += 1;
    }
    return out;
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
    double term = 1;
    double sum = 1;
    for (int i = 1; i <= 13; i += 1) {
      term = term * r / i;
      sum += term;
    }
    return scaleByPowerOfTwo(sum, (long) k);
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
    double s2 = s * s;
    double sum = 0;
    for (int i = 25; i >= 1; i -= 2) {
      sum = sum * s2 + 1.0 / i;
    }
    return 2 * s * sum + e * LN2_HI + e * LN2_LO;
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
    double sum = 0;
    for (int i = SIN_COEFF.length - 1; i >= 0; i -= 1) {
      sum = sum * z + SIN_COEFF[i];
    }
    return r + r * z * sum;
  }

  private static double cosCore(double r) {
    double z = r * r;
    double sum = 0;
    for (int i = COS_COEFF.length - 1; i >= 0; i -= 1) {
      sum = sum * z + COS_COEFF[i];
    }
    return 1 + z * sum;
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
      double result = 1;
      double base = y < 0 ? 1 / x : x;
      long n = (long) Math.abs(y);
      while (n > 0) {
        if (n % 2 == 1) {
          result *= base;
        }
        base *= base;
        n /= 2;
      }
      return result;
    }
    if (x < 0) {
      return Double.NaN;
    }
    if (x == 0) {
      return y > 0 ? 0 : Double.POSITIVE_INFINITY;
    }
    return exp(y * log(x));
  }
}
