using Tdcv2.Prng;

namespace Tdcv2.Distribution;

/// <summary>
/// Hamilton's largest-remainder method: split <c>count</c> rows across values in the declared
/// percentages, exactly.
/// </summary>
/// <remarks>
/// <para>
/// This is what makes <c>percent="60,40"</c> produce 60 and 40 rather than "about" 60 and 40.
/// Each value first takes its whole share; the rows left over by rounding go to the largest
/// fractional remainders.
/// </para>
/// <para>Two details decide whether a port matches the reference, and both are easy to get wrong:</para>
/// <list type="number">
///   <item>
///     <b>Tie order.</b> Values with equal remainders are served lowest index first. Only when a
///     tie group is larger than the number of rows left does the generator get consulted, one draw
///     per row, from a pool that shrinks as it goes.
///   </item>
///   <item>
///     <b>Draw accounting.</b> Tie-breaking and the final shuffle both consume from the same
///     generator, in that order. Drawing a different number of times leaves the generator in a
///     different state, and everything generated afterwards diverges — even though the counts
///     themselves would still look correct.
///   </item>
/// </list>
/// <para>Verified against <c>fixtures/cross-language/hamilton-vectors.json</c>.</para>
/// </remarks>
public static class Hamilton
{
    /// <summary>How many rows each value receives.</summary>
    public static int[] CountsPerValue(int count, double[] percents, Sfc32 prng)
    {
        double cardPercent = 100.0 / count;
        var counts = new int[percents.Length];
        var remainders = new double[percents.Length];

        int filled = 0;
        for (int i = 0; i < percents.Length; i++)
        {
            double rawCells = percents[i] / cardPercent;
            int whole = (int)rawCells; // truncation toward zero, as Math.trunc does
            counts[i] = whole;
            remainders[i] = rawCells % 1;
            filled += whole;
        }

        int unallocated = count - filled;
        if (unallocated <= 0)
        {
            return counts;
        }

        // Remainder descending, index ascending — the order the reference walks in.
        int[] order = Enumerable.Range(0, remainders.Length)
            .OrderByDescending(i => remainders[i])
            .ThenBy(i => i)
            .ToArray();

        int at = 0;
        while (unallocated > 0 && at < order.Length)
        {
            double remainder = remainders[order[at]];
            int end = at;
            while (end < order.Length && remainders[order[end]] == remainder)
            {
                end++;
            }

            int groupSize = end - at;
            if (groupSize <= unallocated)
            {
                for (int k = at; k < end; k++)
                {
                    counts[order[k]]++;
                    unallocated--;
                }

                at = end;
                continue;
            }

            // More values tied than rows left: pick one at random per row, from a pool that
            // shrinks with each pick. One draw per row, which is what keeps the generator in step.
            var pool = new List<int>(order[at..end]);
            while (unallocated > 0)
            {
                int pick = (int)Math.Floor(prng.Next() * pool.Count);
                counts[pool[pick]]++;
                pool.RemoveAt(pick);
                unallocated--;
            }
        }

        return counts;
    }

    /// <summary>The materialised, shuffled sequence of <c>count</c> values.</summary>
    public static IReadOnlyList<T> Distribute<T>(
        int count, IReadOnlyList<T> values, double[] percents, Sfc32 prng)
    {
        int[] counts = CountsPerValue(count, percents, prng);
        var sequence = new List<T>(count);
        for (int i = 0; i < values.Count; i++)
        {
            for (int j = 0; j < counts[i]; j++)
            {
                sequence.Add(values[i]);
            }
        }

        return Shuffle(prng, sequence);
    }

    /// <summary>
    /// Fisher-Yates, from the end backwards.
    /// </summary>
    /// <remarks>
    /// The direction is not a detail. Walking the array the other way consumes the same number of
    /// draws but pairs them with different indices, so a port that flips it produces a shuffle
    /// that is equally valid and not the same one.
    /// </remarks>
    public static IReadOnlyList<T> Shuffle<T>(Sfc32 prng, IReadOnlyList<T> values)
    {
        var result = new List<T>(values);
        for (int i = result.Count - 1; i > 0; i--)
        {
            int j = (int)Math.Floor(prng.Next() * (i + 1));
            (result[i], result[j]) = (result[j], result[i]);
        }

        return result;
    }
}
