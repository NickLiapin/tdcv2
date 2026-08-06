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
    private const double Ln2Hi = 0.6931471803691238;
    private const double Ln2Lo = 1.9082149292705877e-10;
    private const double Ln2 = 0.6931471805599453;

    // pi/2 in three pieces: a single rounded pi/2 loses most of the significant
    // digits of sin(1000) before the series starts.
    private const double PiOver2 = 1.5707963267948966;
    private const double PiOver2A = 1.5707963267341256;
    private const double PiOver2B = 6.077100506506192e-11;
    private const double PiOver2C = 2.0222662487959506e-21;

    private static readonly double[] SinCoeff =
    {
        -1.0 / 6.0,
        1.0 / 120.0,
        -1.0 / 5040.0,
        1.0 / 362880.0,
        -1.0 / 39916800.0,
        1.0 / 6227020800.0,
        -1.0 / 1307674368000.0,
    };

    private static readonly double[] CosCoeff =
    {
        -1.0 / 2.0,
        1.0 / 24.0,
        -1.0 / 720.0,
        1.0 / 40320.0,
        -1.0 / 3628800.0,
        1.0 / 479001600.0,
        -1.0 / 87178291200.0,
    };

    private const double ExpOverflow = 709.782712893384;
    private const double ExpUnderflow = -745.1332191019411;

    /// <summary>
    /// Delegated: IEEE-754 requires square root to be correctly rounded, so there is one legal
    /// answer and every implementation must give it.
    /// </summary>
    public static double Sqrt(double x)
    {
        if (double.IsNaN(x) || x < 0) return double.NaN;
        return System.Math.Sqrt(x);
    }

    /// <summary><c>value * 2^n</c> by exact doubling — a power of two is exact in binary.</summary>
    private static double ScaleByPowerOfTwo(double value, long n)
    {
        double outValue = value;
        long k = n;
        while (k > 0)
        {
            outValue *= 2;
            k -= 1;
        }
        while (k < 0)
        {
            outValue /= 2;
            k += 1;
        }
        return outValue;
    }

    /// <summary><c>exp(x)</c> — range-reduced to 2^k * e^r with |r| &lt;= ln2/2, then Taylor.</summary>
    public static double Exp(double x)
    {
        if (double.IsNaN(x)) return double.NaN;
        if (x > ExpOverflow) return double.PositiveInfinity;
        if (x < ExpUnderflow) return 0;
        double k = System.Math.Truncate((x / Ln2) + (x >= 0 ? 0.5 : -0.5));
        double r = x - (k * Ln2Hi) - (k * Ln2Lo);
        double term = 1;
        double sum = 1;
        for (int i = 1; i <= 13; i += 1)
        {
            term = term * r / i;
            sum += term;
        }
        return ScaleByPowerOfTwo(sum, (long)k);
    }

    /// <summary><c>log(x)</c> — x = m * 2^e by exact halving, then 2*atanh((m-1)/(m+1)).</summary>
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
        double s2 = s * s;
        double sum = 0;
        for (int i = 25; i >= 1; i -= 2)
        {
            sum = (sum * s2) + (1.0 / i);
        }
        return (2 * s * sum) + (e * Ln2Hi) + (e * Ln2Lo);
    }

    public static double Log10(double x) => Log(x) / 2.302585092994046;

    /// <summary>The quadrant (0-3) and the remainder in [-pi/4, pi/4].</summary>
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
        double sum = 0;
        for (int i = SinCoeff.Length - 1; i >= 0; i -= 1)
        {
            sum = (sum * z) + SinCoeff[i];
        }
        return r + (r * z * sum);
    }

    private static double CosCore(double r)
    {
        double z = r * r;
        double sum = 0;
        for (int i = CosCoeff.Length - 1; i >= 0; i -= 1)
        {
            sum = (sum * z) + CosCoeff[i];
        }
        return 1 + (z * sum);
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

    /// <summary>
    /// An integer exponent goes through repeated squaring, so <c>pow(10, 3)</c> is exactly 1000
    /// rather than 999.9999999999998.
    /// </summary>
    public static double Pow(double x, double y)
    {
        if (double.IsNaN(y)) return double.NaN;
        if (y == 0) return 1;
        if (double.IsNaN(x)) return double.NaN;
        if (y == System.Math.Truncate(y) && !double.IsInfinity(y) && System.Math.Abs(y) <= 1024)
        {
            double result = 1;
            double baseValue = y < 0 ? 1 / x : x;
            long n = (long)System.Math.Abs(y);
            while (n > 0)
            {
                if (n % 2 == 1) result *= baseValue;
                baseValue *= baseValue;
                n /= 2;
            }
            return result;
        }
        if (x < 0) return double.NaN;
        if (x == 0) return y > 0 ? 0 : double.PositiveInfinity;
        return Exp(y * Log(x));
    }
}
