using System.Globalization;
using System.Text.RegularExpressions;
using Tdcv2.Distribution;
using Tdcv2.Prng;

namespace Tdcv2.Generators;

/// <summary>
/// <c>repeat="N"</c> or <c>repeat="A..B"</c> — several values in one cell instead of one.
/// </summary>
/// <remarks>
/// <para>
/// A customer with three orders, a post with a handful of tags. The values are joined by
/// <c>separator</c> in text output, and <c>each=</c> on a line walks them.
/// </para>
/// <para>
/// The whole difficulty is that a row has to be computable without computing the rows before it. A
/// variable number of values would mean a variable number of draws, which breaks that. The way out
/// is to decide the <b>lengths first</b>, as an exact quota over the whole run: once the lengths are
/// known the total number of value slots is a fixed number, so nothing is generated and discarded,
/// and a row finds its slice from its own position rather than from a running total over its
/// predecessors.
/// </para>
/// <para>
/// Deciding lengths first also keeps <c>percent=</c> exact. The obvious alternative — give every row
/// <c>max</c> slots and throw away the extras — spends quota on the discarded slots, and a declared
/// 50/50 split quietly stops coming out 50/50.
/// </para>
/// </remarks>
public static class Repeat
{
    /// <summary>A ceiling, so one careless attribute cannot make a run a thousand times slower.</summary>
    public const int MaxRepeat = 64;

    public const string DefaultSeparator = ",";

    /// <summary>Bounded retries before a <c>distinct</c> draw admits it cannot find a fresh value.</summary>
    public const int DistinctMaxTries = 64;

    /// <param name="Distinct">
    /// <c>distinct=</c>: the row's values are drawn WITHOUT replacement.
    /// <para>
    /// This changes the regime the column is built in, which is why <c>percent</c> is refused
    /// beside it. Ordinarily a listed column lays its values out over the whole run as an exact
    /// quota; under <c>distinct</c> it draws per row instead, because holding an exact whole-run
    /// quota AND a per-row guarantee at once costs either streaming or the randomness of the
    /// sample. Frequencies stay approximate, rows stay independent.
    /// </para>
    /// </param>
    /// <param name="Lengths">
    /// <c>lengths=</c>: the share of rows that get each possible length, <c>Min</c> first.
    /// <para>
    /// Without it every length is equally likely, and exactly so — the lengths are laid out as a
    /// Hamilton quota, which is the wrong shape for every real one-to-many relationship. The
    /// shares live HERE, in the spec, rather than in a per-row draw: a per-row count would make a
    /// row's draws depend on the rows before it.
    /// </para>
    /// </param>
    public readonly record struct Spec(
        int Min, int Max, string Separator, string? Accumulate, bool Distinct,
        double[]? Lengths = null);

    /// <summary><c>null</c> when the generator has no <c>repeat</c>, which is the ordinary case.</summary>
    public static Spec? Parse(IReadOnlyDictionary<string, string> attrs)
    {
        string? raw = attrs.GetValueOrDefault("repeat");
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        string text = raw.Trim();
        int dots = text.IndexOf("..", StringComparison.Ordinal);
        string minText = dots < 0 ? text : text[..dots].Trim();
        string maxText = dots < 0 ? text : text[(dots + 2)..].Trim();

        int min = Whole(minText, raw, "minimum");
        int max = Whole(maxText, raw, "maximum");
        if (min < 0)
        {
            throw new ArgumentException($"repeat: minimum of \"{raw}\" must not be negative");
        }

        if (max < min)
        {
            throw new ArgumentException($"repeat: \"{raw}\" has its maximum below its minimum");
        }

        if (max > MaxRepeat)
        {
            throw new ArgumentException(
                $"repeat: maximum of \"{raw}\" must not exceed {MaxRepeat}");
        }

        return new Spec(
            min,
            max,
            attrs.GetValueOrDefault("separator", DefaultSeparator),
            Accumulate.Read(attrs),
            ReadDistinct(attrs),
            ParseLengths(attrs.GetValueOrDefault("lengths"), min, max));
    }

    /// <summary><c>lengths="40,25,15,10,7,3"</c> — one share per possible length, <c>min</c> first.</summary>
    /// <remarks>
    /// One share per length and a sum of 100, both refused rather than repaired: a fan-out
    /// written with five shares for six lengths is a config whose author is thinking of a
    /// different range, and quietly filling the sixth in would hide that.
    /// </remarks>
    public static double[]? ParseLengths(string? raw, int min, int max)
    {
        string text = (raw ?? "").Trim();
        if (text.Length == 0)
        {
            return null;
        }

        string[] parts = text.Split(',')
            .Select(p => p.Trim())
            .Where(p => p.Length > 0)
            .ToArray();
        int groups = Math.Max(1, max - min + 1);
        if (parts.Length != groups)
        {
            throw new ArgumentException(
                $"lengths: {parts.Length} share(s) for {groups} possible length(s) — "
                + $"repeat=\"{min}..{max}\" can produce {min} to {max} values, so it needs one "
                + "share for each");
        }

        var values = new double[parts.Length];
        for (int i = 0; i < parts.Length; i++)
        {
            if (!double.TryParse(
                    parts[i], NumberStyles.Float, CultureInfo.InvariantCulture, out double v)
                || double.IsNaN(v) || double.IsInfinity(v) || v < 0)
            {
                throw new ArgumentException(
                    $"lengths: share for length {min + i} is not a number >= 0");
            }

            values[i] = v;
        }

        double total = values.Sum();
        if (Math.Abs(total - 100.0) > 1e-9)
        {
            throw new ArgumentException(
                "lengths: shares sum to "
                + total.ToString("R", CultureInfo.InvariantCulture) + ", expected 100");
        }

        return values;
    }

    /// <summary>The same attributes without <c>repeat</c>, for building one element at a time.</summary>
    public static IReadOnlyDictionary<string, string> Without(
        IReadOnlyDictionary<string, string> attrs)
    {
        var result = new Dictionary<string, string>(attrs, StringComparer.Ordinal);
        result.Remove("repeat");
        return result;
    }

    /// <summary>
    /// Produce <paramref name="count"/> rows of joined values.
    /// </summary>
    /// <remarks>
    /// <paramref name="buildFlat"/> is the caller's ordinary "give me N values" builder, already
    /// applying anomaly, missing and formatting per value — which is exactly why those come out per
    /// element here with no extra work. The draw order is fixed: all the length draws first, then
    /// the values. Both engines depend on it staying that way.
    /// </remarks>
    /// <summary>
    /// Where each row's values sit in one flat run of slots.
    /// </summary>
    /// <remarks>
    /// The lengths are decided before any value exists, so a row's slice follows from its own
    /// position rather than from a running total over the rows before it. That is what lets the
    /// streaming engine answer row nine million without having built the first eight.
    /// </remarks>
    public sealed class Plan
    {
        private readonly int min;
        private readonly int[] rowCumLo;
        private readonly int[] slotOffset;

        internal Plan(int min, int totalSlots, int[] rowCumLo, int[] slotOffset)
        {
            this.min = min;
            this.TotalSlots = totalSlots;
            this.rowCumLo = rowCumLo;
            this.slotOffset = slotOffset;
        }

        public int TotalSlots { get; }

        /// <summary>How many values the row at permuted position <paramref name="p"/> keeps.</summary>
        public int LengthAt(int p) => this.min + this.GroupOf(p);

        /// <summary>The first slot the row at permuted position <paramref name="p"/> owns.</summary>
        public int SlotStartAt(int p)
        {
            int j = this.GroupOf(p);
            return this.slotOffset[j] + ((p - this.rowCumLo[j]) * (this.min + j));
        }

        private int GroupOf(int p)
        {
            int lo = 0;
            int hi = this.rowCumLo.Length - 1;
            while (lo < hi)
            {
                int mid = (lo + hi + 1) / 2;
                if (p >= this.rowCumLo[mid])
                {
                    lo = mid;
                }
                else
                {
                    hi = mid - 1;
                }
            }

            return lo;
        }
    }

    /// <summary>
    /// Lay out the rows whose lengths were apportioned as <paramref name="counts"/>.
    /// </summary>
    public static Plan MakePlan(Spec spec, int[] counts)
    {
        int groups = Math.Max(1, spec.Max - spec.Min + 1);
        var rowCumLo = new int[groups];
        var slotOffset = new int[groups];
        int rowAcc = 0;
        int slotAcc = 0;
        for (int j = 0; j < groups; j++)
        {
            rowCumLo[j] = rowAcc;
            slotOffset[j] = slotAcc;
            int c = j < counts.Length ? Math.Max(0, counts[j]) : 0;
            rowAcc += c;
            slotAcc += c * (spec.Min + j);
        }

        return new Plan(spec.Min, slotAcc, rowCumLo, slotOffset);
    }

    /// <summary>
    /// An even split across the possible lengths — the shares <see cref="MakePlan"/> quotas by.
    /// </summary>
    public static double[] LengthPercents(Spec spec)
    {
        if (spec.Lengths is { } declared)
        {
            return declared;
        }

        int groups = Math.Max(1, spec.Max - spec.Min + 1);
        return Enumerable.Repeat(100.0 / groups, groups).ToArray();
    }

    public static IReadOnlyList<string> Build(
        Spec spec, int count, Sfc32 prng, Func<int, IReadOnlyList<string>> buildFlat)
    {
        int groups = spec.Max - spec.Min + 1;

        // The lengths, as an exact quota rather than a per-row coin flip — `lengths=` when the
        // config declared a shape, an even split otherwise.
        var groupIds = new List<int>(groups);
        double[] percents = LengthPercents(spec);
        for (int j = 0; j < groups; j++)
        {
            groupIds.Add(j);
        }

        IReadOnlyList<int> perRowGroup = Hamilton.Distribute(count, groupIds, percents, prng);

        var counts = new int[groups];
        foreach (int j in perRowGroup)
        {
            counts[j]++;
        }

        // Each length group owns one contiguous block of slots, so a row's slice follows from its
        // rank inside its own group and from nothing else.
        var offsets = new int[groups];
        int acc = 0;
        for (int j = 0; j < groups; j++)
        {
            offsets[j] = acc;
            acc += counts[j] * (spec.Min + j);
        }

        int totalSlots = acc;

        var nextRank = new int[groups];
        var starts = new int[count];
        var keeps = new int[count];
        for (int i = 0; i < count; i++)
        {
            int j = perRowGroup[i];
            int length = spec.Min + j;
            starts[i] = offsets[j] + (nextRank[j] * length);
            nextRank[j]++;
            keeps[i] = length;
        }

        IReadOnlyList<string> flat = buildFlat(totalSlots);

        var result = new List<string>(count);
        for (int i = 0; i < count; i++)
        {
            var parts = new List<string>(keeps[i]);
            for (int k = 0; k < keeps[i]; k++)
            {
                int at = starts[i] + k;
                parts.Add(at < flat.Count ? flat[at] : "");
            }

            result.Add(Join(parts, spec));
        }

        return result;
    }

    /// <summary>
    /// Split a cell back into the elements <c>each=</c> walks.
    /// </summary>
    /// <remarks>
    /// An empty cell is an empty list, not a list holding one blank. Splitting <c>""</c> would
    /// invent a phantom element and emit an order row for a customer who placed none.
    /// </remarks>
    public static IReadOnlyList<string> Split(string? cell, string separator) =>
        string.IsNullOrEmpty(cell)
            ? Array.Empty<string>()
            : Regex.Split(cell, Regex.Escape(separator));

    /// <summary>
    /// The key for one element: card <paramref name="card"/> (1-based), position
    /// <paramref name="position"/> (1-based).
    /// </summary>
    /// <remarks>
    /// <para>
    /// Each card owns a block of <paramref name="stride"/> keys and each list owns a lane inside it.
    /// Both parts are needed — a config with two repeating sequences writes both into the same child
    /// table, and one shared counter would make their keys collide.
    /// </para>
    /// <para>
    /// Derived from the card index alone, so a row still resolves without knowing anything about the
    /// rows before it. That leaves gaps when a card holds fewer elements than its list allows, which
    /// is the deliberate trade: keys that increase down the file read better in a dump than gapless
    /// keys that jump around.
    /// </para>
    /// </remarks>
    public static long ItemKey(int card, int position, int lane, int stride) =>
        ((long)(card - 1) * stride) + lane + position;

    /// <summary>
    /// The last step every repeat list goes through: accumulate, then join.
    ///
    /// One method rather than three copies because there are three places a list becomes
    /// a cell — one in the in-memory engine and two in the streaming one — and a running
    /// total that appeared on one engine and not the other is the failure this shape
    /// prevents.
    /// </summary>
    public static string Join(IReadOnlyList<string> parts, Spec spec)
    {
        IReadOnlyList<string> running =
            spec.Accumulate is null ? parts : Accumulate.Apply(parts, spec.Accumulate);
        return string.Join(spec.Separator, running);
    }

    private static int Whole(string text, string raw, string label) =>
        int.TryParse(text, out int value)
            ? value
            : throw new ArgumentException(
                $"repeat: {label} of \"{raw}\" must be a whole number");

    /// <summary><c>distinct="true"</c>. Anything but the two words is refused by the validator.</summary>
    public static bool ReadDistinct(IReadOnlyDictionary<string, string> attrs) =>
        attrs.GetValueOrDefault("distinct", "").Trim() == "true";

    /// <summary>Draw <paramref name="keep"/> DIFFERENT values from a weighted list.</summary>
    /// <remarks>
    /// <para>
    /// Weights survive — a frequent name is still likelier to be picked first — but the exact
    /// whole-run quota does not, which is the documented price of <c>distinct</c> and the reason
    /// <c>percent</c> may not appear beside it.
    /// </para>
    /// <para>
    /// Running out throws rather than returning a short list: a cell quietly shorter than
    /// <c>repeat</c> asked for is the silent-and-wrong outcome the feature exists to prevent.
    /// </para>
    /// </remarks>
    public static List<string> DrawDistinct(
        IReadOnlyList<string> values,
        IReadOnlyList<double> weights,
        int keep,
        Func<double> nextUniform,
        string describePool)
    {
        if (keep > values.Count)
        {
            throw new ArgumentException(
                $"repeat with distinct=\"true\" asks for {keep} different values, but "
                    + $"{describePool} holds only {values.Count}");
        }

        // Weighted draw without replacement: pick against the remaining weight, then swap the
        // winner out with the last live candidate. What remains is a pure function of the picks
        // already made, so the draw stays deterministic.
        var pool = new List<string>(values);
        var w = new double[values.Count];
        for (var i = 0; i < w.Length; i++)
        {
            w[i] = weights != null && weights.Count == values.Count ? weights[i] : 1.0;
        }

        var total = 0.0;
        foreach (var x in w)
        {
            if (x > 0)
            {
                total += x;
            }
        }

        var outp = new List<string>(keep);
        for (var picked = 0; picked < keep; picked++)
        {
            var size = pool.Count - picked;
            var index = size - 1;
            if (total > 0)
            {
                var target = nextUniform() * total;
                for (var i = 0; i < size; i++)
                {
                    target -= Math.Max(0, w[i]);
                    if (target < 0)
                    {
                        index = i;
                        break;
                    }
                }
            }
            else
            {
                index = Math.Min(size - 1, (int)(nextUniform() * size));
            }

            var chosen = pool[index];
            outp.Add(chosen);
            total -= Math.Max(0, w[index]);
            var last = size - 1;
            pool[index] = pool[last];
            w[index] = w[last];
            pool[last] = chosen;
        }

        return outp;
    }

    /// <summary>Ask <paramref name="draw"/> for a value that is not already in <paramref name="seen"/>.</summary>
    /// <remarks>
    /// <para>
    /// A drawn generator has no pool to draw down, so <c>distinct</c> is rejection sampling.
    /// <paramref name="draw"/> receives the sub-stream suffix: empty for the first attempt (so a
    /// config WITHOUT <c>distinct</c> reads the very same stream), then <c>r1</c>, <c>r2</c> and
    /// so on.
    /// </para>
    /// <para>
    /// Exhausting the tries throws rather than returning a duplicate or a short list.
    /// <c>regex="[01]"</c> under <c>repeat="5"</c> cannot be satisfied by anything, and saying so
    /// is the entire point of the attribute.
    /// </para>
    /// </remarks>
    public static string RedrawUntilFresh(
        IReadOnlyList<string> seen, string genType, Func<string, string> draw) =>
        RedrawUntilFreshAt(seen, genType, draw).Value;

    /// <summary>The same loop, reporting WHICH sub-stream won.</summary>
    /// <remarks>
    /// The anomaly flag needs this. A flag is resolved by re-running the element's draw and
    /// asking whether it spiked — and under <c>distinct</c> the value that survived may have come
    /// from <c>r3</c> rather than the first attempt. Resolving the flag on the first attempt would
    /// describe a value that was thrown away: the list would say <c>false</c> beside a number that
    /// plainly spiked, which is worse than no flag at all.
    /// </remarks>
    public static (string Value, string Suffix) RedrawUntilFreshAt(
        IReadOnlyList<string> seen, string genType, Func<string, string> draw)
    {
        var suffix = "";
        var value = draw(suffix);
        for (var attempt = 1; seen.Contains(value) && attempt <= DistinctMaxTries; attempt++)
        {
            suffix = $"r{attempt}";
            value = draw(suffix);
        }

        if (seen.Contains(value))
        {
            throw new ArgumentException(
                $"repeat with distinct=\"true\" could not find {seen.Count + 1} different values "
                    + $"for <gen type=\"{genType}\"> after {DistinctMaxTries} tries — the "
                    + "generator does not produce that many");
        }

        return (value, suffix);
    }
}
