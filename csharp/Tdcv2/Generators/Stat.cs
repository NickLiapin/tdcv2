using System.Globalization;

namespace Tdcv2.Generators;

/// <summary>
/// <c>&lt;gen type="stat"&gt;</c> — one number for the WHOLE run, on every row.
/// </summary>
/// <remarks>
/// <para><c>accumulate=</c> totals a list inside one record. <c>&lt;gen type="running"&gt;</c>
/// totals a column as it goes, so row i knows about rows 1..i. This is the third and last axis:
/// a row that knows something about EVERY row, including the ones after it.</para>
///
/// <para><c>sum</c>, <c>min</c> and <c>max</c> are the last value of the corresponding RUNNING
/// column, computed by <see cref="Accumulate.ApplyColumn"/>. That is not a shortcut — it is how
/// the two features are kept from drifting: the fixed-point scale rule, the treatment of an empty
/// cell and the "min returns the winning element's own spelling" rule are written once and used
/// twice.</para>
///
/// <para><c>mean</c>, <c>median</c> and <c>stddev</c> are ratios and cannot be exact, so they are
/// computed in floating point over the numeric values — the same three formulas the expression
/// language's list functions use, including the POPULATION standard deviation. <c>decimals=</c>
/// rounds the answer through the same ToFixed <c>decimals=</c> on a number already uses.</para>
/// </remarks>
internal static class Stat
{
    /// <summary>What a statistic can be.</summary>
    internal static readonly string[] Ops =
        { "sum", "mean", "median", "min", "max", "count", "stddev" };

    /// <summary>
    /// Read <c>op=</c> where an unknown op simply means "none".
    /// </summary>
    /// <remarks>
    /// The engine path uses this one: by the time a value is drawn the validator has already
    /// refused a misspelled op, so throwing here would turn a reported problem into a crash.
    /// </remarks>
    internal static string? ReadOp(IReadOnlyDictionary<string, string> attrs)
    {
        string raw = (attrs.GetValueOrDefault("op") ?? "").Trim();
        return Array.IndexOf(Ops, raw) >= 0 ? raw : null;
    }

    /// <summary>The same, but strict — the validator's copy, which turns a bad op into a diagnostic.</summary>
    internal static string? ParseOp(IReadOnlyDictionary<string, string> attrs)
    {
        string raw = (attrs.GetValueOrDefault("op") ?? "").Trim();
        if (raw.Length == 0)
        {
            return null;
        }

        if (Array.IndexOf(Ops, raw) < 0)
        {
            throw new StatException($"op=\"{raw}\" is not one of {string.Join(", ", Ops)}");
        }

        return raw;
    }

    /// <summary><c>decimals=</c>, or null when the answer is printed at full precision.</summary>
    internal static int? ParseDecimals(IReadOnlyDictionary<string, string> attrs)
    {
        string raw = (attrs.GetValueOrDefault("decimals") ?? "").Trim();
        if (raw.Length == 0)
        {
            return null;
        }

        if (!int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out int n)
            || n < 0 || n > 10)
        {
            throw new StatException($"decimals=\"{raw}\" is not a whole number from 0 to 10");
        }

        return n;
    }

    /// <summary>
    /// The statistic itself, as the text that goes in every cell.
    /// </summary>
    /// <remarks>
    /// A cell the parent filter emptied does not take part — the same rule
    /// <see cref="Accumulate.ApplyColumn"/> follows, so a filtered column has one meaning across
    /// the three features rather than three.
    /// </remarks>
    internal static string Statistic(string?[] values, string op, int? decimals)
    {
        List<string> present = values
            .Where(v => v is not null && v.Trim().Length != 0)
            .Select(v => v!)
            .ToList();
        if (op == "count")
        {
            return present.Count.ToString(CultureInfo.InvariantCulture);
        }

        if (present.Count == 0)
        {
            return string.Empty;
        }

        if (op is "sum" or "min" or "max")
        {
            // The last value of the running column IS the total over every row, and reusing it
            // is what keeps the exact-decimal arithmetic from drifting.
            string?[] running = Accumulate.ApplyColumn(values, op, null, null);
            string last = running.LastOrDefault(v => v is not null) ?? string.Empty;
            return decimals is null ? last : Fixed(AsNumber(last), decimals.Value);
        }

        double[] figures = present.Select(AsNumber).ToArray();
        double answer = op switch
        {
            "mean" => Mean(figures),
            "median" => Median(figures),
            _ => StdDev(figures),
        };
        return decimals is null ? ToText(answer) : Fixed(answer, decimals.Value);
    }

    /// <summary>
    /// A double as JavaScript prints it — a whole number without a decimal point.
    /// </summary>
    /// <remarks>
    /// The reference writes <c>String(x)</c> and the four ports each imitate it; this is C#'s
    /// copy, kept beside its one caller rather than added to a shared helper nothing else needs.
    /// </remarks>
    private static string ToText(double value)
    {
        if (double.IsNaN(value) || double.IsInfinity(value) || value != Math.Floor(value))
        {
            return value.ToString("R", CultureInfo.InvariantCulture);
        }

        return ((long)value).ToString(CultureInfo.InvariantCulture);
    }

    /// <summary>A cell as a number. The column it reads is numeric by construction.</summary>
    private static double AsNumber(string raw) =>
        double.TryParse(raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out double v)
            ? v
            : double.NaN;

    private static double Mean(double[] values) => values.Sum() / values.Length;

    private static double Median(double[] values)
    {
        double[] sorted = (double[])values.Clone();
        Array.Sort(sorted);
        int half = sorted.Length / 2;
        return sorted.Length % 2 == 1 ? sorted[half] : (sorted[half - 1] + sorted[half]) / 2;
    }

    /// <summary>
    /// The POPULATION standard deviation — divided by n, matching <c>stddev()</c> in an expression.
    /// </summary>
    private static double StdDev(double[] values)
    {
        double average = Mean(values);
        double variance = values.Sum(v => (v - average) * (v - average)) / values.Length;
        return Maths.TdcMath.Sqrt(variance);
    }

    /// <summary>
    /// <c>decimals=</c> applied.
    /// </summary>
    /// <remarks>
    /// The same ToFixed <c>decimals=</c> on <c>&lt;gen type="number"&gt;</c> already uses, and
    /// nothing hand-rolled: multiplying by 10^decimals and flooring introduces a rounding error of
    /// its own before the rounding rule ever runs, so two implementations could land on either
    /// side of a tie for the same input.
    /// </remarks>
    private static string Fixed(double value, int decimals) =>
        double.IsNaN(value) || double.IsInfinity(value)
            ? ToText(value)
            : Stats.Distribution.ToFixed(value, decimals);
}

/// <summary>A statistic that cannot be read as one.</summary>
internal sealed class StatException : Exception
{
    internal StatException(string message)
        : base(message)
    {
    }
}
