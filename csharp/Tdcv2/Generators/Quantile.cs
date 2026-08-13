using System.Globalization;
using Tdcv2.Prng;
using Distributions = Tdcv2.Stats.Distribution;

namespace Tdcv2.Generators;

/// <summary>
/// A file read as a QUANTILE FUNCTION rather than as a bag of values.
/// </summary>
/// <remarks>
/// <para><c>&lt;gen type="file" src="amounts.txt" read="quantile"/&gt;</c> — the file is one
/// measurement per line, the engine sorts it once, and a row lands anywhere on that sorted ruler,
/// interpolating between two neighbours when it falls between them.</para>
///
/// <para>Why this exists beside <c>weight=</c>: a weighted read honours declared shares exactly
/// and is the right answer for a countable value, but it can only ever emit values that were
/// written in the file. Stretch a thousand-line sample to a million rows and a thousand distinct
/// values come back with nothing between them — a comb, and for a MEASURED quantity that comb is
/// structure the real data never had.</para>
///
/// <para>Why it fits the engine: one uniform per row, and the answer depends on that row alone.
/// So it streams, it parallelises, and it needs no totals up front — unlike <c>weight=</c>, which
/// is in-memory precisely because an exact quota has to see the whole file first.</para>
/// </remarks>
internal static class Quantile
{
    /// <summary>A source read as a quantile function: sorted values, and how they were written.</summary>
    /// <param name="Sorted">The sample, ascending. Duplicates are kept — they are what makes an atom.</param>
    /// <param name="Decimals">The most decimal places any line used, so the answer is written like the source.</param>
    internal sealed record Source(double[] Sorted, int Decimals);

    /// <summary>Parse and sort the file's values.</summary>
    /// <remarks>
    /// A line that is not a number is refused rather than skipped: dropping it would change the
    /// very shape the file was chosen for, and silently. The message names the line, because in a
    /// file of ten thousand numbers "one of them is not a number" is not an answer anyone can act
    /// on.
    /// </remarks>
    internal static Source Read(IReadOnlyList<string> values, string src)
    {
        if (values.Count == 0)
        {
            throw new ArgumentException(
                $"file generator: read=\"quantile\" needs values, and \"{src}\" has none");
        }

        var sorted = new double[values.Count];
        int decimals = 0;
        for (int i = 0; i < values.Count; i++)
        {
            string text = values[i].Trim();
            if (text.Length == 0
                || !double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out double v)
                || double.IsNaN(v) || double.IsInfinity(v))
            {
                throw new ArgumentException(
                    "file generator: read=\"quantile\" reads the file as measurements, and line "
                    + $"{i + 1} of \"{src}\" is \"{values[i]}\", which is not a number. Every value "
                    + "has to be one, because the sorted sample IS the distribution.");
            }

            sorted[i] = v;
            decimals = Math.Max(decimals, DecimalsOf(text));
        }

        Array.Sort(sorted);
        return new Source(sorted, decimals);
    }

    /// <summary>How many digits this text wrote after the point — <c>12.50</c> is two, <c>12</c> is none.</summary>
    private static int DecimalsOf(string text)
    {
        int dot = text.IndexOf('.');
        if (dot < 0 || text.IndexOf('e') >= 0 || text.IndexOf('E') >= 0)
        {
            // An exponent would make the count meaningless, so such a value asks for nothing.
            return 0;
        }

        return text.Length - dot - 1;
    }

    /// <summary>The value at probability <paramref name="u"/>, interpolating between neighbours.</summary>
    /// <remarks>
    /// <para>Each observation sits at <c>(i + 0.5) / n</c> — the MIDDLE of the slice of probability
    /// it owns — rather than at <c>i / (n - 1)</c>, which is where the ENDS of the sample would be.
    /// That is not a detail of taste: the end convention gives the smallest and largest
    /// observations exactly half the weight they should have, because there is nothing on the far
    /// side of them to ramp from. Measured on the reference before it was fixed, over a hundred
    /// distinct values that each owe 1.000%: first 0.505%, middle 1.010%, last 0.505%.</para>
    ///
    /// <para>It is also the convention the ROW axis already uses, where row <c>i</c> reads
    /// <c>(slot + 0.5) / count</c>. One rule on both axes.</para>
    /// </remarks>
    internal static double At(double[] sorted, double u)
    {
        int n = sorted.Length;
        if (n == 1)
        {
            return sorted[0];
        }

        double p = Math.Min(n - 1, Math.Max(0.0, (u * n) - 0.5));
        int lo = (int)Math.Floor(p);
        double low = sorted[lo];
        if (lo + 1 >= n)
        {
            return sorted[n - 1];
        }

        // A repeated value makes low == high, and the interpolation returns it unchanged — that is
        // how an atom keeps its plateau while everything around it stays continuous.
        return low + ((p - lo) * (sorted[lo + 1] - low));
    }

    /// <summary>The finished cell: written like the source unless the config said otherwise.</summary>
    internal static string Render(double value, int decimals) => Distributions.ToFixed(value, decimals);

    /// <summary>The EXACT sweep: every row takes its own point on the ruler, no dice at all.</summary>
    /// <remarks>
    /// <para>Row <c>i</c> is sent to slot <c>permute(i, count, key)</c> and reads probability
    /// <c>(slot + 0.5) / count</c>. Over the whole run the slots are the numbers <c>0 … count-1</c>
    /// exactly once each, so the generated column reproduces the sample's distribution with no
    /// sampling noise whatever.</para>
    ///
    /// <para>The permutation is what keeps it usable: without it the column would come out sorted.
    /// It is the same seekable, seeded permutation <c>uniq</c> and the exact <c>percent=</c> quota
    /// already use, so a row still costs nothing to compute on its own.</para>
    /// </remarks>
    internal static string ExactAt(Source source, int decimals, int count, int key, int position)
    {
        int slot = Permute.Apply(position, count, key);
        return Render(At(source.Sorted, (slot + 0.5) / count), decimals);
    }

    /// <summary><c>read="quantile"</c>: the file is a distribution, not a bag of values.</summary>
    internal static bool IsQuantile(IReadOnlyDictionary<string, string> attrs) =>
        (attrs.GetValueOrDefault("read") ?? "").Trim() == "quantile";

    /// <summary><c>sample="exact"</c>: cover the distribution evenly rather than draw from it.</summary>
    internal static bool IsExactSample(IReadOnlyDictionary<string, string> attrs) =>
        (attrs.GetValueOrDefault("sample") ?? "").Trim() == "exact";

    /// <summary><c>decimals=</c> when the config declared one, otherwise the source's own precision.</summary>
    /// <remarks>
    /// Interpolating between 31 and 40 gives 35.4, which is right for money and wrong for a count
    /// of orders. Rather than guess, the answer is printed with the same number of decimal places
    /// as the SOURCE.
    /// </remarks>
    internal static int DecimalsFor(IReadOnlyDictionary<string, string> attrs, Source source)
    {
        string raw = (attrs.GetValueOrDefault("decimals") ?? "").Trim();
        return raw.Length == 0
            || !int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out int d)
            ? source.Decimals
            : d;
    }
}
