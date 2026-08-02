using System.Globalization;
using System.Text;

namespace Tdcv2.Output.Parquet;

/// <summary>
/// Dictionary encoding — store each distinct value once, then point at it.
/// </summary>
/// <remarks>
/// <para>
/// A column of city names repeats "Moscow" ten thousand times. PLAIN writes those bytes ten thousand
/// times; a dictionary writes them once and spends two BITS per row pointing at them. That is the
/// largest size win available short of compression, and it costs no dependency.
/// </para>
/// <para>
/// Whether to use it has to be decided from the data, and the decision has to be reproducible. A
/// heuristic that consulted anything else — a clock, a memory figure, a sampling rate — would put
/// different bytes in the file on different runs and break the guarantee the whole writer exists to
/// keep. So the rule below reads only the values.
/// </para>
/// </remarks>
public static class Dictionary
{
    /// <summary>
    /// A dictionary pays for itself when values repeat. Requiring at least a halving keeps it away
    /// from near-unique columns — ids, timestamps, uuids — where the indices would be pure overhead
    /// on top of values that are already all different.
    /// </summary>
    private const double MaxDistinctRatio = 0.5;

    /// <summary>
    /// Beyond this, the dictionary page itself grows large enough that a reader pays to load it even
    /// when it wants only a few rows.
    /// </summary>
    private const int MaxDistinct = 1 << 16;

    /// <summary>The distinct values in first-seen order, and one index per present value.</summary>
    public sealed record Built(IReadOnlyList<Convert.Value?> Values, int[] Indices);

    /// <summary>
    /// Build a dictionary for these values, or <c>null</c> when it would not pay.
    /// </summary>
    /// <remarks>Null is the signal to keep PLAIN encoding, not an error.</remarks>
    public static Built? Build(ColumnType type, IReadOnlyList<Convert.Value?> present)
    {
        // A boolean already costs one bit; a dictionary would only add a page to carry two values.
        if (type.Kind == ColumnKind.Bool || present.Count == 0)
        {
            return null;
        }

        var seen = new Dictionary<string, int>(StringComparer.Ordinal);
        var values = new List<Convert.Value?>();
        var indices = new int[present.Count];

        for (int i = 0; i < present.Count; i++)
        {
            string key = KeyOf(present[i]);
            if (!seen.TryGetValue(key, out int index))
            {
                index = values.Count;
                seen[key] = index;
                values.Add(present[i]);
                // Give up as soon as it is clearly not worth it, rather than building a dictionary
                // the size of the column and then throwing it away.
                if (values.Count > MaxDistinct)
                {
                    return null;
                }
            }

            indices[i] = index;
        }

        return values.Count > present.Count * MaxDistinctRatio ? null : new Built(values, indices);
    }

    /// <summary>A stable identity key. It must never merge two values a reader would tell apart.</summary>
    private static string KeyOf(Convert.Value? value) => value switch
    {
        null => "n:",
        Convert.Value.Bytes bytes => "b:" + string.Join(
            ",", bytes.V.Select(b => b.ToString(CultureInfo.InvariantCulture))) + ",",
        Convert.Value.Text text => "s:" + text.V,
        Convert.Value.Long number => "i:" + number.V.ToString(CultureInfo.InvariantCulture),
        // Distinguished from a long by its prefix, so the same digits in two slots cannot merge.
        Convert.Value.Int number => "j:" + number.V.ToString(CultureInfo.InvariantCulture),
        Convert.Value.Double number => "d:" + JavaDouble(number.V),
        Convert.Value.Bool flag => "z:" + (flag.V ? "true" : "false"),
        _ => throw new ArgumentException($"unhandled value {value}"),
    };

    /// <summary>
    /// A double's identity, written the way the other implementations write it.
    /// </summary>
    /// <remarks>
    /// Only the key's uniqueness matters, not its shape — but two doubles that print alike must be
    /// the same double, so "R" round-trip formatting is used rather than the default.
    /// </remarks>
    private static string JavaDouble(double v) => v.ToString("R", CultureInfo.InvariantCulture);
}
