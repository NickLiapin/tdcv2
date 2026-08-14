using System.Globalization;
using Tdcv2.Stats;

namespace Tdcv2.Generators;

/// <summary>
/// <c>&lt;gen type="increment"/&gt;</c> and <c>&lt;gen type="decrement"/&gt;</c>.
/// </summary>
/// <remarks>
/// Position, not chance: the tenth cell is the start plus ten steps whatever the seed is, and no
/// draw is taken. That is what makes a counter safe to add to an existing config — every column
/// declared after it keeps the values it had.
/// </remarks>
public static class Counter
{
    public static IReadOnlyList<string> Generate(
        IReadOnlyDictionary<string, string> attrs, int count, bool ascending)
    {
        var result = new List<string>(count);
        for (int i = 0; i < count; i++)
        {
            result.Add(ValueAt(attrs, i, ascending));
        }

        return result;
    }

    /// <summary>One row's value, for the engines that build a counter a row at a time.</summary>
    /// <remarks>
    /// <para>Shared with <see cref="Generate"/> so the streaming and the in-memory answer cannot
    /// drift — a counter is position, not chance, and the two paths disagreeing about it would
    /// show in every row.</para>
    /// <para>A whole counter stays on integer arithmetic, where it is exact however far it runs.
    /// A fractional one — <c>value="9.99" step="0.50"</c>, the shape the counters page teaches —
    /// moves to the same floating point the reference uses and is written the same way, so the
    /// two agree digit for digit. Note the value is the start plus <c>step * i</c>, not <c>i</c>
    /// additions: repeated addition accumulates its own error and would drift away from the
    /// reference by the thousandth row.</para>
    /// </remarks>
    public static string ValueAt(
        IReadOnlyDictionary<string, string> attrs, long index, bool ascending)
    {
        string? rawStart = attrs.GetValueOrDefault("value");
        string? rawStep = attrs.GetValueOrDefault("step");
        if (IsWhole(rawStart) && IsWhole(rawStep))
        {
            long start = Number(rawStart, 0);
            long step = Number(rawStep, 1);
            long value = ascending ? start + (step * index) : start - (step * index);
            return value.ToString(CultureInfo.InvariantCulture);
        }

        double startF = Fraction(rawStart, 0);
        double stepF = Fraction(rawStep, 1);
        return Numbers.ToText(ascending ? startF + (stepF * index) : startF - (stepF * index));
    }

    private static bool IsWhole(string? raw) =>
        string.IsNullOrWhiteSpace(raw)
        || long.TryParse(raw.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out _);

    private static long Number(string? raw, long fallback) =>
        string.IsNullOrWhiteSpace(raw)
            ? fallback
            : long.Parse(raw.Trim(), CultureInfo.InvariantCulture);

    private static double Fraction(string? raw, double fallback) =>
        string.IsNullOrWhiteSpace(raw)
            ? fallback
            : double.Parse(raw.Trim(), NumberStyles.Float, CultureInfo.InvariantCulture);
}
