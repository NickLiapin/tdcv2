using System.Globalization;
using System.Text;

namespace Tdcv2.Date;

/// <summary>One language's names and its shorthand formats.</summary>
public sealed record DateLocale(
    IReadOnlyList<string> Months,
    IReadOnlyList<string> MonthsShort,
    IReadOnlyList<string> Weekdays,
    IReadOnlyList<string> WeekdaysShort,
    IReadOnlyDictionary<string, string> Formats,
    /// <summary>The month as it is written WITH a day number beside it.</summary>
    /// <remarks>
    /// Russian <c>январь</c> becomes <c>15 января</c>; Finnish <c>tammikuu</c> becomes
    /// <c>15. tammikuuta</c>. <c>null</c> when the language does not distinguish the two, in
    /// which case <c>Months</c> serves for both.
    /// </remarks>
    IReadOnlyList<string>? MonthsInDate = null);

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
        // The same walk the formatter does, so what is refused here is exactly what would have
        // been printed as literal text there. A near-miss token used to pass validation and
        // then print itself: `hh:mm A` gave `hh:00 A`, `YYY` gave `24Y`, and the run said
        // nothing.
        int i = 0;
        while (i < format.Length)
        {
            if (format[i] == '[')
            {
                int end = format.IndexOf(']', i + 1);
                if (end < 0)
                {
                    throw new ArgumentException($"date format: unterminated literal \"{format}\"");
                }

                i = end + 1;
                continue;
            }

            string? named = Match(NamedFormats, format, i);
            if (named is not null)
            {
                i += named.Length;
                continue;
            }

            string? token = Match(Tokens, format, i);
            if (token is not null)
            {
                i += token.Length;
                continue;
            }

            if (TokenLetters.IndexOf(format[i]) >= 0)
            {
                // The whole run, so the message names what the writer typed rather than one letter.
                int end = i;
                while (end < format.Length && TokenLetters.IndexOf(format[end]) >= 0)
                {
                    end++;
                }

                string run = format.Substring(i, end - i);
                throw new ArgumentException(
                    $"date format: \"{run}\" is not a token — write it as [{run}] if it is "
                    + "meant to be literal text");
            }

            i += 1;
        }
    }

    public static string Format(PlainDateTime value, string? format, string? localeName)
    {
        DateLocale locale = Locale(localeName);
        string expanded = Expand(format ?? "L", locale);

        var result = new StringBuilder();
        // Whether a day-of-month token has already been rendered; `MMMM` reads it to pick
        // between the month's two forms. See `Render`.
        bool afterDay = false;
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
                result.Append(Render(token, value, locale, afterDay));
                if (token is "D" or "DD")
                {
                    afterDay = true;
                }

                i += token.Length;
                continue;
            }

            result.Append(ch);
            i++;
        }

        return result.ToString();
    }

    /// <summary>The named formats, longest first — the order they have to be tried in.</summary>
    /// <remarks>
    /// <c>LLLL</c> before <c>LLL</c> before <c>LL</c> before <c>L</c>, and <c>ISO_TIME</c>
    /// before <c>ISO</c>, or a longer name is read as a shorter one followed by letters nobody
    /// asked for.
    /// </remarks>
    private static readonly string[] NamedFormats =
        { "LLLL", "LLL", "LL", "L", "ISO_TIME", "ISO" };

    /// <summary>
    /// The letters a TOKEN is spelled with, plus the two a reader arrives with from elsewhere.
    /// </summary>
    /// <remarks>
    /// <c>A</c>/<c>a</c> is Moment's AM/PM and <c>h</c> its 12-hour clock; TDC has neither, and
    /// a format carrying them was written by somebody expecting them to work. Letters outside
    /// this set — the <c>o</c> and <c>f</c> of <c>of</c>, the <c>t</c> and <c>e</c> of
    /// <c>date:</c> — are ordinary words, and a word beside a date is a reasonable thing to
    /// write unbracketed.
    /// </remarks>
    private const string TokenLetters = "YMDdHhmsSZAaL";

    private static string Named(string name, DateLocale locale) => name switch
    {
        "ISO" => "YYYY-MM-DD",
        "ISO_TIME" => "YYYY-MM-DDTHH:mm:ss",
        _ => locale.Formats[name],
    };

    /// <summary>Replace every named format with the tokens it stands for, once.</summary>
    /// <remarks>
    /// These are TOKENS, not whole formats: the reference table documents them beside
    /// <c>YYYY</c> and <c>MM</c>, and a reader who writes <c>LL [at] HH:mm</c> is owed the date
    /// the table promises. They used to be matched against the WHOLE format string, so
    /// <c>LL</c> alone worked and <c>LL HH:mm</c> printed the literal text <c>LL 00:00</c> —
    /// the config was accepted, the run succeeded, and the file was wrong.
    /// <para>
    /// Bracketed text is skipped, so <c>[LL]</c> stays the letters. The result is not expanded
    /// again: a locale's own <c>LL</c> is written in plain tokens, and a second pass could only
    /// find a name a locale had put there, which would be a loop rather than a feature.
    /// </para>
    /// </remarks>
    private static string Expand(string format, DateLocale locale)
    {
        var out_ = new System.Text.StringBuilder();
        int i = 0;
        while (i < format.Length)
        {
            if (format[i] == '[')
            {
                int end = format.IndexOf(']', i + 1);
                if (end < 0)
                {
                    // Left for the caller to report, so the message is the one it always was.
                    out_.Append(format, i, format.Length - i);
                    break;
                }

                out_.Append(format, i, end + 1 - i);
                i = end + 1;
                continue;
            }

            string? name = Match(NamedFormats, format, i);
            if (name is not null)
            {
                out_.Append(Named(name, locale));
                i += name.Length;
                continue;
            }

            out_.Append(format[i]);
            i += 1;
        }

        return out_.ToString();
    }

    /// <summary>The first candidate the format starts with at <paramref name="i"/>, or null.</summary>
    private static string? Match(string[] candidates, string format, int i)
    {
        foreach (string candidate in candidates)
        {
            if (string.CompareOrdinal(format, i, candidate, 0, candidate.Length) == 0
                && i + candidate.Length <= format.Length)
            {
                return candidate;
            }
        }

        return null;
    }

    /// <summary>Renders one token. <paramref name="afterDay"/> selects the month form.</summary>
    /// <remarks>
    /// Half the world writes the month differently depending on whether a day number stands
    /// beside it. <c>MMMM</c> takes the in-date form when a day token came BEFORE it and the
    /// standalone form otherwise — the rule the reference applies, read off the format string
    /// alone so all five implementations agree:
    /// <c>D. MMMM YYYY</c> in-date (Czech, Finnish, Russian); <c>MMMM D, YYYY</c> standalone
    /// (English); <c>YYYY. MMMM D.</c> standalone (Hungarian, which wants the nominative);
    /// <c>dddd, D MMMM YYYY</c> in-date, because <c>dddd</c> is a weekday and not a day number.
    /// </remarks>
    private static string Render(string token, PlainDateTime v, DateLocale locale, bool afterDay)
        => token switch
    {
        "YYYY" => Pad(v.Year, 4),
        "YY" => Pad(v.Year % 100, 2),
        "MMMM" => (afterDay && locale.MonthsInDate is not null ? locale.MonthsInDate : locale.Months)[v.Month - 1],
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
