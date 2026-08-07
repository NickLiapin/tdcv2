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
        /// <summary>
        /// True when the range was written with only its START. <c>End</c> is then a copy of
        /// <c>Start</c> and means nothing; <see cref="DateAxis"/> reads this and never wraps.
        /// </summary>
        bool OpenEnd,
        Precision Grain,
        string Format,
        string? Locale);

    public static IReadOnlyList<string> Generate(
        IReadOnlyDictionary<string, string> attrs, string? locale, long nowMillis, int count,
        Sfc32 prng) =>
        Generate(attrs, locale, nowMillis, count, prng, null);

    /// <summary><c>count</c> formatted dates, optionally keeping the value behind each one.</summary>
    /// <param name="instants">
    /// When given, receives the epoch millis the generator actually produced, before
    /// <c>format=</c> turned it into one locale's spelling of it. A column another one measures
    /// from asks for this; everything else passes null and nothing is collected.
    /// </param>
    public static IReadOnlyList<string> Generate(
        IReadOnlyDictionary<string, string> attrs, string? locale, long nowMillis, int count,
        Sfc32 prng, List<long?>? instants)
    {
        Plan plan = BuildPlan(attrs, locale, nowMillis);
        var result = new List<string>(count);
        for (int i = 0; i < count; i++)
        {
            PlainDateTime value = plan.Fixed ?? Pick(plan, prng);
            instants?.Add(Calendar.ToEpochMillis(value));
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
            // `from=` alone is an OPEN axis — legal when the range is WALKED, and the plan carries
            // only a start. `DateAxis` reads `OpenEnd` and never wraps; a DRAWN date with one end
            // is still refused, by TDC150.
            if (hasFrom && !hasTo)
            {
                DateParse.Parsed only = DateParse.DateTime(from!);
                return new Plan(
                    null, only.Value, only.Value, true,
                    ParsePrecision(
                        attrs.GetValueOrDefault("precision"),
                        only.HasTime ? Precision.Millisecond : Precision.Day),
                    format, loc);
            }

            if (!hasFrom)
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

        // Nothing specified at all: the epoch up to right now. The upper bound carries a time, but
        // the fallback precision is still whole days — an unbounded generator answers with a date,
        // not a timestamp at 03:47. Routing this through RangeOf let HasTime pick Millisecond, and
        // a millisecond draw lands a day away from the reference's day draw often enough to fail.
        return RangePlan(
            DateParse.DateTime(DefaultStart).Value,
            Calendar.FromEpochMillis(nowMillis),
            attrs, true, Precision.Day, format, loc);
    }

    private static Plan Fixed(
        PlainDateTime value, Precision grain, string format, string? locale) =>
        new(value, default, default, false, grain, format, locale);

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
            null, start, end, false,
            ParsePrecision(attrs.GetValueOrDefault("precision"), defaultPrecision), format, locale);
    }

    /// <summary>
    /// A date range as a walkable axis: how many steps it holds, and what the k-th is.
    /// </summary>
    /// <remarks>
    /// <c>Size</c> is null for an OPEN axis — <c>from=</c> with no end. Requiring an end meant
    /// working out what date the millionth day falls on in order to write it down, when the end is
    /// simply <c>start + count × step</c>. Such an axis never wraps, because there is nothing to
    /// wrap at.
    /// <para>
    /// The range is never expanded into a list. A century stepped by the second is three billion
    /// values and the streaming engine promises bounded memory whatever the config says — so each
    /// date is <c>start + k × step</c>, measured from the START rather than accumulated, which is
    /// what keeps a clamped February from dragging every later month back with it.
    /// </para>
    /// </remarks>
    public sealed class Axis
    {
        private readonly PlainDateTime _start;
        private readonly DateStep.Spec _step;
        private readonly IReadOnlyList<long> _offsets;
        private readonly long _perCycle;
        private readonly string _format;
        private readonly string? _locale;

        internal Axis(
            long? size, PlainDateTime start, DateStep.Spec step, IReadOnlyList<long> offsets,
            long perCycle, string format, string? locale)
        {
            Size = size;
            _start = start;
            _step = step;
            _offsets = offsets;
            _perCycle = perCycle;
            _format = format;
            _locale = locale;
        }

        /// <summary>How many positions the axis holds, or null when it is open.</summary>
        public long? Size { get; }

        /// <summary>The k-th value of the axis, rendered.</summary>
        public string At(long k) => DateFormatter.Format(ValueAt(k), _format, _locale);

        /// <summary>
        /// The k-th value BEFORE <c>format=</c> turns it into one locale's spelling of it —
        /// what a column measuring from this one has to read.
        /// </summary>
        public PlainDateTime ValueAt(long k)
        {
            if (_offsets.Count == 0)
            {
                return DateStep.AddStep(_start, _step, k);
            }

            long n = _offsets.Count;
            long cycles = k / n;
            long within = _offsets[(int)(k % n)];
            return DateStep.AddStep(_start, _step, (cycles * _perCycle) + within);
        }
    }

    private const long MsPerWeek = 7 * Calendar.MsPerDay;

    private static long Gcd(long a, long b) => b == 0 ? a : Gcd(b, a % b);

    /// <summary>Build the walkable axis an <c>order="sequential"</c> date reads.</summary>
    public static Axis DateAxis(
        IReadOnlyDictionary<string, string> attrs, string? locale, long nowMillis)
    {
        DateStep.Result parsed = DateStep.ParseStep(attrs.GetValueOrDefault("step"));
        DateStep.Spec step = parsed.Step ?? DateStep.DefaultStep;
        bool[]? keep = DateStep.ParseWeekdays(attrs.GetValueOrDefault("weekdays"));
        Plan plan = BuildPlan(attrs, locale, nowMillis);

        if (plan.Fixed is PlainDateTime only)
        {
            return new Axis(
                1, only, DateStep.DefaultStep, Array.Empty<long>(), 1, plan.Format, plan.Locale);
        }

        // `weekdays=` keeps only some of the candidates, so the k-th KEPT one is wanted rather than
        // the k-th candidate. Which candidates match repeats on a cycle — one week's worth of
        // steps — so the offsets are found once and then indexed, instead of scanning from the
        // beginning for every row.
        IReadOnlyList<long> offsets = Array.Empty<long>();
        long perCycle = 1;
        if (keep is not null)
        {
            perCycle = step.Ms > 0 ? MsPerWeek / Gcd(step.Ms, MsPerWeek) : 7;
            var kept = new List<long>();
            for (long i = 0; i < perCycle; i++)
            {
                if (keep[Calendar.Weekday(DateStep.AddStep(plan.Start, step, i))])
                {
                    kept.Add(i);
                }
            }

            offsets = kept;
        }

        long? size = null;
        if (!plan.OpenEnd)
        {
            long candidates = DateStep.StepsBetween(plan.Start, plan.End, step);
            if (offsets.Count == 0)
            {
                size = candidates;
            }
            else
            {
                long whole = candidates / perCycle * offsets.Count;
                long tail = candidates % perCycle;
                long partial = 0;
                foreach (long offset in offsets)
                {
                    if (offset < tail)
                    {
                        partial++;
                    }
                }

                size = Math.Max(1, whole + partial);
            }
        }

        return new Axis(size, plan.Start, step, offsets, perCycle, plan.Format, plan.Locale);
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
