namespace Tdcv2.Date;

/// <summary>
/// A calendar instant with no zone attached.
/// </summary>
/// <remarks>
/// Everything in TDC's date handling is UTC. A generator that quietly used the machine's zone would
/// produce different data in Moscow and in Denver from the same seed, which is the one thing the
/// product promises never happens.
/// </remarks>
public readonly record struct PlainDateTime(
    int Year, int Month, int Day, int Hour, int Minute, int Second, int Millisecond)
{
    public PlainDateTime StartOfDay() => new(Year, Month, Day, 0, 0, 0, 0);
}

/// <summary>UTC Gregorian arithmetic, matching the reference implementation's helpers.</summary>
public static class Calendar
{
    public const long MsPerDay = 86_400_000L;

    public static bool IsLeapYear(int year) =>
        year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);

    public static int DaysInMonth(int year, int month) => month switch
    {
        2 => IsLeapYear(year) ? 29 : 28,
        4 or 6 or 9 or 11 => 30,
        _ => 31,
    };

    public static long ToEpochMillis(PlainDateTime v)
    {
        var utc = new DateTime(
            v.Year, v.Month, v.Day, v.Hour, v.Minute, v.Second, v.Millisecond, DateTimeKind.Utc);
        return (long)(utc - DateTime.UnixEpoch).TotalMilliseconds;
    }

    public static PlainDateTime FromEpochMillis(long ms)
    {
        DateTime t = DateTime.UnixEpoch.AddMilliseconds(ms);
        return new PlainDateTime(
            t.Year, t.Month, t.Day, t.Hour, t.Minute, t.Second, t.Millisecond);
    }

    public static long ToEpochDay(PlainDateTime v) =>
        FloorDiv(ToEpochMillis(v.StartOfDay()), MsPerDay);

    public static PlainDateTime FromEpochDay(long day) => FromEpochMillis(day * MsPerDay);

    /// <summary>
    /// Step back whole years, clamping the day.
    /// </summary>
    /// <remarks>
    /// The clamp is what keeps 29 February from silently becoming 1 March: a birthday on a leap day,
    /// taken back to a non-leap year, lands on the 28th.
    /// </remarks>
    public static long SubtractUtcYears(long ms, int years)
    {
        PlainDateTime source = FromEpochMillis(ms);
        int year = source.Year - years;
        int day = Math.Min(source.Day, DaysInMonth(year, source.Month));
        return ToEpochMillis(
            new PlainDateTime(
                year, source.Month, day, source.Hour, source.Minute, source.Second,
                source.Millisecond));
    }

    /// <summary>Day of week, Sunday = 0, to match the reference's weekday tables.</summary>
    public static int Weekday(PlainDateTime v) =>
        (int)new DateTime(v.Year, v.Month, v.Day, 0, 0, 0, DateTimeKind.Utc).DayOfWeek;

    /// <summary>Division that rounds toward negative infinity, as the reference's does.</summary>
    internal static long FloorDiv(long a, long b)
    {
        long q = a / b;
        return a % b != 0 && a < 0 != b < 0 ? q - 1 : q;
    }
}
