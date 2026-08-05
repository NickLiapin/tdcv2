package io.github.nickliapin.tdc.date;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;

/**
 * Walking a date range instead of drawing from it: {@code step=} and {@code weekdays=}.
 *
 * <p>A step is EITHER a fixed span or a calendar span, and never both. The distinction is not
 * pedantry: {@code 15m} is always 900 000 milliseconds, while {@code 1mo} is 28, 29, 30 or 31
 * days depending on where you start. They compose within their own group — {@code 1h30m},
 * {@code 1y6mo} — and refuse to compose across it, because "one month and fifteen days" depends
 * on which is applied first, and a config whose meaning turns on an invisible ordering is worse
 * than one that will not parse. Allowing the mix later is easy; changing what it already means is
 * not.
 */
public final class DateStep {

  private static final long MS_PER_SECOND = 1000L;

  /** How far one row advances: milliseconds, or months. Exactly one is non-zero. */
  public record Spec(long ms, long months) {}

  /** Why a {@code step=} was refused, or the step it means. */
  public record Result(Spec step, Reason reason) {
    public boolean ok() {
      return step != null;
    }
  }

  /** The two ways a step can fail, which read differently because they ARE different. */
  public enum Reason {
    /** A spelling this notation does not have. */
    SYNTAX,
    /** A calendar unit and a fixed one in the same step. */
    MIXED
  }

  /** What a {@code step=} may say, for a diagnostic to quote. */
  public static final String STEP_SYNTAX = "15m, 1h30m, 2d, 3mo, 1y — units s, m, h, d, w, mo, y";

  /** The default step of a walked axis: one day. */
  public static final Spec DEFAULT_STEP = new Spec(Calendar.MS_PER_DAY, 0);

  /** The weekday names a filter may use, Sunday first. */
  public static final List<String> WEEKDAY_NAMES =
      List.of("sun", "mon", "tue", "wed", "thu", "fri", "sat");

  private DateStep() {}

  /**
   * Milliseconds in a fixed unit, or {@code -1}. {@code m} is MINUTE, as it is everywhere this
   * notation is used.
   */
  private static long fixedUnitMs(String unit) {
    return switch (unit) {
      case "s" -> MS_PER_SECOND;
      case "m" -> 60 * MS_PER_SECOND;
      case "h" -> 3600 * MS_PER_SECOND;
      case "d" -> Calendar.MS_PER_DAY;
      case "w" -> 7 * Calendar.MS_PER_DAY;
      default -> -1;
    };
  }

  /**
   * Months in a calendar unit, or {@code -1}.
   *
   * <p>{@code mo} rather than {@code m} because {@code m} is already the minute, and rather than
   * {@code M} because the difference between three minutes and three months would then rest on
   * the case of one letter — a distinction no reader checks and no tool that normalizes case
   * preserves.
   */
  private static long calendarUnitMonths(String unit) {
    return switch (unit) {
      case "mo" -> 1;
      case "y" -> 12;
      default -> -1;
    };
  }

  /**
   * {@code step="15m"}, {@code step="1h30m"}, {@code step="3mo"}, {@code step="2"}.
   *
   * <p>A bare number means DAYS, the default unit, so {@code step="2"} is every other day. A unit
   * may appear once: {@code 1h30m1h} is a typo, and summing it would hide the typo rather than
   * report it.
   */
  public static Result parseStep(String raw) {
    String value = raw == null ? "" : raw.trim().toLowerCase(java.util.Locale.ROOT);
    if (value.isEmpty()) {
      return new Result(DEFAULT_STEP, null);
    }
    if (value.chars().allMatch(Character::isDigit)) {
      long days;
      try {
        days = Long.parseLong(value);
      } catch (NumberFormatException e) {
        return new Result(null, Reason.SYNTAX);
      }
      return days >= 1
          ? new Result(new Spec(days * Calendar.MS_PER_DAY, 0), null)
          : new Result(null, Reason.SYNTAX);
    }

    long ms = 0;
    long months = 0;
    Set<String> seen = new LinkedHashSet<>();
    int at = 0;
    while (at < value.length()) {
      int digitsFrom = at;
      while (at < value.length() && Character.isDigit(value.charAt(at))) {
        at++;
      }
      if (at == digitsFrom) {
        return new Result(null, Reason.SYNTAX);
      }
      long count;
      try {
        count = Long.parseLong(value.substring(digitsFrom, at));
      } catch (NumberFormatException e) {
        return new Result(null, Reason.SYNTAX);
      }

      int unitFrom = at;
      while (at < value.length() && Character.isLetter(value.charAt(at))) {
        at++;
      }
      String unit = value.substring(unitFrom, at);
      if (unit.isEmpty() || !seen.add(unit)) {
        return new Result(null, Reason.SYNTAX);
      }

      long fixed = fixedUnitMs(unit);
      long calendar = calendarUnitMonths(unit);
      if (fixed >= 0) {
        ms += count * fixed;
      } else if (calendar >= 0) {
        months += count * calendar;
      } else {
        return new Result(null, Reason.SYNTAX);
      }
    }

    if (ms > 0 && months > 0) {
      return new Result(null, Reason.MIXED);
    }
    if (ms == 0 && months == 0) {
      return new Result(null, Reason.SYNTAX);
    }
    return new Result(new Spec(ms, months), null);
  }

  /**
   * {@code start} advanced by {@code n} steps.
   *
   * <p>A calendar month has no fixed length, so stepping by month or year keeps the DAY OF MONTH
   * and clamps it to the last day of a shorter one: 31 January plus one month is 28 February, not
   * 3 March. That is the same rule {@link Calendar#subtractUtcYears} already applies to {@code
   * person.b_day}, so the engine answers one way about calendars rather than two.
   */
  public static PlainDateTime addStep(PlainDateTime start, Spec step, long n) {
    if (step.months() == 0) {
      return Calendar.fromEpochMillis(Calendar.toEpochMillis(start) + n * step.ms());
    }
    long months = (long) start.year() * 12 + (start.month() - 1) + n * step.months();
    int year = (int) Math.floorDiv(months, 12);
    int month = (int) Math.floorMod(months, 12) + 1;
    return new PlainDateTime(
        year,
        month,
        Math.min(start.day(), Calendar.daysInMonth(year, month)),
        start.hour(),
        start.minute(),
        start.second(),
        start.millisecond());
  }

  /**
   * How many steps fit in {@code start..end}, counting both ends.
   *
   * <p>Computed rather than counted, because a second-by-second span of a century is a number no
   * loop should walk. A fixed step divides; a calendar one is estimated from the month difference
   * and corrected by at most one, which is what the clamping in {@link #addStep} can cost.
   */
  public static long stepsBetween(PlainDateTime start, PlainDateTime end, Spec step) {
    if (step.months() == 0) {
      long span = Calendar.toEpochMillis(end) - Calendar.toEpochMillis(start);
      return span < 0 ? 1 : span / step.ms() + 1;
    }
    long months = (long) (end.year() - start.year()) * 12 + end.month() - start.month();
    long n = Math.floorDiv(months, step.months());
    if (n < 0) {
      return 1;
    }
    if (Calendar.toEpochMillis(addStep(start, step, n)) > Calendar.toEpochMillis(end)) {
      n--;
    }
    return n + 1;
  }

  /**
   * True when every row of this step lands on the same weekday.
   *
   * <p>A calendar step does, and so does any whole number of weeks — {@code 14d} as much as
   * {@code 2w}, which a test on the unit's NAME would have missed. A weekday filter over such a
   * step matches every row or none, so it is refused rather than silently producing a full column
   * or an empty one.
   */
  public static boolean fixesWeekday(Spec step) {
    return step.months() > 0 || step.ms() % (7 * Calendar.MS_PER_DAY) == 0;
  }

  /**
   * {@code weekdays="mon..fri"} or {@code weekdays="sun,wed"} — which weekdays an axis keeps.
   *
   * <p>{@code ..} is the range operator everywhere else in the language, so it is the range
   * operator here. A SPAN wraps: {@code fri..mon} is Friday, Saturday, Sunday, Monday, because a
   * week is a circle and refusing to go round it would make half the spans unwritable. Returns
   * {@code null} on a name it does not know, so the caller can say which.
   */
  public static boolean[] parseWeekdays(String raw) {
    String value = raw == null ? "" : raw.trim().toLowerCase(java.util.Locale.ROOT);
    if (value.isEmpty()) {
      return null;
    }
    boolean[] keep = new boolean[7];
    for (String part : value.split(",", -1)) {
      String span = part.trim();
      if (span.isEmpty()) {
        return null;
      }
      int at = span.indexOf("..");
      if (at < 0) {
        int i = WEEKDAY_NAMES.indexOf(span);
        if (i < 0) {
          return null;
        }
        keep[i] = true;
        continue;
      }
      int first = WEEKDAY_NAMES.indexOf(span.substring(0, at).trim());
      int last = WEEKDAY_NAMES.indexOf(span.substring(at + 2).trim());
      if (first < 0 || last < 0) {
        return null;
      }
      for (int day = first; ; day = (day + 1) % 7) {
        keep[day] = true;
        if (day == last) {
          break;
        }
      }
    }
    return keep;
  }

  /** Which offsets within one cycle a weekday filter keeps, found once and then indexed. */
  public static List<Long> keptOffsets(PlainDateTime start, Spec step, boolean[] keep, long perCycle) {
    List<Long> offsets = new ArrayList<>();
    for (long i = 0; i < perCycle; i++) {
      if (keep[Calendar.weekday(addStep(start, step, i))]) {
        offsets.add(i);
      }
    }
    return offsets;
  }
}
