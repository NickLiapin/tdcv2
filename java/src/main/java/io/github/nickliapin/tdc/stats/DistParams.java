package io.github.nickliapin.tdc.stats;

import io.github.nickliapin.tdc.expr.Evaluate;
import io.github.nickliapin.tdc.lib.Numbers;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.function.Function;
import java.util.function.Predicate;

/**
 * A distribution parameter written as an EXPRESSION rather than a number.
 *
 * <p>{@code lambda="Traffic * 0.5"} is an intensity driven by another column;
 * {@code sd="0.5 + 0.01 * _count"} is a sensor that grows noisier as the run goes on. A bare number
 * stays the ordinary case and costs nothing — the spec is parsed once, exactly as before, and only
 * a config that names a column comes here.
 *
 * <p>Why this is allowed at all, when a per-row {@code repeat=} is not: how many uniform draws a
 * row consumes depends on WHICH distribution, never on its parameters. The parameter changes the
 * value the draws are turned into, not their number, so the row stays computable without its
 * predecessors — the property every engine is built on.
 */
public final class DistParams {

  private DistParams() {}

  /** Every parameter any of the nine distributions reads. */
  public static final List<String> PARAMS =
      List.of(
          "mean", "sd", "meanlog", "sdlog", "rate", "alpha", "xmin", "shape", "scale", "lambda",
          "beta", "s", "n", "min", "max");

  /** The two distributions sampled from a PAIR of uniforms; every other reads one. */
  private static final Set<String> TWO_DRAW = Set.of("normal", "lognormal");

  /**
   * The attributes with every expression-valued parameter replaced by its answer.
   *
   * @param attrs the generator's attributes, resolved
   * @param empty a referenced column was empty on this row, so nothing can be drawn
   */
  public record Resolved(Map<String, String> attrs, boolean empty) {}

  /** Digits, a point, a sign, an exponent — anything a plain number can be. */
  public static boolean isPlainNumber(String text) {
    String body = text.trim();
    if (body.isEmpty()) {
      return false;
    }
    try {
      double value = Double.parseDouble(body);
      return !Double.isNaN(value) && !Double.isInfinite(value);
    } catch (NumberFormatException e) {
      return false;
    }
  }

  /** The parameters this generator wrote as an expression rather than a number. */
  public static List<String> expressionParams(Map<String, String> attrs) {
    List<String> out = new ArrayList<>();
    for (String name : PARAMS) {
      String raw = attrs.get(name);
      if (raw != null && !raw.trim().isEmpty() && !isPlainNumber(raw)) {
        out.add(name);
      }
    }
    return out;
  }

  /**
   * How many uniforms a row of this distribution spends, known from the NAME alone.
   *
   * <p>Wanted by a row that cannot be drawn at all — a parameter read an empty cell — which must
   * still spend what a drawn row would. Otherwise blanking one cell would slide every value after
   * it, and a {@code parent=} filter would quietly rewrite the rest of the column.
   */
  public static int draws(Map<String, String> attrs) {
    String name = attrs.getOrDefault("distribution", "").trim().toLowerCase(Locale.ROOT);
    return TWO_DRAW.contains(name) ? 2 : 1;
  }

  /**
   * {@code attrs} with each expression parameter evaluated on this row.
   *
   * <p>A name the registry knows, holding nothing, marks the row EMPTY: that is a row a
   * {@code parent=} filter switched off or a {@code missing=} blank, and it is not a zero. It has
   * to be noticed at the LOOKUP, because an unresolved bare word evaluates to the WORD — the way
   * {@code if="Tier == hi"} reads {@code hi} — and the two cannot be told apart afterwards.
   */
  public static Resolved resolve(
      Map<String, String> attrs,
      List<String> dynamic,
      int row,
      Predicate<String> hasColumn,
      Function<String, String> valueAt) {
    Map<String, String> out = new LinkedHashMap<>(attrs);
    boolean empty = false;

    for (String name : dynamic) {
      String source = attrs.get(name);
      if (source == null) {
        continue;
      }
      Watched scope = new Watched(row, hasColumn, valueAt);
      Object answer = Evaluate.asValue(source, scope);
      empty = empty || scope.empty;

      String written = null;
      if (answer instanceof Long n) {
        written = n.toString();
      } else if (answer instanceof Double d && !Double.isNaN(d) && !Double.isInfinite(d)) {
        written = Numbers.toText(d);
      } else if (answer instanceof String text && isPlainNumber(text)) {
        // A bare column reference resolves to the cell's TEXT — `mean="M"` where M holds "100".
        // Arithmetic would have produced a number, but naming a column and nothing else is the
        // simplest way to write this and must work too.
        written = text.trim();
      }

      if (written != null) {
        out.put(name, written);
      } else if (!empty && scope.textColumn != null) {
        // Nothing numeric came out, and a column is the reason. Say which — the distribution's own
        // message would only repeat that the parameter is "not a number", which the author can
        // already see. Same wording as the formula generator, for the same mistake read from the
        // same columns.
        throw new IllegalArgumentException(
            name
                + ": the expression is not a number: column \""
                + scope.textColumn
                + "\" holds \""
                + scope.textValue
                + "\", which is text rather than a number");
      }
    }

    return new Resolved(out, empty);
  }

  /** A scope that watches what the expression READ, so a refusal can point at the cause. */
  private static final class Watched implements Evaluate.Scope {
    private final int row;
    private final Predicate<String> hasColumn;
    private final Function<String, String> valueAt;
    private boolean empty;
    private String textColumn;
    private String textValue;

    Watched(int row, Predicate<String> hasColumn, Function<String, String> valueAt) {
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
        } else if (textColumn == null && !isPlainNumber(cell)) {
          textColumn = name;
          textValue = cell;
        }
      }
      return cell;
    }
  }
}
