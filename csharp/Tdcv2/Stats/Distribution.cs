using System.Text;
using System.Globalization;

namespace Tdcv2.Stats;

/// <summary>
/// Named statistical distributions for <c>&lt;gen type="number" distribution="..."/&gt;</c>.
/// </summary>
/// <remarks>
/// <para>
/// A column drawn from a distribution looks like real data. Heights are normal, incomes are
/// lognormal, waiting times are exponential, word frequencies are Zipf — and a uniform range over
/// the same interval looks like none of them, which is exactly what makes uniform test data feel
/// wrong to anyone who knows the domain.
/// </para>
/// <para>Two rules hold across every distribution here, and both keep a row computable from its index:</para>
/// <list type="bullet">
///   <item>
///     <b>A fixed number of draws.</b> Inverse-CDF or Box–Muller only, never rejection sampling.
///     Rejection sampling consumes a variable number of uniforms, which would make each row depend
///     on all the rows before it.
///   </item>
///   <item>
///     <b>No dependency.</b> The arithmetic is written out here, so the numbers are the same in
///     every language rather than the same as whatever library each language happened to pick.
///   </item>
/// </list>
/// </remarks>
public static class Distribution
{
    /// <summary><c>e^-lambda</c> underflows to zero past about 745, which would break the recurrence.</summary>
    private const double PoissonMaxLambda = 700;

    private const long ZipfMaxN = 10_000_000L;

    public sealed record Spec(
        string Name,
        int Draws,
        int Decimals,
        double? Min,
        double? Max,
        IReadOnlyDictionary<string, double> Params,
        double[]? Table);

    /// <summary>How many uniforms <see cref="Sample"/> needs, and with what parameters.</summary>
    public static Spec Parse(IReadOnlyDictionary<string, string> attrs)
    {
        string? name = attrs.GetValueOrDefault("distribution");
        int decimals = Decimals(attrs.GetValueOrDefault("decimals"));
        double? min = Optional(attrs.GetValueOrDefault("min"), "min");
        double? max = Optional(attrs.GetValueOrDefault("max"), "max");
        if (min is not null && max is not null && min > max)
        {
            throw new ArgumentException($"distribution: min ({min}) must be <= max ({max})");
        }

        string dist = name ?? "null";
        return dist switch
        {
            "normal" => new Spec(dist, 2, decimals, min, max, new Dictionary<string, double>
            {
                ["mean"] = Required(attrs, "mean", dist),
                ["sd"] = Positive(attrs, "sd", dist),
            }, null),
            "lognormal" => new Spec(dist, 2, decimals, min, max, new Dictionary<string, double>
            {
                ["meanlog"] = Required(attrs, "meanlog", dist),
                ["sdlog"] = Positive(attrs, "sdlog", dist),
            }, null),
            "exponential" => new Spec(dist, 1, decimals, min, max, new Dictionary<string, double>
            {
                ["rate"] = Positive(attrs, "rate", dist),
            }, null),
            "pareto" => new Spec(dist, 1, decimals, min, max, new Dictionary<string, double>
            {
                ["alpha"] = Positive(attrs, "alpha", dist),
                ["xmin"] = Positive(attrs, "xmin", dist),
            }, null),
            "weibull" => new Spec(dist, 1, decimals, min, max, new Dictionary<string, double>
            {
                ["shape"] = Positive(attrs, "shape", dist),
                ["scale"] = Positive(attrs, "scale", dist),
            }, null),
            "gamma" => new Spec(dist, 1, decimals, min, max, new Dictionary<string, double>
            {
                ["shape"] = Positive(attrs, "shape", dist),
                ["scale"] = Positive(attrs, "scale", dist),
            }, null),
            "beta" => new Spec(dist, 1, decimals, min, max, new Dictionary<string, double>
            {
                ["alpha"] = Positive(attrs, "alpha", dist),
                ["beta"] = Positive(attrs, "beta", dist),
            }, null),
            "poisson" => PoissonSpec(attrs, dist, decimals, min, max),
            "zipf" => ZipfSpec(attrs, dist, decimals, min, max),
            _ => throw new ArgumentException(
                $"distribution: unknown distribution \"{dist}\" — expected normal, lognormal, "
                + "exponential, pareto, weibull, poisson, zipf, gamma, or beta"),
        };
    }

    private static Spec PoissonSpec(
        IReadOnlyDictionary<string, string> attrs, string dist, int decimals, double? min, double? max)
    {
        double lambda = Positive(attrs, "lambda", dist);
        return new Spec(dist, 1, decimals, min, max,
            new Dictionary<string, double> { ["lambda"] = lambda }, PoissonCdf(lambda));
    }

    private static Spec ZipfSpec(
        IReadOnlyDictionary<string, string> attrs, string dist, int decimals, double? min, double? max)
    {
        double n = PositiveInteger(attrs, "n", dist);
        double s = Positive(attrs, "s", dist);
        return new Spec(dist, 1, decimals, min, max,
            new Dictionary<string, double> { ["n"] = n, ["s"] = s }, ZipfCumulative((int)n, s));
    }

    /// <summary>
    /// The raw value, from uniforms already in the open interval (0,1).
    /// </summary>
    /// <remarks>Clipping and rounding happen in <see cref="Format"/>.</remarks>
    public static double Sample(Spec spec, double[] uniforms)
    {
        double u1 = uniforms.Length > 0 ? uniforms[0] : 0;
        double u2 = uniforms.Length > 1 ? uniforms[1] : 0;
        IReadOnlyDictionary<string, double> p = spec.Params;
        return spec.Name switch
        {
            "normal" => p["mean"] + (p["sd"] * BoxMuller(u1, u2)),
            "lognormal" => Math.Exp(p["meanlog"] + (p["sdlog"] * BoxMuller(u1, u2))),
            "exponential" => -Math.Log(u1) / p["rate"],
            "pareto" => p["xmin"] * Math.Pow(1 - u1, -1 / p["alpha"]),
            "weibull" => p["scale"] * Math.Pow(-Math.Log(u1), 1 / p["shape"]),
            // The smallest count k where P(X <= k) >= u.
            "poisson" => LowerBound(spec.Table!, u1),
            // Ranks are 1-based.
            "zipf" => LowerBound(spec.Table!, u1) + 1,
            "gamma" => p["scale"] * Special.GammaPInv(p["shape"], u1),
            "beta" => Special.BetaIInv(p["alpha"], p["beta"], u1),
            _ => throw new InvalidOperationException($"distribution: unhandled {spec.Name}"),
        };
    }

    public static string Format(double x, Spec spec)
    {
        double v = x;
        if (spec.Min is not null)
        {
            v = Math.Max(spec.Min.Value, v);
        }

        if (spec.Max is not null)
        {
            v = Math.Min(spec.Max.Value, v);
        }

        return ToFixed(v, spec.Decimals);
    }

    /// <summary>
    /// JavaScript's <c>Number.prototype.toFixed</c>, which is what every implementation matches.
    /// </summary>
    /// <remarks>
    /// <para>NOT .NET's <c>"F"</c> format, which rounds a tie to the EVEN digit: 20.5 comes out
    /// 20 there and 21 in the reference. On a swept quantile column, where exact halves are
    /// common rather than rare, that put a wrong number in one cell in twenty.</para>
    ///
    /// <para>The digits are expanded EXACTLY before the rounding decision is made, so a value
    /// that merely prints like a tie is told apart from one that is a tie. A double is
    /// <c>m × 2^e</c>; for <c>e &lt; 0</c> that is <c>m × 5^|e| / 10^|e|</c>, so multiplying the
    /// mantissa by five <c>|e|</c> times gives the whole expansion.</para>
    /// </remarks>
    public static string ToFixed(double value, int decimals)
    {
        if (double.IsNaN(value) || double.IsInfinity(value) || Math.Abs(value) >= 1e21)
        {
            return value.ToString("R", CultureInfo.InvariantCulture);
        }

        // The sign comes from the INPUT, not from the result: `(-0.0001).toFixed(2)` is
        // `"-0.00"`, a signed zero that says the value was below it. `-0` itself gets none, and
        // that falls out of `value < 0` being false for negative zero — in C# as in JavaScript.
        bool negative = value < 0;
        List<byte> digits = ExactDigits(Math.Abs(value), out int point);
        RoundHalfUp(digits, point, decimals);

        // Rounding may have carried into a new leading digit, so the point is read back from the
        // length rather than remembered.
        point = digits.Count - decimals;
        string whole = string.Concat(digits.Take(point).Select(d => (char)('0' + d))).TrimStart('0');
        var text = new StringBuilder();
        if (negative)
        {
            text.Append('-');
        }

        text.Append(whole.Length == 0 ? "0" : whole);
        if (decimals > 0)
        {
            text.Append('.');
            foreach (byte d in digits.Skip(point))
            {
                text.Append((char)('0' + d));
            }
        }

        return text.ToString();
    }

    /// <summary>The exact decimal digits of a non-negative finite double, big-endian.</summary>
    /// <param name="point">How many of the digits sit before the decimal point.</param>
    private static List<byte> ExactDigits(double value, out int point)
    {
        long bits = BitConverter.DoubleToInt64Bits(value);
        int rawExponent = (int)((bits >> 52) & 0x7FF);
        long rawMantissa = bits & 0x000F_FFFF_FFFF_FFFF;
        // Subnormal: no implicit leading one, and a fixed exponent.
        long mantissa = rawExponent == 0 ? rawMantissa : rawMantissa | 0x0010_0000_0000_0000;
        int exponent = rawExponent == 0 ? -1074 : rawExponent - 1075;

        var digits = mantissa == 0
            ? new List<byte> { 0 }
            : mantissa.ToString(CultureInfo.InvariantCulture)
                .Select(c => (byte)(c - '0')).ToList();

        if (exponent >= 0)
        {
            for (int i = 0; i < exponent; i++)
            {
                MultiplySmall(digits, 2);
            }

            point = digits.Count;
            return digits;
        }

        int fractional = -exponent;
        for (int i = 0; i < fractional; i++)
        {
            MultiplySmall(digits, 5);
        }

        // Left-pad so there are at least `fractional` digits after the point.
        while (digits.Count <= fractional)
        {
            digits.Insert(0, 0);
        }

        point = digits.Count - fractional;
        return digits;
    }

    /// <summary>Multiply a big-endian decimal digit list by a single digit.</summary>
    private static void MultiplySmall(List<byte> digits, int factor)
    {
        int carry = 0;
        for (int i = digits.Count - 1; i >= 0; i--)
        {
            int v = (digits[i] * factor) + carry;
            digits[i] = (byte)(v % 10);
            carry = v / 10;
        }

        while (carry > 0)
        {
            digits.Insert(0, (byte)(carry % 10));
            carry /= 10;
        }
    }

    /// <summary>Cut the expansion to <paramref name="decimals"/> places, ties away from zero.</summary>
    /// <remarks>The sign was taken off before this, so "away from zero" is simply "up".</remarks>
    private static void RoundHalfUp(List<byte> digits, int point, int decimals)
    {
        int keep = point + decimals;
        if (digits.Count <= keep)
        {
            // Shorter than asked for: pad rather than round.
            while (digits.Count < keep)
            {
                digits.Add(0);
            }

            return;
        }

        byte firstDropped = digits[keep];
        digits.RemoveRange(keep, digits.Count - keep);
        if (firstDropped < 5)
        {
            return;
        }

        for (int at = digits.Count - 1; at >= 0; at--)
        {
            if (digits[at] == 9)
            {
                digits[at] = 0;
                continue;
            }

            digits[at]++;
            return;
        }

        digits.Insert(0, 1);
    }

    /// <summary>A standard normal deviate by Box–Muller, from two uniforms in (0,1).</summary>
    private static double BoxMuller(double u1, double u2) =>
        Math.Sqrt(-2 * Math.Log(u1)) * Math.Cos(2 * Math.PI * u2);

    /// <summary>The smallest index where <c>cum[k] &gt;= u</c>, by binary search; clamped to the last.</summary>
    private static double LowerBound(double[] cum, double u)
    {
        int lo = 0;
        int hi = cum.Length - 1;
        while (lo < hi)
        {
            int mid = (int)(((uint)(lo + hi)) >> 1);
            if (cum[mid] >= u)
            {
                hi = mid;
            }
            else
            {
                lo = mid + 1;
            }
        }

        return lo;
    }

    /// <summary><c>cdf[k] = P(X &lt;= k)</c>, extended until it reaches one.</summary>
    private static double[] PoissonCdf(double lambda)
    {
        if (lambda > PoissonMaxLambda)
        {
            throw new ArgumentException(
                $"distribution \"poisson\": lambda {lambda} is too large (max "
                + $"{(long)PoissonMaxLambda}); for large means use distribution=\"normal\" "
                + $"mean=\"{lambda}\" sd=\"sqrt(lambda)\".");
        }

        var cdf = new List<double>();
        double p = Math.Exp(-lambda);
        double cum = p;
        cdf.Add(cum);
        double cap = lambda + (40 * Math.Sqrt(lambda)) + 100;
        for (int k = 1; cum < 1 - 1e-12 && k < cap; k++)
        {
            p = p * lambda / k;
            cum += p;
            cdf.Add(Math.Min(1, cum));
        }

        return cdf.ToArray();
    }

    /// <summary><c>cum[k] = P(rank &lt;= k+1)</c> over ranks 1..n.</summary>
    private static double[] ZipfCumulative(int n, double s)
    {
        if (n > ZipfMaxN)
        {
            throw new ArgumentException(
                $"distribution \"zipf\": n {n} is too large (max {ZipfMaxN}).");
        }

        double sum = 0;
        var weights = new double[n];
        for (int k = 1; k <= n; k++)
        {
            double w = 1 / Math.Pow(k, s);
            weights[k - 1] = w;
            sum += w;
        }

        var cum = new double[n];
        double c = 0;
        for (int k = 0; k < n; k++)
        {
            c += weights[k] / sum;
            cum[k] = c;
        }

        // Pin the last against floating-point drift, so a u near 1 lands on rank n rather than
        // falling off the end of the table.
        cum[n - 1] = 1;
        return cum;
    }

    private static int Decimals(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return 0;
        }

        if (!int.TryParse(raw.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out int n)
            || n < 0)
        {
            throw new ArgumentException(
                $"distribution: \"decimals\" must be a non-negative integer (got \"{raw}\")");
        }

        return n;
    }

    private static double? Optional(string? raw, string label)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        if (!double.TryParse(raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out double n))
        {
            throw new ArgumentException($"distribution: \"{label}\" must be a number (got \"{raw}\")");
        }

        return n;
    }

    private static double Required(IReadOnlyDictionary<string, string> attrs, string key, string dist)
    {
        string? raw = attrs.GetValueOrDefault(key);
        if (string.IsNullOrWhiteSpace(raw)
            || !double.TryParse(raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out double n)
            || !double.IsFinite(n))
        {
            throw new ArgumentException(
                $"distribution \"{dist}\": \"{key}\" is required and must be a number");
        }

        return n;
    }

    private static double Positive(IReadOnlyDictionary<string, string> attrs, string key, string dist)
    {
        double n = Required(attrs, key, dist);
        if (!(n > 0))
        {
            throw new ArgumentException(
                $"distribution \"{dist}\": \"{key}\" must be a positive number (got {n})");
        }

        return n;
    }

    private static double PositiveInteger(
        IReadOnlyDictionary<string, string> attrs, string key, string dist)
    {
        double n = Required(attrs, key, dist);
        if (n != Math.Round(n, MidpointRounding.ToEven) || n < 1)
        {
            throw new ArgumentException(
                $"distribution \"{dist}\": \"{key}\" must be a positive integer (got {n})");
        }

        return n;
    }
}
