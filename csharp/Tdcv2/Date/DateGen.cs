using System.Globalization;
using Tdcv2.Prng;

namespace Tdcv2.Date;

/// <summary>
/// <c>&lt;gen type="date" .../&gt;</c> and the <c>person.b_day</c> template behind it.
/// </summary>
/// <remarks>
/// <para>
/// A plan is built once from the attributes, then each value is one draw against it. Two kinds: a
/// fixed instant (<c>today</c>, <c>now</c>, a single date) that takes no draw at all, and a range
/// that takes exactly one.
/// </para>
/// <para>
/// Precision decides what the draw is over — days, seconds or milliseconds — and it is not cosmetic.
/// A range drawn by day and the same range drawn by millisecond both look like dates once formatted,
/// and they disagree.
/// </para>
/// </remarks>
public static class DateGen
{
    private const string DefaultStart = "1970-01-01";
    private const string DefaultFormat = "L";
    private const long MsPerSecond = 1000L;

    /// <summary>How finely the range is divided before a value is drawn from it.</summary>
    public enum Precision
    {
        Day,
        Second,
        Millisecond,
    }

    private readonly record struct Plan(
        PlainDateTime? Fixed,
        PlainDateTime Start,
        PlainDateTime End,
        Precision Grain,
        string Format,
        string? Locale);

    public static IReadOnlyList<string> Generate(
        IReadOnlyDictionary<string, string> attrs, string? locale, long nowMillis, int count,
        Sfc32 prng)
    {
        Plan plan = BuildPlan(attrs, locale, nowMillis);
        var result = new List<string>(count);
        for (int i = 0; i < count; i++)
        {
            PlainDateTime value = plan.Fixed ?? Pick(plan, prng);
            result.Add(DateFormatter.Format(value, plan.Format, plan.Locale));
        }

        return result;
    }

    /// <summary>One value for <c>person.b_day</c>, which is a date generator wearing a template's name.</summary>
    public static string BirthDay(
        IReadOnlyDictionary<string, string> attrs, string? locale, long nowMillis, Sfc32 prng) =>
        Generate(BirthAttrs(attrs), locale, nowMillis, 1, prng)[0];

    /// <summary>
    /// <c>date.range</c> — a date generator addressed as a pack path, taking the older
    /// <c>range="1990.01.01 - 2000.12.31"</c> spelling.
    /// </summary>
    /// <remarks>
    /// It is the <c>date</c> generator underneath, so the bounds are rewritten into the form that
    /// generator reads rather than a second implementation being kept in step with the first.
    /// </remarks>
    public static IReadOnlyList<string> LegacyRange(
        IReadOnlyDictionary<string, string> attrs, string? locale, long nowMillis, int count,
        Sfc32 prng)
    {
        string raw = attrs.GetValueOrDefault("range", "");
        DateParse.Range range;
        try
        {
            range = DateParse.LegacyRange(raw);
        }
        catch (ArgumentException)
        {
            throw new ArgumentException($"date.range: invalid range attribute \"{raw}\"");
        }

        var rewritten = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["from"] = Serialize(range.Start.Value),
            ["to"] = Serialize(range.End.Value),
            ["precision"] = attrs.GetValueOrDefault("precision", "day"),
        };
        Copy(attrs, rewritten, "format");
        Copy(attrs, rewritten, "local");
        return Generate(rewritten, locale, nowMillis, count, prng);
    }

    private static string Serialize(PlainDateTime v) => string.Format(
        CultureInfo.InvariantCulture,
        "{0:D4}-{1:D2}-{2:D2}T{3:D2}:{4:D2}:{5:D2}.{6:D3}",
        v.Year, v.Month, v.Day, v.Hour, v.Minute, v.Second, v.Millisecond);

    /// <summary>
    /// <c>person.b_day</c> reaches the date generator with <c>value="birth"</c> and an explicit
    /// millisecond precision.
    /// </summary>
    /// <remarks>
    /// The precision looks redundant next to a birth range measured in years, and it is not: it is
    /// what the reference passes, so it is what decides the day.
    /// </remarks>
    private static IReadOnlyDictionary<string, string> BirthAttrs(
        IReadOnlyDictionary<string, string> attrs)
    {
        var result = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["value"] = "birth",
            ["precision"] = attrs.GetValueOrDefault("precision", "millisecond"),
        };
        Copy(attrs, result, "oldest");
        Copy(attrs, result, "youngest");
        Copy(attrs, result, "format");
        Copy(attrs, result, "local");
        return result;
    }

    private static void Copy(
        IReadOnlyDictionary<string, string> from, Dictionary<string, string> to, string key)
    {
        if (from.TryGetValue(key, out string? value))
        {
            to[key] = value;
        }
    }

    private static Plan BuildPlan(
        IReadOnlyDictionary<string, string> attrs, string? locale, long nowMillis)
    {
        string format = attrs.GetValueOrDefault("format", DefaultFormat);
        string? loc = attrs.TryGetValue("local", out string? own) ? own : locale;
        string? value = attrs.GetValueOrDefault("value")?.Trim();

        if (value == "today")
        {
            return Fixed(
                Calendar.FromEpochMillis(nowMillis).StartOfDay(),
                ParsePrecision(attrs.GetValueOrDefault("precision"), Precision.Day), format, loc);
        }

        if (value == "now")
        {
            return Fixed(
                Calendar.FromEpochMillis(nowMillis),
                ParsePrecision(attrs.GetValueOrDefault("precision"), Precision.Millisecond),
                format, loc);
        }

        if (value == "birth")
        {
            int oldest = Age(attrs.GetValueOrDefault("oldest"), 80, "oldest");
            int youngest = Age(attrs.GetValueOrDefault("youngest"), 10, "youngest");
            if (youngest > oldest)
            {
                throw new ArgumentException(
                    "date generator: youngest must be less than or equal to oldest");
            }

            return RangePlan(
                Calendar.FromEpochMillis(Calendar.SubtractUtcYears(nowMillis, oldest)),
                Calendar.FromEpochMillis(Calendar.SubtractUtcYears(nowMillis, youngest)),
                attrs, false, Precision.Day, format, loc);
        }

        bool hasFrom = attrs.TryGetValue("from", out string? from);
        bool hasTo = attrs.TryGetValue("to", out string? to);
        if (hasFrom || hasTo)
        {
            if (!hasFrom || !hasTo)
            {
                throw new ArgumentException(
                    "date generator: \"from\" and \"to\" must be provided together");
            }

            return RangeOf(DateParse.DateTime(from!), DateParse.DateTime(to!), attrs, format, loc);
        }

        if (attrs.TryGetValue("range", out string? range))
        {
            DateParse.Range parsed = DateParse.ParseRange(range);
            return RangeOf(parsed.Start, parsed.End, attrs, format, loc);
        }

        if (!string.IsNullOrEmpty(value))
        {
            if (value.Contains(".."))
            {
                DateParse.Range parsed = DateParse.ParseRange(value);
                return RangeOf(parsed.Start, parsed.End, attrs, format, loc);
            }

            DateParse.Parsed one = DateParse.DateTime(value);
            return Fixed(
                one.Value,
                ParsePrecision(
                    attrs.GetValueOrDefault("precision"),
                    one.HasTime ? Precision.Millisecond : Precision.Day),
                format, loc);
        }

        // Nothing specified at all: the epoch up to right now.
        return RangeOf(
            DateParse.DateTime(DefaultStart),
            new DateParse.Parsed(Calendar.FromEpochMillis(nowMillis), true),
            attrs, format, loc);
    }

    private static Plan Fixed(
        PlainDateTime value, Precision grain, string format, string? locale) =>
        new(value, default, default, grain, format, locale);

    private static Plan RangeOf(
        DateParse.Parsed start, DateParse.Parsed end,
        IReadOnlyDictionary<string, string> attrs, string format, string? locale) =>
        RangePlan(
            start.Value, end.Value, attrs, start.HasTime || end.HasTime, null, format, locale);

    /// <summary>
    /// A range plan. When neither bound carried a time, the range is over whole days — which is why
    /// <c>range="2026-01-01..2026-01-31"</c> yields dates and not timestamps at 03:47.
    /// </summary>
    private static Plan RangePlan(
        PlainDateTime start, PlainDateTime end, IReadOnlyDictionary<string, string> attrs,
        bool hasTime, Precision? fallback, string format, string? locale)
    {
        Precision defaultPrecision =
            fallback ?? (hasTime ? Precision.Millisecond : Precision.Day);
        return new Plan(
            null, start, end,
            ParsePrecision(attrs.GetValueOrDefault("precision"), defaultPrecision), format, locale);
    }

    private static PlainDateTime Pick(Plan plan, Sfc32 prng)
    {
        if (plan.Grain == Precision.Day)
        {
            long a = Calendar.ToEpochDay(plan.Start);
            long b = Calendar.ToEpochDay(plan.End);
            return Calendar.FromEpochDay(Inclusive(prng, Math.Min(a, b), Math.Max(a, b)));
        }

        long divisor = plan.Grain == Precision.Second ? MsPerSecond : 1;
        long lo = Calendar.FloorDiv(Calendar.ToEpochMillis(plan.Start), divisor);
        long hi = Calendar.FloorDiv(Calendar.ToEpochMillis(plan.End), divisor);
        return Calendar.FromEpochMillis(
            Inclusive(prng, Math.Min(lo, hi), Math.Max(lo, hi)) * divisor);
    }

    /// <summary>One draw, inclusive of both ends.</summary>
    private static long Inclusive(Sfc32 prng, long min, long max) =>
        (long)Math.Floor((prng.Next() * (double)(max - min + 1)) + min);

    public static Precision ParsePrecision(string? raw, Precision fallback) => raw switch
    {
        null => fallback,
        "day" => Precision.Day,
        "second" => Precision.Second,
        "millisecond" => Precision.Millisecond,
        _ => throw new ArgumentException(
            $"date generator: unsupported precision \"{raw}\" "
            + "(supported: day, second, millisecond)"),
    };

    /// <summary>
    /// The birth ages, checked without generating anything.
    /// </summary>
    /// <remarks>
    /// Whole numbers in a plausible range, and the older bound actually older — a config that has
    /// them the wrong way round asks for an empty span and gets no dates at all.
    /// </remarks>
    public static void CheckBirthAges(IReadOnlyDictionary<string, string> attrs)
    {
        int oldest = Age(attrs.GetValueOrDefault("oldest"), 80, "oldest");
        int youngest = Age(attrs.GetValueOrDefault("youngest"), 10, "youngest");
        if (youngest > oldest)
        {
            throw new ArgumentException(
                "date generator: youngest must be less than or equal to oldest");
        }
    }

    private static int Age(string? raw, int fallback, string name)
    {
        if (raw is null)
        {
            return fallback;
        }

        if (!int.TryParse(raw.Trim(), out int value) || value < 0 || value > 150)
        {
            throw new ArgumentException(
                $"date generator: {name} must be an integer from 0 to 150");
        }

        return value;
    }
}
