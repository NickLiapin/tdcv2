using System;
using System.Collections.Generic;
using System.Globalization;

namespace Tdcv2.Date;

/// <summary>
/// Walking a date range instead of drawing from it: <c>step=</c> and <c>weekdays=</c>.
/// </summary>
/// <remarks>
/// A step is EITHER a fixed span or a calendar span, and never both. The distinction is not
/// pedantry: <c>15m</c> is always 900 000 milliseconds, while <c>1mo</c> is 28, 29, 30 or 31 days
/// depending on where you start. They compose within their own group — <c>1h30m</c>,
/// <c>1y6mo</c> — and refuse to compose across it, because "one month and fifteen days" depends on
/// which is applied first, and a config whose meaning turns on an invisible ordering is worse than
/// one that will not parse. Allowing the mix later is easy; changing what it already means is not.
/// </remarks>
public static class DateStep
{
    private const long MsPerSecond = 1000L;

    /// <summary>How far one row advances: milliseconds, or months. Exactly one is non-zero.</summary>
    public readonly record struct Spec(long Ms, long Months);

    /// <summary>The two ways a step can fail, which read differently because they ARE different.</summary>
    public enum Reason
    {
        /// <summary>A spelling this notation does not have.</summary>
        Syntax,

        /// <summary>A calendar unit and a fixed one in the same step.</summary>
        Mixed,
    }

    /// <summary>Either the step, or why it was refused. <c>Why</c> is null on success.</summary>
    public readonly record struct Result(Spec? Step, Reason? Why)
    {
        public bool Ok => Step is not null;
    }

    /// <summary>What a <c>step=</c> may say, for a diagnostic to quote.</summary>
    public const string StepSyntax = "15m, 1h30m, 2d, 3mo, 1y — units s, m, h, d, w, mo, y";

    /// <summary>The default step of a walked axis: one day.</summary>
    public static readonly Spec DefaultStep = new(Calendar.MsPerDay, 0);

    /// <summary>The weekday names a filter may use, Sunday first.</summary>
    public static readonly IReadOnlyList<string> WeekdayNames =
        new[] { "sun", "mon", "tue", "wed", "thu", "fri", "sat" };

    /// <summary>
    /// Milliseconds in a fixed unit, or <c>-1</c>. <c>m</c> is MINUTE, as it is everywhere this
    /// notation is used.
    /// </summary>
    private static long FixedUnitMs(string unit) => unit switch
    {
        "s" => MsPerSecond,
        "m" => 60 * MsPerSecond,
        "h" => 3600 * MsPerSecond,
        "d" => Calendar.MsPerDay,
        "w" => 7 * Calendar.MsPerDay,
        _ => -1,
    };

    /// <summary>Months in a calendar unit, or <c>-1</c>.</summary>
    /// <remarks>
    /// <c>mo</c> rather than <c>m</c> because <c>m</c> is already the minute, and rather than
    /// <c>M</c> because the difference between three minutes and three months would then rest on
    /// the case of one letter — a distinction no reader checks and no tool that normalizes case
    /// preserves.
    /// </remarks>
    private static long CalendarUnitMonths(string unit) => unit switch
    {
        "mo" => 1,
        "y" => 12,
        _ => -1,
    };

    /// <summary>
    /// <c>step="15m"</c>, <c>step="1h30m"</c>, <c>step="3mo"</c>, <c>step="2"</c>.
    /// </summary>
    /// <remarks>
    /// A bare number means DAYS, the default unit, so <c>step="2"</c> is every other day. A unit
    /// may appear once: <c>1h30m1h</c> is a typo, and summing it would hide the typo rather than
    /// report it.
    /// </remarks>
    public static Result ParseStep(string? raw)
    {
        string value = (raw ?? string.Empty).Trim().ToLowerInvariant();
        if (value.Length == 0)
        {
            return new Result(DefaultStep, null);
        }

        if (AllDigits(value))
        {
            return long.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out long days)
                && days >= 1
                ? new Result(new Spec(days * Calendar.MsPerDay, 0), null)
                : new Result(null, Reason.Syntax);
        }

        long ms = 0;
        long months = 0;
        var seen = new HashSet<string>(StringComparer.Ordinal);
        int at = 0;
        while (at < value.Length)
        {
            int digitsFrom = at;
            while (at < value.Length && IsDigit(value[at]))
            {
                at++;
            }

            if (at == digitsFrom
                || !long.TryParse(
                    value.AsSpan(digitsFrom, at - digitsFrom), NumberStyles.None,
                    CultureInfo.InvariantCulture, out long count))
            {
                return new Result(null, Reason.Syntax);
            }

            int unitFrom = at;
            while (at < value.Length && IsLetter(value[at]))
            {
                at++;
            }

            string unit = value[unitFrom..at];
            if (unit.Length == 0 || !seen.Add(unit))
            {
                return new Result(null, Reason.Syntax);
            }

            long fixedMs = FixedUnitMs(unit);
            long calendarMonths = CalendarUnitMonths(unit);
            if (fixedMs >= 0)
            {
                ms += count * fixedMs;
            }
            else if (calendarMonths >= 0)
            {
                months += count * calendarMonths;
            }
            else
            {
                return new Result(null, Reason.Syntax);
            }
        }

        if (ms > 0 && months > 0)
        {
            return new Result(null, Reason.Mixed);
        }

        return ms == 0 && months == 0
            ? new Result(null, Reason.Syntax)
            : new Result(new Spec(ms, months), null);
    }

    // Explicit ranges rather than `char.IsAsciiDigit`, which arrived in .NET 7 and this project
    // targets earlier. The value is already lowercased, so letters are a..z.
    private static bool IsDigit(char c) => c >= '0' && c <= '9';

    private static bool IsLetter(char c) => c >= 'a' && c <= 'z';

    private static bool AllDigits(string value)
    {
        foreach (char c in value)
        {
            if (!IsDigit(c))
            {
                return false;
            }
        }

        return true;
    }

    /// <summary><c>start</c> advanced by <c>n</c> steps.</summary>
    /// <remarks>
    /// A calendar month has no fixed length, so stepping by month or year keeps the DAY OF MONTH
    /// and clamps it to the last day of a shorter one: 31 January plus one month is 28 February,
    /// not 3 March. That is the same rule <c>SubtractUtcYears</c> already applies to
    /// <c>person.b_day</c>, so the engine answers one way about calendars rather than two.
    /// </remarks>
    public static PlainDateTime AddStep(PlainDateTime start, Spec step, long n)
    {
        if (step.Months == 0)
        {
            return Calendar.FromEpochMillis(Calendar.ToEpochMillis(start) + (n * step.Ms));
        }

        long months = ((long)start.Year * 12) + (start.Month - 1) + (n * step.Months);
        int year = (int)FloorDiv(months, 12);
        int month = (int)FloorMod(months, 12) + 1;
        return new PlainDateTime(
            year,
            month,
            Math.Min(start.Day, Calendar.DaysInMonth(year, month)),
            start.Hour,
            start.Minute,
            start.Second,
            start.Millisecond);
    }

    /// <summary>How many steps fit in <c>start..end</c>, counting both ends.</summary>
    /// <remarks>
    /// Computed rather than counted, because a second-by-second span of a century is a number no
    /// loop should walk. A fixed step divides; a calendar one is estimated from the month
    /// difference and corrected by at most one, which is what the clamping in
    /// <see cref="AddStep"/> can cost.
    /// </remarks>
    public static long StepsBetween(PlainDateTime start, PlainDateTime end, Spec step)
    {
        if (step.Months == 0)
        {
            long span = Calendar.ToEpochMillis(end) - Calendar.ToEpochMillis(start);
            return span < 0 ? 1 : (span / step.Ms) + 1;
        }

        long months = ((long)(end.Year - start.Year) * 12) + end.Month - start.Month;
        long n = FloorDiv(months, step.Months);
        if (n < 0)
        {
            return 1;
        }

        if (Calendar.ToEpochMillis(AddStep(start, step, n)) > Calendar.ToEpochMillis(end))
        {
            n--;
        }

        return n + 1;
    }

    /// <summary>True when every row of this step lands on the same weekday.</summary>
    /// <remarks>
    /// A calendar step does, and so does any whole number of weeks — <c>14d</c> as much as
    /// <c>2w</c>, which a test on the unit's NAME would have missed. A weekday filter over such a
    /// step matches every row or none, so it is refused rather than silently producing a full
    /// column or an empty one.
    /// </remarks>
    public static bool FixesWeekday(Spec step) =>
        step.Months > 0 || step.Ms % (7 * Calendar.MsPerDay) == 0;

    /// <summary>
    /// <c>weekdays="mon..fri"</c> or <c>weekdays="sun,wed"</c> — which weekdays an axis keeps.
    /// </summary>
    /// <remarks>
    /// <c>..</c> is the range operator everywhere else in the language, so it is the range operator
    /// here. A SPAN wraps: <c>fri..mon</c> is Friday, Saturday, Sunday, Monday, because a week is a
    /// circle and refusing to go round it would make half the spans unwritable. Returns
    /// <c>null</c> on a name it does not know, so the caller can say which.
    /// </remarks>
    public static bool[]? ParseWeekdays(string? raw)
    {
        string value = (raw ?? string.Empty).Trim().ToLowerInvariant();
        if (value.Length == 0)
        {
            return null;
        }

        bool[] keep = new bool[7];
        foreach (string part in value.Split(','))
        {
            string span = part.Trim();
            if (span.Length == 0)
            {
                return null;
            }

            int at = span.IndexOf("..", StringComparison.Ordinal);
            if (at < 0)
            {
                int only = IndexOfWeekday(span);
                if (only < 0)
                {
                    return null;
                }

                keep[only] = true;
                continue;
            }

            int first = IndexOfWeekday(span[..at].Trim());
            int last = IndexOfWeekday(span[(at + 2)..].Trim());
            if (first < 0 || last < 0)
            {
                return null;
            }

            for (int day = first; ; day = (day + 1) % 7)
            {
                keep[day] = true;
                if (day == last)
                {
                    break;
                }
            }
        }

        return keep;
    }

    private static int IndexOfWeekday(string name)
    {
        for (int i = 0; i < WeekdayNames.Count; i++)
        {
            if (string.Equals(WeekdayNames[i], name, StringComparison.Ordinal))
            {
                return i;
            }
        }

        return -1;
    }

    private static long FloorDiv(long a, long b)
    {
        long q = a / b;
        return (a % b != 0 && ((a < 0) != (b < 0))) ? q - 1 : q;
    }

    private static long FloorMod(long a, long b) => a - (FloorDiv(a, b) * b);
}
