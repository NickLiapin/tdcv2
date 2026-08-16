package io.github.nickliapin.tdc.date;

import java.util.List;
import java.util.Map;

/**
 * The Moment-style formatting subset TDC uses.
 *
 * <p>Deliberately not {@code DateTimeFormatter}. The JDK's patterns differ from Moment's in
 * ways that would show up as wrong output rather than as an error — {@code DD} means day of
 * year in one and day of month in the other — and its locale data comes from the platform,
 * which would make the same seed print different month names on different machines. The names
 * live in {@link DateLocales}, byte for byte the same in every implementation.
 */
public final class DateFormatter {

  /** Longest first: {@code MMMM} must be recognised before {@code MMM} and {@code MM}. */
  private static final List<String> TOKENS =
      List.of(
          "YYYY", "MMMM", "dddd", "MMM", "ddd", "SSS", "YY", "MM", "DD", "HH", "mm", "ss", "ZZ",
          "M", "D", "H", "m", "s", "Z");

  /** One language's names and its shorthand formats. */
  public record DateLocale(
      List<String> months,
      List<String> monthsShort,
      List<String> weekdays,
      List<String> weekdaysShort,
      Map<String, String> formats,
      /**
       * The month as it is written WITH a day number beside it — Russian {@code январь} becomes
       * {@code 15 января}. {@code null} when the language does not distinguish the two, in which
       * case {@code months} serves for both.
       */
      List<String> monthsInDate) {

    /** The eighteen languages whose month has a single form. */
    public DateLocale(
        List<String> months,
        List<String> monthsShort,
        List<String> weekdays,
        List<String> weekdaysShort,
        Map<String, String> formats) {
      this(months, monthsShort, weekdays, weekdaysShort, formats, null);
    }
  }

  private DateFormatter() {}

  public static DateLocale locale(String name) {
    return DateLocales.resolve(name);
  }

  /**
   * Whether a format string is well formed, without a date to apply it to.
   *
   * <p>Only the bracket literals can be malformed; an unknown token is passed through as text by
   * design, so it is not an error.
   */
  public static void checkFormat(String format) {
    for (int i = 0; i < format.length(); i++) {
      if (format.charAt(i) != '[') {
        continue;
      }
      int end = format.indexOf(']', i + 1);
      if (end < 0) {
        throw new IllegalArgumentException("date format: unterminated literal \"" + format + "\"");
      }
      i = end;
    }
  }

  public static String format(PlainDateTime value, String format, String localeName) {
    DateLocale locale = locale(localeName);
    String expanded = expand(format == null ? "L" : format, locale);

    StringBuilder out = new StringBuilder();
    // Whether a day-of-month token has already been rendered; `MMMM` reads it to pick between
    // the month's two forms. See `render`.
    boolean afterDay = false;
    int i = 0;
    while (i < expanded.length()) {
      char ch = expanded.charAt(i);
      if (ch == '[') {
        int end = expanded.indexOf(']', i + 1);
        if (end < 0) {
          throw new IllegalArgumentException("date format: unterminated literal \"" + expanded + "\"");
        }
        out.append(expanded, i + 1, end);
        i = end + 1;
        continue;
      }
      String token = null;
      for (String candidate : TOKENS) {
        if (expanded.startsWith(candidate, i)) {
          token = candidate;
          break;
        }
      }
      if (token != null) {
        out.append(render(token, value, locale, afterDay));
        if (token.equals("D") || token.equals("DD")) {
          afterDay = true;
        }
        i += token.length();
        continue;
      }
      out.append(ch);
      i++;
    }
    return out.toString();
  }

  private static String expand(String format, DateLocale locale) {
    return switch (format) {
      case "ISO" -> "YYYY-MM-DD";
      case "ISO_TIME" -> "YYYY-MM-DDTHH:mm:ss";
      case "L", "LL", "LLL", "LLLL" -> locale.formats().get(format);
      default -> format;
    };
  }

  /**
   * Renders one token. {@code afterDay} selects the month form.
   *
   * <p>Half the world writes the month differently depending on whether a day number stands beside
   * it. {@code MMMM} takes the in-date form when a day token came BEFORE it and the standalone form
   * otherwise — the rule the reference applies, read off the format string alone so all five
   * implementations agree: {@code D. MMMM YYYY} in-date (Czech, Finnish, Russian);
   * {@code MMMM D, YYYY} standalone (English); {@code YYYY. MMMM D.} standalone (Hungarian, which
   * wants the nominative); {@code dddd, D MMMM YYYY} in-date, because {@code dddd} is a weekday and
   * not a day number.
   */
  private static String render(
      String token, PlainDateTime v, DateLocale locale, boolean afterDay) {
    return switch (token) {
      case "YYYY" -> pad(v.year(), 4);
      case "YY" -> pad(v.year() % 100, 2);
      case "MMMM" ->
          (afterDay && locale.monthsInDate() != null ? locale.monthsInDate() : locale.months())
              .get(v.month() - 1);
      case "MMM" -> locale.monthsShort().get(v.month() - 1);
      case "MM" -> pad(v.month(), 2);
      case "M" -> String.valueOf(v.month());
      case "DD" -> pad(v.day(), 2);
      case "D" -> String.valueOf(v.day());
      case "dddd" -> locale.weekdays().get(Calendar.weekday(v));
      case "ddd" -> locale.weekdaysShort().get(Calendar.weekday(v));
      case "HH" -> pad(v.hour(), 2);
      case "H" -> String.valueOf(v.hour());
      case "mm" -> pad(v.minute(), 2);
      case "m" -> String.valueOf(v.minute());
      case "ss" -> pad(v.second(), 2);
      case "s" -> String.valueOf(v.second());
      case "SSS" -> pad(v.millisecond(), 3);
      case "Z" -> "+00:00";
      case "ZZ" -> "+0000";
      default -> token;
    };
  }

  private static String pad(int value, int length) {
    String s = String.valueOf(value);
    return s.length() >= length ? s : "0".repeat(length - s.length()) + s;
  }
}
