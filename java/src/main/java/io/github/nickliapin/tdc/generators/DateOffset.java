package io.github.nickliapin.tdc.generators;

import io.github.nickliapin.tdc.date.Calendar;
import io.github.nickliapin.tdc.date.DateFormatter;
import io.github.nickliapin.tdc.date.DateParse;
import io.github.nickliapin.tdc.date.DateStep;
import io.github.nickliapin.tdc.date.PlainDateTime;
import io.github.nickliapin.tdc.model.Config;
import io.github.nickliapin.tdc.prng.Prng;
import java.util.Map;

/**
 * {@code <gen type="date" of="Admitted" plus="3..10d">} — a date measured from another date.
 *
 * <p>The interval is in almost every real record — admitted and discharged, ordered and shipped,
 * issued and expires, the start and end of a shift — and it could not be said at all. Two
 * independent date columns put the discharge BEFORE the admission on a third of the rows, and the
 * workaround people reach for, non-overlapping windows ("admitted in January, discharged April to
 * June"), throws away exactly what the interval is for: its length, and how that length is
 * distributed. "Most stay a week, a few stay months" had no way to be written.
 *
 * <p>A generator sees no other column, by design — that is what makes a column's values a function
 * of the seed and the row index alone. This reads a sibling, so it is resolved in the engine beside
 * {@code running} and {@code stat}, in declaration order, which is also why {@code of=} must name a
 * column declared ABOVE it.
 */
public final class DateOffset {

  private DateOffset() {}

  /** The offset column, and its own instants when a third column measures from it. */
  public record Column(String[] values, Long[] instants) {}

  /** A source column an offset cannot read. */
  public static final class DateOffsetException extends RuntimeException {
    private static final long serialVersionUID = 1L;

    public DateOffsetException(String message, Throwable cause) {
      super(message, cause);
    }
  }

  /** The column this date is measured from, or {@code ""} when the generator did not say. */
  public static String sourceOf(Map<String, String> attrs) {
    String of = attrs.get("of");
    return of == null ? "" : of.trim();
  }

  /** True when this {@code <gen type="date">} is an offset rather than a draw. */
  public static boolean isOffset(Config.Gen gen) {
    return gen != null && "date".equals(gen.type()) && !sourceOf(gen.attrs()).isEmpty();
  }

  /**
   * Publish the offset column.
   *
   * <p>One draw per row, and only when the offset is a RANGE: {@code plus="7d"} is a fixed distance
   * and consumes no randomness at all, so a config that pins the interval leaves every other column
   * exactly where it was.
   *
   * <p>A row whose source is empty — outside a parent filter, or a source that was itself filtered
   * — stays empty. There is no date to measure from, and inventing one would put a value in a cell
   * the config said should have none.
   */
  public static Column build(
      String name,
      Map<String, String> attrs,
      String[] source,
      Long[] instants,
      int count,
      Prng.Sfc32 prng,
      String locale,
      boolean keepInstants) {
    String[] values = new String[count];
    DateStep.OffsetResult parsed = DateStep.parseOffset(attrs.get("plus"));
    if (!parsed.ok()) {
      return new Column(values, null); // a bad plus= is a diagnostic, not a crash
    }
    DateStep.OffsetSpec offset = parsed.offset();

    String format = attrs.get("format");
    format = format == null || format.trim().isEmpty() ? "L" : format.trim();
    // An offset is itself a date this engine produced, so it keeps its own value when a THIRD
    // column measures from it — signed, expires a year later, remind a month before that.
    Long[] own = keepInstants ? new Long[count] : null;

    for (int i = 0; i < count; i++) {
      String text = i < source.length ? source[i] : null;
      if (text == null || text.trim().isEmpty()) {
        continue;
      }
      PlainDateTime start = startOfRow(name, attrs, instants, i, text);
      if (start == null) {
        continue;
      }
      PlainDateTime landed = DateStep.applyOffset(start, offset, drawSteps(offset, prng));
      if (own != null) {
        own[i] = Calendar.toEpochMillis(landed);
      }
      values[i] = DateFormatter.format(landed, format, locale);
    }
    return new Column(values, own);
  }

  /**
   * The date row {@code i} is measured FROM, or null when the row has none.
   *
   * <p>Three readings, in this order:
   *
   * <ol>
   *   <li><b>The instant the source column kept.</b> A {@code <gen type="date">} this engine built
   *       remembers what it generated, so the offset works from the value and {@code format=} is
   *       free to be anything at all — the cell may read {@code March 2} or {@code 02.03.2026} and
   *       the arithmetic is the same either way.
   *   <li><b>No instant on a column that carries them.</b> {@code missing="0.1"} blanked that cell:
   *       the column HAS a date for other rows and none for this one. The offset has nothing to
   *       measure and the cell stays empty.
   *   <li><b>The text, read as ISO.</b> A date that came from a file or a pack has only its
   *       spelling left. The ISO form has one reading in every locale, so it is accepted; anything
   *       else is refused rather than guessed at, because {@code 02/03/2026} is the 2nd of March in
   *       one locale and the 3rd of February in another.
   * </ol>
   */
  private static PlainDateTime startOfRow(
      String name, Map<String, String> attrs, Long[] instants, int i, String text) {
    if (instants != null) {
      Long kept = i < instants.length ? instants[i] : null;
      return kept == null ? null : Calendar.fromEpochMillis(kept);
    }
    try {
      return DateParse.dateTime(text.trim()).value();
    } catch (RuntimeException error) {
      throw new DateOffsetException(
          "date offset (\""
              + name
              + "\"): \""
              + text
              + "\" in column \""
              + sourceOf(attrs)
              + "\" is not a date this can measure from. A date TDC generated carries its own "
              + "value and any format= works; one read from a file or a pack has only its text, "
              + "and only the ISO form (YYYY-MM-DD) means the same thing in every locale.",
          error);
    }
  }

  /**
   * How many steps this row moves.
   *
   * <p>A fixed offset takes no draw, which is what lets {@code plus="7d"} be added to a config
   * without shifting any other column. A range takes exactly one.
   */
  private static long drawSteps(DateStep.OffsetSpec offset, Prng.Sfc32 prng) {
    if (offset.lo() == offset.hi()) {
      return offset.lo();
    }
    long span = offset.hi() - offset.lo() + 1;
    return offset.lo() + Math.min(span - 1, (long) (prng.next() * span));
  }
}
