using System.Globalization;

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
        long start = Number(attrs.GetValueOrDefault("value"), 0);
        long step = Number(attrs.GetValueOrDefault("step"), 1);
        var result = new List<string>(count);
        for (int i = 0; i < count; i++)
        {
            long value = ascending ? start + (step * i) : start - (step * i);
            result.Add(value.ToString(CultureInfo.InvariantCulture));
        }

        return result;
    }

    private static long Number(string? raw, long fallback) =>
        string.IsNullOrWhiteSpace(raw)
            ? fallback
            : long.Parse(raw.Trim(), CultureInfo.InvariantCulture);
}
