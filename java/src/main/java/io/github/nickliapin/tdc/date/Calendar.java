package io.github.nickliapin.tdc.date;

import java.time.Instant;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.ZoneOffset;

/** UTC Gregorian arithmetic, matching the reference implementation's helpers. */
public final class Calendar {

  public static final long MS_PER_DAY = 86_400_000L;

  private Calendar() {}

  public static boolean isLeapYear(int year) {
    return year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
  }

  public static int daysInMonth(int year, int month) {
    return switch (month) {
      case 2 -> isLeapYear(year) ? 29 : 28;
      case 4, 6, 9, 11 -> 30;
      default -> 31;
    };
  }

  public static long toEpochMillis(PlainDateTime v) {
    return LocalDateTime.of(
            v.year(), v.month(), v.day(), v.hour(), v.minute(), v.second(), v.millisecond() * 1_000_000)
        .toInstant(ZoneOffset.UTC)
        .toEpochMilli();
  }

  public static PlainDateTime fromEpochMillis(long ms) {
    LocalDateTime t = LocalDateTime.ofInstant(Instant.ofEpochMilli(ms), ZoneOffset.UTC);
    return new PlainDateTime(
        t.getYear(),
        t.getMonthValue(),
        t.getDayOfMonth(),
        t.getHour(),
        t.getMinute(),
        t.getSecond(),
        t.getNano() / 1_000_000);
  }

  public static long toEpochDay(PlainDateTime v) {
    return Math.floorDiv(toEpochMillis(v.startOfDay()), MS_PER_DAY);
  }

  public static PlainDateTime fromEpochDay(long day) {
    return fromEpochMillis(day * MS_PER_DAY);
  }

  /**
   * Step back whole years, clamping the day.
   *
   * <p>The clamp is what keeps 29 February from silently becoming 1 March: a birthday on a leap
   * day, taken back to a non-leap year, lands on the 28th.
   */
  public static long subtractUtcYears(long ms, int years) {
    PlainDateTime source = fromEpochMillis(ms);
    int year = source.year() - years;
    int day = Math.min(source.day(), daysInMonth(year, source.month()));
    return toEpochMillis(
        new PlainDateTime(
            year,
            source.month(),
            day,
            source.hour(),
            source.minute(),
            source.second(),
            source.millisecond()));
  }

  /** Day of week, Sunday = 0, to match the reference's weekday tables. */
  public static int weekday(PlainDateTime v) {
    LocalDate d = LocalDate.of(v.year(), v.month(), v.day());
    return d.getDayOfWeek().getValue() % 7;
  }
}
