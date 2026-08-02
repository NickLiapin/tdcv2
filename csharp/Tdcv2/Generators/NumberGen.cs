using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using Tdcv2.Distribution;
using Tdcv2.Prng;

namespace Tdcv2.Generators;

/// <summary>
/// <c>&lt;gen type="number"/&gt;</c> — digits, ranges and decimals.
/// </summary>
/// <remarks>
/// <para>
/// The paths ported so far are the ones the shared cases exercise: a plain width
/// (<c>length="6"</c>), one or more inclusive ranges (<c>value="1..9"</c>,
/// <c>value="[1..9],[20..30]"</c>), and decimals. Zero-padding is implied by how the bounds were
/// written, never by their magnitude — <c>00..99</c> pads and <c>0..99</c> does not.
/// </para>
/// <para>
/// <c>include=</c> and <c>exclude=</c> are interval arithmetic rather than enumeration, so
/// <c>value="1..1000000000" exclude="7"</c> stays instant instead of listing a billion numbers to
/// drop one. <c>percent=</c> apportions rows between length groups exactly, over the whole column.
/// </para>
/// </remarks>
public static class NumberGen
{
    private static readonly Regex RangePattern = new(@"^\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*$", RegexOptions.Compiled);
    private static readonly Regex LengthRange = new(@"^(\d+)\s*-\s*(\d+)$", RegexOptions.Compiled);
    private static readonly Regex SingleInt = new(@"^-?\d+$", RegexOptions.Compiled);

    /// <summary>An inclusive integer range; <c>Width</c> is the zero-padding the source implied.</summary>
    public readonly record struct Range(long Min, long Max, int Width);

    /// <summary>One entry of <c>length="2,10-12"</c>: a fixed width, or a range of them.</summary>
    public readonly record struct LengthChoice(int Min, int Max);

    public static IReadOnlyList<string> Generate(
        IReadOnlyDictionary<string, string> attrs, int count, Sfc32 prng)
    {
        string rangeSpec = (attrs.GetValueOrDefault("value") ?? "").Trim();
        IReadOnlyList<Range> ranges = rangeSpec.Length == 0
            ? Array.Empty<Range>()
            : ParseRanges(rangeSpec);

        bool hasExplicitLength = attrs.ContainsKey("length");
        IReadOnlyList<LengthChoice> lengthChoices = hasExplicitLength
            ? ParseLengthChoices(attrs["length"])
            : ranges.Count == 0
                ? new[] { new LengthChoice(1, 1) }
                : Array.Empty<LengthChoice>();

        string? firstZero = attrs.GetValueOrDefault("first_zero");
        bool allowLeadingZero = firstZero is not null
            ? bool.Parse(firstZero.Trim())
            : ranges.Count > 0 || !hasExplicitLength;

        string? percent = attrs.GetValueOrDefault("percent");
        if (percent is not null && lengthChoices.Count <= 1)
        {
            // Validates the mask and reports the same complaint the reference does. It cannot
            // select anything with one choice, but a mask that is wrong should still say so.
            PercentMask.Expand(percent, lengthChoices.Count);
        }

        string? include = attrs.GetValueOrDefault("include");
        string? exclude = attrs.GetValueOrDefault("exclude");
        bool hasModifiers =
            !string.IsNullOrWhiteSpace(include) || !string.IsNullOrWhiteSpace(exclude);
        IReadOnlyList<Interval>? allowed = null;
        int allowedWidth = 0;
        if (hasModifiers)
        {
            if (ranges.Count == 0)
            {
                throw new ArgumentException(
                    "number generator: include/exclude require a numeric range in \"value\", "
                    + "e.g. value=\"0..9\"");
            }

            allowed = ComputeAllowed(ranges, include, exclude);
            allowedWidth = ranges.Where(r => r.Width > 0).Select(r => r.Width).FirstOrDefault();
        }

        int decimals = ParseDecimals(attrs.GetValueOrDefault("decimals"));
        if (decimals > 0 && ranges.Count > 0 && allowed is null)
        {
            var decimalValues = new List<string>(count);
            for (int i = 0; i < count; i++)
            {
                decimalValues.Add(RandomDecimal(ranges, decimals, prng));
            }

            return decimalValues;
        }

        int[] widths = MaterializeWidths(count, lengthChoices, percent, prng);
        var result = new List<string>(count);
        for (int i = 0; i < count; i++)
        {
            int width = widths[i];
            result.Add(allowed is not null
                ? DrawGuarded(allowed, width > 0 ? width : allowedWidth, allowLeadingZero, prng)
                : ranges.Count == 0
                    ? DigitString(width, allowLeadingZero, prng)
                    : DrawGuardedRange(ranges, width, allowLeadingZero, prng));
        }

        return result;
    }

    /// <summary>
    /// The length groups <c>percent=</c> apportions between, or <c>null</c> when there is no split.
    /// </summary>
    /// <remarks>
    /// Which group a row lands in is an exact quota over the whole column, so the streaming engine
    /// has to plan it rather than draw it — with one row to apportion, the largest share takes
    /// everything and an 85/15 split silently becomes 100/0.
    /// </remarks>
    public static IReadOnlyList<LengthChoice>? WeightedLengthChoices(
        IReadOnlyDictionary<string, string> attrs)
    {
        string? length = attrs.GetValueOrDefault("length");
        string? percent = attrs.GetValueOrDefault("percent");
        if (length is null || string.IsNullOrWhiteSpace(percent))
        {
            return null;
        }

        try
        {
            IReadOnlyList<LengthChoice> choices = ParseLengthChoices(length);
            return choices.Count > 1 ? choices : null;
        }
        catch (ArgumentException)
        {
            // Not a length spec this engine can split on; the ordinary path will report it.
            return null;
        }
    }

    /// <summary>The same attributes with one length group pinned, for a row already assigned to it.</summary>
    public static IReadOnlyDictionary<string, string> PinLength(
        IReadOnlyDictionary<string, string> attrs, LengthChoice group)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (KeyValuePair<string, string> entry in attrs)
        {
            if (entry.Key != "percent" && entry.Key != "length")
            {
                result[entry.Key] = entry.Value;
            }
        }

        result["length"] = group.Min == group.Max
            ? group.Min.ToString(CultureInfo.InvariantCulture)
            : $"{group.Min}-{group.Max}";
        return result;
    }

    public static IReadOnlyList<Range> ParseRanges(string source)
    {
        string spec = source.Trim();
        if (spec.Length == 0)
        {
            throw new ArgumentException("number generator: range is empty");
        }

        if (spec == "bit")
        {
            return new[] { new Range(0, 1, 0) };
        }

        if (!spec.Contains('[') && !spec.Contains(']'))
        {
            return new[] { ParseRange(spec) };
        }

        var ranges = new List<Range>();
        string rest = spec;
        while (rest.Length > 0)
        {
            // Found by index, not by a regex. `^\[\s*([^\]]+?)\s*]` said the same thing,
            // but `\s*` and `[^\]]+?` can both match a space, so an unclosed bracket made
            // the engine try every way to split the run between them: `value="["` followed
            // by four thousand spaces took a minute. A generator hanging on its own config
            // is not a slow path, it is a stopped program.
            int close = rest.StartsWith('[') ? rest.IndexOf(']') : -1;
            if (close < 0)
            {
                throw new ArgumentException($"number generator: invalid range list \"{source}\"");
            }

            ranges.Add(ParseRange(rest[1..close].Trim()));
            rest = rest[(close + 1)..].Trim();
            if (rest.Length == 0)
            {
                break;
            }

            if (!rest.StartsWith(",", StringComparison.Ordinal))
            {
                throw new ArgumentException($"number generator: invalid range list \"{source}\"");
            }

            rest = rest[1..].Trim();
            if (rest.Length == 0)
            {
                throw new ArgumentException($"number generator: invalid range list \"{source}\"");
            }
        }

        return ranges;
    }

    private static Range ParseRange(string range)
    {
        Match m = RangePattern.Match(range);
        if (!m.Success || m.Length != range.Length)
        {
            throw new ArgumentException(
                $"number generator: invalid range \"{range}\" (expected MIN..MAX)");
        }

        string minText = m.Groups[1].Value;
        string maxText = m.Groups[2].Value;
        long min = long.Parse(minText, CultureInfo.InvariantCulture);
        long max = long.Parse(maxText, CultureInfo.InvariantCulture);
        if (min > max)
        {
            throw new ArgumentException($"number generator: invalid numeric range \"{range}\"");
        }

        return new Range(min, max, InferWidth(minText, maxText));
    }

    /// <summary>Zero-padding is implied by the way the bounds were written, never by magnitude.</summary>
    private static int InferWidth(string minText, string maxText)
    {
        if (minText.StartsWith("-", StringComparison.Ordinal)
            || maxText.StartsWith("-", StringComparison.Ordinal))
        {
            return 0;
        }

        bool hasLeadingZeros =
            (minText.Length > 1 && minText.StartsWith("0", StringComparison.Ordinal))
            || (maxText.Length > 1 && maxText.StartsWith("0", StringComparison.Ordinal));
        return hasLeadingZeros ? Math.Max(minText.Length, maxText.Length) : 0;
    }

    public static IReadOnlyList<LengthChoice> ParseLengthChoices(string source)
    {
        var choices = new List<LengthChoice>();
        foreach (string rawPart in source.Split(','))
        {
            string part = rawPart.Trim();
            if (part.Length == 0)
            {
                continue;
            }

            Match m = LengthRange.Match(part);
            if (m.Success && m.Length == part.Length)
            {
                choices.Add(new LengthChoice(
                    int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture),
                    int.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture)));
                continue;
            }

            if (!int.TryParse(part, NumberStyles.Integer, CultureInfo.InvariantCulture, out int one))
            {
                throw new ArgumentException($"number generator: invalid length \"{part}\"");
            }

            choices.Add(new LengthChoice(one, one));
        }

        if (choices.Count == 0)
        {
            throw new ArgumentException($"number generator: invalid length \"{source}\"");
        }

        return choices;
    }

    private static int[] MaterializeWidths(
        int count, IReadOnlyList<LengthChoice> choices, string? percent, Sfc32 prng)
    {
        var widths = new int[count];
        if (choices.Count == 0)
        {
            return widths;
        }

        IReadOnlyList<LengthChoice> selected = percent is null
            ? RandomLengthChoices(count, choices, prng)
            : Hamilton.Distribute(count, choices, PercentMask.Expand(percent, choices.Count), prng);

        for (int i = 0; i < count; i++)
        {
            LengthChoice choice = selected[i];
            widths[i] = choice.Min == choice.Max
                ? choice.Min
                : Rand.NextInt(prng, choice.Min, choice.Max + 1);
        }

        return widths;
    }

    private static IReadOnlyList<LengthChoice> RandomLengthChoices(
        int count, IReadOnlyList<LengthChoice> choices, Sfc32 prng)
    {
        if (choices.Count == 1)
        {
            // No draw at all with a single choice — which is why `length="4"` leaves the stream
            // untouched and a config can add it without shifting every later column.
            return Enumerable.Repeat(choices[0], count).ToArray();
        }

        var result = new List<LengthChoice>(count);
        for (int i = 0; i < count; i++)
        {
            result.Add(choices[Rand.NextInt(prng, 0, choices.Count)]);
        }

        return result;
    }

    // ── include / exclude ────────────────────────────────────────────────────────────────────

    private readonly record struct Interval(long Min, long Max);

    /// <summary>
    /// <c>(base ∪ include) − exclude</c>, as disjoint intervals.
    /// </summary>
    /// <remarks>
    /// Interval arithmetic rather than enumeration: <c>value="1..1000000000" exclude="7"</c> has to
    /// stay instant, and listing a billion values to remove one of them would not be.
    /// </remarks>
    private static IReadOnlyList<Interval> ComputeAllowed(
        IReadOnlyList<Range> baseRanges, string? include, string? exclude)
    {
        var combined = baseRanges.Select(r => new Interval(r.Min, r.Max)).ToList();
        if (!string.IsNullOrWhiteSpace(include))
        {
            combined.AddRange(ParseIntervalList(include, "include"));
        }

        IReadOnlyList<Interval> merged = Merge(combined);
        if (!string.IsNullOrWhiteSpace(exclude))
        {
            merged = Subtract(merged, ParseIntervalList(exclude, "exclude"));
        }

        if (merged.Count == 0)
        {
            throw new ArgumentException(
                "number generator: the range is empty after include/exclude");
        }

        return merged;
    }

    private static List<Interval> ParseIntervalList(string source, string label)
    {
        string spec = source.Trim();
        if (spec.Length == 0)
        {
            throw new ArgumentException($"number generator: {label} is empty");
        }

        var result = new List<Interval>();
        foreach (string raw in spec.Split(','))
        {
            string part = raw.Trim();
            if (long.TryParse(part, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out long n)
                && SingleInt.IsMatch(part))
            {
                result.Add(new Interval(n, n));
                continue;
            }

            Match m = RangePattern.Match(part);
            if (m.Success)
            {
                long a = long.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
                long b = long.Parse(m.Groups[2].Value, CultureInfo.InvariantCulture);
                if (a > b)
                {
                    throw new ArgumentException(
                        $"number generator: {label} range \"{part}\" is reversed");
                }

                result.Add(new Interval(a, b));
                continue;
            }

            throw new ArgumentException($"number generator: invalid {label} \"{source}\"");
        }

        return result;
    }

    /// <summary>Touching intervals join, so 1..3 and 4..6 become one; the draw must not double-count.</summary>
    private static List<Interval> Merge(List<Interval> intervals)
    {
        List<Interval> sorted = intervals.OrderBy(i => i.Min).ThenBy(i => i.Max).ToList();
        var merged = new List<Interval>();
        foreach (Interval iv in sorted)
        {
            if (merged.Count > 0 && iv.Min <= merged[^1].Max + 1)
            {
                Interval last = merged[^1];
                merged[^1] = new Interval(last.Min, Math.Max(last.Max, iv.Max));
            }
            else
            {
                merged.Add(iv);
            }
        }

        return merged;
    }

    private static List<Interval> Subtract(
        IReadOnlyList<Interval> ranges, IReadOnlyList<Interval> excludes)
    {
        var result = new List<Interval>(ranges);
        foreach (Interval ex in excludes)
        {
            var next = new List<Interval>();
            foreach (Interval r in result)
            {
                if (ex.Max < r.Min || ex.Min > r.Max)
                {
                    next.Add(r);
                    continue;
                }

                if (ex.Min > r.Min)
                {
                    next.Add(new Interval(r.Min, ex.Min - 1));
                }

                if (ex.Max < r.Max)
                {
                    next.Add(new Interval(ex.Max + 1, r.Max));
                }
            }

            result = next;
        }

        return result;
    }

    private static string DrawGuarded(
        IReadOnlyList<Interval> intervals, int width, bool allowLeadingZero, Sfc32 prng)
    {
        string s = DrawWeighted(intervals, width, prng);
        for (int guard = 0; !allowLeadingZero && s.StartsWith('0') && guard < 100; guard++)
        {
            s = DrawWeighted(intervals, width, prng);
        }

        return s;
    }

    /// <summary>One draw over the total size, then map it into whichever interval holds that index.</summary>
    private static string DrawWeighted(
        IReadOnlyList<Interval> intervals, int width, Sfc32 prng)
    {
        long total = 0;
        foreach (Interval iv in intervals)
        {
            total += iv.Max - iv.Min + 1;
        }

        long k = NextLong(prng, 0, total);
        long n = intervals[0].Min;
        foreach (Interval iv in intervals)
        {
            long size = iv.Max - iv.Min + 1;
            if (k < size)
            {
                n = iv.Min + k;
                break;
            }

            k -= size;
        }

        string s = n.ToString(CultureInfo.InvariantCulture);
        return width > 0 ? Pad(s, width) : s;
    }

    private static int ParseDecimals(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return 0;
        }

        if (!int.TryParse(raw.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out int n)
            || n < 0)
        {
            throw new ArgumentException($"number generator: invalid decimals \"{raw}\"");
        }

        return n;
    }

    private static string DrawGuardedRange(
        IReadOnlyList<Range> ranges, int width, bool allowLeadingZero, Sfc32 prng)
    {
        string s = DrawRange(ranges, width, prng);
        for (int guard = 0;
             !allowLeadingZero && s.StartsWith("0", StringComparison.Ordinal) && guard < 100;
             guard++)
        {
            s = DrawRange(ranges, width, prng);
        }

        return s;
    }

    private static string DrawRange(IReadOnlyList<Range> ranges, int width, Sfc32 prng)
    {
        Range range = ranges.Count == 1 ? ranges[0] : ranges[Rand.NextInt(prng, 0, ranges.Count)];
        long n = NextLong(prng, range.Min, range.Max + 1);
        string s = n.ToString(CultureInfo.InvariantCulture);
        int actualWidth = width > 0 ? width : range.Width;
        return actualWidth > 0 ? Pad(s, actualWidth) : s;
    }

    private static string DigitString(int width, bool allowLeadingZero, Sfc32 prng)
    {
        var result = new StringBuilder(width);
        for (int i = 0; i < width; i++)
        {
            int min = i == 0 && !allowLeadingZero ? 1 : 0;
            result.Append(Rand.NextInt(prng, min, 10).ToString(CultureInfo.InvariantCulture));
        }

        return result.ToString();
    }

    /// <summary>
    /// A uniform draw over the decimal grid of the range.
    /// </summary>
    /// <remarks>
    /// Scaling by a power of ten and drawing one integer costs the same single draw an integer
    /// range costs. Drawing the whole part and the fraction separately would cost two and would
    /// over-represent the endpoints.
    /// </remarks>
    private static string RandomDecimal(IReadOnlyList<Range> ranges, int decimals, Sfc32 prng)
    {
        double scale = Math.Pow(10, decimals);
        var lo = new long[ranges.Count];
        var size = new long[ranges.Count];
        long total = 0;
        for (int i = 0; i < ranges.Count; i++)
        {
            lo[i] = (long)Math.Round(ranges[i].Min * scale, MidpointRounding.AwayFromZero);
            size[i] = (long)Math.Round(ranges[i].Max * scale, MidpointRounding.AwayFromZero) - lo[i] + 1;
            total += size[i];
        }

        long pick = (long)Math.Floor(prng.Next() * total);
        for (int i = 0; i < ranges.Count; i++)
        {
            if (pick < size[i])
            {
                return Fixed(lo[i] + pick, scale, decimals);
            }

            pick -= size[i];
        }

        int last = ranges.Count - 1;
        return Fixed(lo[last] + size[last] - 1, scale, decimals);
    }

    private static string Fixed(long scaled, double scale, int decimals) =>
        (scaled / scale).ToString("F" + decimals.ToString(CultureInfo.InvariantCulture),
            CultureInfo.InvariantCulture);

    /// <summary><c>[min, max)</c> over longs — the range form can exceed what an int holds.</summary>
    private static long NextLong(Sfc32 prng, long min, long max) =>
        (long)Math.Floor((prng.Next() * (max - min)) + min);

    private static string Pad(string s, int width) => s.Length >= width ? s : s.PadLeft(width, '0');
}

/// <summary>Draws shaped the way the reference shapes them.</summary>
public static class Rand
{
    public static int NextInt(Sfc32 prng, int min, int max) =>
        (int)Math.Floor((prng.Next() * (max - min)) + min);

    public static T Pick<T>(Sfc32 prng, IReadOnlyList<T> values) =>
        values[(int)Math.Floor(prng.Next() * values.Count)];
}
