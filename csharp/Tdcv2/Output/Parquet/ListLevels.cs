namespace Tdcv2.Output.Parquet;

/// <summary>
/// The Dremel core: rows of lists turned into the three flat streams Parquet actually stores.
/// </summary>
/// <remarks>
/// <para>
/// Parquet keeps no brackets. A list column is the leaf values laid end to end, plus two integer
/// streams that let a reader rebuild the shape. A repetition level of 0 starts a new record and 1
/// continues the current list; a definition level says how deep the value actually exists, which is
/// how an empty list and a missing element are expressed without any value at all.
/// </para>
/// <para>
/// The schema here has exactly one level of repetition, so the maximum repetition level is 1 and the
/// maximum definition level is 1 for a required element or 2 for an optional one. The outer group is
/// REQUIRED because "no list at all" is not a state this can produce — an empty cell is an empty
/// list — and declaring it optional would spend a level on something never emitted.
/// </para>
/// <para>
/// Kept apart from the writer so it can be checked against levels worked out by hand. Getting these
/// two streams wrong produces a file that readers accept and then reassemble incorrectly, which is
/// the worst failure available.
/// </para>
/// </remarks>
public static class ListLevels
{
    /// <summary>The elements that are present, and the two level streams describing their shape.</summary>
    public sealed record Built(
        IReadOnlyList<string> Present, int[] RepLevels, int[] DefLevels, int MaxDef, int MaxRep);

    /// <summary>The maximum definition level for a list whose element is, or is not, nullable.</summary>
    public static int MaxDefOf(bool elementNullable) => elementNullable ? 2 : 1;

    /// <summary>Bits needed to hold levels up to <paramref name="maxLevel"/>; zero when there is nothing to say.</summary>
    public static int BitWidth(int maxLevel)
    {
        int bits = 0;
        while ((1 << bits) <= maxLevel)
        {
            bits++;
        }

        return bits;
    }

    /// <summary>
    /// The value, repetition and definition streams for one list column.
    /// </summary>
    /// <remarks>
    /// An element is NULL when its text is empty AND the element type is nullable — the same rule the
    /// scalar path uses, so <c>missing=</c> behaves identically whether or not the column repeats.
    /// When the element is not nullable an empty string is a legitimate empty value and is passed on
    /// to conversion, which refuses it if the type cannot hold it.
    /// </remarks>
    public static Built Build(IReadOnlyList<IReadOnlyList<string>> rows, bool elementNullable)
    {
        int maxDef = MaxDefOf(elementNullable);
        var present = new List<string>();
        var repLevels = new List<int>();
        var defLevels = new List<int>();

        foreach (IReadOnlyList<string> row in rows)
        {
            if (row.Count == 0)
            {
                // An empty list still occupies one level slot; definition 0 IS the statement "this
                // row has no elements". Without it the row would vanish entirely.
                repLevels.Add(0);
                defLevels.Add(0);
                continue;
            }

            for (int k = 0; k < row.Count; k++)
            {
                repLevels.Add(k == 0 ? 0 : 1);
                string text = row[k];
                if (elementNullable && text.Length == 0)
                {
                    defLevels.Add(maxDef - 1); // the slot exists, the value does not
                    continue;
                }

                defLevels.Add(maxDef);
                present.Add(text);
            }
        }

        return new Built(present, repLevels.ToArray(), defLevels.ToArray(), maxDef, 1);
    }
}
