using System.Text.RegularExpressions;
using Tdcv2.Generators;
using Tdcv2.Model;
using Tdcv2.Packs;

namespace Tdcv2.Engine;

/// <summary>
/// <c>uniq="true"</c> on a SIMPLE sequence: every row gets a different value.
/// </summary>
/// <remarks>
/// <para>
/// A compound's uniq rearranges what was already drawn — it can keep the per-value proportions
/// because a tuple has room to vary. A single column has no such room: proportions and uniqueness
/// contradict each other the moment any value's share exceeds one row. So here uniq changes the
/// DRAW itself: values are sampled WITHOUT REPLACEMENT. A weighted pool keeps its meaning —
/// frequent values are more likely to make the cut — but nothing appears twice.
/// </para>
/// <para>
/// Draw budget: exactly one PRNG draw per pick, whatever the pool. The reference is
/// <c>typescript/src/sequence/uniq-simple.ts</c>; the numbers here must match it byte for byte.
/// </para>
/// </remarks>
internal static class UniqSimple
{
    private static readonly Regex IntRange = new(@"^\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*$");

    /// <summary>Pairwise-different values, or a refusal that names both numbers.</summary>
    internal static IReadOnlyList<string> Build(
        string name,
        Gen gen,
        int count,
        Prng.Sfc32 prng,
        DataPacks packs,
        string? locale,
        string? baseDir)
    {
        if (gen.Type == "number")
        {
            return UniqueNumbers(name, gen, count, prng);
        }

        (List<string> values, List<double> weights) = PoolOf(name, gen, packs, locale, baseDir);
        if (values.Count < count)
        {
            throw new InvalidOperationException(
                $"uniq: sequence \"{name}\" cannot produce {count} unique values — its source "
                + $"holds only {values.Count} distinct values. Add more values, or lower the "
                + "count.");
        }

        return SampleWithoutReplacement(values, weights, count, prng);
    }

    /// <summary>One draw per pick: a point in the remaining total weight, walked in order.</summary>
    private static List<string> SampleWithoutReplacement(
        List<string> values, List<double> weights, int count, Prng.Sfc32 prng)
    {
        double total = 0.0;
        foreach (double w in weights)
        {
            total += w;
        }

        var taken = new bool[weights.Count];
        var outValues = new List<string>(count);
        for (int k = 0; k < count; k++)
        {
            double target = prng.Next() * total;
            double acc = 0.0;
            int picked = -1;
            for (int i = 0; i < weights.Count; i++)
            {
                if (taken[i])
                {
                    continue;
                }
                acc += weights[i];
                if (target < acc)
                {
                    picked = i;
                    break;
                }
            }

            // Floating summation can leave the target a hair past the last value's edge; the
            // last remaining value is the only honest answer then.
            if (picked < 0)
            {
                for (int i = weights.Count - 1; i >= 0; i--)
                {
                    if (!taken[i])
                    {
                        picked = i;
                        break;
                    }
                }
            }

            if (picked < 0)
            {
                break;
            }
            taken[picked] = true;
            total -= weights[picked];
            outValues.Add(values[picked]);
        }

        return outValues;
    }

    /// <summary>Unique integers from a plain a..b range: draw normally, redraw on a repeat.</summary>
    private static List<string> UniqueNumbers(string name, Gen gen, int count, Prng.Sfc32 prng)
    {
        (long lo, long hi)? bounds = PlainIntRange(gen);
        if (bounds is null)
        {
            throw new InvalidOperationException(
                $"uniq: sequence \"{name}\" — {UnsupportedReason(gen)}");
        }

        (long lo, long hi) = bounds.Value;
        long size = hi - lo + 1;
        if (size < count)
        {
            throw new InvalidOperationException(
                $"uniq: sequence \"{name}\" cannot produce {count} unique values — the range "
                + $"{lo}..{hi} holds only {size} integers. Widen the range, or lower the count.");
        }

        var seen = new HashSet<long>();
        var outValues = new List<string>(count);
        while (outValues.Count < count)
        {
            long n = lo + (long)Math.Floor(prng.Next() * size);
            if (!seen.Add(n))
            {
                continue;
            }
            outValues.Add(n.ToString(System.Globalization.CultureInfo.InvariantCulture));
        }

        return outValues;
    }

    /// <summary>Why this gen cannot take the without-replacement path, for the refusal.</summary>
    private static string UnsupportedReason(Gen gen) =>
        gen.Type == "number"
            ? "its values are not a plain integer range — uniq supports value=\"a..b\" without "
              + "decimals=, distribution=, include=, exclude= or first_zero="
            : $"its values cannot be enumerated (type=\"{gen.Type}\") — uniq on a simple "
              + "sequence supports text lists, template packs, file columns and plain integer "
              + "ranges";

    private static (long, long)? PlainIntRange(Gen gen)
    {
        foreach (string blocked in new[] { "distribution", "decimals", "include", "exclude", "first_zero" })
        {
            if (!string.IsNullOrWhiteSpace(gen.Attr(blocked)))
            {
                return null;
            }
        }

        Match m = IntRange.Match(gen.Attr("value") ?? "");
        if (!m.Success)
        {
            return null;
        }

        long lo = long.Parse(m.Groups[1].Value, System.Globalization.CultureInfo.InvariantCulture);
        long hi = long.Parse(m.Groups[2].Value, System.Globalization.CultureInfo.InvariantCulture);
        return lo <= hi ? (lo, hi) : null;
    }

    /// <summary>The distinct values a gen can produce, with weights; duplicate strings merge.</summary>
    private static (List<string>, List<double>) PoolOf(
        string name, Gen gen, DataPacks packs, string? locale, string? baseDir)
    {
        if (gen.Type == "text" && string.IsNullOrWhiteSpace(gen.Attr("percent")))
        {
            var values = (gen.Attr("value") ?? "").Split(',').Select(s => s.Trim()).ToList();
            return MergeDuplicates(values, null);
        }

        if (gen.Type == "template")
        {
            string path = gen.Attr("value") ?? "";
            if (path is "person.b_day" or "date.range")
            {
                throw NotAList(name, path);
            }
            // `local=` on the <gen> picks the pack here too — a unique draw over a German
            // surname list must enumerate the German file, not the English one.
            string? packLocal = gen.Attr("local");
            DataPacks.Entry entry =
                packs.Load(path, string.IsNullOrWhiteSpace(packLocal) ? locale : packLocal);
            if (entry.IsGenerator || entry.Values.Count == 0)
            {
                throw NotAList(name, path);
            }
            List<double>? weights = entry.Weighted ? entry.Percents!.ToList() : null;
            return MergeDuplicates(entry.Values.ToList(), weights);
        }

        if (gen.Type == "file" && string.IsNullOrWhiteSpace(gen.Attr("row")))
        {
            FileGen.Weighted? weighted = FileGen.LoadWeighted(gen.Attrs, baseDir, packs.DataRoots);
            if (weighted is not null)
            {
                return MergeDuplicates(weighted.Values.ToList(), weighted.Percents.ToList());
            }
            return MergeDuplicates(
                FileGen.Load(gen.Attrs, baseDir, packs.DataRoots).ToList(), null);
        }

        throw new InvalidOperationException(
            $"uniq: sequence \"{name}\" — {UnsupportedReason(gen)}");
    }

    private static InvalidOperationException NotAList(string name, string path) =>
        new(
            $"uniq: sequence \"{name}\" — template \"{path}\" does not resolve to a value "
            + "list, so its values cannot be enumerated for a unique draw");

    /// <summary>Merge duplicate strings, summing weights (missing weights count as 1).</summary>
    private static (List<string>, List<double>) MergeDuplicates(
        List<string> values, List<double>? weights)
    {
        var index = new Dictionary<string, int>();
        var outValues = new List<string>();
        var outWeights = new List<double>();
        for (int i = 0; i < values.Count; i++)
        {
            string value = values[i];
            double weight = weights?[i] ?? 1.0;
            if (index.TryGetValue(value, out int at))
            {
                outWeights[at] += weight;
            }
            else
            {
                index[value] = outValues.Count;
                outValues.Add(value);
                outWeights.Add(weight);
            }
        }

        return (outValues, outWeights);
    }
}
