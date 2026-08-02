using System.Globalization;
using System.Text;

namespace Tdcv2.Date;

/// <summary>One language's names and its shorthand formats.</summary>
public sealed record DateLocale(
    IReadOnlyList<string> Months,
    IReadOnlyList<string> MonthsShort,
    IReadOnlyList<string> Weekdays,
    IReadOnlyList<string> WeekdaysShort,
    IReadOnlyDictionary<string, string> Formats);

/// <summary>
/// The Moment-style formatting subset TDC uses.
/// </summary>
/// <remarks>
/// Deliberately not .NET's custom format strings. Their patterns differ from Moment's in ways that
/// would show up as wrong output rather than as an error — <c>dd</c> is a two-digit day here and an
/// abbreviated weekday there, <c>M</c> and <c>m</c> swap meaning — and .NET reads locale data from
/// ICU or the host OS, which would print different month names on different machines. The names live
/// in <see cref="DateLocales"/>, byte for byte the same in every implementation.
/// </remarks>
public static class DateFormatter
{
    /// <summary>Longest first: <c>MMMM</c> must be recognised before <c>MMM</c> and <c>MM</c>.</summary>
    private static readonly string[] Tokens =
    {
        "YYYY", "MMMM", "dddd", "MMM", "ddd", "SSS", "YY", "MM", "DD", "HH", "mm", "ss", "ZZ",
        "M", "D", "H", "m", "s", "Z",
    };

    public static DateLocale Locale(string? name) => DateLocales.Resolve(name);

    /// <summary>
    /// Whether a format string is well formed, without a date to apply it to.
    /// </summary>
    /// <remarks>
    /// Only the bracket literals can be malformed; an unknown token is passed through as text by
    /// design, so it is not an error.
    /// </remarks>
    public static void CheckFormat(string format)
    {
        for (int i = 0; i < format.Length; i++)
        {
            if (format[i] != '[')
            {
                continue;
            }

            int end = format.IndexOf(']', i + 1);
            if (end < 0)
            {
                throw new ArgumentException($"date format: unterminated literal \"{format}\"");
            }

            i = end;
        }
    }

    public static string Format(PlainDateTime value, string? format, string? localeName)
    {
        DateLocale locale = Locale(localeName);
        string expanded = Expand(format ?? "L", locale);

        var result = new StringBuilder();
        int i = 0;
        while (i < expanded.Length)
        {
            char ch = expanded[i];
            if (ch == '[')
            {
                int end = expanded.IndexOf(']', i + 1);
                if (end < 0)
                {
                    throw new ArgumentException(
                        $"date format: unterminated literal \"{expanded}\"");
                }

                result.Append(expanded, i + 1, end - i - 1);
                i = end + 1;
                continue;
            }

            string? token = null;
            foreach (string candidate in Tokens)
            {
                if (string.CompareOrdinal(expanded, i, candidate, 0, candidate.Length) == 0
                    && i + candidate.Length <= expanded.Length)
                {
                    token = candidate;
                    break;
                }
            }

            if (token is not null)
            {
                result.Append(Render(token, value, locale));
                i += token.Length;
                continue;
            }

            result.Append(ch);
            i++;
        }

        return result.ToString();
    }

    private static string Expand(string format, DateLocale locale) => format switch
    {
        "ISO" => "YYYY-MM-DD",
        "ISO_TIME" => "YYYY-MM-DDTHH:mm:ss",
        "L" or "LL" or "LLL" or "LLLL" => locale.Formats[format],
        _ => format,
    };

    private static string Render(string token, PlainDateTime v, DateLocale locale) => token switch
    {
        "YYYY" => Pad(v.Year, 4),
        "YY" => Pad(v.Year % 100, 2),
        "MMMM" => locale.Months[v.Month - 1],
        "MMM" => locale.MonthsShort[v.Month - 1],
        "MM" => Pad(v.Month, 2),
        "M" => v.Month.ToString(CultureInfo.InvariantCulture),
        "DD" => Pad(v.Day, 2),
        "D" => v.Day.ToString(CultureInfo.InvariantCulture),
        "dddd" => locale.Weekdays[Calendar.Weekday(v)],
        "ddd" => locale.WeekdaysShort[Calendar.Weekday(v)],
        "HH" => Pad(v.Hour, 2),
        "H" => v.Hour.ToString(CultureInfo.InvariantCulture),
        "mm" => Pad(v.Minute, 2),
        "m" => v.Minute.ToString(CultureInfo.InvariantCulture),
        "ss" => Pad(v.Second, 2),
        "s" => v.Second.ToString(CultureInfo.InvariantCulture),
        "SSS" => Pad(v.Millisecond, 3),
        "Z" => "+00:00",
        "ZZ" => "+0000",
        _ => token,
    };

    private static string Pad(int value, int length) =>
        value.ToString(CultureInfo.InvariantCulture).PadLeft(length, '0');
}
