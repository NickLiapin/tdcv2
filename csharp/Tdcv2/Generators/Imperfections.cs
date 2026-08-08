using System.Globalization;
using Tdcv2.Prng;

namespace Tdcv2.Generators;

/// <summary>
/// The two things real data has that generated data usually does not: gaps and outliers.
/// </summary>
/// <remarks>
/// <para>
/// Both are attributes on any <c>&lt;gen&gt;</c> rather than generator types of their own, because
/// both apply to whatever the generator produced. They run as a pass over the finished column,
/// anomaly first and missing second — so a value can be spiked and then blanked, and a blanked value
/// is never spiked afterwards.
/// </para>
/// <para>
/// Each takes exactly one draw per row when it is active and none at all when it is not. That is
/// what lets a config add <c>missing="0.1"</c> to one column without changing any other.
/// </para>
/// </remarks>
public static class Imperfections
{
    /// <summary><c>missing="p"</c> with an optional <c>missing_as="NULL"</c>.</summary>
    public readonly record struct Missing(double Probability, string Token);

    /// <summary><c>anomaly="p"</c> with an optional <c>anomaly_factor="10"</c>.</summary>
    public readonly record struct Anomaly(double Probability, double Factor);

    private const double DefaultFactor = 10;

    public static Missing? ParseMissing(IReadOnlyDictionary<string, string> attrs)
    {
        string? raw = attrs.GetValueOrDefault("missing");
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        return new Missing(
            Probability(raw, "missing"), attrs.GetValueOrDefault("missing_as", ""));
    }

    public static Anomaly? ParseAnomaly(IReadOnlyDictionary<string, string> attrs)
    {
        string? raw = attrs.GetValueOrDefault("anomaly");
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        double p = Probability(raw, "anomaly");
        string? factorRaw = attrs.GetValueOrDefault("anomaly_factor");
        double factor;
        if (string.IsNullOrWhiteSpace(factorRaw))
        {
            factor = DefaultFactor;
        }
        else if (!double.TryParse(
                     factorRaw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture,
                     out factor)
                 || !double.IsFinite(factor))
        {
            throw new ArgumentException(
                $"anomaly: anomaly_factor \"{factorRaw}\" must be a number");
        }

        return new Anomaly(p, factor);
    }

    /// <summary>
    /// Blank each value with the given probability — missing completely at random.
    /// </summary>
    /// <remarks>
    /// Real datasets have holes, and code that has only ever seen complete data tends to fall over
    /// on the first one.
    /// </remarks>
    public static void ApplyMissing(IList<string> values, Missing spec, Sfc32 prng)
    {
        if (spec.Probability <= 0)
        {
            // No draws at all when nothing can go missing, so `missing="0"` costs nothing.
            return;
        }

        for (int i = 0; i < values.Count; i++)
        {
            if (prng.Next() < spec.Probability)
            {
                values[i] = spec.Token;
            }
        }
    }

    /// <summary>
    /// Multiply selected values out of their normal range, for testing detectors and pipelines
    /// against spikes.
    /// </summary>
    /// <remarks>
    /// A non-numeric value is selected but left alone: an outlier is a numeric idea, and there is
    /// nothing sensible to do to the word "Tuesday". <paramref name="flags"/>, when supplied,
    /// records the selection rather than the change, so a ground-truth column marks the rows the run
    /// chose.
    /// </remarks>
    public static void ApplyAnomaly(IList<string> values, Anomaly spec, Sfc32 prng, bool[]? flags)
    {
        for (int i = 0; i < values.Count; i++)
        {
            bool selected = spec.Probability > 0 && prng.Next() < spec.Probability;
            if (flags is not null && i < flags.Length)
            {
                flags[i] = selected;
            }

            if (selected)
            {
                values[i] = Spike(values[i], spec.Factor);
            }
        }
    }

    /// <summary>Whether <see cref="Spike"/> would actually change this value: it is a finite number.</summary>
    /// <remarks>
    /// Split out so the flag can be computed WITHOUT comparing before and after. That comparison
    /// looks equivalent and is not — <c>0</c> times any factor is still <c>0</c>, and a row that
    /// really was spiked would come back unflagged.
    /// </remarks>
    public static bool IsSpikeable(string value) =>
        double.TryParse(
            value.Trim(), System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out double n)
        && double.IsFinite(n);

    /// <summary>
    /// One value made an outlier, or returned untouched when it is not a number.
    /// </summary>
    /// <remarks>
    /// Shared with the streaming engine, which decides row by row rather than over a column but has
    /// to spike a selected value in exactly the same way.
    /// </remarks>
    public static string Spike(string value, double factor)
    {
        if (value is null
            || !double.TryParse(
                value.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out double n)
            || !double.IsFinite(n))
        {
            // Not a number, so there is no outlier to make. Left exactly as it was.
            return value ?? "";
        }

        return KeepShape(value, n * factor);
    }

    /// <summary>The spike keeps the SHAPE of the value it replaced.</summary>
    /// <remarks>
    /// Multiplying and re-stringifying threw away everything the column had already been
    /// rendered with — the zero padding <c>length=</c> asked for, and the decimal places
    /// <c>decimals=</c> asked for — so the outlier rows were the only ones in the file with a
    /// different shape: <c>length="5"</c> gave 00014, 00046 and then 117; <c>decimals="2"</c>
    /// gave 85.66, 40.97 and then 6.445. A column of fixed-width identifiers stopped being
    /// fixed width on exactly the rows a test is about to exercise, and a column declared with
    /// decimals is typed a float in Parquet — a third place is a value the declared type never
    /// promised. An outlier is meant to be far from the others in VALUE, not in format.
    /// </remarks>
    private static string KeepShape(string original, double spiked)
    {
        int dot = original.IndexOf('.');
        int places = dot < 0 ? 0 : original.Length - dot - 1;

        // Rounded on the SCALED integer, half away from zero, rather than by handing an
        // arbitrary product to a host formatter: `round` already means that everywhere else in
        // TDC, and it is the one rule all five spell the same.
        double scale = Math.Pow(10, places);
        double scaled = spiked * scale;
        double rounded = scaled < 0 ? -Math.Floor(-scaled + 0.5) : Math.Floor(scaled + 0.5);
        string text = (rounded / scale).ToString(
            "F" + places.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture);

        // Only a value that was ZERO-PADDED has a width to preserve. `12.89` is five
        // characters wide because the number is, not because the column asked for five.
        string bare = original.StartsWith('-') ? original[1..] : original;
        int bareDot = bare.IndexOf('.');
        string wholePart = bareDot < 0 ? bare : bare[..bareDot];
        if (!wholePart.StartsWith('0') || wholePart.Length < 2)
        {
            return text;
        }

        bool negative = text.StartsWith('-');
        string body = negative ? text[1..] : text;
        int cut = body.IndexOf('.');
        string whole = cut < 0 ? body : body[..cut];
        string rest = cut < 0 ? "" : body[cut..];
        return (negative ? "-" : "") + whole.PadLeft(wholePart.Length, '0') + rest;
    }

    /// <summary><c>String(n)</c> as JavaScript writes it: a whole number carries no decimal point.</summary>
    private static string NumberToString(double n)
    {
        if (n == Math.Round(n, MidpointRounding.ToEven) && Math.Abs(n) < 1e21)
        {
            return ((long)n).ToString(CultureInfo.InvariantCulture);
        }

        return n.ToString("R", CultureInfo.InvariantCulture);
    }

    private static double Probability(string raw, string label)
    {
        if (!double.TryParse(
                raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out double p)
            || !double.IsFinite(p) || p < 0 || p > 1)
        {
            throw new ArgumentException(
                $"{label}: probability \"{raw}\" must be a number in [0, 1]");
        }

        return p;
    }
}
