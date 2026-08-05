package io.github.nickliapin.tdc.date;

import io.github.nickliapin.tdc.prng.Prng;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * {@code <gen type="date" .../>} and the {@code person.b_day} template behind it.
 *
 * <p>A plan is built once from the attributes, then each value is one draw against it. Two
 * kinds: a fixed instant ({@code today}, {@code now}, a single date) that takes no draw at all,
 * and a range that takes exactly one.
 *
 * <p>Precision decides what the draw is over — days, seconds or milliseconds — and it is not
 * cosmetic. A range drawn by day and the same range drawn by millisecond both look like dates
 * once formatted, and they disagree.
 */
public final class DateGen {

  private static final String DEFAULT_START = "1970-01-01";
  private static final String DEFAULT_FORMAT = "L";
  private static final long MS_PER_SECOND = 1000L;

  /** How finely the range is divided before a value is drawn from it. */
  public enum Precision {
    DAY,
    SECOND,
    MILLISECOND
  }

  private record Plan(
      PlainDateTime fixed,
      PlainDateTime start,
      PlainDateTime end,
      /**
       * True when the range was written with only its START. {@code end} is then a copy of {@code
       * start} and means nothing; {@link #dateAxis} reads this and never wraps.
       */
      boolean openEnd,
      Precision precision,
      String format,
      String locale) {}

  private DateGen() {}

  public static List<String> generate(
      Map<String, String> attrs, String locale, long nowMillis, int count, Prng.Sfc32 prng) {
    Plan plan = plan(attrs, locale, nowMillis);
    List<String> out = new ArrayList<>(count);
    for (int i = 0; i < count; i++) {
      PlainDateTime value = plan.fixed() != null ? plan.fixed() : pick(plan, prng);
      out.add(DateFormatter.format(value, plan.format(), plan.locale()));
    }
    return out;
  }

  /** One value for {@code person.b_day}, which is a date generator wearing a template's name. */
  public static String birthDay(
      Map<String, String> attrs, String locale, long nowMillis, Prng.Sfc32 prng) {
    return generate(birthAttrs(attrs), locale, nowMillis, 1, prng).get(0);
  }

  /**
   * {@code date.range} — a date generator addressed as a pack path, taking the older
   * {@code range="1990.01.01 - 2000.12.31"} spelling.
   *
   * <p>It is the {@code date} generator underneath, so the bounds are rewritten into the form
   * that generator reads rather than a second implementation being kept in step with the first.
   */
  public static List<String> legacyRange(
      Map<String, String> attrs, String locale, long nowMillis, int count, Prng.Sfc32 prng) {
    DateParse.Range range;
    try {
      range = DateParse.legacyRange(attrs.getOrDefault("range", ""));
    } catch (RuntimeException e) {
      throw new IllegalArgumentException(
          "date.range: invalid range attribute \"" + attrs.getOrDefault("range", "") + "\"");
    }
    Map<String, String> rewritten = new java.util.HashMap<>();
    rewritten.put("from", serialize(range.start().value()));
    rewritten.put("to", serialize(range.end().value()));
    copy(attrs, rewritten, "format");
    copy(attrs, rewritten, "local");
    rewritten.put("precision", attrs.getOrDefault("precision", "day"));
    return generate(rewritten, locale, nowMillis, count, prng);
  }

  private static String serialize(PlainDateTime value) {
    return String.format(
        "%04d-%02d-%02dT%02d:%02d:%02d.%03d",
        value.year(), value.month(), value.day(), value.hour(), value.minute(), value.second(),
        value.millisecond());
  }

  /**
   * {@code person.b_day} reaches the date generator with {@code value="birth"} and an explicit
   * millisecond precision. The precision looks redundant next to a birth range measured in
   * years, and it is not: it is what the reference passes, so it is what decides the day.
   */
  private static Map<String, String> birthAttrs(Map<String, String> attrs) {
    Map<String, String> out = new java.util.HashMap<>();
    out.put("value", "birth");
    copy(attrs, out, "oldest");
    copy(attrs, out, "youngest");
    copy(attrs, out, "format");
    copy(attrs, out, "local");
    out.put("precision", attrs.getOrDefault("precision", "millisecond"));
    return out;
  }

  private static void copy(Map<String, String> from, Map<String, String> to, String key) {
    String value = from.get(key);
    if (value != null) {
      to.put(key, value);
    }
  }

  private static Plan plan(Map<String, String> attrs, String locale, long nowMillis) {
    String format = attrs.getOrDefault("format", DEFAULT_FORMAT);
    String loc = attrs.getOrDefault("local", locale);
    String value = attrs.get("value") == null ? null : attrs.get("value").trim();

    if ("today".equals(value)) {
      return new Plan(
          Calendar.fromEpochMillis(nowMillis).startOfDay(),
          null,
          null,
          false,
          precision(attrs.get("precision"), Precision.DAY),
          format,
          loc);
    }
    if ("now".equals(value)) {
      return new Plan(
          Calendar.fromEpochMillis(nowMillis),
          null,
          null,
          false,
          precision(attrs.get("precision"), Precision.MILLISECOND),
          format,
          loc);
    }
    if ("birth".equals(value)) {
      int oldest = age(attrs.get("oldest"), 80, "oldest");
      int youngest = age(attrs.get("youngest"), 10, "youngest");
      if (youngest > oldest) {
        throw new IllegalArgumentException(
            "date generator: youngest must be less than or equal to oldest");
      }
      return range(
          Calendar.fromEpochMillis(Calendar.subtractUtcYears(nowMillis, oldest)),
          Calendar.fromEpochMillis(Calendar.subtractUtcYears(nowMillis, youngest)),
          attrs,
          false,
          Precision.DAY,
          format,
          loc);
    }

    String from = attrs.get("from");
    String to = attrs.get("to");
    if (from != null || to != null) {
      // `from=` alone is an OPEN axis — legal when the range is WALKED, and the plan carries only
      // a start. `dateAxis` reads `openEnd` and never wraps; a DRAWN date with one end is still
      // refused, by TDC150.
      if (to == null) {
        DateParse.Parsed start = DateParse.dateTime(from);
        return new Plan(
            null,
            start.value(),
            start.value(),
            true,
            precision(
                attrs.get("precision"),
                start.hasTime() ? Precision.MILLISECOND : Precision.DAY),
            format,
            loc);
      }
      if (from == null) {
        throw new IllegalArgumentException(
            "date generator: \"from\" and \"to\" must be provided together");
      }
      return rangeOf(DateParse.dateTime(from), DateParse.dateTime(to), attrs, format, loc);
    }

    if (attrs.get("range") != null) {
      DateParse.Range parsed = DateParse.range(attrs.get("range"));
      return rangeOf(parsed.start(), parsed.end(), attrs, format, loc);
    }

    if (value != null && !value.isEmpty()) {
      if (value.contains("..")) {
        DateParse.Range parsed = DateParse.range(value);
        return rangeOf(parsed.start(), parsed.end(), attrs, format, loc);
      }
      DateParse.Parsed parsed = DateParse.dateTime(value);
      return new Plan(
          parsed.value(),
          null,
          null,
          false,
          precision(attrs.get("precision"), parsed.hasTime() ? Precision.MILLISECOND : Precision.DAY),
          format,
          loc);
    }

    // Nothing specified at all: the epoch up to right now. The upper bound carries a time, but the
    // fallback precision is still whole days — an unbounded generator answers with a date, not a
    // timestamp at 03:47. Routing this through rangeOf let hasTime pick MILLISECOND, and a
    // millisecond draw lands a day away from the reference's day draw often enough to fail.
    return range(
        DateParse.dateTime(DEFAULT_START).value(),
        Calendar.fromEpochMillis(nowMillis),
        attrs,
        true,
        Precision.DAY,
        format,
        loc);
  }

  private static Plan rangeOf(
      DateParse.Parsed start,
      DateParse.Parsed end,
      Map<String, String> attrs,
      String format,
      String locale) {
    return range(
        start.value(),
        end.value(),
        attrs,
        start.hasTime() || end.hasTime(),
        null,
        format,
        locale);
  }

  /**
   * A range plan. When neither bound carried a time, the range is over whole days — which is
   * why {@code range="2026-01-01..2026-01-31"} yields dates and not timestamps at 03:47.
   */
  private static Plan range(
      PlainDateTime start,
      PlainDateTime end,
      Map<String, String> attrs,
      boolean hasTime,
      Precision fallback,
      String format,
      String locale) {
    Precision defaultPrecision =
        fallback != null ? fallback : hasTime ? Precision.MILLISECOND : Precision.DAY;
    return new Plan(
        null, start, end, false, precision(attrs.get("precision"), defaultPrecision), format,
        locale);
  }

  /**
   * A date range as a walkable axis: how many steps it holds, and what the k-th is.
   *
   * <p>{@code size} is {@code null} for an OPEN axis — {@code from=} with no end. Requiring an end
   * meant working out what date the millionth day falls on in order to write it down, when the end
   * is simply {@code start + count × step}. Such an axis never wraps, because there is nothing to
   * wrap at.
   *
   * <p>The range is never expanded into a list. A century stepped by the second is three billion
   * values and the streaming engine promises bounded memory whatever the config says — so each
   * date is {@code start + k × step}, measured from the START rather than accumulated, which is
   * what keeps a clamped February from dragging every later month back with it.
   */
  public static final class Axis {
    private final Long size;
    private final PlainDateTime start;
    private final DateStep.Spec step;
    private final List<Long> offsets;
    private final long perCycle;
    private final String format;
    private final String locale;

    private Axis(
        Long size,
        PlainDateTime start,
        DateStep.Spec step,
        List<Long> offsets,
        long perCycle,
        String format,
        String locale) {
      this.size = size;
      this.start = start;
      this.step = step;
      this.offsets = offsets;
      this.perCycle = perCycle;
      this.format = format;
      this.locale = locale;
    }

    /** How many positions the axis holds, or {@code null} when it is open. */
    public Long size() {
      return size;
    }

    /** The k-th value of the axis, rendered. */
    public String at(long k) {
      PlainDateTime candidate;
      if (offsets.isEmpty()) {
        candidate = DateStep.addStep(start, step, k);
      } else {
        long n = offsets.size();
        long cycles = Math.floorDiv(k, n);
        long within = offsets.get((int) Math.floorMod(k, n));
        candidate = DateStep.addStep(start, step, cycles * perCycle + within);
      }
      return DateFormatter.format(candidate, format, locale);
    }
  }

  private static final long MS_PER_WEEK = 7 * Calendar.MS_PER_DAY;

  private static long gcd(long a, long b) {
    return b == 0 ? a : gcd(b, a % b);
  }

  /** Build the walkable axis an {@code order="sequential"} date reads. */
  public static Axis dateAxis(Map<String, String> attrs, String locale, long nowMillis) {
    DateStep.Result parsed = DateStep.parseStep(attrs.get("step"));
    DateStep.Spec step = parsed.ok() ? parsed.step() : DateStep.DEFAULT_STEP;
    boolean[] keep = DateStep.parseWeekdays(attrs.get("weekdays"));
    Plan plan = plan(attrs, locale, nowMillis);

    if (plan.start() == null) {
      PlainDateTime fixed = plan.fixed();
      if (fixed == null) {
        throw new IllegalArgumentException("date generator: invalid generation plan");
      }
      return new Axis(
          1L, fixed, DateStep.DEFAULT_STEP, List.of(), 1, plan.format(), plan.locale());
    }

    // `weekdays=` keeps only some of the candidates, so the k-th KEPT one is wanted rather than
    // the k-th candidate. Which candidates match repeats on a cycle — one week's worth of steps —
    // so the offsets are found once and then indexed, instead of scanning from the beginning for
    // every row.
    List<Long> offsets = List.of();
    long perCycle = 1;
    if (keep != null) {
      perCycle = step.ms() > 0 ? MS_PER_WEEK / gcd(step.ms(), MS_PER_WEEK) : 7;
      offsets = DateStep.keptOffsets(plan.start(), step, keep, perCycle);
    }

    Long size = null;
    if (!plan.openEnd()) {
      long candidates = DateStep.stepsBetween(plan.start(), plan.end(), step);
      if (offsets.isEmpty()) {
        size = candidates;
      } else {
        long whole = candidates / perCycle * offsets.size();
        long tail = candidates % perCycle;
        long partial = 0;
        for (long offset : offsets) {
          if (offset < tail) {
            partial++;
          }
        }
        size = Math.max(1, whole + partial);
      }
    }
    return new Axis(size, plan.start(), step, offsets, perCycle, plan.format(), plan.locale());
  }

  private static PlainDateTime pick(Plan plan, Prng.Sfc32 prng) {
    if (plan.precision() == Precision.DAY) {
      long a = Calendar.toEpochDay(plan.start());
      long b = Calendar.toEpochDay(plan.end());
      return Calendar.fromEpochDay(inclusive(prng, Math.min(a, b), Math.max(a, b)));
    }
    long divisor = plan.precision() == Precision.SECOND ? MS_PER_SECOND : 1;
    long a = Math.floorDiv(Calendar.toEpochMillis(plan.start()), divisor);
    long b = Math.floorDiv(Calendar.toEpochMillis(plan.end()), divisor);
    return Calendar.fromEpochMillis(inclusive(prng, Math.min(a, b), Math.max(a, b)) * divisor);
  }

  /** One draw, inclusive of both ends. */
  private static long inclusive(Prng.Sfc32 prng, long min, long max) {
    return (long) Math.floor(prng.next() * (double) (max - min + 1) + (double) min);
  }

  public static Precision precision(String raw, Precision fallback) {
    if (raw == null) {
      return fallback;
    }
    return switch (raw) {
      case "day" -> Precision.DAY;
      case "second" -> Precision.SECOND;
      case "millisecond" -> Precision.MILLISECOND;
      default -> throw new IllegalArgumentException(
          "date generator: unsupported precision \"" + raw + "\" (supported: day, second, millisecond)");
    };
  }

  /**
   * The birth ages, checked without generating anything.
   *
   * <p>Whole numbers in a plausible range, and the older bound actually older — a config that has
   * them the wrong way round asks for an empty span and gets no dates at all.
   */
  public static void checkBirthAges(Map<String, String> attrs) {
    int oldest = age(attrs.get("oldest"), 80, "oldest");
    int youngest = age(attrs.get("youngest"), 10, "youngest");
    if (youngest > oldest) {
      throw new IllegalArgumentException(
          "date generator: youngest must be less than or equal to oldest");
    }
  }

  private static int age(String raw, int fallback, String name) {
    if (raw == null) {
      return fallback;
    }
    int value;
    try {
      value = Integer.parseInt(raw.trim());
    } catch (NumberFormatException e) {
      throw new IllegalArgumentException(
          "date generator: " + name + " must be an integer from 0 to 150");
    }
    if (value < 0 || value > 150) {
      throw new IllegalArgumentException(
          "date generator: " + name + " must be an integer from 0 to 150");
    }
    return value;
  }
}
