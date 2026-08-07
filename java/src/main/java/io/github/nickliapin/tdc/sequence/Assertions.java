package io.github.nickliapin.tdc.sequence;

import io.github.nickliapin.tdc.expr.Evaluate;
import io.github.nickliapin.tdc.model.Config;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.BiFunction;
import java.util.function.Predicate;
import java.util.stream.Collectors;

/**
 * {@code <assert that="Rows == 700" says="…"/>} — a config that checks its own output.
 *
 * <p>What is worth asserting is not what the config already states. You wrote
 * {@code percent="70"} and you assert 70 percent — you have tested that TDC can count. What the
 * config does NOT state is where the value ends up: a {@code parent=} filter removes rows, a
 * second condition removes more, and the share that reaches the file is 42 percent with nothing
 * to say so.
 *
 * <p>Three existing mechanisms, no new language: {@code that=} is the {@code if=} expression
 * language, the numbers come from {@code <gen type="stat">}, and {@code says=} is the sentence a
 * reader gets in a CI log months later.
 *
 * <p>Every name the expression reads must be WHOLE-RUN CONSTANT, or {@code Amount > 100} reads row
 * 0 and reports on one row out of a thousand — a check that passed because it barely looked,
 * wearing a badge that says verified. Which names an expression reads is discovered by handing the
 * evaluator a scope that records what it is asked for, so no parser knows this feature exists.
 */
public final class Assertions {

  /**
   * Built-ins an assertion may read. {@code _count} is deliberately absent: it says which row you
   * are on, which is what an assertion must not depend on.
   */
  private static final Set<String> WHOLE_RUN_BUILTINS = Set.of("_total");

  /** Attributes that make a cell which may or may not be there, so the spec settles nothing. */
  private static final List<String> UNSETTLING = List.of("missing", "anomaly", "if", "repeat");

  private Assertions() {}

  /** A run whose output did not hold up its own config's claim. */
  public static final class AssertionFailed extends RuntimeException {
    private static final long serialVersionUID = 1L;

    AssertionFailed(String message) {
      super(message);
    }
  }

  /** What reading the column found. */
  private enum Constancy {
    CONSTANT,
    VARIES,
    EMPTY_ON_SOME_ROWS
  }

  /**
   * Check every assertion against the finished run, throwing on the first that does not hold.
   *
   * <p>{@code valueAt} and {@code known} come from the engine, because a column is an array on one
   * engine and a function of the row on another — and an assertion has to mean the same thing on
   * both.
   */
  public static void check(
      Config config, BiFunction<String, Integer, String> valueAt, Predicate<String> known) {
    if (config.asserts().isEmpty()) {
      return;
    }
    Map<String, Config.SequenceSpec> bySpec = new HashMap<>();
    for (Config.SequenceSpec spec : config.sequences()) {
      if (spec.name() != null && !spec.name().isEmpty()) {
        bySpec.put(spec.name(), spec);
      }
    }
    int count = Math.max(config.count(), 0);

    for (Config.AssertSpec assertion : config.asserts()) {
      Recording scope = new Recording(valueAt, known);
      boolean held;
      try {
        held = Evaluate.asCondition(assertion.that(), scope);
      } catch (RuntimeException e) {
        throw new AssertionFailed(
            "assert: cannot read \"" + assertion.that() + "\" — " + e.getMessage());
      }

      // The honesty rule, applied to every name the expression touched. The evaluator walks both
      // sides of `&&` rather than short-circuiting — in all five implementations, since they share
      // this walk — so which names are checked does not depend on operand order.
      for (Map.Entry<String, String> read : scope.read.entrySet()) {
        String name = read.getKey();
        Constancy constancy = measure(name, valueAt, bySpec.get(name), count);
        if (constancy == Constancy.CONSTANT) {
          continue;
        }
        String why =
            constancy == Constancy.VARIES
                ? "\"" + name + "\" is not the same on every row, so this would have checked the "
                    + "first row and called the run verified"
                : "\"" + name + "\" is empty on some rows, so the run has no single value for it — "
                    + "this would have checked whatever the first row happened to hold";
        throw new AssertionFailed(
            "assert (\"" + assertion.that() + "\"): " + why
                + ". An assertion reads whole-run values: give it a <gen type=\"stat\" of=\""
                + name + "\" op=\"…\"/> column, or _total.");
      }

      if (!held) {
        String detail =
            scope.read.entrySet().stream()
                .map(e -> e.getKey() + " = " + (e.getValue().isEmpty() ? "(empty)" : e.getValue()))
                .collect(Collectors.joining(", "));
        String shown =
            detail.isEmpty() ? assertion.that() : assertion.that() + "   with " + detail;
        throw new AssertionFailed("assert failed: " + assertion.says() + "\n  " + shown);
      }
    }
  }

  /**
   * Constant from the SPEC alone, without reading a single row.
   *
   * <p>Reading the column is the honest test and stays below, but it costs a pass over the run —
   * and on a streaming engine that pass regenerates every value. Measured at two million rows it
   * cost a third of a second per name, which at a billion rows is minutes spent proving what the
   * spec already said. So this runs first and, like the {@code uniq} capacity check, only ever
   * answers "definitely constant": anything it cannot prove falls through to the scan, so no config
   * is refused that would have been accepted.
   */
  private static boolean constantByConstruction(Config.SequenceSpec spec) {
    if (spec == null || spec.gen() == null) {
      return false; // a compound, a mix, a switch — read it
    }
    if (spec.parent() != null) {
      return false; // a filtered column is empty on the rows the filter excluded
    }
    Map<String, String> attrs = spec.gen().attrs();
    for (String attr : UNSETTLING) {
      if (attrs.containsKey(attr)) {
        return false;
      }
    }
    String type = spec.gen().type();
    if ("stat".equals(type)) {
      return true; // one number for the whole run, by definition
    }
    if ("text".equals(type)) {
      String raw = attrs.get("value");
      return raw != null && !raw.contains(","); // a list of one
    }
    return false;
  }

  /**
   * Whether this column holds one and the same value on every row of the run.
   *
   * <p>An EMPTY cell fails the rule as surely as a different one: a column a {@code parent=} filter
   * leaves blank on half the run has no whole-run value at all, and the condition would compare
   * against whatever row 0 happened to hold.
   */
  private static Constancy measure(
      String name,
      BiFunction<String, Integer, String> valueAt,
      Config.SequenceSpec spec,
      int count) {
    if (WHOLE_RUN_BUILTINS.contains(name) || constantByConstruction(spec)) {
      return Constancy.CONSTANT;
    }
    String seen = null;
    for (int row = 0; row < count; row++) {
      String value = valueAt.apply(name, row);
      if (value == null || value.isEmpty()) {
        return Constancy.EMPTY_ON_SOME_ROWS;
      }
      if (seen == null) {
        seen = value;
      } else if (!seen.equals(value)) {
        return Constancy.VARIES;
      }
    }
    return seen == null ? Constancy.EMPTY_ON_SOME_ROWS : Constancy.CONSTANT;
  }

  /**
   * A scope that answers from row 0 and remembers every real column it was asked for — the whole
   * discovery mechanism, and the reason no parser changes.
   */
  private static final class Recording implements Evaluate.Scope {
    private final BiFunction<String, Integer, String> valueAt;
    private final Predicate<String> known;

    /** Insertion-ordered, so the reported values read in the order the expression asked. */
    private final Map<String, String> read = new LinkedHashMap<>();

    Recording(BiFunction<String, Integer, String> valueAt, Predicate<String> known) {
      this.valueAt = valueAt;
      this.known = known;
    }

    @Override
    public boolean has(String name) {
      return known.test(name);
    }

    @Override
    public String value(String name) {
      String found = valueAt.apply(name, 0);
      String text = found == null ? "" : found;
      // Only a real column is recorded. A name that is not declared is not data at all — the
      // expression language reads it as its own literal text, which is what lets `Kind == a` go
      // unquoted — so it has nothing to be constant about, and the validator is the one that asks
      // whether it was a typo.
      if (known.test(name)) {
        read.putIfAbsent(name, text);
      }
      return text;
    }
  }
}
