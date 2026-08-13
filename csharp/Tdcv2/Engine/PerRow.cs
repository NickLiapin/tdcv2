using Tdcv2.Distribution;
using Tdcv2.Model;
using Tdcv2.Prng;

namespace Tdcv2.Engine;

/// <summary>
/// How the in-memory engine derives a column the way the streaming engine does.
/// </summary>
/// <remarks>
/// The two engines were built on different ideas of randomness. Engine 1 threaded one PRNG
/// through every sequence in declaration order, so a column's values depended on how many draws
/// the columns before it had made; engines 2 and 3 derive each cell from
/// <c>(seed, streamId, row)</c> and are independent of one another. Two architectures, and no
/// seed could ever make them agree.
/// <para>
/// This is engine 1 adopting the second scheme — the port of the reference's
/// <c>sequence/per-row.ts</c>, with the same names so the two can be read side by side. A
/// column's identity travels beside it as a <see cref="Stream"/>; absent, everything falls back
/// to the sequential PRNG, which is what an inline generator or a nested pack body wants.
/// </para>
/// </remarks>
internal static class PerRow
{
    /// <summary>
    /// Generators whose value for a row depends on nothing but that row.
    /// </summary>
    /// <remarks>
    /// A generator is off this list when its column is a PLAN rather than a series of draws.
    /// <c>text</c> is the clearest case: even an UNWEIGHTED list is spread evenly over the column
    /// and permuted, never picked independently per row, so <see cref="ExactTextLayout"/> handles
    /// it instead. The rest are conditional and checked in <see cref="PerRowBuildable"/>.
    /// </remarks>
    internal static readonly HashSet<string> PerRowTypes = new(StringComparer.Ordinal)
    {
        "number", "regex", "symbol", "date", "template", "file", "advanced_regex",
    };

    /// <summary>
    /// Types the streaming engine builds INLINE — it reads the row's position rather than
    /// deriving a value from the row — and whose <c>anomaly=</c>/<c>missing=</c> draws it
    /// therefore takes from dedicated <c>#anom</c> and <c>#miss</c> streams instead of from the
    /// generator's own.
    /// </summary>
    internal static readonly HashSet<string> InlineAnomalyTypes = new(StringComparer.Ordinal)
    {
        "text", "increment", "decrement", "timeseries", "pattern",
    };

    /// <summary>
    /// What a column's exact layout gave each row.
    /// </summary>
    /// <remarks>
    /// Kept so a child that filters on this column can be ordered the way the streaming engine
    /// orders it: a child's position inside its parent's subset is its RANK in the parent's
    /// layout, not its ordinal among the matching rows, and the two are different orders.
    /// </remarks>
    internal sealed record ExactLayout(
        IReadOnlyList<string> Values,
        int[] Counts,
        int[] CumHi,
        Dictionary<int, int> SlotByRow);

    /// <summary>
    /// The column a build belongs to: the seed it derives from, its name on the wire, and — when
    /// it does not cover every row — the ABSOLUTE row each drawn position belongs to.
    /// </summary>
    internal sealed record Stream(string Seed, string Id, IReadOnlyList<int>? Rows)
    {
        /// <summary>The same stream under a different name, keeping the row list.</summary>
        internal Stream Named(string id) => new(this.Seed, id, this.Rows);

        /// <summary>The absolute row a drawn position belongs to.</summary>
        /// <remarks>
        /// Index-dependent generators — counters, timeseries, a pattern stretched over the run —
        /// read the POSITION for their value, and the streaming engine does the same. Their
        /// random draws are keyed by the row instead, which is why the two numbers have to be
        /// told apart.
        /// </remarks>
        internal int RowAt(int position) =>
            this.Rows is null
                ? position
                : (position < this.Rows.Count ? this.Rows[position] : position);
    }

    /// <summary>The absolute rows a mask lets through, in row order.</summary>
    internal static List<int> RowsOf(bool[] mask)
    {
        var rows = new List<int>();
        for (int i = 0; i < mask.Length; i++)
        {
            if (mask[i])
            {
                rows.Add(i);
            }
        }

        return rows;
    }

    /// <summary>
    /// Can this generator be built row by row? <c>count &lt;= 1</c> is already one row.
    /// </summary>
    /// <remarks>
    /// <paramref name="weighted"/> and <paramref name="wholeColumn"/> are decided by the caller,
    /// which is the only place that can reach the pack registry without this class depending on
    /// it.
    /// </remarks>
    internal static bool PerRowBuildable(Gen gen, int count, bool weighted, bool wholeColumn)
    {
        // `sample="exact"` on a quantile read is a PLAN too: every row takes its own point on
        // the sorted sample, and which point follows from a scatter over the whole column. Built
        // a row at a time it would see a count of one and hand every row the median.
        if ((gen.Attrs.GetValueOrDefault("sample") ?? "").Trim() == "exact")
        {
            return false;
        }

        if (count <= 1 || !PerRowTypes.Contains(gen.Type))
        {
            return false;
        }

        IReadOnlyDictionary<string, string> attrs = gen.Attrs;

        // order="sequential" reads the position, never the randomness.
        if (attrs.GetValueOrDefault("order") == "sequential")
        {
            return false;
        }

        // A weighted file column and a pack that declares shares are both exact quotas over the
        // whole column: the streaming engine lays them out the way it lays out weighted text.
        if (attrs.ContainsKey("weight") || weighted || wholeColumn)
        {
            return false;
        }

        // `row=` links several columns to ONE row of a file. That choice belongs to the row as a
        // whole, not to any single column reading from it.
        if (!string.IsNullOrWhiteSpace(attrs.GetValueOrDefault("row")))
        {
            return false;
        }

        // `percent=` on ANY type, not just text: a number can apportion its LENGTH groups the
        // same exact way (length="2,10-12" percent="85,15").
        if (attrs.ContainsKey("percent"))
        {
            return false;
        }

        // `repeat=` apportions the LENGTHS exactly across the column. That plan is separate, and
        // taking this path would skip it.
        return !attrs.ContainsKey("repeat");
    }

    /// <summary>
    /// A list of values laid out exactly, the way the streaming engine lays it out.
    /// </summary>
    /// <remarks>
    /// <see cref="Hamilton.CountsPerValue"/> turns the shares into a whole number of slots per
    /// value; <see cref="Permute.Apply"/> scatters those slots over the rows with a key derived
    /// from the column's name. Row i gets the value whose slot range contains
    /// <c>permute(i)</c>. Both halves are keyed by <c>(seed, streamId)</c>, so the in-memory and
    /// the streaming engine land on the same arrangement.
    /// <para>The layout is recorded in <paramref name="layouts"/> for any child that filters on
    /// this column.</para>
    /// </remarks>
    internal static string[] ExactTextLayout(
        IReadOnlyList<string> values,
        double[] percents,
        int count,
        Stream stream,
        Dictionary<string, ExactLayout>? layouts)
    {
        int[] counts = Hamilton.CountsPerValue(
            count, percents, Prng.Prng.Create($"{stream.Seed}|{stream.Id}|pct"));
        int key = Permute.Key(stream.Seed, stream.Id);

        var cumHi = new int[counts.Length];
        int acc = 0;
        for (int i = 0; i < counts.Length; i++)
        {
            acc += counts[i];
            cumHi[i] = acc;
        }

        var result = new string[count];
        var slotByRow = new Dictionary<int, int>(count);
        for (int i = 0; i < count; i++)
        {
            int slot = Permute.Apply(i, count, key);
            slotByRow[stream.RowAt(i)] = slot;

            // Binary search rather than a linear scan: a wide column (many values) would
            // otherwise make the render O(count x values).
            int lo = 0;
            int hi = cumHi.Length - 1;
            while (lo < hi)
            {
                int mid = (lo + hi) / 2;
                if (slot < cumHi[mid])
                {
                    hi = mid;
                }
                else
                {
                    lo = mid + 1;
                }
            }

            result[i] = lo < values.Count ? values[lo] : "";
        }

        if (layouts is not null)
        {
            layouts[stream.Id] = new ExactLayout(values.ToList(), counts, cumHi, slotByRow);
        }

        return result;
    }

    /// <summary>
    /// The rows a sequence builds, in the order it builds them.
    /// </summary>
    /// <remarks>
    /// For an unparented column that is simply every row. For a child it is the rows the parent
    /// selected, ordered by their RANK inside the parent's exact layout — which is not their row
    /// order. The streaming engine hands a child that rank as its position, so a parented column
    /// would otherwise arrange its own quota over a differently ordered subset and land every
    /// value on the wrong row.
    /// <para>Falls back to row order when the parent kept no layout — a bare
    /// <c>parent="Name"</c> with no value, or a parent the streaming engine would refuse as a
    /// parent anyway.</para>
    /// </remarks>
    internal static List<int> OrderedRows(
        string? parent, bool[] mask, Dictionary<string, ExactLayout> layouts)
    {
        List<int> applicable = RowsOf(mask);
        if (parent is null)
        {
            return applicable;
        }

        int dot = parent.IndexOf('.');
        if (dot < 0)
        {
            return applicable;
        }

        string name = parent.Substring(0, dot);
        string value = parent.Substring(dot + 1);
        if (!layouts.TryGetValue(name, out ExactLayout? plan))
        {
            return applicable;
        }

        int vi = -1;
        for (int i = 0; i < plan.Values.Count; i++)
        {
            if (plan.Values[i] == value)
            {
                vi = i;
                break;
            }
        }

        if (vi < 0)
        {
            return applicable;
        }

        int low = plan.CumHi[vi] - plan.Counts[vi];
        var ordered = new int[applicable.Count];
        Array.Fill(ordered, -1);
        foreach (int row in applicable)
        {
            if (!plan.SlotByRow.TryGetValue(row, out int slot))
            {
                return applicable;
            }

            int rank = slot - low;
            if (rank < 0 || rank >= ordered.Length)
            {
                return applicable;
            }

            ordered[rank] = row;
        }

        return ordered.Any(r => r < 0) ? applicable : ordered.ToList();
    }

    /// <summary>
    /// The uniform of row <paramref name="row"/> on one of the column's own purpose streams
    /// (<c>#anom</c>, <c>#miss</c>).
    /// </summary>
    internal static double PurposeDraw(Stream stream, string purpose, int row) =>
        Seekable.Uniforms(stream.Seed, stream.Id + purpose, row, 1)[0];

    /// <summary>The generator a single row draws from.</summary>
    internal static Sfc32 RowGenerator(Stream stream, int row) =>
        Seekable.Generator(stream.Seed, stream.Id, row);

    /// <summary>
    /// The shares a <c>percent=</c> mask expands to, or equal shares when there is no mask.
    /// </summary>
    internal static double[] SharesOf(string? percent, int valueCount)
    {
        if (string.IsNullOrEmpty(percent))
        {
            return Enumerable.Repeat(100.0 / valueCount, valueCount).ToArray();
        }

        try
        {
            return PercentMask.Expand(percent, valueCount);
        }
        catch (Exception)
        {
            return Enumerable.Repeat(100.0 / valueCount, valueCount).ToArray();
        }
    }
}
