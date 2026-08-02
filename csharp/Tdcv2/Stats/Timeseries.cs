using System.Globalization;
using Tdcv2.Prng;

namespace Tdcv2.Stats;

/// <summary>
/// <c>&lt;gen type="timeseries" .../&gt;</c> — a value that depends on when it happened.
/// </summary>
/// <remarks>
/// <para>The layered model every real series is built from:</para>
/// <para><c>value(i) = base + trend·i + amplitude·sin(2π·i/period) + noise·z</c></para>
/// <para>
/// A trend, one seasonal wave, and gaussian noise, with the row index as the clock. Sales, sensor
/// readings and traffic look like this. A uniform draw over the same range does not, and anything
/// that plots the column will show the difference immediately.
/// </para>
/// <para>
/// Like the counters, the value comes from the absolute row index rather than from the row before
/// it, so any row can be computed on its own.
/// </para>
/// </remarks>
public static class Timeseries
{
    /// <param name="Period">Seasonal period in rows; zero means no seasonality.</param>
    /// <param name="NoiseSd">Standard deviation of the noise; zero means no noise, and no draws.</param>
    public readonly record struct Spec(
        double Base, double Trend, double Period, double Amplitude, double NoiseSd, int Decimals)
    {
        public bool HasNoise => NoiseSd != 0;
    }

    public static IReadOnlyList<string> Generate(
        IReadOnlyDictionary<string, string> attrs, int count, Sfc32 prng)
    {
        Spec spec = Parse(attrs);
        bool noisy = spec.HasNoise;
        var result = new List<string>(count);
        for (int i = 0; i < count; i++)
        {
            // Two uniforms per row when there is noise, none at all when there is not — the draw
            // budget has to be exactly this, or a column declared after this one shifts.
            double z = noisy
                ? StandardNormal(
                    Seekable.OpenUnit(prng.Next()), Seekable.OpenUnit(prng.Next()))
                : 0;
            result.Add(Fixed(ValueAt(spec, i, z), spec.Decimals));
        }

        return result;
    }

    public static Spec Parse(IReadOnlyDictionary<string, string> attrs)
    {
        double period = Number(attrs, "period", 0);
        double noiseSd = Number(attrs, "noise", 0);
        if (period < 0)
        {
            throw new ArgumentException("timeseries: \"period\" must be >= 0");
        }

        if (noiseSd < 0)
        {
            throw new ArgumentException("timeseries: \"noise\" must be >= 0");
        }

        string? decimalsRaw = attrs.GetValueOrDefault("decimals");
        int decimals = 0;
        if (!string.IsNullOrWhiteSpace(decimalsRaw)
            && (!int.TryParse(decimalsRaw.Trim(), out decimals) || decimals < 0))
        {
            throw new ArgumentException(
                "timeseries: \"decimals\" must be a non-negative integer");
        }

        return new Spec(
            Number(attrs, "base", 0),
            Number(attrs, "trend", 0),
            period,
            Number(attrs, "amplitude", 0),
            noiseSd,
            decimals);
    }

    /// <summary>A standard normal deviate by Box–Muller, from two uniforms in (0,1).</summary>
    public static double StandardNormal(double u1, double u2) =>
        Math.Sqrt(-2 * Math.Log(u1)) * Math.Cos(2 * Math.PI * u2);

    public static double ValueAt(Spec spec, int i, double z)
    {
        double v = spec.Base + (spec.Trend * i);
        if (spec.Period > 0 && spec.Amplitude != 0)
        {
            v += spec.Amplitude * Math.Sin(2 * Math.PI * i / spec.Period);
        }

        if (spec.NoiseSd != 0)
        {
            v += spec.NoiseSd * z;
        }

        return v;
    }

    private static string Fixed(double v, int decimals) => Distribution.ToFixed(v, decimals);

    private static double Number(
        IReadOnlyDictionary<string, string> attrs, string key, double fallback)
    {
        string? raw = attrs.GetValueOrDefault(key);
        if (string.IsNullOrWhiteSpace(raw))
        {
            return fallback;
        }

        if (!double.TryParse(
                raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out double n)
            || !double.IsFinite(n))
        {
            throw new ArgumentException(
                $"timeseries: \"{key}\" must be a number (got \"{raw}\")");
        }

        return n;
    }
}
