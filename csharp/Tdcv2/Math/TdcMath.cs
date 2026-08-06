namespace Tdcv2.Maths;

/// <summary>
/// TdcMath — the transcendental functions, computed by TDC rather than by .NET.
///
/// <para>IEEE-754 pins down <c>+</c>, <c>-</c>, <c>*</c>, <c>/</c> and <c>sqrt</c>: each has
/// exactly one legal answer, so every language agrees. It says nothing about <c>sin</c>,
/// <c>cos</c>, <c>exp</c>, <c>log</c> or <c>pow</c> — every libm picks its own algorithm — and
/// the difference is real. Measured on one machine:</para>
///
/// <code>
/// tan(1)      Node 3ff8eb245cbee3a6   Python 3ff8eb245cbee3a5
/// cos(1000)   Node 3fe1ff026793f1bb   Python 3fe1ff026793f1bc
/// </code>
///
/// <para>In <c>timeseries</c> that never shows, because every number is rounded to a decimal
/// string before it becomes output. An <c>if=</c> has no rounding step, so a comparison turns
/// that bit into a different row and a different file.</para>
///
/// <para><b>Nothing here may call a transcendental of the host.</b> No <c>Math.Sin</c>, no
/// <c>Math.Exp</c>, no <c>Math.Pow</c>. Only <c>+ - * /</c>, <c>Math.Sqrt</c> (correctly rounded
/// by the standard, verified equal across the implementations), and the exact operations
/// <c>Math.Abs</c> and <c>Math.Truncate</c>.</para>
///
/// <para>Every line mirrors <c>typescript/src/math/tdc-math.ts</c> in the same ORDER of
/// operations. That order is the contract: float addition is not associative, so regrouping a
/// sum would change the last bit and break the shared case that compares them.</para>
/// </summary>
internal static class TdcMath
{
    public const double Pi = 3.141592653589793;
    public const double E = 2.718281828459045;

    // ln 2, split so `k * Ln2Hi` keeps the low bits a single constant would drop.
    // The constant carries 21 zero low bits, so any k this reduction produces
    // multiplies without rounding.
    private const double Ln2Hi = 0.6931471803691238;
    private const double Ln2Lo = 1.9082149292705877e-10;
    private const double Ln2 = 0.6931471805599453;

    // pi/2 in three pieces: a single rounded pi/2 loses most of the significant
    // digits of sin(1000) before the series starts.
    private const double PiOver2 = 1.5707963267948966;
    private const double PiOver2A = 1.5707963267341256;
    private const double PiOver2B = 6.077100506506192e-11;
    private const double PiOver2C = 2.0222662487959506e-21;

    // pi/4 and 3pi/4 — the quadrant answers Atan2 returns.
    private const double PiOver4 = 0.7853981633974483;
    private const double ThreePiOver4 = 2.356194490192345;

    /// <summary>
    /// Taylor coefficients for (sin(r) − r)/r³ over r², ascending. The count is set by the WORST
    /// point of the reduced interval, |r| = π/4, not by a typical one.
    /// </summary>
    private static readonly double[] SinCoeff =
    {
        -1.0 / 6.0,
        1.0 / 120.0,
        -1.0 / 5040.0,
        1.0 / 362880.0,
        -1.0 / 39916800.0,
        1.0 / 6227020800.0,
        -1.0 / 1307674368000.0,
        1.0 / 355687428096000.0,
    };

    /// <summary>
    /// Taylor coefficients for (cos(r) − 1)/r² over r², ascending. The last two are not optional:
    /// stopping at 1/14! is thirteen ulp out at |r| = π/4, and Sin and Tan both inherit that,
    /// since a quarter-turn reduction routes half of all arguments through this series.
    /// </summary>
    private static readonly double[] CosCoeff =
    {
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

    /// <summary>
    /// Taylor coefficients for eʳ over r, ascending: 1/n!. Horner rather than a forward
    /// recurrence, which rounds twice per term and carries the error forward: 4 ulp against 1 for
    /// the same number of terms.
    /// </summary>
    private static readonly double[] ExpCoeff =
    {
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

    /// <summary>
    /// Taylor coefficients for atan(t)/t over t², ascending. Twenty-four, because the reduction
    /// halves the argument ONCE and no more: measured, one halving with this many terms lands at
    /// 2 ulp, two halvings with sixteen at 3, three with twelve at 4. Series terms are cheaper
    /// than reduction steps here, which is the opposite of the usual advice.
    /// </summary>
    private static readonly double[] AtanCoeff =
    {
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

    /// <summary>Taylor coefficients for sinh(x)/x over x², ascending: 1/(2n+1)!.</summary>
    private static readonly double[] SinhCoeff =
    {
        1.0,
        1.0 / 6.0,
        1.0 / 120.0,
        1.0 / 5040.0,
        1.0 / 362880.0,
        1.0 / 39916800.0,
        1.0 / 6227020800.0,
        1.0 / 1307674368000.0,
    };

    /// <summary>Taylor coefficients for cosh(x) over x², ascending: 1/(2n)!.</summary>
    private static readonly double[] CoshCoeff =
    {
        1.0,
        1.0 / 2.0,
        1.0 / 24.0,
        1.0 / 720.0,
        1.0 / 40320.0,
        1.0 / 3628800.0,
        1.0 / 479001600.0,
        1.0 / 87178291200.0,
    };

    private const double ExpOverflow = 709.782712893384;
    private const double ExpUnderflow = -745.1332191019411;

    /// <summary>The most halvings that keep a value near 1 inside the normal range.</summary>
    private const long DeepestNormalHalving = 1021;

    /// <summary>Taylor coefficients for (eˣ − 1)/x over x, ascending: 1/(n+1)!.</summary>
    private static readonly double[] Expm1Coeff =
    {
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

    /// <summary>Horner over z, ascending coefficients — the shape every series here uses.</summary>
    private static double Horner(double[] coeff, double z)
    {
        double total = 0;
        for (int i = coeff.Length - 1; i >= 0; i -= 1)
        {
            total = (total * z) + coeff[i];
        }
        return total;
    }

    /// <summary>
    /// Delegated: IEEE-754 requires square root to be correctly rounded, so there is one legal
    /// answer and every implementation must give it.
    /// </summary>
    public static double Sqrt(double x)
    {
        if (double.IsNaN(x) || x < 0) return double.NaN;
        return System.Math.Sqrt(x);
    }

    /// <summary>Halve <paramref name="value"/> exactly <paramref name="count"/> times.</summary>
    private static double HalveTimes(double value, long count)
    {
        double outValue = value;
        for (long i = 0; i < count; i += 1)
        {
            outValue /= 2;
        }
        return outValue;
    }

    /// <summary>
    /// <c>value * 2^n</c> for a value near 1.
    ///
    /// <para>Stepping one power at a time is exact — while the numbers stay normal. Below 2⁻¹⁰²²
    /// they are not: a subnormal has fewer bits than it started with, and every further halving
    /// rounds again. Halving all the way down that way threw away most of the answer —
    /// <c>Exp(-730)</c> came back 9.22631e-318 against a true 9.226315e-318, and <c>Exp(-745)</c>
    /// came back 0 against 5e-324.</para>
    ///
    /// <para>So a deep scaling is split: down to the edge of the normal range in exact steps,
    /// then ONE multiplication by a small power of two — itself exact, being no smaller than
    /// 2⁻⁵⁴ — which rounds once and only once.</para>
    /// </summary>
    private static double ScaleByPowerOfTwo(double value, long n)
    {
        if (n >= -DeepestNormalHalving)
        {
            double outValue = value;
            long k = n;
            while (k > 0)
            {
                outValue *= 2;
                k -= 1;
            }
            return HalveTimes(outValue, -k);
        }
        double atTheEdge = HalveTimes(value, DeepestNormalHalving);
        double remainder = HalveTimes(1, -(n + DeepestNormalHalving));
        return atTheEdge * remainder;
    }

    /// <summary><c>exp(x)</c> — range-reduced to 2^k · e^r with |r| &lt;= ln2/2, then Taylor.</summary>
    public static double Exp(double x)
    {
        if (double.IsNaN(x)) return double.NaN;
        if (x > ExpOverflow) return double.PositiveInfinity;
        if (x < ExpUnderflow) return 0;
        double k = System.Math.Truncate((x / Ln2) + (x >= 0 ? 0.5 : -0.5));
        double r = x - (k * Ln2Hi) - (k * Ln2Lo);
        return ScaleByPowerOfTwo(Horner(ExpCoeff, r), (long)k);
    }

    /// <summary><c>log(x)</c> — x = m · 2^e by exact halving, then 2·atanh((m−1)/(m+1)).</summary>
    public static double Log(double x)
    {
        if (double.IsNaN(x) || x < 0) return double.NaN;
        if (x == 0) return double.NegativeInfinity;
        if (double.IsPositiveInfinity(x)) return double.PositiveInfinity;
        double m = x;
        double e = 0;
        while (m >= 1.4142135623730951)
        {
            m /= 2;
            e += 1;
        }
        while (m < 0.7071067811865476)
        {
            m *= 2;
            e -= 1;
        }
        double s = (m - 1) / (m + 1);
        return (2 * s * AtanhSeries(s * s, 25)) + (e * Ln2Hi) + (e * Ln2Lo);
    }

    /// <summary>
    /// The series for atanh(s)/s over s², shared by Log and Log1p.
    ///
    /// <para>The two callers reduce to different intervals, so each names how far to go: Log
    /// halves its argument until |s| &lt;= 0.1716 and thirteen terms suffice, while Log1p cannot
    /// halve — it must not form 1 + x at all — and reaches |s| &lt;= 1/3, where thirteen terms are
    /// 63 ulp out and twenty are 2.</para>
    /// </summary>
    private static double AtanhSeries(double s2, int highestOddPower)
    {
        double sum = 0;
        for (int i = highestOddPower; i >= 1; i -= 2)
        {
            sum = (sum * s2) + (1.0 / i);
        }
        return sum;
    }

    public static double Log10(double x) => Log(x) / 2.302585092994046;

    /// <summary>The quadrant (0-3) and the remainder in [−π/4, π/4].</summary>
    private static (int Quadrant, double Remainder) ReduceByQuarterTurn(double x)
    {
        double k = System.Math.Truncate((x / PiOver2) + (x >= 0 ? 0.5 : -0.5));
        double remainder = x - (k * PiOver2A) - (k * PiOver2B) - (k * PiOver2C);
        long q = (long)k;
        return ((int)(((q % 4) + 4) % 4), remainder);
    }

    private static double SinCore(double r)
    {
        double z = r * r;
        return r + (r * z * Horner(SinCoeff, z));
    }

    private static double CosCore(double r)
    {
        double z = r * r;
        return 1 + (z * Horner(CosCoeff, z));
    }

    public static double Sin(double x)
    {
        if (double.IsNaN(x) || double.IsInfinity(x)) return double.NaN;
        var (quadrant, remainder) = ReduceByQuarterTurn(x);
        if (quadrant == 0) return SinCore(remainder);
        if (quadrant == 1) return CosCore(remainder);
        if (quadrant == 2) return -SinCore(remainder);
        return -CosCore(remainder);
    }

    public static double Cos(double x)
    {
        if (double.IsNaN(x) || double.IsInfinity(x)) return double.NaN;
        var (quadrant, remainder) = ReduceByQuarterTurn(x);
        if (quadrant == 0) return CosCore(remainder);
        if (quadrant == 1) return -SinCore(remainder);
        if (quadrant == 2) return -CosCore(remainder);
        return SinCore(remainder);
    }

    /// <summary>
    /// One reduction shared by both halves, so numerator and denominator can never come from
    /// different quadrants.
    /// </summary>
    public static double Tan(double x)
    {
        if (double.IsNaN(x) || double.IsInfinity(x)) return double.NaN;
        var (quadrant, remainder) = ReduceByQuarterTurn(x);
        double s = SinCore(remainder);
        double c = CosCore(remainder);
        return quadrant % 2 == 0 ? s / c : -c / s;
    }

    private static double RepeatedSquaring(double baseValue, long exponent)
    {
        double result = 1;
        double b = baseValue;
        long n = exponent;
        while (n > 0)
        {
            if (n % 2 == 1) result *= b;
            b *= b;
            n /= 2;
        }
        return result;
    }

    /// <summary>
    /// An integer exponent goes through repeated squaring, so <c>Pow(10, 3)</c> is exactly 1000
    /// rather than 999.9999999999998.
    /// </summary>
    public static double Pow(double x, double y)
    {
        if (double.IsNaN(y)) return double.NaN;
        if (y == 0) return 1;
        if (double.IsNaN(x)) return double.NaN;
        if (y == System.Math.Truncate(y) && !double.IsInfinity(y) && System.Math.Abs(y) <= 1024)
        {
            return RepeatedSquaring(y < 0 ? 1 / x : x, (long)System.Math.Abs(y));
        }
        // A negative base with a fractional exponent has no real answer, and saying
        // so is better than returning whatever the general route would produce.
        if (x < 0) return double.NaN;
        if (x == 0) return y > 0 ? 0 : double.PositiveInfinity;
        // A half-integer exponent is the fractional one people actually write, and
        // x^(n/2) is (√x)^n — both halves exact. Without this, Pow(100, 0.5) came
        // back 9.999999999999998 and Pow(9, 1.5) 26.99999999999999.
        double half = 2 * y;
        if (half == System.Math.Truncate(half) && System.Math.Abs(half) <= 2048)
        {
            double root = System.Math.Sqrt(x);
            return RepeatedSquaring(half < 0 ? 1 / root : root, (long)System.Math.Abs(half));
        }
        return Exp(y * Log(x));
    }

    // ── The second wave: inverses and hyperbolics ────────────────────────────
    //
    // Same rule as everything above: + - * /, Math.Sqrt, and the functions this
    // class already built. Nothing here calls a transcendental of the host.

    /// <summary>Half-angle for the arctangent: atan(t) = 2·atan(h(t)). Built from sqrt alone.</summary>
    private static double AtanHalf(double t) => t / (1 + System.Math.Sqrt(1 + (t * t)));

    /// <summary><c>atan</c> on [0, 1], halved once so the series runs on |t| &lt;= 0.4143.</summary>
    private static double AtanCore(double t)
    {
        double h = AtanHalf(t);
        return 2 * (h * Horner(AtanCoeff, h * h));
    }

    /// <summary><c>atan(x)</c> — the arctangent, in radians, over the whole real line.</summary>
    public static double Atan(double x)
    {
        if (double.IsNaN(x)) return double.NaN;
        if (double.IsPositiveInfinity(x)) return PiOver2;
        if (double.IsNegativeInfinity(x)) return -PiOver2;
        double sign = x < 0 ? -1 : 1;
        double a = System.Math.Abs(x);
        double r = a > 1 ? PiOver2 - AtanCore(1 / a) : AtanCore(a);
        return sign * r;
    }

    /// <summary>
    /// <c>atan2(y, x)</c> — the angle of the point (x, y), in radians, over (−π, π].
    ///
    /// <para>The quadrant cannot be recovered from <c>y/x</c> alone: the ratio is the same in
    /// opposite quadrants, which is the whole reason this exists separately from Atan.</para>
    /// </summary>
    public static double Atan2(double y, double x)
    {
        if (double.IsNaN(y) || double.IsNaN(x)) return double.NaN;
        if (double.IsInfinity(y) && double.IsInfinity(x))
        {
            double magnitude = x > 0 ? PiOver4 : ThreePiOver4;
            return y > 0 ? magnitude : -magnitude;
        }
        if (double.IsInfinity(y)) return y > 0 ? PiOver2 : -PiOver2;
        if (double.IsInfinity(x))
        {
            if (x > 0) return 0;
            return y < 0 ? -Pi : Pi;
        }
        if (x == 0 && y == 0) return 0;
        if (x == 0) return y > 0 ? PiOver2 : -PiOver2;
        if (y == 0) return x > 0 ? 0 : Pi;
        double r = Atan(y / x);
        if (x > 0) return r;
        return y > 0 ? r + Pi : r - Pi;
    }

    /// <summary><c>asin</c> on [0, 0.5], where 1 − a² keeps every bit it started with.</summary>
    private static double AsinSmall(double a) => Atan(a / System.Math.Sqrt(1 - (a * a)));

    /// <summary>
    /// <c>asin(x)</c> — the arcsine, in radians, over [−1, 1].
    ///
    /// <para>Past a half the direct route would compute 1 − a² with a and 1 nearly equal, and
    /// lose most of its digits before sqrt ever saw them. The half-angle identity moves the
    /// subtraction to 1 − a, which is exact in that range.</para>
    /// </summary>
    public static double Asin(double x)
    {
        if (double.IsNaN(x)) return double.NaN;
        double sign = x < 0 ? -1 : 1;
        double a = System.Math.Abs(x);
        if (a > 1) return double.NaN;
        if (a == 1) return sign * PiOver2;
        if (a <= 0.5) return sign * AsinSmall(a);
        return sign * (PiOver2 - (2 * AsinSmall(System.Math.Sqrt((1 - a) / 2))));
    }

    /// <summary>
    /// <c>acos(x)</c> — the arccosine, in radians, over [−1, 1].
    ///
    /// <para>Not π/2 − asin(x) everywhere: near x = 1 the answer approaches zero, and that
    /// subtraction would compute it as the difference of two numbers that are nearly π/2,
    /// throwing away every digit that matters.</para>
    /// </summary>
    public static double Acos(double x)
    {
        if (double.IsNaN(x)) return double.NaN;
        if (x > 1 || x < -1) return double.NaN;
        if (x == 1) return 0;
        if (x == -1) return Pi;
        if (x >= 0.5) return 2 * AsinSmall(System.Math.Sqrt((1 - x) / 2));
        if (x <= -0.5) return Pi - (2 * AsinSmall(System.Math.Sqrt((1 + x) / 2)));
        return PiOver2 - (AsinSmall(System.Math.Abs(x)) * (x < 0 ? -1 : 1));
    }

    /// <summary><c>sinh(x)</c> — below a half the exponential route would cancel the answer away.</summary>
    public static double Sinh(double x)
    {
        if (double.IsNaN(x) || double.IsInfinity(x)) return x;
        double a = System.Math.Abs(x);
        if (a < 0.5) return x * Horner(SinhCoeff, x * x);
        double sign = x < 0 ? -1 : 1;
        // Past this point e^x overflows but sinh(x) still fits, so the halving is
        // folded into the exponent rather than applied after it.
        if (a > 709) return sign * Exp(a - Ln2);
        double t = Exp(a);
        return sign * (t - (1 / t)) / 2;
    }

    /// <summary><c>cosh(x)</c> — a sum rather than a difference, so nothing cancels.</summary>
    public static double Cosh(double x)
    {
        if (double.IsNaN(x)) return double.NaN;
        if (double.IsInfinity(x)) return double.PositiveInfinity;
        double a = System.Math.Abs(x);
        if (a < 0.5) return Horner(CoshCoeff, x * x);
        if (a > 709) return Exp(a - Ln2);
        double t = Exp(a);
        return (t + (1 / t)) / 2;
    }

    /// <summary>
    /// <c>tanh(x)</c> — past 20 the true value is within 10⁻¹⁷ of 1, closer than the next double,
    /// so the answer is 1 and computing e⁴⁰ to discover that would be waste.
    /// </summary>
    public static double Tanh(double x)
    {
        if (double.IsNaN(x)) return double.NaN;
        double sign = x < 0 ? -1 : 1;
        if (double.IsInfinity(x)) return sign;
        double a = System.Math.Abs(x);
        if (a > 20) return sign;
        if (a < 0.5)
        {
            double z = x * x;
            return x * Horner(SinhCoeff, z) / Horner(CoshCoeff, z);
        }
        double u = Exp(2 * a);
        return sign * (u - 1) / (u + 1);
    }

    /// <summary>
    /// <c>cbrt(x)</c> — the cube root, defined for negatives too.
    ///
    /// <para><c>Pow(x, 1/3)</c> is not the same function: one third is not a double, and a
    /// negative base with a fractional exponent has no real answer at all. So this is its own
    /// function, reduced by powers of eight — exact, being powers of two — and then refined by
    /// Newton's method.</para>
    /// </summary>
    public static double Cbrt(double x)
    {
        if (double.IsNaN(x) || double.IsInfinity(x) || x == 0) return x;
        double sign = x < 0 ? -1 : 1;
        double a = System.Math.Abs(x);
        long e = 0;
        while (a >= 8)
        {
            a /= 8;
            e += 1;
        }
        while (a < 1)
        {
            a *= 8;
            e -= 1;
        }
        // A straight line through the ends of [1, 8): within 11% everywhere, which
        // six Newton passes take past the last bit.
        double y = 1 + ((a - 1) / 7);
        for (int i = 0; i < 6; i += 1)
        {
            y = ((2 * y) + (a / (y * y))) / 3;
        }
        return sign * ScaleByPowerOfTwo(y, e);
    }

    // ── The third wave: the shapes that exist to avoid cancellation ──────────
    //
    // Expm1 and Log1p are not conveniences. Near zero, exp(x) − 1 and log(1 + x)
    // each throw away most of their answer to a subtraction or to a rounding
    // that happens before the function is even called — and these two are what
    // the inverse hyperbolics are built from, which is why they come first.

    /// <summary>
    /// <c>expm1(x)</c> — eˣ − 1, computed so that small x keeps its digits.
    ///
    /// <para><c>Exp(0.0000001) - 1</c> in plain arithmetic is a subtraction of two numbers that
    /// agree to seven places, and most of the answer dies in it.</para>
    /// </summary>
    public static double Expm1(double x)
    {
        if (double.IsNaN(x)) return double.NaN;
        if (System.Math.Abs(x) < 0.5) return x * Horner(Expm1Coeff, x);
        return Exp(x) - 1;
    }

    /// <summary>
    /// <c>log1p(x)</c> — log(1 + x), computed so that small x keeps its digits.
    ///
    /// <para>The loss here happens before the logarithm is reached: <c>1 + 1e-20</c> IS 1 as a
    /// double, so <c>Log(1 + x)</c> returns zero for every x under 1e-16. Reducing instead to
    /// 2·atanh(x/(2+x)) never forms 1 + x at all.</para>
    /// </summary>
    public static double Log1p(double x)
    {
        if (double.IsNaN(x) || x < -1) return double.NaN;
        if (x == -1) return double.NegativeInfinity;
        if (double.IsPositiveInfinity(x)) return double.PositiveInfinity;
        // Past a half, 1 + x has nothing left to lose and the direct route is
        // both shorter and better conditioned.
        if (System.Math.Abs(x) >= 0.5) return Log(1 + x);
        double s = x / (2 + x);
        return 2 * s * AtanhSeries(s * s, 39);
    }

    /// <summary>
    /// <c>log2(x)</c>.
    ///
    /// <para>Not <c>Log(x) / ln2</c>: that would make <c>Log2(8)</c> come out 2.9999999999999996,
    /// and a power of two is precisely the argument someone passes to Log2. The exponent is
    /// separated first.</para>
    /// </summary>
    public static double Log2(double x)
    {
        if (double.IsNaN(x) || x < 0) return double.NaN;
        if (x == 0) return double.NegativeInfinity;
        if (double.IsPositiveInfinity(x)) return double.PositiveInfinity;
        double m = x;
        double e = 0;
        while (m >= 1.4142135623730951)
        {
            m /= 2;
            e += 1;
        }
        while (m < 0.7071067811865476)
        {
            m *= 2;
            e -= 1;
        }
        if (m == 1) return e;
        return e + (Log(m) / Ln2);
    }

    /// <summary>
    /// <c>hypot(x, y)</c> — the length of the vector, without an intermediate that overflows.
    ///
    /// <para><c>Sqrt(x*x + y*y)</c> is the definition and the wrong implementation: for x = 1e200
    /// the square overflows to infinity and the answer comes back infinite, though it is perfectly
    /// representable. Factoring the larger side out first keeps every intermediate near 1.</para>
    /// </summary>
    public static double Hypot(double x, double y)
    {
        // An infinite side wins even against a NaN on the other, which is what
        // IEEE-754 recommends: the length is infinite whatever the other side is.
        if (double.IsInfinity(x) || double.IsInfinity(y)) return double.PositiveInfinity;
        if (double.IsNaN(x) || double.IsNaN(y)) return double.NaN;
        double a = System.Math.Abs(x);
        double b = System.Math.Abs(y);
        if (a < b)
        {
            (a, b) = (b, a);
        }
        if (a == 0) return 0;
        double ratio = b / a;
        return a * System.Math.Sqrt(1 + (ratio * ratio));
    }

    /// <summary><c>sign(x)</c> — −1, 0 or 1. Exact: there is nothing here to round.</summary>
    public static double Sign(double x)
    {
        if (double.IsNaN(x)) return double.NaN;
        if (x > 0) return 1;
        if (x < 0) return -1;
        return 0;
    }

    /// <summary>
    /// <c>asinh(x)</c> — the inverse hyperbolic sine, over the whole real line.
    ///
    /// <para>log(x + sqrt(x² + 1)) is the textbook form and cancels for small x. Rewriting the
    /// argument as x + x²/(1 + sqrt(1 + x²)) leaves Log1p a number near x rather than near 1.</para>
    /// </summary>
    public static double Asinh(double x)
    {
        if (double.IsNaN(x) || double.IsInfinity(x)) return x;
        double sign = x < 0 ? -1 : 1;
        double a = System.Math.Abs(x);
        // Past this, a² would overflow while asinh(a) is still a small number; up
        // there sqrt(1 + a²) is a to every bit, so the answer is log(2a).
        if (a > 1e150) return sign * (Log(a) + Ln2);
        return sign * Log1p(a + ((a * a) / (1 + System.Math.Sqrt(1 + (a * a)))));
    }

    /// <summary>
    /// <c>acosh(x)</c> — the inverse hyperbolic cosine, defined for x ≥ 1.
    ///
    /// <para>Written around t = x − 1, which is exact for the x near 1 where the answer approaches
    /// zero and the textbook form loses it.</para>
    /// </summary>
    public static double Acosh(double x)
    {
        if (double.IsNaN(x)) return double.NaN;
        if (x < 1) return double.NaN;
        if (x == 1) return 0;
        if (double.IsPositiveInfinity(x)) return double.PositiveInfinity;
        if (x > 1e150) return Log(x) + Ln2;
        double t = x - 1;
        return Log1p(t + System.Math.Sqrt((2 * t) + (t * t)));
    }

    /// <summary>
    /// <c>atanh(x)</c> — the inverse hyperbolic tangent, over (−1, 1).
    ///
    /// <para>½·log((1+x)/(1−x)) forms a ratio near 1 for small x and loses it. The same ratio
    /// written as 1 + 2x/(1−x) hands Log1p the small part directly.</para>
    /// </summary>
    public static double Atanh(double x)
    {
        if (double.IsNaN(x)) return double.NaN;
        if (x > 1 || x < -1) return double.NaN;
        if (x == 1) return double.PositiveInfinity;
        if (x == -1) return double.NegativeInfinity;
        // The identity is only well-conditioned on the positive side. Fed
        // x = -0.999999 directly it hands Log1p an argument of -0.9999995, which
        // is the very cancellation Log1p exists to avoid — and the answer came
        // back 37618 ulp wrong. Folding to |x| first keeps that argument positive.
        double sign = x < 0 ? -1 : 1;
        double a = System.Math.Abs(x);
        return sign * 0.5 * Log1p((2 * a) / (1 - a));
    }

    // ── The fourth wave: statistics ──────────────────────────────────────────
    //
    // Erf, Erfc, Gamma and Lgamma. These are the first functions here whose
    // accuracy is bounded by something other than the series that computes
    // them, and each one says so where it lives.

    private const double TwoOverSqrtPi = 1.1283791670955126;
    private const double OneOverSqrtPi = 0.5641895835477563;
    private const double LogSqrt2Pi = 0.9189385332046728;
    private const double Sqrt2Pi = 2.5066282746310002;

    /// <summary>2²⁷ + 1 — Dekker's splitting constant.</summary>
    private const double Split = 134217729;

    /// <summary>Taylor coefficients for erf(x)·√π/2 over x², ascending.</summary>
    private static readonly double[] ErfCoeff =
    {
        1.0,
        -1.0 / 3.0,
        1.0 / 10.0,
        -1.0 / 42.0,
        1.0 / 216.0,
        -1.0 / 1320.0,
        1.0 / 9360.0,
        -1.0 / 75600.0,
        1.0 / 685440.0,
        -1.0 / 6894720.0,
        1.0 / 76204800.0,
        -1.0 / 918086400.0,
        1.0 / 11975040000.0,
        -1.0 / 168129561600.0,
        1.0 / 2528170444800.0,
        -1.0 / 40537905525000.0,
        1.0 / 691118486016000.0,
        -1.0 / 12460033493760000.0,
    };

    /// <summary>How deep the continued fraction for Erfc runs.</summary>
    private const int ErfcDepth = 200;

    /// <summary>Lanczos coefficients, g = 7, n = 9 — the classic set.</summary>
    private static readonly double[] Lanczos =
    {
        0.99999999999980993,
        676.5203681218851,
        -1259.1392167224028,
        771.32342877765313,
        -176.61502916214059,
        12.507343278686905,
        -0.13857109526572012,
        9.9843695780195716e-6,
        1.5056327351493116e-7,
    };

    /// <summary>
    /// <c>e^(−x²)</c>, computed so the rounding of x² never reaches the exponent.
    ///
    /// <para>This is the whole accuracy story for Erfc. Squaring x rounds by about x²·2⁻⁵³; Exp
    /// then turns that ABSOLUTE error in its argument into a RELATIVE error in its answer, so at
    /// x = 23 the result drifts by about 6e-14 — four hundred ulp. Measured before this existed:
    /// 445 ulp. After: 5. The high part keeps 26 significant bits, so its square needs 52 and is
    /// exact.</para>
    /// </summary>
    private static double ExpNegSquare(double x)
    {
        double s = Split * x;
        double hi = s - (s - x);
        double lo = x - hi;
        return Exp(-hi * hi) * (1 + Expm1(-((2 * hi * lo) + (lo * lo))));
    }

    /// <summary>Erf on [0, 1] — no exponential involved, so nothing amplifies.</summary>
    private static double ErfSmall(double x) => TwoOverSqrtPi * x * Horner(ErfCoeff, x * x);

    /// <summary>
    /// Erfc for x &gt; 1, by continued fraction. Two hundred levels rather than a convergence
    /// test: a FIXED depth is one less thing for five implementations to agree about. The depth is
    /// set by the slowest point, just above x = 1, where 100 levels leave 29645 ulp and 200 leave 5.
    /// </summary>
    private static double ErfcLarge(double x)
    {
        double f = 0;
        for (int k = ErfcDepth; k >= 1; k -= 1)
        {
            f = k / 2.0 / (x + f);
        }
        return OneOverSqrtPi * ExpNegSquare(x) / (x + f);
    }

    /// <summary>
    /// <c>erf(x)</c> — the error function. Below 1 the series is used directly; above it,
    /// <c>1 − erfc(x)</c>, because there erfc is the small quantity.
    /// </summary>
    public static double Erf(double x)
    {
        if (double.IsNaN(x)) return double.NaN;
        double sign = x < 0 ? -1 : 1;
        double a = System.Math.Abs(x);
        if (double.IsInfinity(a)) return sign;
        if (a <= 1) return sign * ErfSmall(a);
        return sign * (1 - ErfcLarge(a));
    }

    /// <summary>
    /// <c>erfc(x)</c> — the complement, and not computed as 1 − erf past 1. At x = 5 the true
    /// value is 1.5e-12 and the subtraction keeps only six of its twelve digits; by x = 6 erf has
    /// rounded to 1 and the answer is gone entirely.
    /// </summary>
    public static double Erfc(double x)
    {
        if (double.IsNaN(x)) return double.NaN;
        if (double.IsPositiveInfinity(x)) return 0;
        if (double.IsNegativeInfinity(x)) return 2;
        if (x < 0) return 2 - Erfc(-x);
        if (x <= 1) return 1 - ErfSmall(x);
        return ErfcLarge(x);
    }

    /// <summary>
    /// <c>sin(πx)</c>, taken from the distance to the nearest whole number.
    ///
    /// <para>The reflection formula for Γ needs this near the integers, where sin(πx) approaches
    /// zero. Computing Sin(Pi * x) directly puts the rounding of Pi * x — absolute, and growing
    /// with x — right next to a zero: at x = −4.00006 the answer came out 28582 ulp wrong.</para>
    /// </summary>
    private static double SinPi(double x)
    {
        double n = System.Math.Floor(x + 0.5);
        double r = x - n;
        double s = Sin(Pi * r);
        return (long)n % 2 == 0 ? s : -s;
    }

    private static double LanczosSum(double z)
    {
        double a = Lanczos[0];
        for (int i = 1; i < 9; i += 1)
        {
            a += Lanczos[i] / (z + i);
        }
        return a;
    }

    /// <summary>
    /// <c>lgamma(x)</c> — the natural logarithm of |Γ(x)|.
    ///
    /// <para>Away from x = 1 and x = 2 it is within 32 ulp. AT those two points lgamma is ZERO,
    /// and a relative bound there is not a statement about this code — no method that sums terms
    /// of size 1 can be relatively accurate about their cancelling to nothing. What holds is the
    /// ABSOLUTE error, measured under 1e-13 on a bounded range.</para>
    /// </summary>
    public static double Lgamma(double x)
    {
        if (double.IsNaN(x)) return double.NaN;
        if (double.IsPositiveInfinity(x)) return double.PositiveInfinity;
        // The poles: every whole number at or below zero.
        if (x <= 0 && x == System.Math.Truncate(x)) return double.PositiveInfinity;
        if (x < 0.5) return Log(Pi / System.Math.Abs(SinPi(x))) - Lgamma(1 - x);
        double z = x - 1;
        double t = z + 7.5;
        return LogSqrt2Pi + ((z + 0.5) * Log(t)) - t + Log(LanczosSum(z));
    }

    /// <summary>
    /// <c>gamma(x)</c> — the factorial extended to the reals.
    ///
    /// <para>Γ of a whole number is a factorial, and multiplying it out is exact for the first
    /// twenty-three and within 7 ulp for all 171 that fit in a double. The general route ends in
    /// an exponential, and Exp turns the absolute error of its argument into a relative error of
    /// its answer, so the drift grows with log Γ(x) — about 2000 ulp near x = 146.</para>
    /// </summary>
    public static double Gamma(double x)
    {
        if (double.IsNaN(x)) return double.NaN;
        if (double.IsPositiveInfinity(x)) return double.PositiveInfinity;
        if (double.IsNegativeInfinity(x)) return double.NaN;
        // Every whole number at or below zero is a pole, with no value to give.
        if (x <= 0 && x == System.Math.Truncate(x)) return double.NaN;
        if (x == System.Math.Truncate(x) && x >= 1 && x <= 171)
        {
            double result = 1;
            for (double k = 2; k < x; k += 1)
            {
                result *= k;
            }
            return result;
        }
        if (x < 0.5) return Pi / (SinPi(x) * Gamma(1 - x));
        double z = x - 1;
        double t = z + 7.5;
        // One exponential rather than t^(z+0.5) · e^(−t): that product overflows
        // on its first factor near x = 150, while Γ(x) is still finite to 171.
        return Sqrt2Pi * LanczosSum(z) * Exp(((z + 0.5) * Log(t)) - t);
    }

    // ── The fifth wave: what was left ────────────────────────────────────────
    //
    // Two conversions, and three functions each defined in terms of what came
    // before.

    private const double DegreesPerRadian = 57.29577951308232;
    private const double RadiansPerDegree = 0.017453292519943295;

    /// <summary>
    /// Asymptotic coefficients for digamma, ascending in 1/x²: −B₂ₖ/(2k). The series is
    /// asymptotic, not convergent — adding terms forever makes it worse, not better.
    /// </summary>
    private static readonly double[] DigammaCoeff =
    {
        -1.0 / 12.0,
        1.0 / 120.0,
        -1.0 / 252.0,
        1.0 / 240.0,
        -1.0 / 132.0,
        691.0 / 32760.0,
        -1.0 / 12.0,
        3617.0 / 8160.0,
    };

    /// <summary>
    /// Where the recurrence stops shifting. Ten, and larger is WORSE: each step of
    /// ψ(x) = ψ(x+1) − 1/x adds its own rounding. Measured against the exact value at whole
    /// numbers — ψ(n) = −γ + H(n−1) — ten gives 3 ulp, fourteen gives 12.
    /// </summary>
    private const double DigammaShift = 10;

    /// <summary>B₂ₖ/(2k)! for k = 1…7 — the Euler–Maclaurin tail for ζ.</summary>
    private static readonly double[] ZetaBernoulli =
    {
        1.0 / 12.0,
        -1.0 / 720.0,
        1.0 / 30240.0,
        -1.0 / 1209600.0,
        1.0 / 47900160.0,
        -691.0 / 1307674368000.0,
        1.0 / 74724249600.0,
    };

    private const int ZetaTerms = 12;
    private const int ZetaCorrections = 6;

    /// <summary>
    /// <c>degrees(x)</c> — one multiplication, so all five agree trivially. It exists because
    /// every circular function here takes radians and says so.
    /// </summary>
    public static double Degrees(double x) => x * DegreesPerRadian;

    /// <summary><c>radians(x)</c> — the other direction, same single rounding.</summary>
    public static double Radians(double x) => x * RadiansPerDegree;

    /// <summary>
    /// <c>beta(a, b)</c> — the Euler beta function, Γ(a)Γ(b)/Γ(a+b).
    ///
    /// <para>Taken directly from the gammas while they fit. Past a+b = 171 the numerator
    /// overflows although the answer is small — beta SHRINKS as its arguments grow — so up there
    /// it goes through logarithms.</para>
    /// </summary>
    public static double Beta(double a, double b)
    {
        if (double.IsNaN(a) || double.IsNaN(b)) return double.NaN;
        if (a > 0 && b > 0 && a + b > 171)
        {
            return Exp(Lgamma(a) + Lgamma(b) - Lgamma(a + b));
        }
        return Gamma(a) * Gamma(b) / Gamma(a + b);
    }

    /// <summary>
    /// <c>digamma(x)</c> — the derivative of log Γ(x). Small arguments are lifted by the
    /// recurrence until the asymptotic series is usable; negatives come back through the
    /// reflection ψ(1−x) − ψ(x) = π·cot(πx).
    /// </summary>
    public static double Digamma(double x)
    {
        if (double.IsNaN(x)) return double.NaN;
        if (double.IsPositiveInfinity(x)) return double.PositiveInfinity;
        // Every whole number at or below zero is a pole, as it is for Γ itself.
        if (x <= 0 && x == System.Math.Truncate(x)) return double.NaN;
        if (x < 0.5) return Digamma(1 - x) - (Pi / Tan(Pi * x));
        double shifted = x;
        double correction = 0;
        while (shifted < DigammaShift)
        {
            correction -= 1 / shifted;
            shifted += 1;
        }
        double f = 1 / (shifted * shifted);
        return correction + Log(shifted) - (0.5 / shifted) + (f * Horner(DigammaCoeff, f));
    }

    /// <summary>ζ(s) for s &gt; 1, by Euler–Maclaurin.</summary>
    private static double ZetaSum(double s)
    {
        double total = 0;
        for (int n = 1; n < ZetaTerms; n += 1)
        {
            total += Pow(n, -s);
        }
        double tail = Pow(ZetaTerms, -s);
        total += (tail / 2) + (ZetaTerms * tail / (s - 1));
        // Then the Bernoulli corrections, each a rising factorial over a growing power.
        double rising = s;
        double power = tail / ZetaTerms;
        for (int k = 1; k <= ZetaCorrections; k += 1)
        {
            total += ZetaBernoulli[k - 1] * rising * power;
            rising *= (s + (2 * k) - 1) * (s + (2 * k));
            power /= (double)ZetaTerms * ZetaTerms;
        }
        return total;
    }

    /// <summary>
    /// <c>zeta(s)</c> — the Riemann zeta function, for real s.
    ///
    /// <para>Above 1 the sum converges and Euler–Maclaurin makes twelve terms behave like
    /// thousands. Below it the functional equation reflects the argument across s = ½, which is
    /// why this needs Γ and Sin. ζ(1) is the pole; ζ(0) is −½, which the reflection cannot give
    /// because it meets 0 · ∞ there.</para>
    /// </summary>
    public static double Zeta(double s)
    {
        if (double.IsNaN(s)) return double.NaN;
        if (s == 1) return double.PositiveInfinity;
        if (s == 0) return -0.5;
        if (s > 1) return ZetaSum(s);
        return Pow(2, s) * Pow(Pi, s - 1) * Sin(Pi * s / 2) * Gamma(1 - s) * ZetaSum(1 - s);
    }
}
