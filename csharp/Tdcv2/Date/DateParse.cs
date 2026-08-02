using System.Globalization;
using System.Text.RegularExpressions;

namespace Tdcv2.Date;

/// <summary>
/// Strict parsing for the dates a config writes by hand.
/// </summary>
/// <remarks>
/// Strict on purpose. A lenient parser would read <c>2026-02-30</c> as 2 March and generate data that
/// looks fine until someone tries to explain where March came from. The separator has to match itself
/// too, so <c>2026-01/01</c> is an error rather than a guess.
/// </remarks>
public static class DateParse
{
    /// <summary><c>\2</c> makes the second separator match the first: dashes, dots or slashes, not a mix.</summary>
    private static readonly Regex DateTimePattern = new(
        @"^(\d{4})([./-])(\d{2})\2(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$",
        RegexOptions.Compiled);

    private static readonly Regex LegacyRangePattern = new(
        @"^(\d{4}\.\d{2}\.\d{2})\s*-\s*(\d{4}\.\d{2}\.\d{2})$", RegexOptions.Compiled);

    /// <summary>A parsed value plus whether the text carried a time — which decides the default precision.</summary>
    public readonly record struct Parsed(PlainDateTime Value, bool HasTime);

    public readonly record struct Range(Parsed Start, Parsed End);

    public static Parsed DateTime(string source)
    {
        Match m = DateTimePattern.Match(source.Trim());
        if (!m.Success)
        {
            throw new ArgumentException(
                $"date: invalid date \"{source}\" (expected YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss)");
        }

        bool hasTime = m.Groups[5].Success;
        var value = new PlainDateTime(
            Num(m.Groups[1]),
            Num(m.Groups[3]),
            Num(m.Groups[4]),
            hasTime ? Num(m.Groups[5]) : 0,
            hasTime ? Num(m.Groups[6]) : 0,
            m.Groups[7].Success ? Num(m.Groups[7]) : 0,
            // ".5" means 500 milliseconds, not 5 — pad on the right, never the left.
            m.Groups[8].Success ? int.Parse(PadRight(m.Groups[8].Value)) : 0);

        AssertValid(value, source);
        return new Parsed(value, hasTime);
    }

    /// <summary>
    /// The older <c>range="1990.01.01 - 2000.12.31"</c> spelling, as <c>date.range</c> takes it.
    /// </summary>
    /// <remarks>
    /// Dots and a dash rather than the <c>..</c> the <c>date</c> generator uses. Two spellings for
    /// one idea is not a design anyone would choose, but the old one is in configs already and
    /// silently rejecting them would be worse than carrying it.
    /// </remarks>
    public static Range LegacyRange(string source)
    {
        Match m = LegacyRangePattern.Match(source.Trim());
        if (!m.Success)
        {
            throw new ArgumentException($"date.range: invalid range attribute \"{source}\"");
        }

        return new Range(DateTime(m.Groups[1].Value), DateTime(m.Groups[2].Value));
    }

    public static Range ParseRange(string source)
    {
        string[] parts = Regex.Split(source, @"\.\.");
        if (parts.Length != 2)
        {
            throw new ArgumentException(
                $"date: invalid range \"{source}\" (expected START..END)");
        }

        return new Range(DateTime(parts[0]), DateTime(parts[1]));
    }

    private static int Num(Group g) => int.Parse(g.Value, CultureInfo.InvariantCulture);

    private static void AssertValid(PlainDateTime v, string source)
    {
        if (v.Month < 1 || v.Month > 12)
        {
            throw new ArgumentException($"date: invalid month in \"{source}\"");
        }

        if (v.Day < 1 || v.Day > Calendar.DaysInMonth(v.Year, v.Month))
        {
            throw new ArgumentException($"date: invalid day in \"{source}\"");
        }

        if (v.Hour > 23 || v.Minute > 59 || v.Second > 59)
        {
            throw new ArgumentException($"date: invalid time in \"{source}\"");
        }
    }

    private static string PadRight(string fraction) => fraction.PadRight(3, '0');
}
