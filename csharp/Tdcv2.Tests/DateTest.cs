using Tdcv2.Date;

namespace Tdcv2.Tests;

/// <summary>
/// The date rules that a platform's own library would get subtly wrong.
/// </summary>
/// <remarks>
/// The shared cases already prove the generator draws the same values as the reference. What they do
/// not reach are the edges: a token whose meaning differs between .NET and Moment, a leap day taken
/// back to a non-leap year, a date string a lenient parser would quietly repair.
/// </remarks>
public class DateTest
{
    private static readonly PlainDateTime Sample = new(2026, 2, 1, 9, 5, 7, 42);

    [Theory]
    // DD is the day of the month here. .NET's own "dd" agrees, but its "ddd" is an abbreviated
    // weekday while Moment's D/DD/M/MM/mm split day, month and minute differently — the reason
    // this formatter exists rather than a call into ToString(format).
    [InlineData("YYYY-MM-DD", "2026-02-01")]
    [InlineData("D/M/YY", "1/2/26")]
    [InlineData("HH:mm:ss.SSS", "09:05:07.042")]
    [InlineData("H:m:s", "9:5:7")]
    [InlineData("dddd", "Sunday")]
    [InlineData("ddd MMM", "Sun Feb")]
    [InlineData("ISO", "2026-02-01")]
    [InlineData("ISO_TIME", "2026-02-01T09:05:07")]
    [InlineData("LL", "February 1, 2026")]
    // A literal in brackets is passed through, tokens inside it and all.
    [InlineData("[on] D [of] MMMM", "on 1 of February")]
    // Zones are always UTC: nothing here reads the machine's.
    [InlineData("Z ZZ", "+00:00 +0000")]
    public void FormatsMomentTokensRatherThanDotNetOnes(string format, string expected) =>
        Assert.Equal(expected, DateFormatter.Format(Sample, format, "en"));

    [Fact]
    public void MonthNamesComeFromTheTableNotThePlatform()
    {
        // Russian inflects the month inside a date: the standalone «февраль» is «февраля» here.
        Assert.Equal("1 февраля 2026 г.", DateFormatter.Format(Sample, "LL", "ru"));
        // An unknown locale falls back to English rather than refusing to render a date.
        Assert.Equal(
            DateFormatter.Format(Sample, "LL", "en"),
            DateFormatter.Format(Sample, "LL", "kl"));
    }

    [Fact]
    public void AllTheAdvertisedLocalesResolveToTheirOwnTable()
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (string name in DateLocales.Names)
        {
            Assert.True(DateLocales.IsKnown(name), name);
            seen.Add(DateLocales.Resolve(name).Months[1]);
        }

        // Eleven languages, eleven different words for February — no table is a copy of another.
        Assert.Equal(DateLocales.Names.Count, seen.Count);
    }

    [Fact]
    public void SteppingBackWholeYearsClampsTheLeapDay()
    {
        long leapDay = Calendar.ToEpochMillis(new PlainDateTime(2024, 2, 29, 0, 0, 0, 0));
        PlainDateTime oneYearBack = Calendar.FromEpochMillis(Calendar.SubtractUtcYears(leapDay, 1));

        // Not 1 March: a birthday on a leap day lands on the 28th, it does not roll over.
        Assert.Equal(new PlainDateTime(2023, 2, 28, 0, 0, 0, 0), oneYearBack);
    }

    [Theory]
    // A lenient parser reads this as 2 March and the data looks fine until someone asks where
    // March came from.
    [InlineData("2026-02-30")]
    [InlineData("2026-13-01")]
    // The separator has to match itself, so a mixed one is an error rather than a guess.
    [InlineData("2026-01/01")]
    [InlineData("2026-01-01T25:00:00")]
    public void RefusesADateItWouldOtherwiseHaveToInvent(string source) =>
        Assert.Throws<ArgumentException>(() => DateParse.DateTime(source));

    [Fact]
    public void AFractionPadsOnTheRight()
    {
        // ".5" is 500 milliseconds, not 5.
        Assert.Equal(500, DateParse.DateTime("2026-01-01T00:00:00.5").Value.Millisecond);
        Assert.Equal(50, DateParse.DateTime("2026-01-01T00:00:00.05").Value.Millisecond);
    }

    [Fact]
    public void PrecisionDecidesWhatTheDrawIsOver()
    {
        var attrs = new Dictionary<string, string>
        {
            ["range"] = "2026-01-01T00:00:00..2026-01-01T23:59:59",
            ["format"] = "ISO_TIME",
        };

        string byDay = Run(new Dictionary<string, string>(attrs) { ["precision"] = "day" });
        string bySecond = Run(new Dictionary<string, string>(attrs) { ["precision"] = "second" });

        // Both are dates once formatted, and they disagree — which is why precision is not cosmetic.
        Assert.Equal("2026-01-01T00:00:00", byDay);
        Assert.NotEqual(byDay, bySecond);
    }

    private static string Run(IReadOnlyDictionary<string, string> attrs) =>
        DateGen.Generate(attrs, "en", 0, 1, Tdcv2.Prng.Prng.Create("unit-test"))[0];
}
