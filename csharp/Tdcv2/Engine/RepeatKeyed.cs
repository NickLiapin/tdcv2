using Tdcv2.Distribution;
using Tdcv2.Generators;
using Tdcv2.Prng;

namespace Tdcv2.Engine;

/// <summary>
/// <c>repeat=</c> built in memory the way the streaming engine builds it.
/// </summary>
/// <remarks>
/// A repeating column has two plans, not one. How MANY values a row keeps is an exact quota over
/// the run — permuted by <c>#replen</c>, so a row's length follows from its own position and
/// never from a running total over its predecessors. What those values ARE then depends on the
/// generator: a list is laid out over the whole slot space and read at the row's slots, while
/// anything drawn takes one seekable sub-stream per element, <c>#e0</c>, <c>#e1</c>, and so on.
/// <para>
/// Both halves are keyed by <c>(seed, streamId)</c> and mirror the reference's
/// <c>repeat-keyed.ts</c>. The older sequential builder in <see cref="Repeat.Build"/> stays for
/// the cases with nothing to key by — an inline generator inside a pack body.
/// </para>
/// </remarks>
internal static class RepeatKeyed
{
    /// <summary>
    /// A repeating column of DRAWN values.
    /// </summary>
    /// <remarks>
    /// Element k of a row comes off the row's own <c>#e{k}</c> stream, so the row still resolves
    /// alone — which is also what lets a worker render a range of rows without seeing the rest.
    /// </remarks>
    internal static IReadOnlyList<string> BuildDraws(
        Repeat.Spec spec,
        int count,
        PerRow.Stream stream,
        Func<int, Sfc32, bool[], string> oneElement,
        List<string>? flagTextOut)
    {
        (Repeat.Plan plan, int key) = LengthPlan(spec, count, stream);
        var result = new List<string>(count);
        for (int i = 0; i < count; i++)
        {
            int row = stream.RowAt(i);
            int keep = plan.LengthAt(Permute.Apply(i, count, key));
            var parts = new List<string>(keep);
            var marks = new List<string>(keep);
            for (int k = 0; k < keep; k++)
            {
                Sfc32 elementPrng = Seekable.Generator(stream.Seed, $"{stream.Id}#e{k}", row);
                var flag = new bool[1];
                parts.Add(oneElement(k, elementPrng, flag));
                marks.Add(flag[0] ? "true" : "false");
            }

            result.Add(Repeat.Join(parts, spec));

            // A parallel list of true/false, never a running total — accumulating it would mean
            // nothing — so it joins with the separator alone.
            flagTextOut?.Add(string.Join(spec.Separator, marks));
        }

        return result;
    }

    /// <summary>
    /// A repeating column of LISTED values.
    /// </summary>
    /// <remarks>
    /// The slot space covers every element of every row at once, laid out exactly and permuted;
    /// a row reads the slots its length plan gave it.
    /// </remarks>
    internal static IReadOnlyList<string> BuildLayout(
        Repeat.Spec spec,
        IReadOnlyList<string> values,
        double[] percents,
        int count,
        PerRow.Stream stream,
        Func<int, string, int, string>? modify)
    {
        (Repeat.Plan plan, int lengthKey) = LengthPlan(spec, count, stream);
        int slots = plan.TotalSlots;
        int[] counts = Hamilton.CountsPerValue(
            slots, percents, Prng.Prng.Create($"{stream.Seed}|{stream.Id}|pct"));
        int key = Permute.Key(stream.Seed, stream.Id);

        var cumHi = new int[counts.Length];
        int acc = 0;
        for (int i = 0; i < counts.Length; i++)
        {
            acc += counts[i];
            cumHi[i] = acc;
        }

        string ValueForSlot(int slot)
        {
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

            return lo < values.Count ? values[lo] : "";
        }

        var result = new List<string>(count);
        for (int i = 0; i < count; i++)
        {
            int p = Permute.Apply(i, count, lengthKey);
            int row = stream.RowAt(i);
            int start = plan.SlotStartAt(p);
            int keep = plan.LengthAt(p);
            var parts = new List<string>(keep);
            for (int k = 0; k < keep; k++)
            {
                string raw = ValueForSlot(Permute.Apply(start + k, slots, key));
                parts.Add(modify is null ? raw : modify(row, raw, k));
            }

            result.Add(Repeat.Join(parts, spec));
        }

        return result;
    }

    /// <summary>
    /// The <c>anomaly=</c>/<c>missing=</c> draw for one element of a repeating LISTED column.
    /// </summary>
    /// <remarks>
    /// One draw per element, pulled a whole row at a time — the budget is the row's maximum
    /// length, so which uniform element k gets does not depend on how long its row turned out.
    /// </remarks>
    internal static Func<int, int, double> ElementUniforms(
        PerRow.Stream stream, string purpose, int budget)
    {
        string id = stream.Id + purpose;
        int cachedRow = -1;
        double[]? cached = null;
        return (row, k) =>
        {
            if (cached is null || cachedRow != row)
            {
                cached = Seekable.Uniforms(stream.Seed, id, row, budget);
                cachedRow = row;
            }

            return k < cached.Length ? cached[k] : 1.0;
        };
    }

    /// <summary>
    /// How many values each position keeps, and where in the slot space they start.
    /// </summary>
    private static (Repeat.Plan Plan, int Key) LengthPlan(
        Repeat.Spec spec, int count, PerRow.Stream stream)
    {
        int[] counts = Hamilton.CountsPerValue(
            count,
            Repeat.LengthPercents(spec),
            Prng.Prng.Create($"{stream.Seed}|{stream.Id}|replen"));
        return (Repeat.MakePlan(spec, counts), Permute.Key(stream.Seed, $"{stream.Id}#replen"));
    }
}
