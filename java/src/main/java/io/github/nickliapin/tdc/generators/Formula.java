package io.github.nickliapin.tdc.generators;

import io.github.nickliapin.tdc.expr.Evaluate;
import io.github.nickliapin.tdc.lib.Fixed;
import io.github.nickliapin.tdc.lib.Numbers;
import io.github.nickliapin.tdc.stats.DistParams;
import java.util.Map;
import java.util.function.Function;
import java.util.function.Predicate;

/**
 * {@code <gen type="formula" expr="Weight / (Height * Height)">} — arithmetic over the columns
 * beside it.
 *
 * <p>A whole COLUMN read from other columns, like {@code running} and {@code stat}, but unlike them
 * it needs only its OWN row: row nine million is {@code Weight[9M] / Height[9M]²} and nothing
 * before it. So it streams and it parallelises, where a running total cannot.
 *
 * <p>Two rules decide what a cell holds, and both are the ones {@code stat} already follows:
 * without {@code decimals=} the value is printed whole, with it the answer is rounded; and a source
 * cell that is EMPTY makes the answer empty. A cell a {@code parent=} filter switched off is not a
 * zero, and {@code 0 / 0} is not the honest reading of it.
 */
public final class Formula {

  private Formula() {}

  /** {@code expr=}, which a formula cannot do without. */
  public static String expressionOf(Map<String, String> attrs) {
    String source = attrs.getOrDefault("expr", "").trim();
    if (source.isEmpty()) {
      throw new IllegalArgumentException("<gen type=\"formula\"> needs expr=\"…\"");
    }
    return source;
  }

  /** {@code decimals=} when the config declared one, else the value is printed whole. */
  public static Integer decimalsOf(Map<String, String> attrs) {
    String raw = attrs.getOrDefault("decimals", "").trim();
    if (raw.isEmpty()) {
      return null;
    }
    int value;
    try {
      value = Integer.parseInt(raw);
    } catch (NumberFormatException e) {
      throw new IllegalArgumentException(
          "decimals=\"" + raw + "\" is not a whole number from 0 to 10");
    }
    if (value < 0 || value > 10) {
      throw new IllegalArgumentException(
          "decimals=\"" + raw + "\" is not a whole number from 0 to 10");
    }
    return value;
  }

  /** One row's answer, or {@code null} when a column it read was empty. */
  public static String valueAtRow(
      String source,
      Integer decimals,
      int row,
      Predicate<String> hasColumn,
      Function<String, String> valueAt) {
    RowScope scope = new RowScope(row, hasColumn, valueAt);
    Object answer = Evaluate.asValue(source, scope);
    return scope.empty ? null : render(answer, decimals, scope);
  }

  /**
   * One evaluated answer, as the text that goes in the cell.
   *
   * <p>NaN is how "arithmetic on text" arrives here. In an {@code if=} it merely makes every
   * comparison false and the branch quietly does not fire; in a COLUMN it would print, and a file
   * full of {@code NaN} nobody was warned about is the defect this project keeps closing. So it is
   * refused — and the refusal names the column that held the text, because the scope recorded what
   * the expression actually read.
   */
  private static String render(Object value, Integer decimals, RowScope scope) {
    // A whole number is printed from the integer it still is: going through a double would undo
    // the exactness the expression language worked to keep.
    if (value instanceof Long n) {
      return decimals == null ? n.toString() : Fixed.toFixed(n, decimals);
    }
    if (value instanceof Boolean on) {
      return on ? "true" : "false";
    }
    if (value instanceof Double d) {
      if (Double.isNaN(d)) {
        throw new IllegalArgumentException(
            scope.textColumn == null
                ? "the expression has no number as its answer — 0/0, the square root of a"
                    + " negative, or another sum with no value"
                : "the expression is not a number: column \""
                    + scope.textColumn
                    + "\" holds \""
                    + scope.textValue
                    + "\", which is text rather than a number");
      }
      if (Double.isInfinite(d)) {
        throw new IllegalArgumentException(
            "the expression is "
                + (d > 0 ? "Infinity" : "-Infinity")
                + " — a division by zero, the logarithm of zero, or a value past the range a"
                + " number can hold");
      }
      return decimals == null ? Numbers.toText(d) : Fixed.toFixed(d, decimals);
    }
    // Text. A formula is allowed to produce it — `expr="Age > 65 ? senior : adult"` is a label,
    // and labels are half of what a data-science config builds. `decimals=` says nothing about a
    // label, so it is left alone rather than forced through a number.
    return value instanceof String text ? text : "";
  }

  /**
   * The scope one row's evaluation reads through.
   *
   * <p>{@code has} and {@code value} stay separate for the same reason they do in a condition: an
   * absent name is not an empty one. A name the registry does not know is its own text — that is
   * what lets {@code if="Gender == Male"} go unquoted — so only a name it DOES know can make the
   * row empty.
   */
  private static final class RowScope implements Evaluate.Scope {
    private final int row;
    private final Predicate<String> hasColumn;
    private final Function<String, String> valueAt;
    private boolean empty;
    private String textColumn;
    private String textValue;

    RowScope(int row, Predicate<String> hasColumn, Function<String, String> valueAt) {
      this.row = row;
      this.hasColumn = hasColumn;
      this.valueAt = valueAt;
    }

    @Override
    public boolean has(String name) {
      return "_count".equals(name) || hasColumn.test(name);
    }

    @Override
    public String value(String name) {
      if ("_count".equals(name)) {
        return Integer.toString(row + 1);
      }
      String cell = valueAt.apply(name);
      if (cell == null) {
        cell = "";
      }
      if (hasColumn.test(name)) {
        if (cell.trim().isEmpty()) {
          empty = true;
        } else if (textColumn == null && !DistParams.isPlainNumber(cell)) {
          textColumn = name;
          textValue = cell;
        }
      }
      return cell;
    }
  }
}
