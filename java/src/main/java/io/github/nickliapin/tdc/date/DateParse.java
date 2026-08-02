package io.github.nickliapin.tdc.date;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Strict parsing for the dates a config writes by hand.
 *
 * <p>Strict on purpose. A lenient parser would read {@code 2026-02-30} as 2 March and generate
 * data that looks fine until someone tries to explain where March came from. The separator has
 * to match itself too, so {@code 2026-01/01} is an error rather than a guess.
 */
public final class DateParse {

  /** {@code \2} makes the second separator match the first: dashes, dots or slashes, not a mix. */
  private static final Pattern DATE_TIME =
      Pattern.compile(
          "^(\\d{4})([./-])(\\d{2})\\2(\\d{2})(?:[T ](\\d{2}):(\\d{2})(?::(\\d{2})(?:\\.(\\d{1,3}))?)?)?$");

  /** A parsed value plus whether the text carried a time — which decides the default precision. */
  public record Parsed(PlainDateTime value, boolean hasTime) {}

  public record Range(Parsed start, Parsed end) {}

  private DateParse() {}

  public static Parsed dateTime(String source) {
    Matcher m = DATE_TIME.matcher(source.trim());
    if (!m.matches()) {
      throw new IllegalArgumentException(
          "date: invalid date \"" + source + "\" (expected YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss)");
    }
    boolean hasTime = m.group(5) != null;
    PlainDateTime value =
        new PlainDateTime(
            Integer.parseInt(m.group(1)),
            Integer.parseInt(m.group(3)),
            Integer.parseInt(m.group(4)),
            hasTime ? Integer.parseInt(m.group(5)) : 0,
            hasTime ? Integer.parseInt(m.group(6)) : 0,
            m.group(7) == null ? 0 : Integer.parseInt(m.group(7)),
            // ".5" means 500 milliseconds, not 5 — pad on the right, never the left.
            m.group(8) == null ? 0 : Integer.parseInt(padRight(m.group(8))));
    assertValid(value, source);
    return new Parsed(value, hasTime);
  }

  /**
   * The older {@code range="1990.01.01 - 2000.12.31"} spelling, as {@code date.range} takes it.
   *
   * <p>Dots and a dash rather than the {@code ..} the {@code date} generator uses. Two spellings
   * for one idea is not a design anyone would choose, but the old one is in configs already and
   * silently rejecting them would be worse than carrying it.
   */
  public static Range legacyRange(String source) {
    java.util.regex.Matcher m =
        java.util.regex.Pattern.compile("^(\\d{4}\\.\\d{2}\\.\\d{2})\\s*-\\s*(\\d{4}\\.\\d{2}\\.\\d{2})$")
            .matcher(source.trim());
    if (!m.matches()) {
      throw new IllegalArgumentException("date.range: invalid range attribute \"" + source + "\"");
    }
    return new Range(dateTime(m.group(1)), dateTime(m.group(2)));
  }

  public static Range range(String source) {
    String[] parts = source.split("\\.\\.", -1);
    if (parts.length != 2) {
      throw new IllegalArgumentException(
          "date: invalid range \"" + source + "\" (expected START..END)");
    }
    return new Range(dateTime(parts[0]), dateTime(parts[1]));
  }

  private static void assertValid(PlainDateTime v, String source) {
    if (v.month() < 1 || v.month() > 12) {
      throw new IllegalArgumentException("date: invalid month in \"" + source + "\"");
    }
    if (v.day() < 1 || v.day() > Calendar.daysInMonth(v.year(), v.month())) {
      throw new IllegalArgumentException("date: invalid day in \"" + source + "\"");
    }
    if (v.hour() > 23 || v.minute() > 59 || v.second() > 59) {
      throw new IllegalArgumentException("date: invalid time in \"" + source + "\"");
    }
  }

  private static String padRight(String fraction) {
    StringBuilder out = new StringBuilder(fraction);
    while (out.length() < 3) {
      out.append('0');
    }
    return out.toString();
  }
}
